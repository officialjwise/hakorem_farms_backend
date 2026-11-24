import { randomUUID } from 'node:crypto';
import { ManualClock } from '@hakorem/kernel';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { stepUp, type TotpSession } from '../../support/fin';
import { consolePost, createUser, enrolAndLogin, login, relaxRateLimits, testStartTime, type RoleCode, type TestSession } from '../../support/iam';
import { SQLSTATE, sqlStateOf } from '../../support/sql-state';
import { startTestApp, TEST_ORIGIN, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * Eggs found broken while picking (CR-054 point 1, FR-ORD-009, A-370), over the seeded farm: a guest's order of crates of
 * big eggs EGG-0003 picked at the shop. Five single eggs found cracked beside the crate picked are written off from the
 * shop in the pick's own transaction through INV's stock adjustment: under the STOCK_WRITE_OFF threshold it posts at
 * once (the shop holds exactly five eggs fewer, the crate picked moves nothing, ADR-0091); with the threshold at nil it
 * waits for a different person, and nothing moves until the Manager approves. Every refusal writes nothing.
 */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let branchId: string;
let baseUom: string;
const ids = new Map<string, string>();
const id = (name: string) => ids.get(name)!;
const sessions = new Map<string, TestSession>();
const as = (name: string) => sessions.get(name)!;
const admin = () => database.pool('admin');
const post = (who: string, path: string, body: object, key = randomUUID()) => consolePost(api.server, as(who), `/v1${path}`, key).send(body);
const one = async <T extends object>(sql: string, params: unknown[] = []) => (await admin().query<T & Record<string, unknown>>(sql, params)).rows[0]!;
const count = async (sql: string, params: unknown[] = []) => Number((await one<{ n: string }>(sql, params)).n);
const onHand = async () => (await one<{ q: string }>("SELECT COALESCE(sum(on_hand_qty), 0)::text AS q FROM inv.stock_balance WHERE product_id = $1 AND location_id = $2", [id('EGG-0003'), id('location:SHOP')])).q;
const footprint = () => count('SELECT ((SELECT count(*) FROM inv.stock_adjustment) + (SELECT count(*) FROM inv.stock_movement) + (SELECT count(*) FROM ord.pick_breakage) + (SELECT count(*) FROM ord.fulfilment_line))::text AS n');
const setThreshold = (pesewas: number) => admin().query("UPDATE iam.approval_policy SET threshold_pesewas = $1, version = version + 1 WHERE kind = 'STOCK_WRITE_OFF' AND branch_id IS NULL", [pesewas]);
const dodowa = { recipientName: 'Ama Serwaa Ofori', recipientPhone: '0244512876', line1: 'Two houses after the Presby church', area: 'Dodowa', city: 'Dodowa', region: 'Greater Accra' };

/** A guest's cash-on-delivery order of `crates` crates of big eggs, its pick list made at the shop. */
async function pickList(crates: number): Promise<{ listId: string; lineId: string }> {
  const created = await request(api.server).post('/v1/shop/carts').set('Origin', TEST_ORIGIN).set('Idempotency-Key', randomUUID());
  const cookie = (created.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('__Host-hk_guest='))!.split(';')[0]!;
  const guest = (path: string, body: object) => request(api.server).post(`/v1${path}`).set('Origin', TEST_ORIGIN).set('Idempotency-Key', randomUUID()).set('Cookie', cookie).send(body);
  expect((await guest(`/shop/carts/${created.body.id as string}/lines`, { productId: id('EGG-0003'), quantity: `${crates}.000` })).status).toBe(200);
  const started = await guest(`/shop/carts/${created.body.id as string}/checkout`, { contactName: 'Kofi Boateng', contactPhone: '0201234567', fulfilmentMode: 'DELIVERY', address: dodowa, paymentTerms: 'COD' });
  expect(started.status, JSON.stringify(started.body)).toBe(201);
  const placed = await guest(`/shop/checkouts/${started.body.id as string}/place`, { paymentMethod: 'COD' });
  expect(placed.status, JSON.stringify(placed.body)).toBe(201);
  const made = await post('storekeeper', `/orders/${placed.body.orderId as string}/fulfilments`, { pickLocationId: id('location:SHOP') });
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  return { listId: made.body.id as string, lineId: made.body.pickList[0].orderLineId as string };
}
const pick = (lineId: string, damaged?: object) => ({ id: randomUUID(), orderLineId: lineId, stockUnitId: id('lot:EGG-0003'), qty: '1.000', ...(damaged === undefined ? {} : { damaged }) });

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  await relaxRateLimits(database);
  for (const key of ['rate_limit.public.per_address_1m', 'rate_limit.checkout.per_address_10m']) {
    await database.pool('app').query(
      `INSERT INTO platform.setting (id, key, value, value_type, valid_from, description, created_by, updated_by)
       VALUES ($1, $2, '100000', 'INTEGER', now() - interval '1 day', 'Raised for a test file', '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001')`,
      [randomUUID(), key],
    );
  }
  api = await startTestApp(database, { clock, environment: { AUTH_ACCESS_TTL_SECONDS: '43200' } });
  await runSeedUnits(database.pool('app'), api.app, seedUnits({ SEED_STAFF_PASSWORD: `Seed-${randomUUID()}` }));
  for (const row of (await admin().query<{ code: string; id: string }>('SELECT sku AS code, id FROM mdm.product')).rows) ids.set(row.code, row.id);
  baseUom = (await one<{ u: string }>("SELECT base_uom AS u FROM mdm.product WHERE sku = 'EGG-0003'")).u;
  branchId = (await one<{ id: string }>("SELECT id FROM mdm.branch WHERE code = 'DDW'")).id;
  for (const row of (await admin().query<{ code: string; id: string }>('SELECT l.code, l.id FROM mdm.location l WHERE l.branch_id = $1', [branchId])).rows) ids.set(`location:${row.code}`, row.id);
  ids.set('lot:EGG-0003', (await one<{ id: string }>("SELECT u.id FROM inv.stock_unit u JOIN mdm.product p ON p.id = u.product_id WHERE p.sku = 'EGG-0003' AND u.tracking = 'LOT'")).id);
  const staff: [string, string, RoleCode][] = [
    ['storekeeper', 'Yaw Boateng', 'STOREKEEPER'],
    ['sales', 'Kojo Antwi', 'SALES'],
    ['cashier', 'Adwoa Darko', 'CASHIER'],
    ['driver', 'Kwabena Asare', 'DRIVER'],
  ];
  for (const [key, name, role] of staff) {
    const user = await createUser(database, { name, grants: [{ role, branchId }] });
    ids.set(key, user.principalId);
    sessions.set(key, await login(api.server, user));
  }
  sessions.set('manager', await enrolAndLogin(api.server, await createUser(database, { name: 'Abena Owusu', grants: [{ role: 'MANAGER', branchId }] }), () => clock.now()));
});

afterAll(async () => {
  await api?.close();
  await database?.drop();
});

describe('eggs found broken on the pick are written off from the pick location in the same transaction (CR-054 point 1)', () => {
  it('refuses the Sales, the Cashier and the Driver, and a unit the eggs are not sold by, a part of an egg and a reason not for stock, writing nothing', async () => {
    const { listId, lineId } = await pickList(1);
    const before = await footprint();
    for (const who of ['sales', 'cashier', 'driver']) {
      expect((await post(who, `/fulfilments/${listId}/picks`, { picks: [pick(lineId, { qty: '5.000', uom: baseUom, reasonCode: 'BREAKAGE' })] })).status, who).toBe(403);
    }
    const unit = await post('storekeeper', `/fulfilments/${listId}/picks`, { picks: [pick(lineId, { qty: '5.000', uom: 'KG', reasonCode: 'BREAKAGE' })] });
    expect([unit.status, unit.body.error?.details?.[0]]).toEqual([422, expect.objectContaining({ field: '/picks/0/damaged/qty', code: 'UNIT_NOT_SOLD' })]);
    const inexact = await post('storekeeper', `/fulfilments/${listId}/picks`, { picks: [pick(lineId, { qty: '0.010', reasonCode: 'BREAKAGE' })] });
    expect(inexact.body.error?.details?.[0]?.code, JSON.stringify(inexact.body)).toBe('INEXACT_QUANTITY');
    const reason = await post('storekeeper', `/fulfilments/${listId}/picks`, { picks: [pick(lineId, { qty: '5.000', uom: baseUom, reasonCode: 'CUSTOMER_PAID_SHORT' })] });
    expect(reason.status).toBe(422);
    expect(await footprint()).toBe(before);
  });

  it('posts five cracked eggs at once under the threshold: the shop holds exactly five fewer, the crate picked moves nothing', async () => {
    const { listId, lineId } = await pickList(1);
    const held = await onHand();
    const answer = await post('storekeeper', `/fulfilments/${listId}/picks`, { picks: [pick(lineId, { qty: '5.000', uom: baseUom, reasonCode: 'BREAKAGE' })] });
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    const line = answer.body.lines[0];
    expect(line).toMatchObject({ qty: '1.000', damaged: { qty: '5.000', uom: baseUom, reasonCode: 'BREAKAGE' } });
    const adjustment = await one<{ status: string; location: string; reason: string; qty: string; direction: string }>(
      'SELECT a.status, a.location_id AS location, a.reason_code AS reason, l.qty::text AS qty, l.direction FROM inv.stock_adjustment a JOIN inv.stock_adjustment_line l ON l.stock_adjustment_id = a.id WHERE a.id = $1',
      [line.damaged.stockAdjustmentId],
    );
    expect(adjustment).toEqual({ status: 'POSTED', location: id('location:SHOP'), reason: 'BREAKAGE', qty: '5.000', direction: 'LOSS' });
    expect(Number(await onHand())).toBe(Number(held) - 5);
    const row = await one<{ id: string; qty_base: string }>('SELECT id, qty_base::text FROM ord.pick_breakage WHERE fulfilment_line_id = $1', [line.id]);
    expect(row.qty_base).toBe('5.000');
    // Insert-only: never changed, by the application or by hand.
    expect(await sqlStateOf(database.pool('app').query("UPDATE ord.pick_breakage SET qty = 1 WHERE id = $1", [row.id]))).toBe(SQLSTATE.insufficientPrivilege);
    expect(await sqlStateOf(admin().query("UPDATE ord.pick_breakage SET qty = 1 WHERE id = $1", [row.id]))).toBe(SQLSTATE.ledgerImmutable);
  });

  it('waits for a different person above the threshold, moving nothing until the Manager approves', async () => {
    const { rows } = await admin().query<{ t: string }>("SELECT threshold_pesewas::text AS t FROM iam.approval_policy WHERE kind = 'STOCK_WRITE_OFF' AND branch_id IS NULL");
    await setThreshold(0);
    try {
      const { listId, lineId } = await pickList(1);
      const held = await onHand();
      const answer = await post('storekeeper', `/fulfilments/${listId}/picks`, { picks: [pick(lineId, { qty: '2.000', uom: baseUom, reasonCode: 'BREAKAGE' })] });
      expect(answer.status, JSON.stringify(answer.body)).toBe(200);
      const adjustmentId = answer.body.lines[0].damaged.stockAdjustmentId as string;
      const waiting = await one<{ status: string; approval: string }>('SELECT status, approval_request_id AS approval FROM inv.stock_adjustment WHERE id = $1', [adjustmentId]);
      expect(waiting.status).toBe('PENDING_APPROVAL');
      expect(await onHand()).toBe(held);
      await stepUp(api.server, as('manager') as TotpSession, clock);
      const approved = await post('manager', `/iam/approvals/${waiting.approval}/approve`, { reason: 'Seen the cracked eggs' });
      expect(approved.status, JSON.stringify(approved.body)).toBe(200);
      expect((await one<{ status: string }>('SELECT status FROM inv.stock_adjustment WHERE id = $1', [adjustmentId])).status).toBe('POSTED');
      expect(Number(await onHand())).toBe(Number(held) - 2);
    } finally {
      await setThreshold(Number(rows[0]!.t));
    }
  });
});
