import { randomUUID } from 'node:crypto';
import { createUuidV7Generator, ManualClock, toBusinessDate } from '@hakorem/kernel';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { PAYSTACK_MTN_TEST_PHONE, paystackEnvironment, startFakePaystack, type FakePaystack } from '../../support/fake-paystack';
import { stepUp, type TotpSession } from '../../support/fin';
import { consoleGet, consolePost, createBranch, createUser, enrolAndLogin, login, relaxRateLimits, testStartTime, type RoleCode, type TestSession } from '../../support/iam';
import { runSweep } from '../../support/pay';
import { SQLSTATE, sqlStateOf } from '../../support/sql-state';
import { startTestApp, TEST_ORIGIN, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * The van's two other ways out (FR-DEL-011; the owner, 2026-11-23: "a run can't be closed while goods remain on the van.
 * Every item is delivered, returned to stock or written off with a reason, and anything unaccounted for goes on the
 * driver variance report"; A-360), the first part of the B11 continued 4 gate, over the seeded farm. Kwabena Asare's run
 * carries four crates of big eggs on VAN1, each a guest's: A, B and C on cash on delivery, D paid ahead by mobile money.
 * All four fail at the door. A is returned to the returns hold, B written off as spoiled (below the stock write-off
 * threshold, at once), C written off as unaccounted for (above it: refused once, then approved by the Owner), D refused
 * below zero when the van no longer holds it, then returned with its money asked back to store credit. The run closes
 * only once all four are off the van. Every figure is read by SQL.
 */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let fake: FakePaystack;
let branchId: string;
let today = '';
const nextId = () => createUuidV7Generator(clock)();
const ids = new Map<string, string>();
const id = (name: string) => ids.get(name)!;
const sessions = new Map<string, TestSession>();
const as = (name: string) => sessions.get(name)!;
const admin = () => database.pool('admin');
const post = (who: string, path: string, body: object, key = randomUUID()) => consolePost(api.server, as(who), `/v1${path}`, key).send(body);
const get = (who: string, path: string) => consoleGet(api.server, as(who), `/v1${path}`);
const one = async <T extends object>(sql: string, params: unknown[] = []) => (await admin().query<T & Record<string, unknown>>(sql, params)).rows[0]!;
const count = async (sql: string, params: unknown[] = []) => Number((await one<{ n: string }>(sql, params)).n);
const codes = (res: request.Response) => [res.status, res.body.error?.code, ...((res.body.error?.details ?? []) as { code: string }[]).map((d) => d.code)];
/** The server's own account of a 500, for a failing expectation's message. */
const errors = () => JSON.stringify(api.logLines().filter((l) => JSON.stringify(l).includes('rror')).slice(-2)).slice(0, 3000);
const step = (who: string) => stepUp(api.server, as(who) as TotpSession, clock);
const decide = async (who: string, approvalId: string, verb: 'approve' | 'reject') => {
  await step(who);
  return post(who, `/iam/approvals/${approvalId}/${verb}`, { reason: 'Seen the van come back' });
};
const eggsAt = async (location: string) =>
  (await one<{ q: string }>("SELECT COALESCE(sum(b.on_hand_qty), 0)::text AS q FROM inv.stock_balance b JOIN mdm.product p ON p.id = b.product_id WHERE b.location_id = $1 AND p.sku = 'EGG-0003'", [id(`location:${location}`)])).q;
/** Everything a way out leaves behind, to show a refusal wrote none of it. */
const footprint = () =>
  count(`SELECT ((SELECT count(*) FROM ord.delivery_return) + (SELECT count(*) FROM inv.stock_adjustment) + (SELECT count(*) FROM inv.stock_movement)
                 + (SELECT count(*) FROM bil.billing_document WHERE kind = 'CREDIT_NOTE') + (SELECT coalesce(sum(version), 0) FROM del.delivery))::text AS n`);
const setThreshold = (pesewas: number) => admin().query("UPDATE iam.approval_policy SET threshold_pesewas = $1, version = version + 1 WHERE kind = 'STOCK_WRITE_OFF' AND branch_id IS NULL", [pesewas]);
const wayOut = (deliveryId: string) =>
  one<{ status: string; way_out: string; credit_note_id: string | null; refund_id: string | null; refund_destination: string; created_by: string }>(
    'SELECT status, way_out, credit_note_id, refund_id, refund_destination, created_by FROM ord.delivery_return WHERE delivery_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1',
    [deliveryId],
  );
const documentOf = (billingDocumentId: string) => one<{ gross: string; kind: string }>('SELECT gross_pesewas::text AS gross, kind FROM bil.billing_document WHERE id = $1', [billingDocumentId]);
const creditOf = (creditNoteId: string) =>
  one<{ gross: string; asked: string; status: string; approval: string; original: string; reason: string; created_by: string }>(
    `SELECT d.gross_pesewas::text AS gross, q.amount_pesewas::text AS asked, d.status, d.approval_request_id AS approval, d.original_document_id AS original, d.reason_code AS reason, d.created_by
       FROM bil.billing_document d JOIN iam.approval_request q ON q.id = d.approval_request_id WHERE d.id = $1`,
    [creditNoteId],
  );

const dodowa = { recipientName: 'Ama Serwaa Ofori', recipientPhone: '0244512876', line1: 'Two houses after the Presby church', area: 'Dodowa', city: 'Dodowa', region: 'Greater Accra' };

interface Crate {
  readonly orderId: string;
  readonly deliveryId: string;
  readonly billingDocumentId: string;
}

/** A guest's order of one crate of big eggs, on cash on delivery or paid ahead by mobile money, dispatched onto VAN1 to the driver named. */
async function dispatchedCrate(driver: string, pay: 'COD' | 'MOMO'): Promise<Crate> {
  const created = await request(api.server).post('/v1/shop/carts').set('Origin', TEST_ORIGIN).set('Idempotency-Key', randomUUID());
  const cookie = (created.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('__Host-hk_guest='))!.split(';')[0]!;
  const cartId = created.body.id as string;
  const guest = (path: string, body: object) => request(api.server).post(`/v1${path}`).set('Origin', TEST_ORIGIN).set('Idempotency-Key', randomUUID()).set('Cookie', cookie).send(body);
  expect((await guest(`/shop/carts/${cartId}/lines`, { productId: id('EGG-0003'), quantity: '1.000' })).status).toBe(200);
  const started = await guest(`/shop/carts/${cartId}/checkout`, { contactName: 'Kofi Boateng', contactPhone: '0201234567', fulfilmentMode: 'DELIVERY', address: dodowa, paymentTerms: pay === 'COD' ? 'COD' : 'PREPAID' });
  expect(started.status, JSON.stringify(started.body)).toBe(201);
  const placed = await guest(`/shop/checkouts/${started.body.id as string}/place`, pay === 'COD' ? { paymentMethod: 'COD' } : { paymentMethod: 'MOBILE_MONEY', payerPhone: PAYSTACK_MTN_TEST_PHONE, network: 'MTN' });
  expect(placed.status, JSON.stringify(placed.body)).toBe(201);
  if (pay === 'MOMO') {
    clock.advanceBy(31_000);
    await runSweep(api);
  }
  const orderId = placed.body.orderId as string;
  const made = await post('storekeeper', `/orders/${orderId}/fulfilments`, { pickLocationId: id('location:SHOP') });
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  const lineId = (await get('manager', `/orders/${orderId}`)).body.lines[0].id as string;
  expect((await post('storekeeper', `/fulfilments/${made.body.id as string}/picks`, { picks: [{ id: nextId(), orderLineId: lineId, stockUnitId: id('lot:EGG-0003'), qty: '1.000' }] })).status).toBe(200);
  expect((await post('storekeeper', `/fulfilments/${made.body.id as string}/pack`, { packageCount: 1 })).status).toBe(200);
  const sent = await post('manager', `/fulfilments/${made.body.id as string}/dispatch`, { driverId: id(driver), vehicleLocationId: id('location:VAN1') });
  expect(sent.status, JSON.stringify(sent.body)).toBe(200);
  const delivery = (await get('manager', `/deliveries?orderId=${orderId}`)).body.data[0];
  const billed = await one<{ id: string }>('SELECT billing_document_id AS id FROM del.delivery WHERE id = $1', [delivery.id]);
  return { orderId, deliveryId: delivery.id as string, billingDocumentId: billed.id };
}

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  today = toBusinessDate(clock.now());
  await relaxRateLimits(database);
  for (const key of ['rate_limit.public.per_address_1m', 'rate_limit.checkout.per_address_10m']) {
    await database.pool('app').query(
      `INSERT INTO platform.setting (id, key, value, value_type, valid_from, description, created_by, updated_by)
       VALUES ($1, $2, '100000', 'INTEGER', now() - interval '1 day', 'Raised for a test file', '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001')`,
      [randomUUID(), key],
    );
  }
  fake = await startFakePaystack(() => clock.now());
  api = await startTestApp(database, { clock, environment: { ...paystackEnvironment(fake), AUTH_ACCESS_TTL_SECONDS: '43200', AUTH_STAFF_REFRESH_IDLE_SECONDS: '172800' } });
  await runSeedUnits(database.pool('app'), api.app, seedUnits({ SEED_STAFF_PASSWORD: `Seed-${randomUUID()}` }));
  for (const row of (await admin().query<{ code: string; id: string }>('SELECT sku AS code, id FROM mdm.product')).rows) ids.set(row.code, row.id);
  branchId = (await admin().query<{ id: string }>("SELECT id FROM mdm.branch WHERE code = 'DDW'")).rows[0]!.id;
  for (const row of (await admin().query<{ code: string; id: string; kind: string }>('SELECT l.code, l.id, l.kind FROM mdm.location l WHERE l.branch_id = $1', [branchId])).rows) {
    ids.set(`location:${row.code}`, row.id);
    if (row.kind === 'RETURNS_HOLD') ids.set('location:RETURNS', row.id);
  }
  ids.set('lot:EGG-0003', (await one<{ id: string }>("SELECT u.id FROM inv.stock_unit u JOIN mdm.product p ON p.id = u.product_id WHERE p.sku = 'EGG-0003' AND u.tracking = 'LOT'")).id);
  const staff: [string, string, RoleCode][] = [
    ['storekeeper', 'Yaw Boateng', 'STOREKEEPER'],
    ['cashier', 'Adwoa Darko', 'CASHIER'],
    ['sales', 'Kojo Antwi', 'SALES'],
    ['driver', 'Kwabena Asare', 'DRIVER'],
    ['otherDriver', 'Kwesi Appiah', 'DRIVER'],
  ];
  for (const [key, name, role] of staff) {
    const user = await createUser(database, { name, grants: [{ role, branchId }] });
    ids.set(key, user.principalId);
    sessions.set(key, await login(api.server, user));
  }
  for (const [key, name, role] of [['manager', 'Abena Owusu', 'MANAGER'], ['owner', 'Nana Agyeman', 'OWNER']] as const) {
    const user = await createUser(database, { name, grants: [{ role, branchId }] });
    ids.set(key, user.principalId);
    sessions.set(key, await enrolAndLogin(api.server, user, () => clock.now()));
  }
  const elsewhere = await createBranch(database, 'TMA');
  sessions.set('otherManager', await enrolAndLogin(api.server, await createUser(database, { name: 'Efua Quaye', grants: [{ role: 'MANAGER', branchId: elsewhere.branchId }] }), () => clock.now()));
});

afterAll(async () => {
  await api?.close();
  await fake?.close();
  await database?.drop();
});

describe("the van's two other ways out: returned to stock or written off with a reason, the unaccounted on the driver variance report (FR-DEL-011, the owner 2026-11-23)", () => {
  const crate: Record<'A' | 'B' | 'C' | 'D', Crate> = {} as never;
  let kwesi: Crate;
  let routeId = '';

  beforeAll(async () => {
    for (const name of ['A', 'B', 'C'] as const) crate[name] = await dispatchedCrate('driver', 'COD');
    crate.D = await dispatchedCrate('driver', 'MOMO');
    kwesi = await dispatchedCrate('otherDriver', 'COD');
    const made = await post('manager', '/routes', { driverId: id('driver'), routeDate: today, vehicleLocationId: id('location:VAN1'), deliveryIds: Object.values(crate).map((c) => c.deliveryId) });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    routeId = made.body.id as string;
    expect((await post('manager', `/routes/${routeId}/start`, {})).status).toBe(200);
    for (const c of Object.values(crate)) {
      clock.advanceBy(60_000);
      const failed = await post('driver', `/driver/deliveries/${c.deliveryId}/fail`, { id: nextId(), failureReasonCode: 'CUSTOMER_NOT_AVAILABLE', nextAction: 'RETURN_TO_STOCK', occurredAt: clock.now().toISOString() });
      expect(failed.status, JSON.stringify(failed.body)).toBe(200);
    }
    expect(await eggsAt('VAN1')).toBe('150.000');
  });

  it('refuses the run its close with every failed crate still on the van, stop by stop', async () => {
    const refused = await post('manager', `/routes/${routeId}/complete`, {});
    expect(codes(refused)).toEqual([422, 'ROUTE_INVALID', 'GOODS_ON_VAN', 'GOODS_ON_VAN', 'GOODS_ON_VAN', 'GOODS_ON_VAN']);
  });

  it('refuses both ways out to the Driver, the Storekeeper, the Cashier, Sales and another branch\'s Manager, writing nothing', async () => {
    const before = await footprint();
    for (const who of ['driver', 'storekeeper', 'cashier', 'sales', 'otherManager']) {
      expect((await post(who, `/deliveries/${crate.A.deliveryId}/return-to-stock`, { returnsLocationId: id('location:RETURNS'), note: 'Customer unreachable' })).status, who).toBe(403);
      expect((await post(who, `/deliveries/${crate.A.deliveryId}/write-off`, { reasonCode: 'SPOILED', note: 'Cool box failed' })).status, who).toBe(403);
    }
    expect(await footprint()).toBe(before);
  });

  it('refuses a delivery not failed, a shelf for a returns hold, and a reason that is not a write-off from the van, writing nothing', async () => {
    const before = await footprint();
    expect(codes(await post('manager', `/deliveries/${kwesi.deliveryId}/return-to-stock`, { returnsLocationId: id('location:RETURNS'), note: 'Not failed' }))).toEqual([422, 'INVALID_STATE_TRANSITION', 'ASSIGNED']);
    expect(codes(await post('manager', `/deliveries/${kwesi.deliveryId}/write-off`, { reasonCode: 'SPOILED', note: 'Not failed' }))).toEqual([422, 'INVALID_STATE_TRANSITION', 'ASSIGNED']);
    expect(codes(await post('manager', `/deliveries/${crate.A.deliveryId}/return-to-stock`, { returnsLocationId: id('location:SHOP'), note: 'Back on the shelf' }))).toEqual([422, 'DELIVERY_INVALID', 'NOT_A_RETURNS_HOLD']);
    expect(codes(await post('manager', `/deliveries/${crate.A.deliveryId}/write-off`, { reasonCode: 'COUNT_ERROR', note: 'Miscounted' }))).toEqual([422, 'DELIVERY_INVALID', 'REASON_NOT_ALLOWED']);
    expect(codes(await post('manager', `/deliveries/${crate.A.deliveryId}/write-off`, { reasonCode: 'NO_SUCH_REASON', note: 'Gone' }))).toEqual([422, 'DELIVERY_INVALID', 'REASON_UNKNOWN']);
    expect(codes(await post('manager', `/deliveries/${crate.A.deliveryId}/write-off`, { reasonCode: 'UNACCOUNTED_ON_VAN' }))).toEqual([422, 'DELIVERY_INVALID', 'NOTE_REQUIRED']);
    expect((await post('manager', `/deliveries/${crate.A.deliveryId}/return-to-stock`, { returnsLocationId: id('location:RETURNS'), note: 'x', extra: true })).status).toBe(400);
    expect(await footprint()).toBe(before);
  });

  it('returns A to the returns hold, not sellable, the order RETURNED and the whole document credited through its approval', async () => {
    const holdBefore = await eggsAt('RETURNS');
    const key = randomUUID();
    const body = { returnsLocationId: id('location:RETURNS'), note: 'Customer unreachable after three calls' };
    const returned = await post('manager', `/deliveries/${crate.A.deliveryId}/return-to-stock`, body, key);
    expect(returned.status, `${JSON.stringify(returned.body)} ${errors()}`).toBe(200);
    expect(returned.body).toMatchObject({ id: crate.A.deliveryId, status: 'RETURNED' });
    expect((await post('manager', `/deliveries/${crate.A.deliveryId}/return-to-stock`, body, key)).body.version).toBe(returned.body.version);
    expect(codes(await post('manager', `/deliveries/${crate.A.deliveryId}/return-to-stock`, body))).toEqual([422, 'INVALID_STATE_TRANSITION', 'RETURNED']);
    // The 30 eggs moved once, from the van into the returns hold, a location never promised or picked from.
    const moved = await admin().query<{ type: string; from: string; to: string; qty: string }>(
      `SELECT m.movement_type AS type, f.kind AS from, t.kind AS to, m.qty_base::text AS qty FROM inv.stock_movement m
         JOIN mdm.location f ON f.id = m.from_location_id JOIN mdm.location t ON t.id = m.to_location_id WHERE m.source_document_id = $1`,
      [crate.A.deliveryId],
    );
    expect(moved.rows).toEqual([{ type: 'TRANSFER_INTERNAL', from: 'VEHICLE', to: 'RETURNS_HOLD', qty: '30.000' }]);
    expect(await eggsAt('VAN1')).toBe('120.000');
    expect(Number(await eggsAt('RETURNS')) - Number(holdBefore)).toBe(30);
    expect((await one<{ status: string }>('SELECT status FROM ord.sales_order WHERE id = $1', [crate.A.orderId])).status).toBe('RETURNED');
    expect((await one<{ status: string; posted: boolean }>('SELECT status, posted_at IS NOT NULL AS posted FROM del.delivery WHERE id = $1', [crate.A.deliveryId]))).toMatchObject({ status: 'RETURNED', posted: true });
    // The credit note is of the whole document, drafted and waiting for someone other than the Manager.
    const way = await wayOut(crate.A.deliveryId);
    expect(way).toMatchObject({ status: 'POSTED', way_out: 'RETURN_TO_STOCK', refund_id: null, refund_destination: 'ORIGINAL_METHOD', created_by: id('manager') });
    const credit = await creditOf(way.credit_note_id!);
    expect(credit).toMatchObject({ status: 'DRAFT', original: crate.A.billingDocumentId, reason: 'DELIVERY_RETURNED', created_by: id('manager') });
    expect(credit.asked).toBe((await documentOf(crate.A.billingDocumentId)).gross);
    expect([(await decide('manager', credit.approval, 'approve')).status]).not.toEqual([200]);
    const approved = await decide('owner', credit.approval, 'approve');
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(await creditOf(way.credit_note_id!)).toMatchObject({ status: 'ISSUED', gross: (await documentOf(crate.A.billingDocumentId)).gross });
    // Nothing was paid on cash on delivery, so nothing is asked back.
    expect((await wayOut(crate.A.deliveryId)).refund_id).toBeNull();
    expect(await count("SELECT count(*)::text AS n FROM platform.outbox_message WHERE event_type = 'del.DeliveryReturned' AND subject_id = $1", [crate.A.deliveryId])).toBe(1);
  });

  it('writes B off as spoiled below the threshold at once: the loss from the van at cost, off the van, not a driver variance', async () => {
    const written = await post('manager', `/deliveries/${crate.B.deliveryId}/write-off`, { reasonCode: 'SPOILED', note: 'The cool box failed on the road' });
    expect(written.status, `${JSON.stringify(written.body)} ${errors()}`).toBe(200);
    expect(written.body).toMatchObject({ id: crate.B.deliveryId, status: 'WRITTEN_OFF' });
    const row = await one<{ reason: string; value: string; adjustment: string }>('SELECT written_off_reason_code AS reason, written_off_value_pesewas::text AS value, write_off_document_id AS adjustment FROM del.delivery WHERE id = $1', [crate.B.deliveryId]);
    const adjustment = await one<{ status: string; total: string; kind: string; reason: string }>(
      'SELECT a.status, a.total_value_pesewas::text AS total, l.kind, a.reason_code AS reason FROM inv.stock_adjustment a JOIN mdm.location l ON l.id = a.location_id WHERE a.id = $1',
      [row.adjustment],
    );
    expect(adjustment).toEqual({ status: 'POSTED', total: row.value, kind: 'VEHICLE', reason: 'SPOILED' });
    expect(Number(row.value)).toBeGreaterThan(0);
    const loss = await one<{ type: string; to: string; qty: string; value: string }>(
      `SELECT m.movement_type AS type, t.kind AS to, m.qty_base::text AS qty, m.value_pesewas::text AS value FROM inv.stock_movement m JOIN mdm.location t ON t.id = m.to_location_id WHERE m.source_document_id = $1`,
      [row.adjustment],
    );
    expect(loss).toEqual({ type: 'ADJUST_LOSS', to: 'LOSS', qty: '30.000', value: row.value });
    expect(await eggsAt('VAN1')).toBe('90.000');
    expect((await one<{ status: string }>('SELECT status FROM ord.sales_order WHERE id = $1', [crate.B.orderId])).status).toBe('RETURNED');
    const way = await wayOut(crate.B.deliveryId);
    expect(way).toMatchObject({ status: 'POSTED', way_out: 'WRITE_OFF' });
    expect((await creditOf(way.credit_note_id!)).asked).toBe((await documentOf(crate.B.billingDocumentId)).gross);
    expect((await get('manager', '/driver-goods-variances')).body.data).toEqual([]);
    const event = await one<{ payload: Record<string, unknown> }>("SELECT payload FROM platform.outbox_message WHERE event_type = 'del.DeliveryWrittenOff' AND subject_id = $1", [crate.B.deliveryId]);
    expect(event.payload).toMatchObject({ reasonCode: 'SPOILED', unaccounted: false, valuePesewas: Number(row.value), abuseCases: [] });
  });

  it('holds C on the van while its unaccounted write-off waits above the threshold; refused, it stays; approved, it leaves and is the driver\'s variance', async () => {
    await setThreshold(1);
    try {
      const body = { reasonCode: 'UNACCOUNTED_ON_VAN', note: 'Driver reports the crate missing after the Dodowa stop' };
      const asked = await post('manager', `/deliveries/${crate.C.deliveryId}/write-off`, body);
      expect(asked.status, JSON.stringify(asked.body)).toBe(202);
      expect(asked.body).toMatchObject({ status: 'PENDING_APPROVAL', kind: 'STOCK_WRITE_OFF', subject: { docType: 'STOCK_ADJUSTMENT' } });
      expect((await one<{ status: string }>('SELECT status FROM del.delivery WHERE id = $1', [crate.C.deliveryId])).status).toBe('FAILED');
      expect(await eggsAt('VAN1')).toBe('90.000');
      expect(codes(await post('manager', `/deliveries/${crate.C.deliveryId}/write-off`, body))).toEqual([422, 'DELIVERY_INVALID', 'WRITE_OFF_PENDING']);
      expect(codes(await post('manager', `/deliveries/${crate.C.deliveryId}/return-to-stock`, { returnsLocationId: id('location:RETURNS'), note: 'Found it' }))).toEqual([422, 'DELIVERY_INVALID', 'WRITE_OFF_PENDING']);
      // Refused: the crate is still the van's, and the write-off may be asked again.
      expect((await decide('owner', asked.body.approvalRequestId, 'reject')).status).toBe(200);
      expect((await wayOut(crate.C.deliveryId)).status).toBe('REJECTED');
      expect((await one<{ status: string }>('SELECT status FROM del.delivery WHERE id = $1', [crate.C.deliveryId])).status).toBe('FAILED');
      expect(await eggsAt('VAN1')).toBe('90.000');
      const again = await post('manager', `/deliveries/${crate.C.deliveryId}/write-off`, body);
      expect(again.status, JSON.stringify(again.body)).toBe(202);
      expect((await decide('manager', again.body.approvalRequestId, 'approve')).status).not.toBe(200);
      const approved = await decide('owner', again.body.approvalRequestId, 'approve');
      expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    } finally {
      await setThreshold(50_000);
    }
    const row = await one<{ status: string; value: string; adjustment: string }>('SELECT status, written_off_value_pesewas::text AS value, write_off_document_id AS adjustment FROM del.delivery WHERE id = $1', [crate.C.deliveryId]);
    expect(row.status).toBe('WRITTEN_OFF');
    expect((await one<{ total: string; posted_by: string }>('SELECT total_value_pesewas::text AS total, posted_by FROM inv.stock_adjustment WHERE id = $1', [row.adjustment]))).toEqual({ total: row.value, posted_by: id('owner') });
    expect(await eggsAt('VAN1')).toBe('60.000');
    expect((await one<{ status: string }>('SELECT status FROM ord.sales_order WHERE id = $1', [crate.C.orderId])).status).toBe('RETURNED');
    const way = await wayOut(crate.C.deliveryId);
    expect(way).toMatchObject({ status: 'POSTED', way_out: 'WRITE_OFF', created_by: id('manager') });
    const credit = await creditOf(way.credit_note_id!);
    expect(credit).toMatchObject({ status: 'DRAFT', created_by: id('manager'), asked: (await documentOf(crate.C.billingDocumentId)).gross });
    // The driver variance report's goods line: C alone, at the adjustment's value, on Kwabena's run.
    const report = await get('manager', `/driver-goods-variances?driverId=${id('driver')}&from=${today}&to=${today}`);
    expect(report.status, JSON.stringify(report.body)).toBe(200);
    expect(report.body.data).toEqual([
      expect.objectContaining({ delivery: expect.objectContaining({ id: crate.C.deliveryId }), driver: { id: id('driver'), displayName: 'Kwabena Asare' }, routeId, reasonCode: 'UNACCOUNTED_ON_VAN', valuePesewas: Number(row.value), stockAdjustmentId: row.adjustment, currency: 'GHS' }),
    ]);
    expect((await get('manager', `/driver-goods-variances?driverId=${id('otherDriver')}`)).body.data).toEqual([]);
    expect((await get('otherManager', '/driver-goods-variances')).body.data).toEqual([]);
    for (const who of ['driver', 'storekeeper', 'cashier', 'sales']) expect((await get(who, '/driver-goods-variances')).status, who).toBe(403);
    const event = await one<{ payload: Record<string, unknown> }>("SELECT payload FROM platform.outbox_message WHERE event_type = 'del.DeliveryWrittenOff' AND subject_id = $1", [crate.C.deliveryId]);
    expect(event.payload).toMatchObject({ unaccounted: true, driverId: id('driver'), abuseCases: [48] });
  });

  it('never takes the van below zero: with D\'s eggs gone from it, neither way out is taken and nothing is written', async () => {
    // Every other crate's eggs on VAN1 taken off by hand first (Kwesi's still ride there), so it holds none for D.
    const taken = await post('manager', '/stock-adjustments', { locationId: id('location:VAN1'), reasonCode: 'BREAKAGE', lines: [{ productId: id('EGG-0003'), stockUnitId: id('lot:EGG-0003'), direction: 'LOSS', qty: '60.000' }] });
    expect(taken.status, JSON.stringify(taken.body)).toBe(201);
    expect((await post('manager', `/stock-adjustments/${taken.body.id as string}/submit`, {})).status).toBe(200);
    expect(await eggsAt('VAN1')).toBe('0.000');
    const before = await footprint();
    expect(codes(await post('manager', `/deliveries/${crate.D.deliveryId}/write-off`, { reasonCode: 'DAMAGED', note: 'Dropped' })).slice(0, 2)).toEqual([422, 'INSUFFICIENT_STOCK']);
    expect(codes(await post('manager', `/deliveries/${crate.D.deliveryId}/return-to-stock`, { returnsLocationId: id('location:RETURNS'), note: 'Back' })).slice(0, 2)).toEqual([422, 'INSUFFICIENT_STOCK']);
    expect(await footprint()).toBe(before);
    expect(await eggsAt('VAN1')).toBe('0.000');
    // Found again: back onto the van, so D can come off it.
    const found = await post('manager', '/stock-adjustments', { locationId: id('location:VAN1'), reasonCode: 'FOUND_STOCK', note: 'Under the seat', lines: [{ productId: id('EGG-0003'), stockUnitId: id('lot:EGG-0003'), direction: 'GAIN', qty: '60.000' }] });
    expect(found.status, JSON.stringify(found.body)).toBe(201);
    expect((await post('manager', `/stock-adjustments/${found.body.id as string}/submit`, {})).status).toBe(200);
  });

  it('returns D, paid ahead, and once its credit note is issued asks back exactly what was paid, the way it was paid, the Manager its maker', async () => {
    const paid = await one<{ allocated: string }>('SELECT sum(amount_pesewas)::text AS allocated FROM pay.payment_allocation WHERE billing_document_id = $1', [crate.D.billingDocumentId]);
    expect(paid.allocated).toBe((await documentOf(crate.D.billingDocumentId)).gross);
    // A guest has no store credit to keep it in: their money goes back the way it was paid.
    const before = await footprint();
    expect(codes(await post('manager', `/deliveries/${crate.D.deliveryId}/return-to-stock`, { returnsLocationId: id('location:RETURNS'), note: 'Customer moved house', refundDestination: 'STORE_CREDIT' }))).toEqual([422, 'DELIVERY_INVALID', 'STORE_CREDIT_NEEDS_CUSTOMER']);
    expect(await footprint()).toBe(before);
    const returned = await post('manager', `/deliveries/${crate.D.deliveryId}/return-to-stock`, { returnsLocationId: id('location:RETURNS'), note: 'Customer moved house' });
    expect(returned.status, `${JSON.stringify(returned.body)} ${errors()}`).toBe(200);
    const way = await wayOut(crate.D.deliveryId);
    expect(way).toMatchObject({ refund_id: null, refund_destination: 'ORIGINAL_METHOD' });
    const credit = await creditOf(way.credit_note_id!);
    const approved = await decide('owner', credit.approval, 'approve');
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    const after = await wayOut(crate.D.deliveryId);
    expect(after.refund_id).not.toBeNull();
    const refund = await one<{ amount: string; destination: string; status: string; credit: string; reason: string; requested_by: string }>(
      `SELECT r.amount_pesewas::text AS amount, r.destination, r.status, r.credit_note_id AS credit, r.reason_code AS reason, q.requested_by
         FROM pay.refund r JOIN iam.approval_request q ON q.id = r.approval_request_id WHERE r.id = $1`,
      [after.refund_id],
    );
    expect(refund).toEqual({ amount: (await creditOf(way.credit_note_id!)).gross, destination: 'ORIGINAL_METHOD', status: 'PENDING_APPROVAL', credit: way.credit_note_id, reason: 'ORDER_RETURNED', requested_by: id('manager') });
    expect(refund.amount).toBe(paid.allocated);
  });

  it('closes the run once every crate is off the van, delivered, returned or written off', async () => {
    expect(await eggsAt('VAN1')).toBe('30.000');
    const closed = await post('manager', `/routes/${routeId}/complete`, {});
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect(closed.body).toMatchObject({ status: 'COMPLETED', stopsOnVan: 0 });
    expect(await count("SELECT count(*)::text AS n FROM platform.audit_event WHERE entity_type = 'Delivery' AND action IN ('RETURN_TO_STOCK', 'WRITE_OFF') AND entity_id = ANY($1::uuid[])", [Object.values(crate).map((c) => c.deliveryId)])).toBe(4);
  });

  it('holds the rules in the database itself', async () => {
    const app = database.pool('app');
    // Written off straight from the van's assigned stop: the guard's edges (ck_delivery_transition).
    expect(await sqlStateOf(app.query("UPDATE del.delivery SET status = 'WRITTEN_OFF', posted_at = now(), posted_by = created_by, version = version + 1 WHERE id = $1", [kwesi.deliveryId]))).toBe(SQLSTATE.documentFrozen);
    // A failed delivery written off with no reason, value or adjustment: ck_delivery_written_off.
    const client = await app.connect();
    try {
      await client.query('BEGIN');
      await client.query("UPDATE del.delivery SET status = 'FAILED', version = version + 1 WHERE id = $1", [kwesi.deliveryId]);
      expect(await sqlStateOf(client.query("UPDATE del.delivery SET status = 'WRITTEN_OFF', posted_at = now(), posted_by = created_by, version = version + 1 WHERE id = $1", [kwesi.deliveryId]))).toBe(SQLSTATE.checkViolation);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
    // A written-off delivery is frozen: ck_delivery_transition.
    expect(await sqlStateOf(app.query("UPDATE del.delivery SET written_off_reason_code = 'DAMAGED', version = version + 1 WHERE id = $1", [crate.C.deliveryId]))).toBe(SQLSTATE.documentFrozen);
    // A way out's credit note, refund and what was asked never change; a refused one is frozen; none is deleted.
    expect(await sqlStateOf(app.query('UPDATE ord.delivery_return SET credit_note_id = $2, version = version + 1 WHERE delivery_id = $1 AND status = $3', [crate.D.deliveryId, crate.A.billingDocumentId, 'POSTED']))).toBe(SQLSTATE.documentFrozen);
    expect(await sqlStateOf(app.query("UPDATE ord.delivery_return SET note = 'Changed', version = version + 1 WHERE delivery_id = $1 AND status = 'POSTED'", [crate.A.deliveryId]))).toBe(SQLSTATE.documentFrozen);
    expect(await sqlStateOf(app.query("UPDATE ord.delivery_return SET status = 'POSTED', version = version + 1 WHERE delivery_id = $1 AND status = 'REJECTED'", [crate.C.deliveryId]))).toBe(SQLSTATE.documentFrozen);
    expect(await sqlStateOf(app.query('DELETE FROM ord.delivery_return WHERE delivery_id = $1', [crate.A.deliveryId]))).toBe(SQLSTATE.insufficientPrivilege);
    // A second live way out of one delivery: uq_delivery_return_live.
    expect(
      await sqlStateOf(
        app.query(
            `INSERT INTO ord.delivery_return (id, delivery_id, sales_order_id, original_billing_document_id, way_out, returns_location_id, refund_destination, status, credit_note_id, branch_id, created_at, created_by, updated_at, updated_by, posted_at, posted_by)
             SELECT $2, delivery_id, sales_order_id, original_billing_document_id, 'RETURN_TO_STOCK', $3, 'ORIGINAL_METHOD', 'POSTED', $4, branch_id, now(), created_by, now(), created_by, now(), created_by FROM ord.delivery_return WHERE delivery_id = $1`,
            [crate.A.deliveryId, randomUUID(), id('location:RETURNS'), crate.B.billingDocumentId],
          )
      ),
    ).toBe(SQLSTATE.uniqueViolation);
  });
});
