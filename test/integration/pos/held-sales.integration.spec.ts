import { randomUUID } from 'node:crypto';
import { createUuidV7Generator, ManualClock } from '@hakorem/kernel';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Approvals } from '../../../src/modules/iam';
import { runWithRequestContext, type Actor } from '../../../src/platform/context/request-context';
import { UnitOfWork } from '../../../src/platform/database/unit-of-work';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { stepUp, type TotpSession } from '../../support/fin';
import { consoleGet, consolePost, createUser, enrolAndLogin, login, relaxRateLimits, testStartTime, type TestSession, type TestUser } from '../../support/iam';
import { startTestApp, TEST_ORIGIN, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * Held sales (FR-POS-007, A-276): a sale parked on the till's open shift by its own cashier, from an enrolled device of
 * the till, reserving nothing; recalled once (404 the second time) on that shift by that cashier, re-priced after a price
 * change between hold and recall; lapsing at the shift's declaration and at its force close, held by the database too.
 * Every price is read by SQL from the price list entries in force, never from the code under test.
 */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let nextId: () => string;
const sessions = new Map<string, TestSession>();
const users = new Map<string, TestUser>();
const ids = new Map<string, string>();
const credentials = new Map<string, string>();
const id = (code: string) => ids.get(code)!;
const admin = () => database.pool('admin');
const as = (who: string) => sessions.get(who)!;
const idOf = (who: string) => users.get(who)!.principalId;
const post = (who: string, path: string, body: object = {}, key: string = randomUUID()) => consolePost(api.server, as(who), `/v1${path}`, key).send(body);
const get = (who: string, path: string) => consoleGet(api.server, as(who), `/v1${path}`);
const one = async <T>(sql: string, values: unknown[]): Promise<T> => (await admin().query(sql, values)).rows[0] as T;
const step = (who: string) => stepUp(api.server, as(who) as TotpSession, clock);
const actorOf = (who: string): Actor => ({ principalId: idOf(who), kind: 'USER', displayName: who, realm: 'STAFF', sessionId: null, steppedUpAt: clock.now() });

/** A hold sent as a till sends it, with the device's credential. */
function hold(who: string, till: string, body: Record<string, unknown>, device: string | null = till, key: string = randomUUID()) {
  const call = consolePost(api.server, as(who), `/v1/registers/${id(`till:${till}`)}/held-sales`, key);
  if (device !== null) call.set('X-Device-Credential', credentials.get(device) ?? device);
  return call.send({ id: nextId(), ...body });
}

/** A recall (DELETE) sent as a till sends it. */
function recall(who: string, heldSaleId: string, device: string | null, key: string = randomUUID()) {
  const call = request(api.server).delete(`/v1/held-sales/${heldSaleId}`).set('Cookie', as(who).jar.header()).set('X-CSRF-Token', as(who).csrfToken).set('Origin', TEST_ORIGIN).set('Idempotency-Key', key);
  if (device !== null) call.set('X-Device-Credential', credentials.get(device) ?? device);
  return call;
}

const yams = (n: number) => ({ productId: id('yam'), quantity: `${n}.000` });
const cabbages = (n: number) => ({ productId: id('cabbage'), quantity: `${n}.000` });

/** The list price of a product on a price list's version in force at `at`, read straight from the entries. */
async function listPrice(listCode: string, productId: string, at: Date): Promise<number> {
  const row = await one<{ n: string }>(
    `SELECT e.list_price_pesewas::text AS n FROM mdm.price_list_entry e JOIN mdm.price_list_version v ON v.id = e.version_id JOIN mdm.price_list l ON l.id = v.price_list_id
      WHERE l.code = $1 AND e.product_id = $2 AND v.status = 'ACTIVE' AND v.valid_from <= $3 AND (v.valid_to IS NULL OR v.valid_to > $3)
      ORDER BY v.valid_from DESC LIMIT 1`,
    [listCode, productId, at],
  );
  return Number(row.n);
}

async function heldRow(heldSaleId: string) {
  return one<{ status: string; lapse_reason: string | null; recalled_by: string | null; held_at: Date; expires_at: Date; held_gross_pesewas: string; shift_id: string }>(
    'SELECT status, lapse_reason, recalled_by, held_at, expires_at, held_gross_pesewas::text, shift_id FROM pos.held_sale WHERE id = $1',
    [heldSaleId],
  );
}

async function footprint(): Promise<Record<string, string>> {
  const counts: Record<string, string> = {};
  for (const table of ['pos.held_sale', 'inv.stock_reservation', 'inv.stock_movement', 'ord.sales_order', 'pay.payment']) counts[table] = (await one<{ n: string }>(`SELECT count(*)::text AS n FROM ${table}`, [])).n;
  return counts;
}

/** Runs SQL as the application role in a transaction that is always rolled back, and answers the constraint or code it broke. */
async function refusedAs(sql: string, values: unknown[]): Promise<string | undefined> {
  const client = await database.pool('app').connect();
  try {
    await client.query('BEGIN');
    await client.query(sql, values);
    return undefined;
  } catch (error) {
    const e = error as { constraint?: string; code?: string };
    return e.constraint ?? e.code;
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

async function openShift(who: string, till: string): Promise<string> {
  const shift = nextId();
  const opened = await post(who, '/shifts', { id: shift, registerId: id(`till:${till}`), openingFloatPesewas: 20_000, openedAt: clock.now().toISOString() }, shift);
  expect(opened.status, JSON.stringify(opened.body)).toBe(201);
  return shift;
}

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  nextId = createUuidV7Generator(clock);
  await relaxRateLimits(database);
  // The day runs for many hours on the test clock: sessions outlive it, as a shift's would with its refreshes.
  api = await startTestApp(database, { clock, environment: { AUTH_ACCESS_TTL_SECONDS: '172800' } });
  await runSeedUnits(database.pool('app'), api.app, seedUnits({ SEED_STAFF_PASSWORD: `Seed-${randomUUID()}` }));
  for (const row of (
    await admin().query<{ code: string; id: string }>(
      `SELECT 'branch' AS code, id FROM mdm.branch WHERE code = 'DDW'
       UNION ALL SELECT 'shop', l.id FROM mdm.location l JOIN mdm.branch b ON b.id = l.branch_id WHERE b.code = 'DDW' AND l.code = 'SHOP'
       UNION ALL SELECT 'yam', id FROM mdm.product WHERE sku = 'PRD-0005'
       UNION ALL SELECT 'cabbage', id FROM mdm.product WHERE sku = 'PRD-0002'
       UNION ALL SELECT 'goat', id FROM mdm.product WHERE sku = 'LIV-0004'
       UNION ALL SELECT code, id FROM mdm.payment_method`,
    )
  ).rows) {
    ids.set(row.code, row.id);
  }
  for (const [who, name, role, totp] of [
    ['owner', 'Kwabena Owusu', 'OWNER', true],
    ['manager', 'Akosua Boateng', 'MANAGER', true],
    ['kofi', 'Kofi Asante', 'CASHIER', false],
    ['ama', 'Ama Serwaa', 'CASHIER', false],
    ['storekeeper', 'Kwesi Ofori', 'STOREKEEPER', false],
    ['accountant', 'Yaw Agyeman', 'ACCOUNTANT', true],
  ] as const) {
    const user = await createUser(database, { name, grants: [{ role, branchId: id('branch'), ...(role === 'CASHIER' || role === 'STOREKEEPER' ? { locationId: id('shop') } : {}) }] });
    users.set(who, user);
    sessions.set(who, totp ? await enrolAndLogin(api.server, user, () => clock.now()) : await login(api.server, user));
  }
  for (const code of ['H1', 'H2', 'H3']) {
    const till = await post('manager', '/registers', { branchId: id('branch'), locationId: id('shop'), code, name: `Hold till ${code}` });
    expect(till.status, JSON.stringify(till.body)).toBe(201);
    ids.set(`till:${code}`, till.body.id as string);
    await step('manager');
    const enrolled = await post('manager', `/registers/${till.body.id as string}/devices`, { deviceLabel: `Hold tablet ${code}` });
    expect(enrolled.status, JSON.stringify(enrolled.body)).toBe(201);
    credentials.set(code, enrolled.body.deviceCredential as string);
  }
  ids.set('shift:kofi', await openShift('kofi', 'H1'));
  ids.set('shift:ama', await openShift('ama', 'H2'));

  // The counter's new yam price, 2,300 a tuber, from two hours on: a POS channel list, made by the manager, approved by the owner.
  const list = await post('manager', '/price-lists', { code: 'POS-HOLD-TEST', name: 'Counter prices from the afternoon (test)', kind: 'CHANNEL', channel: 'POS', taxInclusive: true });
  expect(list.status, JSON.stringify(list.body)).toBe(201);
  ids.set('afternoon', new Date(clock.now().getTime() + 2 * 3_600_000).toISOString());
  const version = await post('manager', `/price-lists/${list.body.id as string}/versions`, { validFrom: id('afternoon') });
  expect(version.status, JSON.stringify(version.body)).toBe(201);
  const put = await request(api.server)
    .put(`/v1/price-list-versions/${version.body.id as string}/entries`)
    .set('Cookie', as('manager').jar.header())
    .set('X-CSRF-Token', as('manager').csrfToken)
    .set('Origin', TEST_ORIGIN)
    .set('Idempotency-Key', randomUUID())
    .send({ version: 1, entries: [{ productId: id('yam'), basis: 'PER_UNIT', listPricePesewas: 2_300, floorPricePesewas: 1_800, ceilingPricePesewas: 2_800 }] });
  expect(put.status, JSON.stringify(put.body)).toBe(200);
  const submitted = await post('manager', `/price-list-versions/${version.body.id as string}/submit`, {});
  expect(submitted.status, JSON.stringify(submitted.body)).toBe(202);
  await runWithRequestContext({ correlationId: randomUUID(), ip: '127.0.0.1', userAgent: 'held sales', actor: actorOf('owner') }, () =>
    api.app.get(UnitOfWork).run({ isolation: 'serializable' }, (tx) => api.app.get(Approvals).decide(tx, actorOf('owner'), submitted.body.approvalRequestId as string, 'APPROVED', null)),
  );
});

afterAll(async () => {
  await api?.close();
  await database?.drop();
});

describe('holding a sale on the till open shift (holdSale, FR-POS-007)', () => {
  it('holds 3 yams and 2 cabbages, priced now at exactly 3 x 2,000 + 2 x 1,000 = 8,000, and reserves nothing', async () => {
    const yam = await listPrice('BASE', id('yam'), clock.now());
    const cabbage = await listPrice('BASE', id('cabbage'), clock.now());
    expect([yam, cabbage]).toEqual([2_000, 1_000]);
    const before = await footprint();
    const held = await hold('kofi', 'H1', { label: 'Auntie Akua, gone for more cash', payload: { lines: [yams(3), cabbages(2)] } });
    expect(held.status, JSON.stringify(held.body)).toBe(201);
    ids.set('held:first', held.body.id as string);
    expect(held.body).toMatchObject({
      registerId: id('till:H1'),
      shiftId: id('shift:kofi'),
      heldBy: { id: idOf('kofi'), displayName: 'Kofi Asante' },
      label: 'Auntie Akua, gone for more cash',
      payload: { lines: [yams(3), cabbages(2)] },
      status: 'HELD',
      heldTotalPesewas: 3 * yam + 2 * cabbage,
      currency: 'GHS',
    });
    expect(held.body.heldTotalPesewas).toBe(8_000);
    expect(held.body.pricing.lines.map((l: { listUnitPricePesewas: number; lineTotalPesewas: number }) => [l.listUnitPricePesewas, l.lineTotalPesewas])).toEqual([
      [yam, 3 * yam],
      [cabbage, 2 * cabbage],
    ]);
    expect(held.body.pricing.totalPesewas).toBe(8_000);
    const row = await heldRow(held.body.id as string);
    expect(row).toMatchObject({ status: 'HELD', held_gross_pesewas: '8000', shift_id: id('shift:kofi') });
    expect(row.expires_at.getTime() - row.held_at.getTime()).toBe(12 * 3_600_000);
    // It reserves nothing and moves nothing: the only new row is the hold itself.
    expect(await footprint()).toEqual({ ...before, 'pos.held_sale': String(Number(before['pos.held_sale']) + 1) });
    const audit = await one<{ n: string }>("SELECT count(*)::text AS n FROM platform.audit_event WHERE entity_type = 'HeldSale' AND entity_id = $1 AND action = 'HOLD_SALE' AND actor_id = $2", [held.body.id, idOf('kofi')]);
    expect(audit.n).toBe('1');
  });

  it('answers a replay of the same key with the first hold and holds nothing more', async () => {
    const key = randomUUID();
    const body = { id: nextId(), payload: { lines: [cabbages(1)] } };
    const first = await hold('kofi', 'H1', body, 'H1', key);
    expect(first.status).toBe(201);
    const count = (await footprint())['pos.held_sale'];
    const again = await hold('kofi', 'H1', body, 'H1', key);
    expect(again.status).toBe(201);
    expect(again.body).toEqual(first.body);
    expect((await footprint())['pos.held_sale']).toBe(count);
    ids.set('held:cabbage', body.id);
  });

  it('refuses the wrong role, another cashier, a manager, another till device, no device and a till with no open shift, holding nothing', async () => {
    const before = await footprint();
    for (const who of ['storekeeper', 'accountant']) expect((await hold(who, 'H1', { payload: { lines: [yams(1)] } })).status, who).toBe(403);
    // Nobody sells on another cashier's shift, a manager included (ADR-0077).
    for (const who of ['ama', 'manager']) {
      const refused = await hold(who, 'H1', { payload: { lines: [yams(1)] } });
      expect(refused.status, who).toBe(403);
    }
    expect((await hold('kofi', 'H1', { payload: { lines: [yams(1)] } }, 'H2')).status).toBe(403);
    const noDevice = await hold('kofi', 'H1', { payload: { lines: [yams(1)] } }, null);
    expect(noDevice.status).toBe(401);
    expect(noDevice.body.error.code).toBe('DEVICE_CREDENTIAL_INVALID');
    const noShift = await hold('kofi', 'H3', { payload: { lines: [yams(1)] } });
    expect(noShift.status, JSON.stringify(noShift.body)).toBe(422);
    expect(noShift.body.error.code).toBe('SHIFT_NOT_OPEN');
    expect(await footprint()).toEqual(before);
  });

  it('refuses a line with no price to sell at, a weight without its source, a non-v7 id and an unknown field', async () => {
    const before = await footprint();
    const unpriced = await hold('kofi', 'H1', { payload: { lines: [{ productId: id('goat'), quantity: '1.000' }] } });
    expect(unpriced.status, JSON.stringify(unpriced.body)).toBe(422);
    expect(unpriced.body.error).toMatchObject({ code: 'HELD_SALE_INVALID', details: [{ field: '/payload/lines/0', code: 'QUOTE_REQUIRED' }] });
    const sourceless = await hold('kofi', 'H1', { payload: { lines: [{ ...yams(1), weightKg: '1.200' }] } });
    expect(sourceless.body.error).toMatchObject({ code: 'HELD_SALE_INVALID', details: [{ field: '/payload/lines/0/weightSource', code: 'WEIGHT_SOURCE_REQUIRED' }] });
    const v4 = await hold('kofi', 'H1', { id: randomUUID(), payload: { lines: [yams(1)] } });
    expect(v4.body.error).toMatchObject({ code: 'HELD_SALE_INVALID', details: [{ field: '/id', code: 'ID_NOT_UUID_V7' }] });
    expect((await hold('kofi', 'H1', { payload: { lines: [{ ...yams(1), agreedUnitPricePesewas: 1 }] } })).status).toBe(400);
    expect(await footprint()).toEqual(before);
  });

  it('lists the till holds, newest first, without pricing them, to anyone who sells there, and to no other role', async () => {
    const listed = await get('ama', `/registers/${id('till:H1')}/held-sales`);
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    expect(listed.body.data.map((h: { id: string }) => h.id)).toEqual([id('held:cabbage'), id('held:first')]);
    expect(listed.body.data[1]).toMatchObject({ heldTotalPesewas: 8_000, pricing: null, status: 'HELD' });
    expect((await get('storekeeper', `/registers/${id('till:H1')}/held-sales`)).status).toBe(403);
    expect((await get('kofi', `/registers/${randomUUID()}/held-sales`)).status).toBe(404);
  });
});

describe('recalling a held sale (recallHeldSale, FR-POS-007)', () => {
  it('refuses another cashier and a manager on Kofi shift, recalling nothing', async () => {
    for (const who of ['ama', 'manager']) expect((await recall(who, id('held:first'), 'H1')).status, who).toBe(403);
    expect((await recall('storekeeper', id('held:first'), 'H1')).status).toBe(403);
    expect((await recall('kofi', id('held:first'), 'H2')).status).toBe(403);
    expect((await heldRow(id('held:first'))).status).toBe('HELD');
  });

  it('re-prices it after the price changed between hold and recall: 3 x 2,300 + 2 x 1,000 = 8,900, against 8,000 when held', async () => {
    clock.set(new Date(new Date(id('afternoon')).getTime() + 60_000));
    const yam = await listPrice('POS-HOLD-TEST', id('yam'), clock.now());
    const cabbage = await listPrice('BASE', id('cabbage'), clock.now());
    expect([yam, cabbage]).toEqual([2_300, 1_000]);
    const key = randomUUID();
    const recalled = await recall('kofi', id('held:first'), 'H1', key);
    expect(recalled.status, JSON.stringify(recalled.body)).toBe(200);
    expect(recalled.body).toMatchObject({ id: id('held:first'), status: 'RECALLED', heldTotalPesewas: 8_000, payload: { lines: [yams(3), cabbages(2)] } });
    expect(recalled.body.pricing.lines.map((l: { listUnitPricePesewas: number; lineTotalPesewas: number }) => [l.listUnitPricePesewas, l.lineTotalPesewas])).toEqual([
      [yam, 3 * yam],
      [cabbage, 2 * cabbage],
    ]);
    expect(recalled.body.pricing.totalPesewas).toBe(3 * yam + 2 * cabbage);
    expect(recalled.body.pricing.totalPesewas).toBe(8_900);
    expect(await heldRow(id('held:first'))).toMatchObject({ status: 'RECALLED', recalled_by: idOf('kofi') });
    ids.set('recall:key', key);
    ids.set('recall:body', JSON.stringify(recalled.body));
  });

  it('is recalled once: the same key answers the first recall, a new one is 404, and the list no longer shows it', async () => {
    const replay = await recall('kofi', id('held:first'), 'H1', id('recall:key'));
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(JSON.parse(id('recall:body')));
    const second = await recall('kofi', id('held:first'), 'H1');
    expect(second.status).toBe(404);
    expect(second.body.error.code).toBe('NOT_FOUND');
    const unknown = await recall('kofi', nextId(), 'H1');
    expect(unknown.status).toBe(404);
    expect(Object.keys(second.body)).toEqual(Object.keys(unknown.body));
    const listed = await get('kofi', `/registers/${id('till:H1')}/held-sales`);
    expect(listed.body.data.map((h: { id: string }) => h.id)).toEqual([id('held:cabbage')]);
  });

  it('completes the recalled sale at the counter at the new price: a receipt of exactly 8,900, paid 8,900 in cash', async () => {
    const saleId = nextId();
    const sold = await consolePost(api.server, as('kofi'), '/v1/pos/sales', saleId)
      .set('X-Device-Credential', credentials.get('H1')!)
      .send({
        id: saleId,
        shiftId: id('shift:kofi'),
        occurredAt: clock.now().toISOString(),
        lines: [
          { ...yams(3), agreedUnitPricePesewas: 2_300 },
          { ...cabbages(2), agreedUnitPricePesewas: 1_000 },
        ],
        tenders: [{ paymentMethodId: id('CASH'), amountPesewas: 8_900 }],
      });
    expect(sold.status, JSON.stringify(sold.body)).toBe(201);
    const gross = await one<{ n: string }>("SELECT gross_pesewas::text AS n FROM bil.billing_document WHERE order_document_id = $1 AND kind = 'RECEIPT'", [saleId]);
    const paid = await one<{ n: string }>("SELECT sum(amount_pesewas)::text AS n FROM pay.payment WHERE order_document_id = $1 AND status = 'CLEARED'", [saleId]);
    expect([gross.n, paid.n]).toEqual(['8900', '8900']);
  });

  it('lapses twelve hours after it was held even while the shift stays open', async () => {
    const held = await hold('kofi', 'H1', { payload: { lines: [yams(1)] } });
    expect(held.status).toBe(201);
    clock.advanceBy(12 * 3_600_000);
    expect((await recall('kofi', held.body.id as string, 'H1')).status).toBe(404);
    expect((await get('kofi', `/registers/${id('till:H1')}/held-sales`)).body.data.map((h: { id: string }) => h.id)).not.toContain(held.body.id);
    ids.set('held:expired', held.body.id as string);
  });
});

describe('a held sale lapses with its shift (A-276 (b))', () => {
  it('lapses every hold still on the shift when the cashier declares the count, and recalls none afterwards', async () => {
    const held = await hold('kofi', 'H1', { payload: { lines: [yams(2)] } });
    expect(held.status).toBe(201);
    const declared = await post('kofi', `/shifts/${id('shift:kofi')}/close`, { declared: [{ paymentMethodId: id('CASH'), declaredPesewas: 28_900 }] });
    expect(declared.status, JSON.stringify(declared.body)).toBe(200);
    for (const heldSaleId of [held.body.id as string, id('held:cabbage'), id('held:expired')]) {
      expect(await heldRow(heldSaleId), heldSaleId).toMatchObject({ status: 'LAPSED', lapse_reason: 'SHIFT_CLOSED' });
    }
    expect((await heldRow(id('held:first'))).status).toBe('RECALLED');
    expect((await recall('kofi', held.body.id as string, 'H1')).status).toBe(404);
    expect((await get('kofi', `/registers/${id('till:H1')}/held-sales`)).body.data).toEqual([]);
    const lapsed = await one<{ n: string }>("SELECT count(*)::text AS n FROM platform.audit_event WHERE entity_type = 'HeldSale' AND action = 'LAPSE_HELD_SALE' AND entity_id = $1", [held.body.id]);
    expect(lapsed.n).toBe('1');
  });

  it('lapses every hold on a shift a manager force-closes, and recalls none afterwards', async () => {
    const held = await hold('ama', 'H2', { label: 'Mr Boakye', payload: { lines: [yams(4), cabbages(1)] } });
    expect(held.status, JSON.stringify(held.body)).toBe(201);
    expect(held.body.heldTotalPesewas).toBe(4 * (await listPrice('POS-HOLD-TEST', id('yam'), clock.now())) + (await listPrice('BASE', id('cabbage'), clock.now())));
    await step('manager');
    const forced = await post('manager', `/shifts/${id('shift:ama')}/force-close`, { reason: 'Till 2 tablet died; Ama has gone home' });
    expect(forced.status, JSON.stringify(forced.body)).toBe(200);
    expect(await heldRow(held.body.id as string)).toMatchObject({ status: 'LAPSED', lapse_reason: 'SHIFT_FORCE_CLOSED' });
    expect((await recall('ama', held.body.id as string, 'H2')).status).toBe(404);
    expect((await get('ama', `/registers/${id('till:H2')}/held-sales`)).body.data).toEqual([]);
  });
});

describe('the database holds the held sale rules (pos.held_sale_guard, trg_shift_held_sales_lapsed)', () => {
  let shift: string;
  let live: string;

  beforeAll(async () => {
    shift = await openShift('ama', 'H3');
    const held = await hold('ama', 'H3', { payload: { lines: [yams(1)] } });
    expect(held.status, JSON.stringify(held.body)).toBe(201);
    live = held.body.id as string;
  });

  const insert = (shiftId: string, register: string, heldBy: string) =>
    refusedAs(
      `INSERT INTO pos.held_sale (id, register_id, shift_id, branch_id, held_by, payload, held_gross_pesewas, held_at, expires_at, status)
       VALUES ($1, $2, $3, $4, $5, '{"lines": []}', 0, $6, $6::timestamptz + interval '1 hour', 'HELD')`,
      [randomUUID(), register, shiftId, id('branch'), heldBy, clock.now()],
    );

  it('refuses a hold on a closed shift, on another till and by anyone but the shift cashier', async () => {
    expect(await insert(id('shift:kofi'), id('till:H1'), idOf('kofi'))).toBe('ck_held_sale_open_shift');
    expect(await insert(shift, id('till:H1'), idOf('ama'))).toBe('ck_held_sale_open_shift');
    expect(await insert(shift, id('till:H3'), idOf('kofi'))).toBe('ck_held_sale_open_shift');
  });

  it('refuses a change to what was held, a recall by another, any change to a recalled or lapsed hold, and deleting a live one', async () => {
    expect(await refusedAs(`UPDATE pos.held_sale SET payload = '{"lines": [1]}' WHERE id = $1`, [live])).toBe('HK004');
    expect(await refusedAs("UPDATE pos.held_sale SET status = 'RECALLED', recalled_at = $2, recalled_by = $3 WHERE id = $1", [live, clock.now(), idOf('kofi')])).toBe('ck_held_sale_recall');
    expect(await refusedAs("UPDATE pos.held_sale SET status = 'HELD', recalled_at = NULL, recalled_by = NULL WHERE id = $1", [id('held:first')])).toBe('HK004');
    expect(await refusedAs("UPDATE pos.held_sale SET status = 'HELD', lapsed_at = NULL, lapse_reason = NULL WHERE id = $1", [id('held:cabbage')])).toBe('HK004');
    // Work that may be purged once recalled or lapsed; a live hold is never deleted.
    expect(await refusedAs('DELETE FROM pos.held_sale WHERE id = $1', [live])).toBe('HK004');
    expect(await refusedAs('DELETE FROM pos.held_sale WHERE id = $1', [id('held:first')])).toBeUndefined();
  });

  it('refuses a shift leaving OPEN while a sale is still held on it', async () => {
    const at = clock.now();
    expect(
      await refusedAs("UPDATE pos.shift SET version = version + 1, status = 'CLOSING', declared_at = $2, declared_cash_pesewas = 20000, updated_at = $2, updated_by = $3 WHERE id = $1", [shift, at, idOf('ama')]),
    ).toBe('ck_shift_held_sales_lapsed');
    expect((await heldRow(live)).status).toBe('HELD');
  });
});
