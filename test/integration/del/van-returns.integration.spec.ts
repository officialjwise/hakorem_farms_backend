import { randomUUID } from 'node:crypto';
import { UnitOfWork } from '../../../src/platform/database/unit-of-work';
import { FileStore } from '../../../src/platform/storage/file-store';
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
async function dispatchedCrate(driver: string, pay: 'COD' | 'MOMO', crates = 1): Promise<Crate> {
  const created = await request(api.server).post('/v1/shop/carts').set('Origin', TEST_ORIGIN).set('Idempotency-Key', randomUUID());
  const cookie = (created.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('__Host-hk_guest='))!.split(';')[0]!;
  const cartId = created.body.id as string;
  const guest = (path: string, body: object) => request(api.server).post(`/v1${path}`).set('Origin', TEST_ORIGIN).set('Idempotency-Key', randomUUID()).set('Cookie', cookie).send(body);
  expect((await guest(`/shop/carts/${cartId}/lines`, { productId: id('EGG-0003'), quantity: `${crates}.000` })).status).toBe(200);
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
  expect((await post('storekeeper', `/fulfilments/${made.body.id as string}/picks`, { picks: [{ id: nextId(), orderLineId: lineId, stockUnitId: id('lot:EGG-0003'), qty: `${crates}.000` }] })).status).toBe(200);
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

describe('a dispatched delivery cancelled before it leaves: its goods back into the returns hold, the document credited (FR-ORD-014, A-364 (a))', () => {
  let cod: Crate;
  let paid: Crate;
  let onRun: Crate;
  let failed: Crate;
  const body = () => ({ reasonCode: 'CUSTOMER_CANCELLED', returnsLocationId: id('location:RETURNS') });
  const cancel = (who: string, deliveryId: string, sent: object = body(), key = randomUUID()) => post(who, `/deliveries/${deliveryId}/cancel`, sent, key);

  beforeAll(async () => {
    cod = await dispatchedCrate('driver', 'COD');
    paid = await dispatchedCrate('driver', 'MOMO');
    onRun = await dispatchedCrate('otherDriver', 'COD');
    failed = await dispatchedCrate('otherDriver', 'COD');
    const tomorrow = toBusinessDate(new Date(clock.now().getTime() + 86_400_000));
    const made = await post('manager', '/routes', { driverId: id('otherDriver'), routeDate: tomorrow, vehicleLocationId: id('location:VAN1'), deliveryIds: [onRun.deliveryId] });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    clock.advanceBy(60_000);
    const fail = await post('otherDriver', `/driver/deliveries/${failed.deliveryId}/fail`, { id: nextId(), failureReasonCode: 'CUSTOMER_NOT_AVAILABLE', nextAction: 'RETURN_TO_STOCK', occurredAt: clock.now().toISOString() });
    expect(fail.status, JSON.stringify(fail.body)).toBe(200);
  });

  it('refuses the Driver, the Storekeeper, the Cashier, Sales and another branch\'s Manager, writing nothing', async () => {
    const before = await footprint();
    for (const who of ['driver', 'storekeeper', 'cashier', 'sales', 'otherManager']) expect((await cancel(who, cod.deliveryId)).status, who).toBe(403);
    expect((await cancel('manager', randomUUID())).status).toBe(404);
    expect((await cancel('manager', cod.deliveryId, { reasonCode: 'CUSTOMER_CANCELLED' })).status).toBe(400);
    expect((await cancel('manager', cod.deliveryId, { ...body(), extra: true })).status).toBe(400);
    expect(await footprint()).toBe(before);
  });

  it('refuses a failed delivery, a stop of a planned run, a shelf, a reason not a cancellation, and store credit for a guest, writing nothing', async () => {
    const before = await footprint();
    expect(codes(await cancel('manager', failed.deliveryId))).toEqual([422, 'INVALID_STATE_TRANSITION', 'FAILED']);
    expect(codes(await cancel('manager', onRun.deliveryId))).toEqual([422, 'DELIVERY_INVALID', 'ON_A_RUN']);
    expect(codes(await cancel('manager', cod.deliveryId, { ...body(), returnsLocationId: id('location:SHOP') }))).toEqual([422, 'DELIVERY_INVALID', 'NOT_A_RETURNS_HOLD']);
    expect(codes(await cancel('manager', cod.deliveryId, { ...body(), reasonCode: 'SPOILED' }))).toEqual([422, 'DELIVERY_INVALID', 'REASON_NOT_ALLOWED']);
    expect(codes(await cancel('manager', cod.deliveryId, { ...body(), reasonCode: 'NO_SUCH_REASON' }))).toEqual([422, 'DELIVERY_INVALID', 'REASON_UNKNOWN']);
    expect(codes(await cancel('manager', cod.deliveryId, { ...body(), refundDestination: 'STORE_CREDIT' }))).toEqual([422, 'DELIVERY_INVALID', 'STORE_CREDIT_NEEDS_CUSTOMER']);
    expect(await footprint()).toBe(before);
  });

  it('cancels a crate waiting on the van: CANCELLED with its reason, the eggs into the returns hold, the order RETURNED, the whole document credited, once', async () => {
    const van = Number(await eggsAt('VAN1'));
    const hold = Number(await eggsAt('RETURNS'));
    const key = randomUUID();
    const done = await cancel('manager', cod.deliveryId, { ...body(), note: 'Customer travelled to Kumasi' }, key);
    expect(done.status, `${JSON.stringify(done.body)} ${errors()}`).toBe(200);
    expect(done.body).toMatchObject({ id: cod.deliveryId, status: 'CANCELLED' });
    expect(await one('SELECT status, cancel_reason_code, (cancelled_at IS NOT NULL) AS dated, (posted_at IS NOT NULL) AS posted FROM del.delivery WHERE id = $1', [cod.deliveryId])).toEqual({
      status: 'CANCELLED',
      cancel_reason_code: 'CUSTOMER_CANCELLED',
      dated: true,
      posted: true,
    });
    const moved = await admin().query<{ type: string; from: string; to: string; qty: string }>(
      'SELECT movement_type AS type, from_location_id AS from, to_location_id AS to, qty_base::text AS qty FROM inv.stock_movement WHERE source_document_id = $1',
      [cod.deliveryId],
    );
    expect(moved.rows).toEqual([{ type: 'TRANSFER_INTERNAL', from: id('location:VAN1'), to: id('location:RETURNS'), qty: '30.000' }]);
    expect(Number(await eggsAt('VAN1'))).toBe(van - 30);
    expect(Number(await eggsAt('RETURNS'))).toBe(hold + 30);
    const history = await admin().query<{ from: string; to: string; reason: string }>('SELECT from_status AS from, to_status AS to, reason FROM ord.order_status_history WHERE sales_order_id = $1 ORDER BY occurred_at, id', [cod.orderId]);
    expect(history.rows.slice(-2).map((h) => [h.from, h.to])).toEqual([
      ['DISPATCHED', 'DELIVERY_FAILED'],
      ['DELIVERY_FAILED', 'RETURNED'],
    ]);
    expect(history.rows.at(-2)!.reason).toContain('cancelled before it left (CUSTOMER_CANCELLED)');
    expect((await one<{ status: string }>('SELECT status FROM ord.sales_order WHERE id = $1', [cod.orderId])).status).toBe('RETURNED');
    const way = await wayOut(cod.deliveryId);
    expect(way).toMatchObject({ status: 'POSTED', way_out: 'RETURN_TO_STOCK', refund_id: null, created_by: id('manager') });
    const credit = await creditOf(way.credit_note_id!);
    expect(credit).toMatchObject({ status: 'DRAFT', asked: (await documentOf(cod.billingDocumentId)).gross, original: cod.billingDocumentId, reason: 'DELIVERY_RETURNED', created_by: id('manager') });
    expect(await count("SELECT count(*)::text AS n FROM platform.outbox_message WHERE event_type = 'del.DeliveryCancelled' AND subject_id = $1", [cod.deliveryId])).toBe(1);
    expect(await count("SELECT count(*)::text AS n FROM platform.audit_event WHERE entity_id = $1 AND action = 'CANCEL'", [cod.deliveryId])).toBe(1);

    const after = await footprint();
    const replay = await cancel('manager', cod.deliveryId, { ...body(), note: 'Customer travelled to Kumasi' }, key);
    expect([replay.status, replay.body]).toEqual([200, done.body]);
    expect(codes(await cancel('manager', cod.deliveryId))).toEqual([422, 'INVALID_STATE_TRANSITION', 'CANCELLED']);
    expect(await footprint()).toBe(after);
    // The driver no longer has it to deliver.
    expect(codes(await post('driver', `/driver/deliveries/${cod.deliveryId}/fail`, { id: nextId(), failureReasonCode: 'CUSTOMER_NOT_AVAILABLE', nextAction: 'REATTEMPT', occurredAt: clock.now().toISOString() })).slice(0, 2)).toEqual([422, 'INVALID_STATE_TRANSITION']);
  });

  it('never takes the van below zero, and asks back what a paid-ahead order paid once its credit note is issued', async () => {
    const onVan = await eggsAt('VAN1');
    const taken = await post('manager', '/stock-adjustments', { locationId: id('location:VAN1'), reasonCode: 'BREAKAGE', lines: [{ productId: id('EGG-0003'), stockUnitId: id('lot:EGG-0003'), direction: 'LOSS', qty: onVan }] });
    expect(taken.status, JSON.stringify(taken.body)).toBe(201);
    expect((await post('manager', `/stock-adjustments/${taken.body.id as string}/submit`, {})).status).toBe(200);
    const before = await footprint();
    expect(codes(await cancel('manager', paid.deliveryId)).slice(0, 2)).toEqual([422, 'INSUFFICIENT_STOCK']);
    expect(await footprint()).toBe(before);
    expect((await one<{ status: string }>('SELECT status FROM del.delivery WHERE id = $1', [paid.deliveryId])).status).toBe('ASSIGNED');
    const found = await post('manager', '/stock-adjustments', { locationId: id('location:VAN1'), reasonCode: 'FOUND_STOCK', note: 'Under the seat', lines: [{ productId: id('EGG-0003'), stockUnitId: id('lot:EGG-0003'), direction: 'GAIN', qty: onVan }] });
    expect((await post('manager', `/stock-adjustments/${found.body.id as string}/submit`, {})).status).toBe(200);

    const done = await cancel('manager', paid.deliveryId, { ...body(), reasonCode: 'CUSTOMER_CANCELLED' });
    expect(done.status, `${JSON.stringify(done.body)} ${errors()}`).toBe(200);
    const way = await wayOut(paid.deliveryId);
    const credit = await creditOf(way.credit_note_id!);
    expect((await decide('owner', credit.approval, 'approve')).status).toBe(200);
    const refund = await one<{ amount: string; destination: string; reason: string }>('SELECT amount_pesewas::text AS amount, destination, reason_code AS reason FROM pay.refund WHERE id = $1', [(await wayOut(paid.deliveryId)).refund_id]);
    const allocated = await one<{ n: string }>('SELECT sum(amount_pesewas)::text AS n FROM pay.payment_allocation WHERE billing_document_id = $1', [paid.billingDocumentId]);
    expect(refund).toEqual({ amount: allocated.n, destination: 'ORIGINAL_METHOD', reason: 'ORDER_RETURNED' });
  });

  it('holds the cancellation in the database: a reason and a time exactly when CANCELLED, and frozen after', async () => {
    const app = database.pool('app');
    const client = await app.connect();
    try {
      await client.query('BEGIN');
      expect(await sqlStateOf(client.query("UPDATE del.delivery SET status = 'CANCELLED', posted_at = now(), posted_by = created_by, version = version + 1 WHERE id = $1", [failed.deliveryId]))).toBe(SQLSTATE.documentFrozen);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
    const second = await app.connect();
    try {
      await second.query('BEGIN');
      // ASSIGNED to CANCELLED is an edge of the guard, but never without its reason and time (ck_delivery_cancelled).
      const stillAssigned = (await second.query<{ id: string }>("SELECT id FROM del.delivery WHERE status = 'ASSIGNED' LIMIT 1")).rows[0]!.id;
      expect(await sqlStateOf(second.query("UPDATE del.delivery SET status = 'CANCELLED', posted_at = now(), posted_by = created_by, version = version + 1 WHERE id = $1", [stillAssigned]))).toBe(SQLSTATE.checkViolation);
    } finally {
      await second.query('ROLLBACK');
      second.release();
    }
    expect(await sqlStateOf(app.query("UPDATE del.delivery SET cancel_reason_code = 'OTHER', version = version + 1 WHERE id = $1", [cod.deliveryId]))).toBe(SQLSTATE.documentFrozen);
  });
});

describe('a part delivery: the customer keeps two of three crates, the third comes back and is credited (CR-055, ADR-0093)', () => {
  let three: Crate;
  let paidTwo: Crate;
  let lineOf = '';
  let photoId = '';
  const photo = (seed: number) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(1_020, seed)]);
  const upload = async (who: string, seed: number) => {
    const sent = await consolePost(api.server, as(who), '/v1/files').field('purpose', 'PROOF_OF_DELIVERY').attach('file', photo(seed), 'door.jpg');
    expect(sent.status, JSON.stringify(sent.body)).toBe(201);
    return sent.body.id as string;
  };
  const proof = (deliveryId: string, body: object, who = 'driver', key = randomUUID()) =>
    post(who, `/driver/deliveries/${deliveryId}/proof`, { id: nextId(), recipientName: 'Ama Serwaa Ofori', photoFileId: photoId, capturedAt: clock.now().toISOString(), ...body }, key);
  const lineGross = async (billingDocumentId: string) => Number((await one<{ g: string }>("SELECT line_gross_pesewas::text AS g FROM bil.billing_document_line WHERE billing_document_id = $1 AND line_kind = 'PRODUCT'", [billingDocumentId])).g);
  const proofFootprint = () => count('SELECT ((SELECT count(*) FROM del.proof_of_delivery) + (SELECT count(*) FROM del.proof_line) + (SELECT count(*) FROM inv.stock_movement) + (SELECT count(*) FROM pay.payment))::text AS n');

  beforeAll(async () => {
    three = await dispatchedCrate('driver', 'COD', 3);
    paidTwo = await dispatchedCrate('driver', 'MOMO', 2);
    lineOf = (await get('manager', `/orders/${three.orderId}`)).body.lines[0].id as string;
    photoId = await upload('driver', 41);
    clock.advanceBy(60_000);
  });

  it('refuses another driver, more than was dispatched, nothing kept, a short line with no reason or note, and a reason when all was kept, writing nothing', async () => {
    const before = await proofFootprint();
    const due = (await get('driver', `/driver/deliveries/${three.deliveryId}`)).body.codDuePesewas as number;
    expect((await proof(three.deliveryId, { codCollectedPesewas: due }, 'otherDriver')).status).toBe(403);
    expect(codes(await proof(three.deliveryId, { codCollectedPesewas: due, lines: [{ orderLineId: lineOf, deliveredQty: '3.001' }] }))).toEqual([422, 'DELIVERY_INVALID', 'ABOVE_DISPATCHED']);
    expect(codes(await proof(three.deliveryId, { codCollectedPesewas: 0, lines: [{ orderLineId: lineOf, deliveredQty: '0.000' }], returnedReasonCode: 'CUSTOMER_NOT_AVAILABLE' }))).toEqual([422, 'DELIVERY_INVALID', 'NOTHING_DELIVERED']);
    expect(codes(await proof(three.deliveryId, { codCollectedPesewas: due, lines: [{ orderLineId: lineOf, deliveredQty: '2.000' }] }))).toEqual([422, 'DELIVERY_INVALID', 'REASON_REQUIRED']);
    expect(codes(await proof(three.deliveryId, { codCollectedPesewas: due, lines: [{ orderLineId: lineOf, deliveredQty: '2.000' }], returnedReasonCode: 'CUSTOMER_REFUSED' }))).toEqual([422, 'DELIVERY_INVALID', 'NOTE_REQUIRED']);
    expect(codes(await proof(three.deliveryId, { codCollectedPesewas: due, lines: [{ orderLineId: lineOf, deliveredQty: '2.000' }], returnedReasonCode: 'SPOILED' }))).toEqual([422, 'DELIVERY_INVALID', 'REASON_NOT_ALLOWED']);
    expect(codes(await proof(three.deliveryId, { codCollectedPesewas: due, lines: [{ orderLineId: lineOf, deliveredQty: '3.000' }], returnedReasonCode: 'CUSTOMER_NOT_AVAILABLE' }))).toEqual([422, 'DELIVERY_INVALID', 'REASON_NOT_NEEDED']);
    expect(codes(await proof(three.deliveryId, { codCollectedPesewas: due, lines: [{ orderLineId: randomUUID(), deliveredQty: '1.000' }] }))).toEqual([422, 'DELIVERY_INVALID', 'LINE_UNKNOWN']);
    expect((await proof(three.deliveryId, { codCollectedPesewas: due, lines: [{ orderLineId: lineOf, deliveredQty: '2.5' }] })).status).toBe(400);
    expect(await proofFootprint()).toBe(before);
  });

  it('collects the cash due less the crate that came back, to the pesewa: never the whole, never more', async () => {
    const due = (await get('driver', `/driver/deliveries/${three.deliveryId}`)).body.codDuePesewas as number;
    const gross = await lineGross(three.billingDocumentId);
    expect(gross % 3).toBe(0);
    const crate = gross / 3;
    const part = { lines: [{ orderLineId: lineOf, deliveredQty: '2.000' }], returnedReasonCode: 'CUSTOMER_REFUSED', returnedNote: 'One crate had cracked eggs; the customer kept two' };
    const before = await proofFootprint();
    expect(codes(await proof(three.deliveryId, { ...part, codCollectedPesewas: due }))).toEqual([422, 'DELIVERY_INVALID', 'ABOVE_DUE']);
    expect(codes(await proof(three.deliveryId, { ...part, codCollectedPesewas: due - crate + 1 }))).toEqual([422, 'DELIVERY_INVALID', 'ABOVE_DUE']);
    expect(await proofFootprint()).toBe(before);
    const van = Number(await eggsAt('VAN1'));
    const hold = Number(await eggsAt('RETURNS'));
    const done = await proof(three.deliveryId, { ...part, codCollectedPesewas: due - crate });
    expect(done.status, `${JSON.stringify(done.body)} ${errors()}`).toBe(200);
    expect(done.body).toMatchObject({ status: 'DELIVERED', codDuePesewas: due, codCollectedPesewas: due - crate });
    expect(done.body.proof).toMatchObject({ returnedReasonCode: 'CUSTOMER_REFUSED', returnedNote: 'One crate had cracked eggs; the customer kept two', returnedCreditPesewas: crate, codVarianceReasonCode: null, lines: [{ orderLineId: lineOf, dispatchedQty: '3.000', deliveredQty: '2.000' }] });
    // Two crates issued to the customer from the van, the third back into the returns hold.
    const moved = await admin().query<{ type: string; from: string; to: string; qty: string }>(
      `SELECT m.movement_type AS type, m.from_location_id AS from, m.to_location_id AS to, m.qty_base::text AS qty FROM inv.stock_movement m
        WHERE (m.source_document_id = $1 OR m.source_document_id = $2) AND m.from_location_id = $3 ORDER BY m.movement_type`,
      [three.orderId, three.deliveryId, id('location:VAN1')],
    );
    expect(moved.rows.map((r) => [r.type, r.qty, r.to === id('location:RETURNS') ? 'RETURNS' : 'CUSTOMER'])).toEqual([
      ['SALE_ISSUE', '60.000', 'CUSTOMER'],
      ['TRANSFER_INTERNAL', '30.000', 'RETURNS'],
    ]);
    expect(Number(await eggsAt('VAN1'))).toBe(van - 90);
    expect(Number(await eggsAt('RETURNS'))).toBe(hold + 30);
    // The crate that came back is credited by its own price, through the credit note approval, the driver its maker.
    const way = await wayOut(three.deliveryId);
    expect(way).toMatchObject({ status: 'POSTED', way_out: 'RETURN_TO_STOCK', refund_id: null, created_by: id('driver') });
    const credit = await creditOf(way.credit_note_id!);
    expect(credit).toMatchObject({ status: 'DRAFT', asked: String(crate), original: three.billingDocumentId, reason: 'DELIVERY_RETURNED', created_by: id('driver') });
    const statusOf = async () => (await one<{ status: string }>('SELECT status FROM ord.sales_order WHERE id = $1', [three.orderId])).status;
    // Until the credit note is issued the crate's price is still owed, so the order waits DELIVERED (BL-097).
    expect(await statusOf()).toBe('DELIVERED');
    expect((await decide('owner', credit.approval, 'approve')).status).toBe(200);
    expect(await creditOf(way.credit_note_id!)).toMatchObject({ status: 'ISSUED', gross: String(crate) });
    // The credit note issued later settles the document: the order completes then (BL-097, B11 continued 7).
    expect(await statusOf()).toBe('COMPLETED');
    expect((await wayOut(three.deliveryId)).refund_id).toBeNull();
    const event = await one<{ payload: Record<string, unknown> }>("SELECT payload FROM platform.outbox_message WHERE event_type = 'del.DeliveryCompleted' AND subject_id = $1", [three.deliveryId]);
    expect(event.payload).toMatchObject({ returnedReasonCode: 'CUSTOMER_REFUSED', returnedCreditPesewas: crate, returnedLines: [{ orderLineId: lineOf, returnedQty: '1.000', weighed: false }] });
    expect(await count("SELECT count(*)::text AS n FROM platform.audit_event WHERE entity_id = $1 AND action = 'PART_DELIVERY'", [three.orderId])).toBe(1);
  });

  it('collects nothing on a paid-ahead order kept in part, and refunds the crate that came back once its credit note is issued', async () => {
    expect((await get('driver', `/driver/deliveries/${paidTwo.deliveryId}`)).body.codDuePesewas).toBe(0);
    const line = (await get('manager', `/orders/${paidTwo.orderId}`)).body.lines[0].id as string;
    const crate = (await lineGross(paidTwo.billingDocumentId)) / 2;
    const done = await proof(paidTwo.deliveryId, { codCollectedPesewas: 0, lines: [{ orderLineId: line, deliveredQty: '1.000' }], returnedReasonCode: 'CUSTOMER_NOT_AVAILABLE' });
    expect(done.status, `${JSON.stringify(done.body)} ${errors()}`).toBe(200);
    expect(done.body.proof).toMatchObject({ returnedCreditPesewas: crate, codVarianceReasonCode: null });
    const way = await wayOut(paidTwo.deliveryId);
    const credit = await creditOf(way.credit_note_id!);
    expect((await decide('owner', credit.approval, 'approve')).status).toBe(200);
    const refund = await one<{ amount: string; destination: string; reason: string }>('SELECT amount_pesewas::text AS amount, destination, reason_code AS reason FROM pay.refund WHERE id = $1', [(await wayOut(paidTwo.deliveryId)).refund_id]);
    expect(refund).toEqual({ amount: String(crate), destination: 'ORIGINAL_METHOD', reason: 'ORDER_RETURNED' });
  });

  it('records a photograph used before on the proof, publishes it for the exception report (abuse case 44, CR-059), and matches another upload of the same bytes', async () => {
    const flags = async (deliveryId: string) =>
      one<{ photo: boolean; signature: boolean; id: string }>('SELECT id, photo_matches_earlier_upload AS photo, signature_matches_earlier_upload AS signature FROM del.proof_of_delivery WHERE delivery_id = $1', [deliveryId]);
    const first = await flags(three.deliveryId);
    expect(first).toMatchObject({ photo: false, signature: false });
    const again = await flags(paidTwo.deliveryId);
    expect(again).toMatchObject({ photo: true, signature: false });
    const published = await admin().query<{ payload: Record<string, unknown> }>("SELECT payload FROM platform.outbox_message WHERE event_type = 'del.ProofFileReused' AND payload ->> 'proofId' = $1", [again.id]);
    expect(published.rows.map((r) => r.payload)).toEqual([expect.objectContaining({ deliveryId: paidTwo.deliveryId, file: 'PHOTO', fileId: photoId, earlierFileIds: [], earlierProofIds: [first.id], matchedBy: 'SHA256', abuseCases: [44] })]);
    const copy = await upload('driver', 41);
    const earlier = await api.app.get(UnitOfWork).run({ isolation: 'read committed' }, (tx) => api.app.get(FileStore).earlierWithSameContent(tx, copy));
    expect(earlier).toEqual([photoId]);
  });

  it('holds the part delivery in the database: never more kept than dispatched, and a returned reason exactly when a line was kept short', async () => {
    const app = database.pool('app');
    const proofId = (await one<{ id: string }>('SELECT id FROM del.proof_of_delivery WHERE delivery_id = $1', [three.deliveryId])).id;
    expect(await sqlStateOf(app.query('UPDATE del.proof_line SET delivered_qty = 3 WHERE proof_id = $1', [proofId]))).toBe(SQLSTATE.insufficientPrivilege);
    expect(await sqlStateOf(admin().query('UPDATE del.proof_line SET delivered_qty = 3 WHERE proof_id = $1', [proofId]))).toBe(SQLSTATE.ledgerImmutable);
    expect(await sqlStateOf(app.query('INSERT INTO del.proof_line (proof_id, order_line_id, dispatched_qty, delivered_qty, actor_id) VALUES ($1, $2, 1, 2, $3)', [proofId, randomUUID(), id('driver')]))).toBe(SQLSTATE.checkViolation);
    // A line kept short added to a proof that gave no returned reason: refused at commit.
    const whole = await dispatchedCrate('driver', 'COD');
    const due = (await get('driver', `/driver/deliveries/${whole.deliveryId}`)).body.codDuePesewas as number;
    expect((await proof(whole.deliveryId, { codCollectedPesewas: due })).status).toBe(200);
    const other = (await one<{ id: string }>('SELECT id FROM del.proof_of_delivery WHERE delivery_id = $1', [whole.deliveryId])).id;
    expect(await sqlStateOf(app.query('INSERT INTO del.proof_line (proof_id, order_line_id, dispatched_qty, delivered_qty, actor_id) VALUES ($1, $2, 2, 1, $3)', [other, randomUUID(), id('driver')]))).toBe('HK010');
  });
});

describe("the driver's offline queue: each proof and failure once by its client id, a resend answering the first outcome (CR-057 point 3)", () => {
  let full: Crate;
  let short: Crate;
  let failing: Crate;
  let kwesis: Crate;
  let photoId = '';
  const sync = (who: string, body: object) => consolePost(api.server, as(who), '/v1/driver/sync').send(body);
  const outcomes = (res: request.Response) => (res.body.results as { deliveryId: string; outcome: string; reason: string | null; firstOutcome: string | null }[]).map((r) => [r.deliveryId, r.outcome, r.reason, r.firstOutcome]);
  const written = () => count('SELECT ((SELECT count(*) FROM del.proof_of_delivery) + (SELECT count(*) FROM del.delivery_attempt) + (SELECT count(*) FROM pay.payment))::text AS n');
  let batch: { proofs: object[]; failures: object[] };

  beforeAll(async () => {
    full = await dispatchedCrate('driver', 'COD');
    short = await dispatchedCrate('driver', 'COD');
    failing = await dispatchedCrate('driver', 'COD');
    kwesis = await dispatchedCrate('otherDriver', 'COD');
    const sent = await consolePost(api.server, as('driver'), '/v1/files').field('purpose', 'PROOF_OF_DELIVERY').attach('file', Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(1_020, 77)]), 'door.jpg');
    photoId = sent.body.id as string;
    clock.advanceBy(60_000);
    const due = (await get('driver', `/driver/deliveries/${full.deliveryId}`)).body.codDuePesewas as number;
    const at = clock.now().toISOString();
    batch = {
      proofs: [
        { deliveryId: full.deliveryId, proof: { id: nextId(), recipientName: 'Ama Serwaa Ofori', photoFileId: photoId, codCollectedPesewas: due, capturedAt: at } },
        { deliveryId: short.deliveryId, proof: { id: nextId(), recipientName: 'Ama Serwaa Ofori', photoFileId: photoId, codCollectedPesewas: due - 500, codVarianceReasonCode: 'CUSTOMER_PAID_SHORT', codVarianceNote: 'Short by GHS 5.00, will pay at the shop', capturedAt: at } },
        { deliveryId: kwesis.deliveryId, proof: { id: nextId(), recipientName: 'Ama Serwaa Ofori', photoFileId: photoId, codCollectedPesewas: due, capturedAt: at } },
        { deliveryId: failing.deliveryId, proof: { id: randomUUID(), recipientName: 'Ama Serwaa Ofori', photoFileId: photoId, codCollectedPesewas: due, capturedAt: at } },
        { deliveryId: failing.deliveryId, proof: { id: nextId(), recipientName: 'Ama Serwaa Ofori', photoFileId: photoId, codCollectedPesewas: due + 1, capturedAt: at } },
      ],
      failures: [{ deliveryId: failing.deliveryId, failure: { id: nextId(), failureReasonCode: 'CUSTOMER_NOT_AVAILABLE', nextAction: 'REATTEMPT', occurredAt: at } }],
    };
  });

  it('refuses the whole batch to every role but the Driver, and a malformed batch, writing nothing', async () => {
    const before = await written();
    for (const who of ['storekeeper', 'cashier', 'sales']) expect((await sync(who, batch)).status, who).toBe(403);
    // The Manager may drive (del.proof.create), but only their own deliveries: every record here is another's.
    const manager = await sync('manager', batch);
    expect(outcomes(manager).map((o) => o[1])).toEqual(['REJECTED', 'REJECTED', 'REJECTED', 'REJECTED', 'REJECTED', 'REJECTED']);
    expect((await sync('driver', { proofs: [] })).status).toBe(400);
    expect((await sync('driver', { ...batch, extra: true })).status).toBe(400);
    expect(await written()).toBe(before);
  });

  it('applies each record in its own transaction: a refused one never loses the rest', async () => {
    const res = await sync('driver', batch);
    expect(res.status, `${JSON.stringify(res.body)} ${errors()}`).toBe(200);
    expect(outcomes(res), JSON.stringify(outcomes(res))).toEqual([
      [full.deliveryId, 'APPLIED', null, null],
      [short.deliveryId, 'APPLIED_WITH_EXCEPTION', 'COD_VARIANCE:CUSTOMER_PAID_SHORT', null],
      [kwesis.deliveryId, 'REJECTED', 'FORBIDDEN', null],
      [failing.deliveryId, 'REJECTED', 'CLIENT_ID_NOT_V7', null],
      [failing.deliveryId, 'REJECTED', 'ABOVE_DUE', null],
      [failing.deliveryId, 'APPLIED', null, null],
    ]);
    expect(res.body.serverTime).toBe(clock.now().toISOString());
    const statuses = await admin().query<{ id: string; status: string }>('SELECT id, status FROM del.delivery WHERE id = ANY($1::uuid[])', [[full.deliveryId, short.deliveryId, failing.deliveryId, kwesis.deliveryId]]);
    expect(Object.fromEntries(statuses.rows.map((r) => [r.id, r.status]))).toEqual({ [full.deliveryId]: 'DELIVERED', [short.deliveryId]: 'DELIVERED', [failing.deliveryId]: 'FAILED', [kwesis.deliveryId]: 'ASSIGNED' });
  });

  it('answers a resend DUPLICATE with the first outcome and its reason, writing nothing more; an id of another delivery is refused', async () => {
    const before = await written();
    const again = await sync('driver', { proofs: batch.proofs.slice(0, 2), failures: batch.failures });
    expect(outcomes(again), JSON.stringify(outcomes(again))).toEqual([
      [full.deliveryId, 'DUPLICATE', null, 'APPLIED'],
      [short.deliveryId, 'DUPLICATE', 'COD_VARIANCE:CUSTOMER_PAID_SHORT', 'APPLIED_WITH_EXCEPTION'],
      [failing.deliveryId, 'DUPLICATE', null, 'APPLIED'],
    ]);
    const reused = { ...(batch.proofs[0] as { proof: object }), deliveryId: failing.deliveryId };
    expect(outcomes(await sync('driver', { proofs: [reused], failures: [] }))).toEqual([[failing.deliveryId, 'REJECTED', 'ID_IN_USE', null]]);
    // Kwesi resending Kwabena's proof by its id learns nothing of it.
    expect(outcomes(await sync('otherDriver', { proofs: [batch.proofs[0]], failures: [] }))).toEqual([[full.deliveryId, 'REJECTED', 'FORBIDDEN', null]]);
    expect(await written()).toBe(before);
    expect(await count('SELECT count(*)::text AS n FROM del.proof_of_delivery WHERE delivery_id = ANY($1::uuid[])', [[full.deliveryId, short.deliveryId]])).toBe(2);
  });
});
