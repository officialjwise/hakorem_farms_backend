import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createUuidV7Generator, ManualClock } from '@hakorem/kernel';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { stepUp, type TotpSession } from '../../support/fin';
import { consolePost, createUser, enrolAndLogin, login, relaxRateLimits, testStartTime, type TestSession } from '../../support/iam';
import { startTestApp, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * The receipt link of a live counter sale (BL-133, the owner, 2026-11-24, A-396; ADR-0083 Amendments, A-398). The till
 * makes the token as it does offline and sends it with `completeCounterSale` as `CounterSale.receiptToken`; the server
 * keeps only its hash, in the sale's own transaction, through the store the synced sale uses, one TILL link per sale. A
 * token refused (already bound, or shaped like an identifier) never refuses the sale: the sale completes with no link,
 * the refusal is recorded once and reaches the exception report's source. A token not of the till's form is refused by
 * validation, as `OfflineSale.receiptToken` is. Without the token the sale is exactly as before. Every figure by SQL.
 */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let nextId: () => string;
const sessions = new Map<string, TestSession>();
const ids = new Map<string, string>();
const id = (code: string) => ids.get(code)!;
let credential = '';
let shiftId = '';
const admin = () => database.pool('admin');
const as = (who: string) => sessions.get(who)!;
const post = (who: string, path: string, body: object = {}, key: string = randomUUID()) => consolePost(api.server, as(who), `/v1${path}`, key).send(body);
const rows = async <T>(sql: string, values: unknown[] = []): Promise<T[]> => (await admin().query(sql, values)).rows as T[];
const one = async <T>(sql: string, values: unknown[] = []): Promise<T> => (await rows<T>(sql, values))[0]!;
const count = async (sql: string, values: unknown[] = []) => Number((await one<{ n: string }>(sql, values)).n);
const read = (token: string) => request(api.server).get(`/v1/shop/receipts/${encodeURIComponent(token)}`);
const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest();
const tillToken = () => randomBytes(16).toString('base64url');
const MINUTE = 60_000;

/** A crate of eggs at 6,000 sold live, cash with 10,000 handed over; the same key replays it. */
function live(extra: object = {}) {
  const saleId = nextId();
  clock.advanceBy(MINUTE);
  const body = {
    id: saleId,
    shiftId,
    occurredAt: clock.now().toISOString(),
    lines: [{ productId: id('EGG-0003'), quantity: '1.000', uom: 'CRATE', agreedUnitPricePesewas: 6_000 }],
    tenders: [{ paymentMethodId: id('CASH'), amountPesewas: 6_000, tenderedPesewas: 10_000 }],
    ...extra,
  };
  const send = () => consolePost(api.server, as('kwame'), '/v1/pos/sales', saleId).set('X-Device-Credential', credential).send(body);
  return { saleId, send };
}

/** The token's text written anywhere: the links, idempotency answers, audit, outbox, the orders. */
async function writtenAnywhere(token: string): Promise<string[]> {
  const found = await rows<{ place: string }>(
    `SELECT 'pos.receipt_link' AS place FROM pos.receipt_link l WHERE row_to_json(l)::text LIKE '%' || $1 || '%'
     UNION ALL SELECT 'pos.receipt_token_refusal' FROM pos.receipt_token_refusal r WHERE row_to_json(r)::text LIKE '%' || $1 || '%'
     UNION ALL SELECT 'platform.idempotency_key' FROM platform.idempotency_key WHERE coalesce(response_body::text, '') LIKE '%' || $1 || '%'
     UNION ALL SELECT 'platform.audit_event' FROM platform.audit_event WHERE (coalesce(before::text, '') || coalesce(after::text, '') || coalesce(metadata::text, '')) LIKE '%' || $1 || '%'
     UNION ALL SELECT 'platform.outbox_message' FROM platform.outbox_message WHERE payload::text LIKE '%' || $1 || '%'
     UNION ALL SELECT 'ord.sales_order' FROM ord.sales_order o WHERE row_to_json(o)::text LIKE '%' || $1 || '%'`,
    [token],
  );
  return found.map((r) => r.place);
}

const flagsOf = (saleId: string) =>
  rows<{ payload: Record<string, unknown> }>("SELECT payload FROM platform.outbox_message WHERE event_type = 'pos.CounterSaleFlagged' AND subject_id = $1", [saleId]);

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
  await stepUp(api.server, as('manager') as TotpSession, clock);
  const enrolled = await post('manager', `/registers/${till.body.id as string}/devices`, { deviceLabel: 'Shop floor tablet' });
  expect(enrolled.status, JSON.stringify(enrolled.body)).toBe(201);
  credential = enrolled.body.deviceCredential as string;
  ids.set('device', enrolled.body.device.id as string);
  clock.advanceBy(10 * MINUTE);
  shiftId = nextId();
  const opened = await post('kwame', '/shifts', { id: shiftId, registerId: till.body.id as string, openingFloatPesewas: 0, openedAt: clock.now().toISOString() }, shiftId);
  expect(opened.status, JSON.stringify(opened.body)).toBe(201);
});

afterAll(async () => {
  await api?.close();
  await database?.drop();
});

describe("a live sale's till makes its receipt link (BL-133, ADR-0083 Amendments)", () => {
  const first = { token: '', saleId: '', receiptNo: '', orderNo: '' };

  it('binds the token to the sale in its own transaction, keeping only the hash, and the link reads at once', async () => {
    first.token = tillToken();
    const sale = live({ customerPhone: '+233244000101', receiptToken: first.token });
    const sold = await sale.send();
    expect(sold.status, JSON.stringify(sold.body)).toBe(201);
    first.saleId = sale.saleId;
    first.receiptNo = sold.body.receipt.documentNo as string;
    first.orderNo = sold.body.order.orderNo as string;
    expect(sold.body.changeDuePesewas).toBe(4_000);
    const link = await one<{ n: string; source: string; shift: string; device: string; hash: Buffer; issued: Date; recorded: Date; actor: string; change: string; tenders: unknown[] }>(
      `SELECT count(*) OVER () AS n, source, shift_id AS shift, device_id AS device, token_hash AS hash, issued_at AS issued, recorded_at AS recorded, actor_id AS actor,
              change_pesewas::text AS change, tenders
         FROM pos.receipt_link WHERE order_document_id = $1`,
      [sale.saleId],
    );
    expect(link).toMatchObject({ n: '1', source: 'TILL', shift: shiftId, device: id('device'), actor: id('kwame'), change: '4000' });
    expect(link.hash).toEqual(sha256(first.token));
    // Posted at the server's time, the link reads for twelve months from it.
    expect(link.issued).toEqual(link.recorded);
    expect(link.tenders).toEqual([{ paymentMethodId: id('CASH'), amountPesewas: 6_000, tenderedPesewas: 10_000, unverified: false }]);
    const answer = await read(first.token);
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    expect(answer.body).toMatchObject({ state: 'RECORDED', saleReference: first.orderNo, receiptNo: first.receiptNo, totalPesewas: 6_000, changePesewas: 4_000 });
    expect(await writtenAnywhere(first.token)).toEqual([]);
    expect(await flagsOf(sale.saleId)).toEqual([]);
  });

  it('a replay of the same key answers the first sale and makes no second link', async () => {
    const token = tillToken();
    const sale = live({ receiptToken: token });
    const sold = await sale.send();
    expect(sold.status, JSON.stringify(sold.body)).toBe(201);
    const again = await sale.send();
    expect([again.status, again.body.order.id, again.body.receipt.documentNo]).toEqual([201, sold.body.order.id, sold.body.receipt.documentNo]);
    expect(await count('SELECT count(*) AS n FROM pos.receipt_link WHERE order_document_id = $1', [sale.saleId])).toBe(1);
    expect(await count('SELECT count(*) AS n FROM pos.receipt_link WHERE token_hash = $1', [sha256(token)])).toBe(1);
  });

  it("a token already bound to another sale never refuses the sale: no link, the refusal recorded once and raised URGENT", async () => {
    const sale = live({ customerPhone: '+233244000101', receiptToken: first.token });
    const sold = await sale.send();
    expect(sold.status, JSON.stringify(sold.body)).toBe(201);
    expect(sold.body.order.id).toBe(sale.saleId);
    expect(await count('SELECT count(*) AS n FROM pos.receipt_link WHERE order_document_id = $1', [sale.saleId])).toBe(0);
    expect(
      await rows('SELECT reason, bound_order_document_id AS bound, shift_id AS shift, device_id AS device, cashier_id AS cashier, needs_server_link AS "needsLink" FROM pos.receipt_token_refusal WHERE order_document_id = $1', [sale.saleId]),
    ).toEqual([{ reason: 'TOKEN_ALREADY_BOUND', bound: first.saleId, shift: shiftId, device: id('device'), cashier: id('kwame'), needsLink: true }]);
    // The token still opens only the first sale's receipt.
    expect((await read(first.token)).body.receiptNo).toBe(first.receiptNo);
    const [flag, ...more] = await flagsOf(sale.saleId);
    expect(more).toEqual([]);
    expect(flag!.payload).toMatchObject({
      saleId: sale.saleId,
      shiftId,
      branchId: id('branch'),
      deviceId: id('device'),
      cashierId: id('kwame'),
      exceptionKind: 'RECEIPT_TOKEN_REFUSED',
      severity: 'URGENT',
      amountPesewas: 6_000,
      fact: { reason: 'TOKEN_ALREADY_BOUND', saleId: sale.saleId, boundSale: { saleId: first.saleId, shiftId, deviceId: id('device') }, needsServerLink: true, customerPhoneGiven: true },
      abuseCases: [37],
    });
    // Its replay records nothing more.
    expect((await sale.send()).status).toBe(201);
    expect(await count('SELECT count(*) AS n FROM pos.receipt_token_refusal WHERE order_document_id = $1', [sale.saleId])).toBe(1);
    expect(await flagsOf(sale.saleId)).toHaveLength(1);
    expect(await writtenAnywhere(first.token)).toEqual([]);
  });

  it('a token shaped like an identifier is refused as TOKEN_IS_AN_IDENTIFIER and opens nothing; the sale completes', async () => {
    const shaped = randomUUID();
    const sale = live({ receiptToken: shaped });
    const sold = await sale.send();
    expect(sold.status, JSON.stringify(sold.body)).toBe(201);
    expect(await rows('SELECT reason, bound_order_document_id AS bound FROM pos.receipt_token_refusal WHERE order_document_id = $1', [sale.saleId])).toEqual([{ reason: 'TOKEN_IS_AN_IDENTIFIER', bound: null }]);
    expect(await count('SELECT count(*) AS n FROM pos.receipt_link WHERE order_document_id = $1', [sale.saleId])).toBe(0);
    expect((await read(shaped)).status).toBe(404);
    expect((await flagsOf(sale.saleId)).map((f) => (f.payload['fact'] as { reason: string }).reason)).toEqual(['TOKEN_IS_AN_IDENTIFIER']);
  });

  it("a token not of the till's form is refused by validation, as OfflineSale.receiptToken is, and nothing is posted", async () => {
    const sale = live({ receiptToken: 'too-short' });
    const refused = await sale.send();
    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe('VALIDATION_FAILED');
    expect(await count('SELECT count(*) AS n FROM ord.sales_order WHERE id = $1', [sale.saleId])).toBe(0);
  });

  it('without a token the sale is as before: no link, no refusal, nothing raised', async () => {
    const sale = live({ customerPhone: '+233244000101' });
    const sold = await sale.send();
    expect(sold.status, JSON.stringify(sold.body)).toBe(201);
    expect(Object.keys(sold.body).sort()).toEqual(['changeDuePesewas', 'currency', 'escPosBase64', 'order', 'receipt']);
    expect(await count('SELECT count(*) AS n FROM pos.receipt_link WHERE order_document_id = $1', [sale.saleId])).toBe(0);
    expect(await count('SELECT count(*) AS n FROM pos.receipt_token_refusal WHERE order_document_id = $1', [sale.saleId])).toBe(0);
    expect(await flagsOf(sale.saleId)).toEqual([]);
  });
});

describe("the database admits a live sale's own link and nothing else (ck_receipt_link_synced, ck_receipt_token_refusal_synced, migration 0377)", () => {
  it("refuses a live sale's link written by anyone but the shift's cashier, at another time than recorded, for the shift itself, or once its shift is closing", async () => {
    const sale = live();
    expect((await sale.send()).status).toBe(201);
    const insert = (over: Record<string, unknown>) => {
      const at = clock.now();
      const r = { order: sale.saleId, shift: shiftId, issued: at, recorded: at, actor: id('kwame'), ...over };
      return admin().query(
        `INSERT INTO pos.receipt_link (id, order_document_id, branch_id, shift_id, device_id, source, token_hash, issued_at, expires_at, tenders, change_pesewas, recorded_at, actor_id)
         VALUES ($1, $2, $3, $4, $5, 'TILL', $6, $7, (($7::timestamptz AT TIME ZONE 'UTC') + interval '12 months') AT TIME ZONE 'UTC', '[{"paymentMethodId":"x","amountPesewas":1,"tenderedPesewas":null,"unverified":false}]', 0, $8, $9)`,
        [randomUUID(), r.order, id('branch'), r.shift, id('device'), randomBytes(32), r.issued, r.recorded, r.actor],
      );
    };
    const refusal = (over: Record<string, unknown>) => {
      const r = { order: sale.saleId, actor: id('kwame'), ...over };
      return admin().query(
        `INSERT INTO pos.receipt_token_refusal (order_document_id, token_hash, reason, bound_order_document_id, branch_id, shift_id, device_id, cashier_id, needs_server_link, recorded_at, actor_id)
         VALUES ($1, $2, 'TOKEN_IS_AN_IDENTIFIER', NULL, $3, $4, $5, $6, true, $7, $8)`,
        [r.order, randomBytes(32), id('branch'), shiftId, id('device'), id('kwame'), clock.now(), r.actor],
      );
    };
    await expect(insert({ actor: id('manager') })).rejects.toMatchObject({ constraint: 'ck_receipt_link_synced' });
    await expect(insert({ issued: new Date(clock.now().getTime() - MINUTE) })).rejects.toMatchObject({ constraint: 'ck_receipt_link_synced' });
    await expect(insert({ order: shiftId })).rejects.toMatchObject({ constraint: 'ck_receipt_link_synced' });
    await expect(refusal({ actor: id('manager') })).rejects.toMatchObject({ constraint: 'ck_receipt_token_refusal_synced' });
    await expect(refusal({ order: shiftId })).rejects.toMatchObject({ constraint: 'ck_receipt_token_refusal_synced' });
    // Once the shift stops taking entries (closing), nothing links a sale on it.
    const client = await admin().connect();
    try {
      await client.query('BEGIN');
      // Closed by hand inside a transaction rolled back below: the shift's own close rules are not this test's.
      await client.query('ALTER TABLE pos.shift DISABLE TRIGGER USER');
      await client.query("UPDATE pos.shift SET status = 'CLOSING', declared_at = $2, declared_cash_pesewas = 6000 WHERE id = $1", [shiftId, clock.now()]);
      await client.query('ALTER TABLE pos.shift ENABLE TRIGGER USER');
      const at = clock.now();
      await expect(
        client.query(
          `INSERT INTO pos.receipt_link (id, order_document_id, branch_id, shift_id, device_id, source, token_hash, issued_at, expires_at, tenders, change_pesewas, recorded_at, actor_id)
           VALUES ($1, $2, $3, $4, $5, 'TILL', $6, $7, (($7::timestamptz AT TIME ZONE 'UTC') + interval '12 months') AT TIME ZONE 'UTC', '[{"paymentMethodId":"x","amountPesewas":1,"tenderedPesewas":null,"unverified":false}]', 0, $7, $8)`,
          [randomUUID(), sale.saleId, id('branch'), shiftId, id('device'), randomBytes(32), at, id('kwame')],
        ),
      ).rejects.toMatchObject({ constraint: 'ck_receipt_link_synced' });
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
    // The sale's own link, written as the till's sale writes it, is admitted.
    await insert({});
    expect(await count('SELECT count(*) AS n FROM pos.receipt_link WHERE order_document_id = $1', [sale.saleId])).toBe(1);
  });
});
