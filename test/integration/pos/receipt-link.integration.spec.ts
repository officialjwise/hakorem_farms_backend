import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createUuidV7Generator, ManualClock } from '@hakorem/kernel';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SEED_BUSINESS_PROFILE } from '../../../src/seed/farm-aud';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { stepUp, type TotpSession } from '../../support/fin';
import { consoleGet, consolePost, createUser, enrolAndLogin, login, relaxRateLimits, testStartTime, type TestSession } from '../../support/iam';
import { syncBatch, tillSale, type TillSale } from '../../support/offline';
import { startTestApp, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * The receipt link (CR-033 points 1 and 2, ADR-0074 Amendments, ADR-0083, B09b continued 4). The till makes the token
 * offline from its secure source and sends it with the sale; the server keeps only its hash, and the public receipt is
 * read by the token and nothing else. A token sent again with another sale refuses only that sale's link, once, and
 * reaches the exception report's source; the sale is recorded. Every figure is read by SQL.
 */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
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
const read = (token: string) => request(api.server).get(`/v1/shop/receipts/${encodeURIComponent(token)}`);
const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest();
/** A till's token as the device makes it: 16 random bytes, base64url, no padding (22 characters). */
const tillToken = () => randomBytes(16).toString('base64url');
const MINUTE = 60_000;

/** Two crates of eggs at 6,000, cash 12,000 with 15,000 handed over, as the till queues it. */
function crates(token: string | undefined, extra: Partial<Parameters<typeof tillSale>[0]> = {}): TillSale {
  counter += 1;
  clock.advanceBy(MINUTE);
  return tillSale({
    till: 'T2',
    shiftSeq: shift.seq,
    counter,
    at: clock.now(),
    lines: [{ productId: id('EGG-0003'), quantity: '2.000', uom: 'CRATE', agreedUnitPricePesewas: 6_000 }],
    tenders: [{ paymentMethodId: id('CASH'), amountPesewas: 12_000, tenderedPesewas: 15_000 }],
    ...(token === undefined ? {} : { receiptToken: token }),
    ...extra,
  });
}

async function sync(sales: readonly TillSale[]) {
  const answer = await syncBatch(api.server, as('kwame'), credential, { deviceId: id('device'), shiftId: shift.id, sales });
  expect(answer.status, JSON.stringify(answer.body)).toBe(200);
  return answer.body.results as { clientSaleId: string; outcome: string; orderNo: string | null; receiptNo: string | null; exceptions: { kind: string; summary: string }[] }[];
}

/** The token's text written anywhere: the sync log, the links, idempotency answers, audit, outbox, the orders. */
async function writtenAnywhere(token: string): Promise<string[]> {
  const found = await rows<{ place: string }>(
    `SELECT 'pos.sale_sync' AS place FROM pos.sale_sync s WHERE row_to_json(s)::text LIKE '%' || $1 || '%'
     UNION ALL SELECT 'pos.receipt_link' FROM pos.receipt_link l WHERE row_to_json(l)::text LIKE '%' || $1 || '%'
     UNION ALL SELECT 'platform.idempotency_key' FROM platform.idempotency_key WHERE coalesce(response_body::text, '') LIKE '%' || $1 || '%'
     UNION ALL SELECT 'platform.audit_event' FROM platform.audit_event WHERE (coalesce(before::text, '') || coalesce(after::text, '') || coalesce(metadata::text, '')) LIKE '%' || $1 || '%'
     UNION ALL SELECT 'platform.outbox_message' FROM platform.outbox_message WHERE payload::text LIKE '%' || $1 || '%'
     UNION ALL SELECT 'ord.sales_order' FROM ord.sales_order o WHERE row_to_json(o)::text LIKE '%' || $1 || '%'`,
    [token],
  );
  return found.map((r) => r.place);
}

const refusalsRaised = async (saleId: string) =>
  rows<{ payload: Record<string, unknown> }>("SELECT payload FROM platform.outbox_message WHERE event_type = 'pos.OfflineSaleFlagged' AND subject_id = $1 AND payload->>'exceptionKind' = 'RECEIPT_TOKEN_REFUSED'", [saleId]);

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  nextId = createUuidV7Generator(clock);
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock, environment: { RECEIPT_LINK_BASE_URL: 'https://shop.hakorem.test', AUTH_ACCESS_TTL_SECONDS: '172800', AUTH_STAFF_REFRESH_IDLE_SECONDS: '172800' } });
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
  ids.set('manager', manager.principalId);
  sessions.set('manager', await enrolAndLogin(api.server, manager, () => clock.now()));
  const kwame = await createUser(database, { name: 'Kwame Asare', grants: [{ role: 'CASHIER', branchId: id('branch'), locationId: id('shop') }] });
  ids.set('kwame', kwame.principalId);
  sessions.set('kwame', await login(api.server, kwame));
  const till = await post('manager', '/registers', { branchId: id('branch'), locationId: id('shop'), code: 'T2', name: 'Shop floor till' });
  expect(till.status, JSON.stringify(till.body)).toBe(201);
  ids.set('till', till.body.id as string);
  await stepUp(api.server, as('manager') as TotpSession, clock);
  const enrolled = await post('manager', `/registers/${till.body.id as string}/devices`, { deviceLabel: 'Shop floor tablet' });
  expect(enrolled.status, JSON.stringify(enrolled.body)).toBe(201);
  credential = enrolled.body.deviceCredential as string;
  ids.set('device', enrolled.body.device.id as string);
  clock.advanceBy(10 * MINUTE);
  const shiftId = nextId();
  const opened = await post('kwame', '/shifts', { id: shiftId, registerId: id('till'), openingFloatPesewas: 0, openedAt: clock.now().toISOString() }, shiftId);
  expect(opened.status, JSON.stringify(opened.body)).toBe(201);
  shift = { id: shiftId, seq: opened.body.shiftSeq as number };
});

afterAll(async () => {
  await api?.close();
  await database.drop();
});

describe('the offline pack hands the till the link to fill (CR-033 point 1)', () => {
  it('carries the shop address with the token placeholder', async () => {
    const pack = await consoleGet(api.server, as('kwame'), `/v1/registers/${id('till')}/offline-pack`).set('X-Device-Credential', credential);
    expect(pack.status, JSON.stringify(pack.body)).toBe(200);
    expect(pack.body.receiptLinkTemplate).toBe('https://shop.hakorem.test/r/{token}');
  });
});

describe('a synced sale is read by its token alone (CR-033 points 1 and 2, ADR-0083)', () => {
  const first = { token: '', sale: undefined as unknown as TillSale, orderNo: '', receiptNo: '' };
  const second = { token: '', sale: undefined as unknown as TillSale, orderNo: '', receiptNo: '' };

  beforeAll(async () => {
    first.token = tillToken();
    second.token = tillToken();
    first.sale = crates(first.token);
    second.sale = crates(second.token, { lines: [{ productId: id('EGG-0003'), quantity: '1.000', uom: 'CRATE', agreedUnitPricePesewas: 6_000 }], tenders: [{ paymentMethodId: id('CASH'), amountPesewas: 6_000, tenderedPesewas: 10_000 }] });
    const [a, b] = await sync([first.sale, second.sale]);
    expect(a!.outcome, JSON.stringify(a)).toBe('APPLIED');
    expect(b!.outcome, JSON.stringify(b)).toBe('APPLIED');
    first.orderNo = a!.orderNo!;
    first.receiptNo = a!.receiptNo!;
    second.orderNo = b!.orderNo!;
    second.receiptNo = b!.receiptNo!;
  });

  it('answers the sale as recorded: its numbers, lines, total, tenders, change and the business, and no id of anything', async () => {
    const answer = await read(first.token);
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    expect(answer.body).toEqual({
      state: 'RECORDED',
      saleReference: first.orderNo,
      receiptNo: first.receiptNo,
      occurredAt: first.sale.occurredAt,
      validUntil: new Date(Date.UTC(new Date(first.sale.occurredAt).getUTCFullYear() + 1, new Date(first.sale.occurredAt).getUTCMonth(), new Date(first.sale.occurredAt).getUTCDate(), new Date(first.sale.occurredAt).getUTCHours(), new Date(first.sale.occurredAt).getUTCMinutes(), new Date(first.sale.occurredAt).getUTCSeconds(), new Date(first.sale.occurredAt).getUTCMilliseconds())).toISOString(),
      business: { name: SEED_BUSINESS_PROFILE.tradingName, phone: SEED_BUSINESS_PROFILE.phone, address: SEED_BUSINESS_PROFILE.address },
      lines: [{ name: expect.any(String), quantity: '2.000', saleUom: 'CRATE', weightKg: null, stockUnitIdentifier: 'EGG-BIG-2026-1110', unitPricePesewas: 6_000, amountPesewas: 12_000 }],
      totalPesewas: 12_000,
      tenders: [{ name: 'Cash', amountPesewas: 12_000, tenderedPesewas: 15_000, unverified: false }],
      changePesewas: 3_000,
      currency: 'GHS',
    });
    expect(JSON.stringify(answer.body)).not.toContain(first.sale.id);
    expect(JSON.stringify(answer.body)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
    const other = await read(second.token);
    expect(other.status).toBe(200);
    expect(other.body).toMatchObject({ saleReference: second.orderNo, receiptNo: second.receiptNo, totalPesewas: 6_000, changePesewas: 4_000 });
  });

  it('stores only the hash, unique, valid twelve months from the sale, and the token in clear nowhere', async () => {
    const link = await one<{ token_hash: Buffer; issued_at: Date; expires_at: Date; change_pesewas: string; source: string; twelve: Date }>(
      "SELECT token_hash, issued_at, expires_at, change_pesewas::text AS change_pesewas, source, ((issued_at AT TIME ZONE 'UTC') + interval '12 months') AT TIME ZONE 'UTC' AS twelve FROM pos.receipt_link WHERE order_document_id = $1",
      [first.sale.id],
    );
    expect(link.token_hash.equals(sha256(first.token))).toBe(true);
    expect(link.issued_at.toISOString()).toBe(first.sale.occurredAt);
    expect(link.expires_at.toISOString()).toBe(link.twelve.toISOString());
    expect(link.change_pesewas).toBe('3000');
    expect(link.source).toBe('TILL');
    expect(await writtenAnywhere(first.token)).toEqual([]);
    expect(await writtenAnywhere(second.token)).toEqual([]);
  });

  it('answers 404, one answer for all, for a guess, an altered token, the sale id, its numbers, a SKU and the other forms', async () => {
    const altered = `${first.token.slice(0, -1)}${first.token.endsWith('A') ? 'B' : 'A'}`;
    const guesses = [tillToken(), altered, first.sale.id, first.sale.id.replaceAll('-', ''), first.orderNo, first.receiptNo, 'EGG-0003', first.sale.provisionalRef, first.token.slice(0, 21), `${first.token}=`, `rcp_${first.token}`, sha256(first.token).toString('hex')];
    const bodies = new Set<string>();
    for (const guess of guesses) {
      const answer = await read(guess);
      expect(answer.status, guess).toBe(404);
      expect(answer.body.error.code, guess).toBe('NOT_FOUND');
      bodies.add(JSON.stringify({ ...answer.body.error, correlationId: undefined }));
    }
    expect(bodies.size).toBe(1);
  });

  it('a replayed sync changes nothing: the sale is a duplicate and its link is the one it was', async () => {
    const [again] = await sync([first.sale]);
    expect(again!.outcome).toBe('DUPLICATE');
    expect((await one<{ n: number }>('SELECT count(*)::int AS n FROM pos.receipt_link WHERE order_document_id = $1', [first.sale.id])).n).toBe(1);
    expect((await read(first.token)).status).toBe(200);
  });
});

describe('a token sent again with another sale (the owner, 2026-11-17, ADR-0074 Amendments)', () => {
  const bound = { token: '', sale: undefined as unknown as TillSale };
  let reused: TillSale;

  beforeAll(async () => {
    bound.token = tillToken();
    bound.sale = crates(bound.token);
    expect((await sync([bound.sale]))[0]!.outcome).toBe('APPLIED');
    reused = crates(bound.token);
  });

  it('records the second sale, refuses only its link, tells the till, and the first link still reads the first sale', async () => {
    const [result] = await sync([reused]);
    expect(result!.outcome).toBe('APPLIED_WITH_EXCEPTION');
    expect(result!.receiptNo).toMatch(/^RCP-/);
    expect(result!.exceptions.map((e) => e.kind)).toEqual(['RECEIPT_TOKEN_REFUSED']);
    const order = await one<{ n: number }>('SELECT count(*)::int AS n FROM ord.sales_order WHERE id = $1', [reused.id]);
    expect(order.n).toBe(1);
    const cash = await one<{ total: string }>('SELECT coalesce(sum(amount_pesewas), 0)::text AS total FROM pay.payment WHERE order_document_id = $1', [reused.id]);
    expect(cash.total).toBe('12000');
    expect((await rows('SELECT 1 FROM pos.receipt_link WHERE order_document_id = $1', [reused.id])).length).toBe(0);
    const answer = await read(bound.token);
    expect(answer.status).toBe(200);
    expect(answer.body.receiptNo).not.toBe(result!.receiptNo);
    expect(answer.body.saleReference).toBe((await one<{ order_no: string }>('SELECT order_no FROM ord.sales_order WHERE id = $1', [bound.sale.id])).order_no);
  });

  it('marks the sale as needing a fresh server-made link and raises it once, naming the device, the shift, the cashier and both sales', async () => {
    const refusal = await one<{ reason: string; bound_order_document_id: string; token_hash: Buffer; needs_server_link: boolean; device_id: string; shift_id: string; cashier_id: string }>(
      'SELECT reason, bound_order_document_id, token_hash, needs_server_link, device_id, shift_id, cashier_id FROM pos.receipt_token_refusal WHERE order_document_id = $1',
      [reused.id],
    );
    expect(refusal).toMatchObject({ reason: 'TOKEN_ALREADY_BOUND', bound_order_document_id: bound.sale.id, needs_server_link: true, device_id: id('device'), shift_id: shift.id, cashier_id: id('kwame') });
    expect(refusal.token_hash.equals(sha256(bound.token))).toBe(true);
    const raised = await refusalsRaised(reused.id);
    expect(raised).toHaveLength(1);
    expect(raised[0]!.payload).toMatchObject({
      exceptionKind: 'RECEIPT_TOKEN_REFUSED',
      severity: 'URGENT',
      saleId: reused.id,
      deviceId: id('device'),
      shiftId: shift.id,
      cashierId: id('kwame'),
      abuseCases: [37],
      fact: { reason: 'TOKEN_ALREADY_BOUND', saleId: reused.id, boundSale: { saleId: bound.sale.id, shiftId: shift.id, deviceId: id('device') }, needsServerLink: true, customerPhoneGiven: false },
    });
    expect(await writtenAnywhere(bound.token)).toEqual([]);
  });

  it('a replayed sync adds no second entry and no second refusal', async () => {
    const [again] = await sync([reused]);
    expect(again!.outcome).toBe('DUPLICATE');
    expect(await refusalsRaised(reused.id)).toHaveLength(1);
    expect((await one<{ n: number }>('SELECT count(*)::int AS n FROM pos.receipt_token_refusal WHERE order_document_id = $1', [reused.id])).n).toBe(1);
  });

  it('a third sale with the same token is refused too, once, against the sale that holds it', async () => {
    const third = crates(bound.token);
    const [result] = await sync([third]);
    expect(result!.exceptions.map((e) => e.kind)).toEqual(['RECEIPT_TOKEN_REFUSED']);
    expect((await one<{ bound_order_document_id: string }>('SELECT bound_order_document_id FROM pos.receipt_token_refusal WHERE order_document_id = $1', [third.id])).bound_order_document_id).toBe(bound.sale.id);
    expect(await refusalsRaised(third.id)).toHaveLength(1);
  });

  it('refuses a token that is the sale id itself, records the sale, and the id opens nothing', async () => {
    const idToken = nextId();
    const sale = crates(idToken, { id: idToken });
    const [result] = await sync([sale]);
    expect(result!.outcome).toBe('APPLIED_WITH_EXCEPTION');
    expect(result!.exceptions.map((e) => e.kind)).toEqual(['RECEIPT_TOKEN_REFUSED']);
    expect((await one<{ reason: string; bound_order_document_id: string | null }>('SELECT reason, bound_order_document_id FROM pos.receipt_token_refusal WHERE order_document_id = $1', [sale.id]))).toEqual({ reason: 'TOKEN_IS_AN_IDENTIFIER', bound_order_document_id: null });
    expect((await read(idToken)).status).toBe(404);
  });

  it('a sale refused for integrity binds nothing, and its evidence carries no token', async () => {
    const token = tillToken();
    const sale = { ...crates(token), payloadHash: '0'.repeat(64) };
    const [result] = await sync([sale]);
    expect(result!.outcome).toBe('REJECTED_INTEGRITY');
    expect((await rows('SELECT 1 FROM pos.receipt_link WHERE token_hash = $1', [sha256(token)])).length).toBe(0);
    expect((await read(token)).status).toBe(404);
    expect(await writtenAnywhere(token)).toEqual([]);
    const evidence = await one<{ payload: { submitted: Record<string, unknown> } }>("SELECT payload FROM platform.outbox_message WHERE event_type = 'pos.OfflineSaleRejected' AND payload->>'saleId' = $1", [sale.id]);
    expect(evidence.payload.submitted['receiptLinkSent']).toBe(true);
  });
});

describe('the database keeps the links', () => {
  it('refuses a second link of the same hash, a wrong expiry, a link for a sale not synced, and a refusal of a token the bound sale does not hold', async () => {
    const [link] = await rows<{ id: string; order_document_id: string; branch_id: string; shift_id: string; device_id: string; issued_at: Date; actor_id: string; token_hash: Buffer }>('SELECT * FROM pos.receipt_link ORDER BY recorded_at LIMIT 1');
    const insert = (over: Record<string, unknown>) => {
      const r = { id: randomUUID(), order_document_id: link!.order_document_id, token_hash: randomBytes(32), issued_at: link!.issued_at, months: '12 months', ...over };
      return admin().query(
        `INSERT INTO pos.receipt_link (id, order_document_id, branch_id, shift_id, device_id, source, token_hash, issued_at, expires_at, tenders, change_pesewas, recorded_at, actor_id)
         VALUES ($1, $2, $3, $4, $5, 'TILL', $6, $7, (($7::timestamptz AT TIME ZONE 'UTC') + $8::interval) AT TIME ZONE 'UTC', '[{"paymentMethodId":"x","amountPesewas":1,"tenderedPesewas":null,"unverified":false}]', 0, $7, $9)`,
        [r.id, r.order_document_id, link!.branch_id, link!.shift_id, link!.device_id, r.token_hash, r.issued_at, r.months, link!.actor_id],
      );
    };
    await expect(insert({ token_hash: link!.token_hash, order_document_id: (await one<{ id: string }>("SELECT order_document_id AS id FROM pos.receipt_token_refusal WHERE reason = 'TOKEN_ALREADY_BOUND' LIMIT 1")).id })).rejects.toMatchObject({ constraint: 'uq_receipt_link_token' });
    await expect(insert({})).rejects.toMatchObject({ constraint: 'uq_receipt_link_sale' });
    const refused = (await one<{ id: string }>("SELECT order_document_id AS id FROM pos.receipt_token_refusal WHERE reason = 'TOKEN_IS_AN_IDENTIFIER' LIMIT 1")).id;
    await expect(insert({ order_document_id: refused, months: '13 months' })).rejects.toMatchObject({ constraint: 'ck_receipt_link_expiry' });
    await expect(insert({ order_document_id: shift.id })).rejects.toMatchObject({ constraint: 'ck_receipt_link_synced' });
    await expect(
      admin().query(
        `INSERT INTO pos.receipt_token_refusal (order_document_id, token_hash, reason, bound_order_document_id, branch_id, shift_id, device_id, cashier_id, needs_server_link, recorded_at, actor_id)
         VALUES ($1, $2, 'TOKEN_ALREADY_BOUND', $3, $4, $5, $6, $7, true, $8, $7)`,
        [refused, randomBytes(32), link!.order_document_id, link!.branch_id, link!.shift_id, link!.device_id, id('kwame'), clock.now()],
      ),
    ).rejects.toMatchObject({ constraint: 'ck_receipt_token_refusal_bound' });
  });

  it('refuses update and delete on all three ledgers', async () => {
    for (const table of ['pos.receipt_link', 'pos.receipt_token_refusal']) {
      await expect(admin().query(`UPDATE ${table} SET recorded_at = recorded_at`)).rejects.toThrow();
      await expect(admin().query(`DELETE FROM ${table}`)).rejects.toThrow();
    }
  });
});

describe('a revoked or expired link reads nothing', () => {
  it('reads nothing once revoked', async () => {
    const token = tillToken();
    const sale = crates(token);
    await sync([sale]);
    expect((await read(token)).status).toBe(200);
    const link = await one<{ id: string }>('SELECT id FROM pos.receipt_link WHERE order_document_id = $1', [sale.id]);
    await admin().query('INSERT INTO pos.receipt_link_revocation (receipt_link_id, reason, revoked_at, recorded_at, actor_id) VALUES ($1, $2, $3, $3, $4)', [link.id, 'Sent to the wrong number', clock.now(), id('manager')]);
    expect((await read(token)).status).toBe(404);
    await expect(admin().query('UPDATE pos.receipt_link_revocation SET reason = reason')).rejects.toThrow();
    await expect(admin().query('DELETE FROM pos.receipt_link_revocation')).rejects.toThrow();
  });

  it('reads until twelve months after the sale and nothing a moment after', async () => {
    const token = tillToken();
    const sale = crates(token);
    await sync([sale]);
    const link = await one<{ expires_at: Date }>('SELECT expires_at FROM pos.receipt_link WHERE order_document_id = $1', [sale.id]);
    clock.set(new Date(link.expires_at.getTime() - 1));
    expect((await read(token)).status).toBe(200);
    clock.set(link.expires_at);
    expect((await read(token)).status).toBe(404);
  });
});

describe('the read is rate-limited per address', () => {
  it('answers 429 past the public limit', async () => {
    await admin().query(
      `INSERT INTO platform.setting (id, key, value, value_type, valid_from, description, created_by, updated_by)
       VALUES ($1, 'rate_limit.public.per_address_1m', '3', 'INTEGER', $2, 'test: a low public limit', $3, $3)`,
      [randomUUID(), new Date(clock.now().getTime() - MINUTE), id('kwame')],
    );
    clock.advanceBy(2 * MINUTE);
    const statuses: number[] = [];
    for (let i = 0; i < 5; i += 1) statuses.push((await read(tillToken())).status);
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
  });
});
