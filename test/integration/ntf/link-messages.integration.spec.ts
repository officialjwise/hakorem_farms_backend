import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createUuidV7Generator, ManualClock } from '@hakorem/kernel';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { stepUp, type TotpSession } from '../../support/fin';
import { consolePost, createUser, enrolAndLogin, login, relaxRateLimits, testStartTime, type TestSession } from '../../support/iam';
import { FakeSms, ntfHarness, SCHEDULER, signReport, type NtfHarness } from '../../support/ntf';
import { syncBatch, tillSale, type TillSale } from '../../support/offline';
import { SQLSTATE, sqlStateOf } from '../../support/sql-state';
import { startTestApp, TEST_ORIGIN, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * The messages that carry a link (B11 continued 12, ADR-0084, ADR-0074, CR-033 point 3; the gate's first half): the
 * guest's tracking SMS when an online order is placed and the receipt SMS when a till's counter sale with the buyer's
 * number syncs. Each is queued once with the link's merge field unfilled, so no token is ever in the outbox or the
 * message row; the sending worker asks the record's own module (ORD, POS) for a fresh token just before the provider
 * call, and the SMS goes only to the number on the record, read at send. A guessed token, the order's id and the sale's
 * id open nothing. The provider is a test double. Every figure is read by SQL.
 */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let ntf: NtfHarness;
let nextId: () => string;
const sessions = new Map<string, TestSession>();
const ids = new Map<string, string>();
const id = (code: string) => ids.get(code)!;
let credential = '';
let shift = { id: '', seq: 0 };
let counter = 0;
const admin = () => database.pool('admin');
const as = (who: string) => sessions.get(who)!;
const post = (who: string, path: string, body: object = {}, key: string = randomUUID()) => consolePost(api.server, as(who), `/v1${path}`, key).send(body);
const rows = async <T>(sql: string, values: unknown[] = []): Promise<T[]> => (await admin().query(sql, values)).rows as T[];
const one = async <T>(sql: string, values: unknown[] = []): Promise<T> => (await rows<T>(sql, values))[0]!;
const count = async (sql: string, values: unknown[] = []) => Number((await one<{ n: string }>(sql, values)).n);
const receipt = (token: string) => request(api.server).get(`/v1/shop/receipts/${encodeURIComponent(token)}`);
const tracking = (token: string) => request(api.server).get(`/v1/shop/orders/track/${encodeURIComponent(token)}`);
/** An answer with its correlation id left out, so two refusals can be compared whole. */
const bare = (res: request.Response) => ({ status: res.status, error: { ...res.body.error, correlationId: undefined } });
const tillToken = () => randomBytes(16).toString('base64url');
const BASE = 'https://shop.hakorem.test';
const MINUTE = 60_000;
const BUYER = '+233244000101';
const GUEST_PHONE = '+233201234567';
const WEBHOOK_SECRET = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');
/** A signed reply from a phone, as the provider forwards it. */
const reply = (from: string, text: string) => {
  const body = JSON.stringify({ type: 'inbound', id: `mo-${randomUUID()}`, from, text });
  return request(api.server).post('/v1/webhooks/messaging/GENERIC_HTTP').set('Content-Type', 'application/json').set('X-Provider-Signature', signReport(WEBHOOK_SECRET, body)).send(body);
};

const messagesOf = (orderId: string) =>
  rows<{ id: string; code: string; status: string; body: string; masked: string; reason: string | null; linkKind: string | null; linkRecord: string | null; attempts: number }>(
    `SELECT m.id, t.code, m.status, m.rendered_body AS body, m.address_masked AS masked, m.suppressed_reason AS reason, m.link_kind AS "linkKind",
            m.link_record_id AS "linkRecord", m.attempts
       FROM ntf.message m JOIN ntf.template t ON t.id = m.template_id WHERE m.sales_order_id = $1 ORDER BY m.created_at, m.id`,
    [orderId],
  );

/** The token's text written anywhere NTF, POS, ORD or the platform keeps rows. */
async function writtenAnywhere(token: string): Promise<string[]> {
  const found = await rows<{ place: string }>(
    `SELECT 'ntf.message' AS place FROM ntf.message m WHERE row_to_json(m)::text LIKE '%' || $1 || '%'
     UNION ALL SELECT 'ntf.message_attempt' FROM ntf.message_attempt a WHERE row_to_json(a)::text LIKE '%' || $1 || '%'
     UNION ALL SELECT 'pos.receipt_message_link' FROM pos.receipt_message_link l WHERE row_to_json(l)::text LIKE '%' || $1 || '%'
     UNION ALL SELECT 'ord.order_tracking_token' FROM ord.order_tracking_token t WHERE row_to_json(t)::text LIKE '%' || $1 || '%'
     UNION ALL SELECT 'platform.audit_event' FROM platform.audit_event WHERE (coalesce(before::text, '') || coalesce(after::text, '') || coalesce(metadata::text, '')) LIKE '%' || $1 || '%'
     UNION ALL SELECT 'platform.outbox_message' FROM platform.outbox_message WHERE payload::text LIKE '%' || $1 || '%'`,
    [token],
  );
  return found.map((r) => r.place);
}

/** Two crates of eggs at 6,000, cash 12,000 with 15,000 handed over, as the till queues it. */
function crates(extra: Partial<Parameters<typeof tillSale>[0]> = {}): TillSale {
  counter += 1;
  clock.advanceBy(MINUTE);
  return tillSale({
    till: 'T2',
    shiftSeq: shift.seq,
    counter,
    at: clock.now(),
    lines: [{ productId: id('EGG-0003'), quantity: '2.000', uom: 'CRATE', agreedUnitPricePesewas: 6_000 }],
    tenders: [{ paymentMethodId: id('CASH'), amountPesewas: 12_000, tenderedPesewas: 15_000 }],
    ...extra,
  });
}

async function sync(sales: readonly TillSale[]) {
  const answer = await syncBatch(api.server, as('kwame'), credential, { deviceId: id('device'), shiftId: shift.id, sales });
  expect(answer.status, JSON.stringify(answer.body)).toBe(200);
  return answer.body.results as { clientSaleId: string; outcome: string; orderNo: string | null; receiptNo: string | null; exceptions: { kind: string }[] }[];
}

/** A guest's online order of one crate of big eggs, placed on cash on delivery from the shop. */
async function guestOrder(): Promise<string> {
  const created = await request(api.server).post('/v1/shop/carts').set('Origin', TEST_ORIGIN).set('Idempotency-Key', randomUUID());
  const cookie = (created.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('__Host-hk_guest='))!.split(';')[0]!;
  const cartId = created.body.id as string;
  const guest = (path: string, body: object, key = randomUUID()) => request(api.server).post(`/v1${path}`).set('Origin', TEST_ORIGIN).set('Idempotency-Key', key).set('Cookie', cookie).send(body);
  expect((await guest(`/shop/carts/${cartId}/lines`, { productId: id('EGG-0003'), quantity: '1.000' })).status).toBe(200);
  const address = { recipientName: 'Ama Serwaa Ofori', recipientPhone: '0244512876', line1: 'Two houses after the Presby church', area: 'Dodowa', city: 'Dodowa', region: 'Greater Accra' };
  const started = await guest(`/shop/carts/${cartId}/checkout`, { contactName: 'Kofi Boateng', contactPhone: '0201234567', fulfilmentMode: 'DELIVERY', address, paymentTerms: 'COD' });
  expect(started.status, JSON.stringify(started.body)).toBe(201);
  const key = randomUUID();
  const placed = await guest(`/shop/checkouts/${started.body.id as string}/place`, { paymentMethod: 'COD' }, key);
  expect(placed.status, JSON.stringify(placed.body)).toBe(201);
  // The placement replayed with its key: answered again with a fresh token for the same order, and no second message.
  const replayed = await guest(`/shop/checkouts/${started.body.id as string}/place`, { paymentMethod: 'COD' }, key);
  expect(replayed.body.orderId).toBe(placed.body.orderId);
  return placed.body.orderId as string;
}

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  nextId = createUuidV7Generator(clock);
  await relaxRateLimits(database);
  for (const key of ['rate_limit.public.per_address_1m', 'rate_limit.checkout.per_address_10m']) {
    await database.pool('app').query(
      `INSERT INTO platform.setting (id, key, value, value_type, valid_from, description, created_by, updated_by)
       VALUES ($1, $2, '100000', 'INTEGER', now() - interval '1 day', 'Raised for a test file', '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001')`,
      [randomUUID(), key],
    );
  }
  api = await startTestApp(database, { clock, environment: { RECEIPT_LINK_BASE_URL: BASE, SMS_WEBHOOK_SECRET: WEBHOOK_SECRET, AUTH_ACCESS_TTL_SECONDS: '172800', AUTH_STAFF_REFRESH_IDLE_SECONDS: '172800' } });
  ntf = ntfHarness(api.app, database, clock);
  await runSeedUnits(database.pool('app'), api.app, seedUnits({ SEED_STAFF_PASSWORD: `Seed-${randomUUID()}` }));
  for (const row of await rows<{ code: string; id: string }>(
    `SELECT 'branch' AS code, id FROM mdm.branch WHERE code = 'DDW'
     UNION ALL SELECT 'shop', l.id FROM mdm.location l JOIN mdm.branch b ON b.id = l.branch_id WHERE b.code = 'DDW' AND l.code = 'SHOP'
     UNION ALL SELECT sku, id FROM mdm.product WHERE sku = 'EGG-0003'
     UNION ALL SELECT code, id FROM mdm.payment_method`,
  )) {
    ids.set(row.code, row.id);
  }
  const manager = await createUser(database, { name: 'Kwabena Owusu', grants: [{ role: 'MANAGER', branchId: id('branch') }] });
  sessions.set('manager', await enrolAndLogin(api.server, manager, () => clock.now()));
  const kwame = await createUser(database, { name: 'Kwame Asare', grants: [{ role: 'CASHIER', branchId: id('branch'), locationId: id('shop') }] });
  sessions.set('kwame', await login(api.server, kwame));
  const till = await post('manager', '/registers', { branchId: id('branch'), locationId: id('shop'), code: 'T2', name: 'Shop floor till' });
  expect(till.status, JSON.stringify(till.body)).toBe(201);
  await stepUp(api.server, as('manager') as TotpSession, clock);
  const enrolled = await post('manager', `/registers/${till.body.id as string}/devices`, { deviceLabel: 'Shop floor tablet' });
  expect(enrolled.status, JSON.stringify(enrolled.body)).toBe(201);
  credential = enrolled.body.deviceCredential as string;
  ids.set('device', enrolled.body.device.id as string);
  clock.advanceBy(10 * MINUTE);
  const shiftId = nextId();
  const opened = await post('kwame', '/shifts', { id: shiftId, registerId: till.body.id as string, openingFloatPesewas: 0, openedAt: clock.now().toISOString() }, shiftId);
  expect(opened.status, JSON.stringify(opened.body)).toBe(201);
  shift = { id: shiftId, seq: opened.body.shiftSeq as number };
});

afterAll(async () => {
  await api?.close();
  await database?.drop();
});

describe("the guest's tracking SMS: once, to the order's own contact, with a token of its own made at send", () => {
  const sms = new FakeSms();
  let orderId = '';

  beforeAll(async () => {
    orderId = await guestOrder();
  });

  it('is queued once with the link unfilled, so the outbox and the message row hold no link', async () => {
    await ntf.dispatch();
    await ntf.dispatch();
    const messages = await messagesOf(orderId);
    const orderNo = (await one<{ no: string }>('SELECT order_no AS no FROM ord.sales_order WHERE id = $1', [orderId])).no;
    expect(messages).toEqual([
      { id: expect.any(String), code: 'ORDER_TRACKING', status: 'QUEUED', body: `HaKorem Farms: thank you for order ${orderNo}. Follow it here: {{link}}`, masked: '+23320*****67', reason: null, linkKind: 'TRACKING', linkRecord: orderId, attempts: 0 },
    ]);
    expect(await count("SELECT count(*) AS n FROM platform.outbox_message WHERE payload::text LIKE '%trk_%'")).toBe(0);
  });

  it("is sent once to the guest's own number with a fresh token that opens the order, and nothing else opens it", async () => {
    const before = await count('SELECT count(*) AS n FROM ord.order_tracking_token WHERE sales_order_id = $1', [orderId]);
    expect((await ntf.sender(sms).run(SCHEDULER)).sent).toBe(1);
    expect((await ntf.sender(sms).run(SCHEDULER)).claimed).toBe(0);
    expect(sms.calls).toHaveLength(1);
    const call = sms.calls[0]!;
    expect(call.to).toBe(GUEST_PHONE);
    const match = new RegExp(`^HaKorem Farms: thank you for order SO-[A-Z0-9-]+\\. Follow it here: ${BASE}/track/(trk_[A-Za-z0-9_-]{43})$`).exec(call.text);
    expect(match, call.text).not.toBeNull();
    const token = match![1]!;
    expect(await count('SELECT count(*) AS n FROM ord.order_tracking_token WHERE sales_order_id = $1', [orderId])).toBe(before + 1);
    const opened = await tracking(token);
    expect(opened.status, JSON.stringify(opened.body)).toBe(200);
    expect(await writtenAnywhere(token)).toEqual([]);
    const guessed = await tracking(`trk_${randomBytes(32).toString('base64url')}`);
    expect(guessed.status).toBe(404);
    for (const other of [orderId, orderId.replace(/-/g, ''), `trk_${Buffer.from(orderId.replace(/-/g, ''), 'hex').toString('base64url')}`]) expect(bare(await tracking(other))).toEqual(bare(guessed));
    const [message] = await messagesOf(orderId);
    expect(message).toMatchObject({ status: 'SENT', attempts: 1, body: expect.stringContaining('{{link}}') });
  });

  it('a message sent again gets another token, and a redelivered event queues nothing more', async () => {
    const [message] = await messagesOf(orderId);
    await admin().query("UPDATE ntf.message SET status = 'FAILED', failed_at = $2, failure_reason = 'report: failed', version = version + 1 WHERE id = $1", [message!.id, clock.now()]);
    const retried = await post('manager', `/notifications/messages/${message!.id}/retry`, {});
    expect(retried.status, JSON.stringify(retried.body)).toBe(200);
    expect((await ntf.sender(sms).run(SCHEDULER)).sent).toBe(1);
    expect(sms.calls).toHaveLength(2);
    const [first, second] = sms.calls.map((c) => /track\/(trk_[A-Za-z0-9_-]+)$/.exec(c.text)![1]!);
    expect(first).not.toBe(second);
    expect((await tracking(first!)).status).toBe(200);
    expect((await tracking(second!)).status).toBe(200);
    await admin().query("UPDATE platform.outbox_delivery SET status = 'PENDING', next_attempt_at = now() - interval '1 second', delivered_at = NULL WHERE consumer = 'ntf.link-messages'");
    await ntf.dispatch();
    expect(await messagesOf(orderId)).toHaveLength(1);
  });
});

describe("the receipt SMS for a live counter sale (the owner, 2026-11-24, A-396; A-397 (d), ADR-0084 Amendments, BL-133)", () => {
  const sms = new FakeSms();
  /** A crate of eggs sold live at the till, through completeCounterSale with the device's credential. */
  const live = (extra: object = {}) => {
    const saleId = nextId();
    clock.advanceBy(MINUTE);
    const body = { id: saleId, shiftId: shift.id, occurredAt: clock.now().toISOString(), lines: [{ productId: id('EGG-0003'), quantity: '1.000', uom: 'CRATE', agreedUnitPricePesewas: 6_000 }], tenders: [{ paymentMethodId: id('CASH'), amountPesewas: 6_000 }], ...extra };
    return () => consolePost(api.server, as('kwame'), '/v1/pos/sales', saleId).set('X-Device-Credential', credential).send(body);
  };

  it('sends none for a live sale, with the buyer\'s phone or without, nor on its replay, because its till makes no receipt link (ADR-0083); a synced sale with the phone sends one', async () => {
    const withPhone = live({ customerPhone: BUYER });
    const sold = await withPhone();
    expect(sold.status, JSON.stringify(sold.body)).toBe(201);
    const replayed = await withPhone();
    expect([replayed.status, replayed.body.order.id]).toEqual([201, sold.body.order.id]);
    const noPhone = await live()();
    expect(noPhone.status, JSON.stringify(noPhone.body)).toBe(201);
    const liveOrders = [sold.body.order.id as string, noPhone.body.order.id as string];
    // Each live sale completed once, and its event reached NTF's consumer.
    expect(await count("SELECT count(*) AS n FROM platform.outbox_message WHERE event_type = 'ord.OrderCompleted' AND subject_id = ANY($1::uuid[])", [liveOrders])).toBe(2);
    const synced = crates({ receiptToken: tillToken(), customerPhone: BUYER });
    await sync([synced]);
    expect((await sync([synced]))[0]!.outcome).toBe('DUPLICATE');
    await ntf.dispatch();
    expect(await count("SELECT count(*) AS n FROM platform.outbox_delivery d JOIN platform.outbox_message m ON m.id = d.message_id WHERE d.consumer = 'ntf.link-messages' AND d.status = 'DELIVERED' AND m.subject_id = ANY($1::uuid[])", [liveOrders])).toBe(2);
    const calls = sms.calls.length;
    await ntf.sender(sms).run(SCHEDULER);
    await ntf.sender(sms).run(SCHEDULER);
    // The live sales: no till link, so no message queued and nothing on the exception report's source (no NO_LINK).
    for (const order of liveOrders) expect(await messagesOf(order)).toEqual([]);
    expect(await count('SELECT count(*) AS n FROM pos.receipt_link WHERE order_document_id = ANY($1::uuid[])', [liveOrders])).toBe(0);
    expect(await count("SELECT count(*) AS n FROM platform.outbox_message WHERE event_type = 'ntf.MessageSuppressed' AND payload->>'salesOrderId' = ANY($1::text[])", [liveOrders])).toBe(0);
    // The synced sale: one text, to the number it carried, linking its till's receipt, a replay adding none.
    expect(await messagesOf(synced.id)).toEqual([expect.objectContaining({ code: 'SALE_RECEIPT', status: 'SENT', linkKind: 'RECEIPT' })]);
    expect(sms.calls.slice(calls).map((c) => c.to)).toEqual([BUYER]);
    expect(sms.calls.at(-1)!.text).toMatch(new RegExp(`^HaKorem Farms: receipt .* Your receipt: ${BASE}/r/rcp_[A-Za-z0-9_-]{43}$`));
  });
});

describe("the receipt SMS (CR-033 point 3): once per synced sale, to the buyer's number, linking exactly the till's receipt", () => {
  const sms = new FakeSms();

  it("sends one SMS to the number the buyer gave, whose own token answers exactly the till link's receipt", async () => {
    const token = tillToken();
    const sale = crates({ receiptToken: token, customerPhone: BUYER });
    const [result] = await sync([sale]);
    expect(result!.outcome).toBe('APPLIED');
    await ntf.dispatch();
    const [message] = await messagesOf(sale.id);
    expect(message).toMatchObject({ code: 'SALE_RECEIPT', status: 'QUEUED', masked: '+23324*****01', linkKind: 'RECEIPT', linkRecord: sale.id, body: `HaKorem Farms: receipt ${result!.receiptNo!} for GHS 120.00, sale ${result!.orderNo!}. Your receipt: {{link}}` });
    const tillAnswer = await receipt(token);
    expect(tillAnswer.status).toBe(200);
    expect((await ntf.sender(sms).run(SCHEDULER)).sent).toBe(1);
    expect(sms.calls.map((c) => c.to)).toEqual([BUYER]);
    const sent = new RegExp(`Your receipt: ${BASE}/r/(rcp_[A-Za-z0-9_-]{43})$`).exec(sms.calls[0]!.text)![1]!;
    const messageAnswer = await receipt(sent);
    expect(messageAnswer.status).toBe(200);
    expect(messageAnswer.body).toEqual(tillAnswer.body);
    expect(messageAnswer.body).toMatchObject({ receiptNo: result!.receiptNo, totalPesewas: 12_000, changePesewas: 3_000 });
    // The till's own link answers exactly as before.
    expect((await receipt(token)).body).toEqual(tillAnswer.body);
    expect(await writtenAnywhere(sent)).toEqual([]);
    const stored = await one<{ hash: Buffer; expires: Date; tillExpires: Date }>(
      'SELECT m.token_hash AS hash, m.expires_at AS expires, l.expires_at AS "tillExpires" FROM pos.receipt_message_link m JOIN pos.receipt_link l ON l.id = m.receipt_link_id WHERE m.order_document_id = $1',
      [sale.id],
    );
    expect(stored.hash).toEqual(createHash('sha256').update(sent, 'utf8').digest());
    expect(stored.expires).toEqual(stored.tillExpires);
    // The sale's id, with and without hyphens, and a guessed token open nothing, answered alike.
    const guessed = await receipt(`rcp_${randomBytes(32).toString('base64url')}`);
    expect(guessed.status).toBe(404);
    for (const other of [sale.id, sale.id.replace(/-/g, ''), result!.receiptNo!, result!.orderNo!]) expect(bare(await receipt(other))).toEqual(bare(guessed));
  });

  it('a replayed sync and a redelivered event send one SMS, never two', async () => {
    const sale = crates({ receiptToken: tillToken(), customerPhone: BUYER });
    await sync([sale]);
    const [again] = await sync([sale]);
    expect(again!.outcome).toBe('DUPLICATE');
    await ntf.dispatch();
    await admin().query("UPDATE platform.outbox_delivery SET status = 'PENDING', next_attempt_at = now() - interval '1 second', delivered_at = NULL WHERE consumer = 'ntf.link-messages'");
    await ntf.dispatch();
    const calls = sms.calls.length;
    await ntf.sender(sms).run(SCHEDULER);
    await ntf.sender(sms).run(SCHEDULER);
    expect(await messagesOf(sale.id)).toHaveLength(1);
    expect(sms.calls.length).toBe(calls + 1);
    expect(await count("SELECT count(*) AS n FROM platform.outbox_message WHERE event_type = 'ord.OrderCompleted' AND subject_id = $1", [sale.id])).toBe(1);
  });

  it('a sale with no number sends nothing; a sale whose till token was refused or never sent gets no receipt by message', async () => {
    const reused = tillToken();
    const first = crates({ receiptToken: reused });
    const refused = crates({ receiptToken: reused, customerPhone: BUYER });
    const none = crates({ customerPhone: BUYER });
    const results = await sync([first, refused, none]);
    expect(results[1]!.exceptions.map((e) => e.kind)).toContain('RECEIPT_TOKEN_REFUSED');
    await ntf.dispatch();
    const calls = sms.calls.length;
    await ntf.sender(sms).run(SCHEDULER);
    expect(sms.calls.length).toBe(calls);
    expect(await messagesOf(first.id)).toEqual([expect.objectContaining({ code: 'SALE_RECEIPT', status: 'SUPPRESSED', reason: 'NO_ADDRESS', masked: '' })]);
    expect(await messagesOf(refused.id)).toEqual([expect.objectContaining({ code: 'SALE_RECEIPT', status: 'SUPPRESSED', reason: 'NO_LINK', attempts: 0 })]);
    expect(await messagesOf(none.id)).toEqual([expect.objectContaining({ code: 'SALE_RECEIPT', status: 'SUPPRESSED', reason: 'NO_LINK' })]);
    expect(await count('SELECT count(*) AS n FROM pos.receipt_message_link WHERE order_document_id = ANY($1::uuid[])', [[first.id, refused.id, none.id]])).toBe(0);
    // Each receipt that could not be linked reaches the exception report's source (abuse case 60); a sale with no number does not.
    const published = await rows<{ order: string; payload: { reason: string; templateCode: string; abuseCases: number[] } }>(
      "SELECT payload->>'salesOrderId' AS order, payload FROM platform.outbox_message WHERE event_type = 'ntf.MessageSuppressed' AND payload->>'salesOrderId' = ANY($1::text[]) ORDER BY payload->>'salesOrderId'",
      [[first.id, refused.id, none.id]],
    );
    expect(published.map((p) => [p.order, p.payload.reason, p.payload.templateCode, p.payload.abuseCases]).sort()).toEqual([[none.id, 'NO_LINK', 'SALE_RECEIPT', [60]], [refused.id, 'NO_LINK', 'SALE_RECEIPT', [60]]].sort());
  });

  it('is transactional: an opt-out of reminders on the number does not stop it', async () => {
    expect((await reply(BUYER, 'STOP')).status).toBe(200);
    expect(await count("SELECT count(*) AS n FROM ntf.opt_out WHERE address_masked = '+23324*****01' AND direction = 'OPT_OUT'")).toBe(1);
    const sale = crates({ receiptToken: tillToken(), customerPhone: BUYER });
    await sync([sale]);
    await ntf.dispatch();
    const calls = sms.calls.length;
    expect((await ntf.sender(sms).run(SCHEDULER)).sent).toBe(1);
    expect(sms.calls.length).toBe(calls + 1);
    expect(sms.calls.at(-1)!.to).toBe(BUYER);
  });

  it("revoking the till link revokes its message links at once, and a revoked, expired or unknown link answers as a guess", async () => {
    const token = tillToken();
    const sale = crates({ receiptToken: token, customerPhone: BUYER });
    await sync([sale]);
    await ntf.dispatch();
    await ntf.sender(sms).run(SCHEDULER);
    const sent = /\/r\/(rcp_[A-Za-z0-9_-]+)$/.exec(sms.calls.at(-1)!.text)![1]!;
    expect((await receipt(sent)).status).toBe(200);
    const guessed = bare(await receipt(`rcp_${randomBytes(32).toString('base64url')}`));
    await stepUp(api.server, as('manager') as TotpSession, clock);
    const revoked = await post('manager', `/pos/sales/${sale.id}/revoke-receipt-link`, { reason: 'Printed for the wrong customer' });
    expect(revoked.status, JSON.stringify(revoked.body)).toBe(200);
    expect(bare(await receipt(sent))).toEqual(guessed);
    expect(bare(await receipt(token))).toEqual(guessed);
    // Every live message link reads nothing once its till link has expired, twelve months from the sale's time.
    const live = /\/r\/(rcp_[A-Za-z0-9_-]+)$/.exec(sms.calls[0]!.text)![1]!;
    expect((await receipt(live)).status).toBe(200);
    clock.advanceBy(366 * 24 * 60 * MINUTE);
    expect(bare(await receipt(live))).toEqual(guessed);
  });

  it('the database keeps a message link to its own sale\'s till link, expiring with it, never a till hash, never changed', async () => {
    const link = await one<{ id: string; tillId: string; sale: string; hash: Buffer; expires: Date }>(
      'SELECT m.id, m.receipt_link_id AS "tillId", m.order_document_id AS sale, m.token_hash AS hash, m.expires_at AS expires FROM pos.receipt_message_link m LIMIT 1',
    );
    const other = await one<{ id: string; sale: string; hash: Buffer; expires: Date }>('SELECT id, order_document_id AS sale, token_hash AS hash, expires_at AS expires FROM pos.receipt_link WHERE id <> $1 LIMIT 1', [link.tillId]);
    const insert = (tillId: string, sale: string, hash: Buffer, expires: Date) =>
      database.pool('app').query('INSERT INTO pos.receipt_message_link (id, receipt_link_id, order_document_id, token_hash, expires_at, recorded_at, actor_id) VALUES ($1, $2, $3, $4, $5, $6, $7)', [
        randomUUID(), tillId, sale, hash, expires, clock.now(), '01900000-0000-7000-8000-000000000004',
      ]);
    expect(await sqlStateOf(insert(link.tillId, other.sale, randomBytes(32), link.expires))).toBe('HK010');
    expect(await sqlStateOf(insert(link.tillId, link.sale, randomBytes(32), new Date(link.expires.getTime() + MINUTE)))).toBe('HK010');
    expect(await sqlStateOf(insert(other.id, other.sale, other.hash, other.expires))).toBe('HK010');
    expect(await sqlStateOf(insert(link.tillId, link.sale, link.hash, link.expires))).toBe(SQLSTATE.uniqueViolation);
    expect(await sqlStateOf(database.pool('app').query('UPDATE pos.receipt_message_link SET expires_at = expires_at WHERE id = $1', [link.id]))).toBe(SQLSTATE.insufficientPrivilege);
    expect(await sqlStateOf(admin().query('DELETE FROM pos.receipt_message_link WHERE id = $1', [link.id]))).toBe('HK001');
    const message = await one<{ id: string }>("SELECT id FROM ntf.message WHERE link_kind = 'RECEIPT' LIMIT 1");
    expect(await sqlStateOf(admin().query('UPDATE ntf.message SET link_record_id = $2 WHERE id = $1', [message.id, randomUUID()]))).toBe('HK004');
    expect(await sqlStateOf(admin().query("UPDATE ntf.message SET rendered_body = 'no placeholder' WHERE id = $1", [message.id]))).toBe('HK004');
    expect(await sqlStateOf(admin().query("UPDATE ntf.message SET link_kind = NULL, link_record_id = NULL WHERE id = $1", [message.id]))).toBe('HK004');
  });
});
