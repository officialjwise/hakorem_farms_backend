import { randomUUID } from 'node:crypto';
import { createUuidV7Generator, ManualClock, toBusinessDate } from '@hakorem/kernel';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { stepUp, type TotpSession } from '../../support/fin';
import { consoleGet, consolePost, createBranch, createUser, enrolAndLogin, login, relaxRateLimits, testStartTime, type RoleCode, type TestSession } from '../../support/iam';
import { SQLSTATE, sqlStateOf } from '../../support/sql-state';
import { startTestApp, TEST_ORIGIN, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * A driver's run for a day (FR-DEL-005, FR-DEL-007, FR-DEL-011, CR-056 items 3 and 4, CR-057 point 2) and the owner's
 * close rule (2026-11-23: "a run cannot be closed while goods remain on the van"; the run's hand-in recorded against
 * it, A-345 (g)), the B11 continued 3 gate, over the seeded farm. Kwabena Asare's run carries three crates of big eggs
 * dispatched to him on VAN1, each on cash on delivery; Kwesi Appiah's carries one. Nothing happens at a doorstep before
 * a run starts; a run with goods on the van or cash still held is refused its close, stop by stop; Kwesi's run closes
 * once his crate is delivered and its cash handed in at Adwoa Darko's till shift, and names that hand-in. Every figure
 * is read by SQL.
 */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let branchId: string;
let credential = '';
let shiftId = '';
let today = '';
const nextId = () => createUuidV7Generator(clock)();
const ids = new Map<string, string>();
const id = (name: string) => ids.get(name)!;
const sessions = new Map<string, TestSession>();
const as = (name: string) => sessions.get(name)!;
const admin = () => database.pool('admin');
const post = (who: string, path: string, body: object, key = randomUUID()) => consolePost(api.server, as(who), `/v1${path}`, key).send(body);
const put = (who: string, path: string, body: object, key = randomUUID()) => request(api.server).put(`/v1${path}`).set('Origin', TEST_ORIGIN).set('Cookie', as(who).jar.header()).set('X-CSRF-Token', as(who).csrfToken).set('Idempotency-Key', key).send(body);
const get = (who: string, path: string) => consoleGet(api.server, as(who), `/v1${path}`);
const one = async <T extends object>(sql: string, params: unknown[] = []) => (await admin().query<T & Record<string, unknown>>(sql, params)).rows[0]!;
const count = async (sql: string, params: unknown[] = []) => Number((await one<{ n: string }>(sql, params)).n);
const codes = (res: request.Response) => [res.status, res.body.error?.code, ...((res.body.error?.details ?? []) as { code: string }[]).map((d) => d.code)];
/** Everything a route write leaves behind, to show a refusal wrote none of it. */
const routeFootprint = () => count('SELECT ((SELECT count(*) FROM del.route) + (SELECT count(*) FROM del.route_stop) + (SELECT coalesce(sum(version), 0) FROM del.route))::text AS n');

const dodowa = { recipientName: 'Ama Serwaa Ofori', recipientPhone: '0244512876', line1: 'Two houses after the Presby church', area: 'Dodowa', city: 'Dodowa', region: 'Greater Accra' };
const photo = (seed: number) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(1_020, seed)]);

/** A guest's order of one crate of big eggs on cash on delivery, picked, packed and dispatched onto VAN1 to the driver named. */
async function dispatchedCrate(driver: string): Promise<{ readonly orderId: string; readonly deliveryId: string; readonly due: number }> {
  const created = await request(api.server).post('/v1/shop/carts').set('Origin', TEST_ORIGIN).set('Idempotency-Key', randomUUID());
  const cookie = (created.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('__Host-hk_guest='))!.split(';')[0]!;
  const cartId = created.body.id as string;
  const guest = (path: string, body: object) => request(api.server).post(`/v1${path}`).set('Origin', TEST_ORIGIN).set('Idempotency-Key', randomUUID()).set('Cookie', cookie).send(body);
  expect((await guest(`/shop/carts/${cartId}/lines`, { productId: id('EGG-0003'), quantity: '1.000' })).status).toBe(200);
  const started = await guest(`/shop/carts/${cartId}/checkout`, { contactName: 'Kofi Boateng', contactPhone: '0201234567', fulfilmentMode: 'DELIVERY', address: dodowa, paymentTerms: 'COD' });
  expect(started.status, JSON.stringify(started.body)).toBe(201);
  const placed = await guest(`/shop/checkouts/${started.body.id as string}/place`, { paymentMethod: 'COD' });
  expect(placed.status, JSON.stringify(placed.body)).toBe(201);
  const orderId = placed.body.orderId as string;
  const made = await post('storekeeper', `/orders/${orderId}/fulfilments`, { pickLocationId: id('location:SHOP') });
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  const lineId = (await get('manager', `/orders/${orderId}`)).body.lines[0].id as string;
  expect((await post('storekeeper', `/fulfilments/${made.body.id as string}/picks`, { picks: [{ id: nextId(), orderLineId: lineId, stockUnitId: id('lot:EGG-0003'), qty: '1.000' }] })).status).toBe(200);
  expect((await post('storekeeper', `/fulfilments/${made.body.id as string}/pack`, { packageCount: 1 })).status).toBe(200);
  const sent = await post('manager', `/fulfilments/${made.body.id as string}/dispatch`, { driverId: id(driver), vehicleLocationId: id('location:VAN1') });
  expect(sent.status, JSON.stringify(sent.body)).toBe(200);
  const delivery = (await get('manager', `/deliveries?orderId=${orderId}`)).body.data[0];
  return { orderId, deliveryId: delivery.id as string, due: delivery.codDuePesewas as number };
}

/** The proof of a delivery with its whole cash due collected, by its driver, with a photograph they uploaded. */
async function prove(driver: string, deliveryId: string, due: number, seed: number): Promise<request.Response> {
  const uploaded = await consolePost(api.server, as(driver), '/v1/files').field('purpose', 'PROOF_OF_DELIVERY').attach('file', photo(seed), 'door.jpg');
  expect(uploaded.status, JSON.stringify(uploaded.body)).toBe(201);
  clock.advanceBy(60_000);
  return post(driver, `/driver/deliveries/${deliveryId}/proof`, { id: nextId(), recipientName: 'Ama Serwaa Ofori', photoFileId: uploaded.body.id as string, codCollectedPesewas: due, capturedAt: clock.now().toISOString() });
}

const handIn = () =>
  consolePost(api.server, as('cashier'), `/v1/shifts/${shiftId}/driver-cash-hand-ins`, randomUUID()).set('X-Device-Credential', credential);

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
  api = await startTestApp(database, { clock, environment: { AUTH_ACCESS_TTL_SECONDS: '43200', AUTH_STAFF_REFRESH_IDLE_SECONDS: '172800' } });
  await runSeedUnits(database.pool('app'), api.app, seedUnits({ SEED_STAFF_PASSWORD: `Seed-${randomUUID()}` }));
  for (const row of (await admin().query<{ code: string; id: string }>('SELECT sku AS code, id FROM mdm.product')).rows) ids.set(row.code, row.id);
  branchId = (await admin().query<{ id: string }>("SELECT id FROM mdm.branch WHERE code = 'DDW'")).rows[0]!.id;
  for (const row of (await admin().query<{ code: string; id: string }>('SELECT l.code, l.id FROM mdm.location l WHERE l.branch_id = $1', [branchId])).rows) ids.set(`location:${row.code}`, row.id);
  ids.set('lot:EGG-0003', (await one<{ id: string }>("SELECT u.id FROM inv.stock_unit u JOIN mdm.product p ON p.id = u.product_id WHERE p.sku = 'EGG-0003' AND u.tracking = 'LOT'")).id);
  const staff: [string, string, RoleCode, boolean][] = [
    ['storekeeper', 'Yaw Boateng', 'STOREKEEPER', false],
    ['cashier', 'Adwoa Darko', 'CASHIER', true],
    ['sales', 'Kojo Antwi', 'SALES', false],
    ['driver', 'Kwabena Asare', 'DRIVER', false],
    ['otherDriver', 'Kwesi Appiah', 'DRIVER', false],
  ];
  for (const [key, name, role, atShop] of staff) {
    const user = await createUser(database, { name, grants: [{ role, branchId, ...(atShop ? { locationId: id('location:SHOP') } : {}) }] });
    ids.set(key, user.principalId);
    sessions.set(key, await login(api.server, user));
  }
  const manager = await createUser(database, { name: 'Abena Owusu', grants: [{ role: 'MANAGER', branchId }] });
  ids.set('manager', manager.principalId);
  sessions.set('manager', await enrolAndLogin(api.server, manager, () => clock.now()));
  const elsewhere = await createBranch(database, 'TMA');
  sessions.set('otherManager', await enrolAndLogin(api.server, await createUser(database, { name: 'Efua Quaye', grants: [{ role: 'MANAGER', branchId: elsewhere.branchId }] }), () => clock.now()));

  const till = await post('manager', '/registers', { branchId, locationId: id('location:SHOP'), code: 'T2', name: 'Shop floor till' });
  expect(till.status, JSON.stringify(till.body)).toBe(201);
  await stepUp(api.server, as('manager') as TotpSession, clock);
  const enrolled = await post('manager', `/registers/${till.body.id as string}/devices`, { deviceLabel: 'Shop floor tablet' });
  expect(enrolled.status, JSON.stringify(enrolled.body)).toBe(201);
  credential = enrolled.body.deviceCredential as string;
  shiftId = nextId();
  const opened = await post('cashier', '/shifts', { id: shiftId, registerId: till.body.id as string, openingFloatPesewas: 20_000, openedAt: clock.now().toISOString() }, shiftId as ReturnType<typeof randomUUID>);
  expect(opened.status, JSON.stringify(opened.body)).toBe(201);
});

afterAll(async () => {
  await api?.close();
  await database?.drop();
});

describe("a driver's run: planned, ordered, started, and closed only with nothing on the van and nothing held (FR-DEL-005, the owner 2026-11-23)", () => {
  const crates: { readonly orderId: string; readonly deliveryId: string; readonly due: number }[] = [];
  let kwesi: { readonly orderId: string; readonly deliveryId: string; readonly due: number };
  let routeId = '';
  let kwesiRoute = '';

  beforeAll(async () => {
    for (let i = 0; i < 3; i++) crates.push(await dispatchedCrate('driver'));
    kwesi = await dispatchedCrate('otherDriver');
    expect(crates.every((c) => c.due === crates[0]!.due && c.due > 0)).toBe(true);
  });

  it('refuses every role but the Manager and the Owner a run, and another branch\'s Manager, writing nothing', async () => {
    const body = { driverId: id('driver'), routeDate: today, vehicleLocationId: id('location:VAN1'), deliveryIds: crates.map((c) => c.deliveryId) };
    const before = await routeFootprint();
    for (const who of ['driver', 'storekeeper', 'cashier', 'sales', 'otherManager']) expect((await post(who, '/routes', body)).status, who).toBe(403);
    expect(await routeFootprint()).toBe(before);
  });

  it('refuses a run of another driver\'s delivery, one for a past day, one with no stops and one stop twice, writing nothing', async () => {
    const base = { driverId: id('driver'), routeDate: today, vehicleLocationId: id('location:VAN1') };
    const before = await routeFootprint();
    expect(codes(await post('manager', '/routes', { ...base, deliveryIds: [crates[0]!.deliveryId, kwesi.deliveryId] }))).toEqual([422, 'ROUTE_INVALID', 'NOT_THE_DRIVERS']);
    const yesterday = toBusinessDate(new Date(clock.now().getTime() - 86_400_000));
    expect(codes(await post('manager', '/routes', { ...base, routeDate: yesterday, deliveryIds: [crates[0]!.deliveryId] }))).toEqual([422, 'ROUTE_INVALID', 'ROUTE_DATE_PAST', 'DISPATCHED_AFTER_ROUTE_DATE']);
    expect(codes(await post('manager', '/routes', { ...base, deliveryIds: [] }))).toEqual([422, 'ROUTE_INVALID', 'NO_STOPS']);
    expect(codes(await post('manager', '/routes', { ...base, deliveryIds: [crates[0]!.deliveryId, crates[0]!.deliveryId] }))).toEqual([422, 'ROUTE_INVALID', 'STOP_REPEATED']);
    expect(codes(await post('manager', '/routes', { ...base, driverId: id('storekeeper'), deliveryIds: [crates[0]!.deliveryId] }))).toEqual([422, 'DELIVERY_INVALID', 'NOT_A_DRIVER']);
    expect(await routeFootprint()).toBe(before);
  });

  it('plans the run in the order given, with what is due on it, and answers the same key with the same run', async () => {
    const body = { driverId: id('driver'), routeDate: today, vehicleLocationId: id('location:VAN1'), deliveryIds: crates.map((c) => c.deliveryId) };
    const key = randomUUID();
    const made = await post('manager', '/routes', body, key);
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    routeId = made.body.id as string;
    expect(made.body).toMatchObject({ status: 'PLANNED', routeDate: today, driver: { id: id('driver'), displayName: 'Kwabena Asare' }, stopsOnVan: 3, codDueTotalPesewas: 3 * crates[0]!.due, codCollectedPesewas: 0, codHeldPesewas: 0, handIns: [], startedAt: null, completedAt: null, version: 1 });
    expect((made.body.stops as { stopNo: number; delivery: { id: string; status: string; area: string } }[]).map((s) => [s.stopNo, s.delivery.id, s.delivery.status, s.delivery.area])).toEqual(crates.map((c, i) => [i + 1, c.deliveryId, 'ASSIGNED', 'Dodowa']));
    const again = await post('manager', '/routes', body, key);
    expect([again.status, again.body.id]).toEqual([201, routeId]);
    expect(await count('SELECT count(*)::text AS n FROM del.route_stop WHERE route_id = $1', [routeId])).toBe(3);
    expect(codes(await post('manager', '/routes', body))).toEqual([422, 'ROUTE_INVALID', 'DRIVER_HAS_A_ROUTE', 'ON_ANOTHER_ROUTE', 'ON_ANOTHER_ROUTE', 'ON_ANOTHER_ROUTE']);
    const tomorrow = toBusinessDate(new Date(clock.now().getTime() + 86_400_000));
    expect(codes(await post('manager', '/routes', { ...body, routeDate: tomorrow, deliveryIds: [crates[1]!.deliveryId] }))).toEqual([422, 'ROUTE_INVALID', 'ON_ANOTHER_ROUTE']);
    const second = await post('manager', '/routes', { driverId: id('otherDriver'), routeDate: today, vehicleLocationId: id('location:VAN1'), deliveryIds: [kwesi.deliveryId] });
    expect(second.status, JSON.stringify(second.body)).toBe(201);
    kwesiRoute = second.body.id as string;
  });

  it('lets the Manager read the run and list the drivers; another branch, the Driver and every other role are refused', async () => {
    const read = await get('manager', `/routes/${routeId}`);
    expect([read.status, read.body.id, read.body.stops.length]).toEqual([200, routeId, 3]);
    const listed = await get('manager', `/routes?date=${today}&driverId=${id('driver')}`);
    expect(listed.body.data.map((r: { id: string }) => r.id)).toEqual([routeId]);
    expect((await get('otherManager', `/routes/${routeId}`)).status).toBe(403);
    expect((await get('otherManager', '/routes')).body.data).toEqual([]);
    for (const who of ['driver', 'otherDriver', 'storekeeper', 'cashier', 'sales']) {
      expect((await get(who, `/routes/${routeId}`)).status, who).toBe(403);
      expect((await get(who, '/routes')).status, who).toBe(403);
      expect((await get(who, `/drivers?branchId=${branchId}`)).status, who).toBe(403);
    }
    const drivers = await get('manager', `/drivers?branchId=${branchId}`);
    expect(drivers.status, JSON.stringify(drivers.body)).toBe(200);
    const names = (drivers.body.data as { id: string; displayName: string }[]).map((d) => d.displayName);
    expect(names).toEqual(expect.arrayContaining(['Kwabena Asare', 'Kwesi Appiah', 'Abena Owusu']));
    expect(names).not.toContain('Yaw Boateng');
    expect((await get('otherManager', `/drivers?branchId=${branchId}`)).status).toBe(403);
  });

  it("gives each driver only their own run; a driver with no run that day gets 404 (CR-057 point 2)", async () => {
    const mine = await get('driver', '/driver/route');
    expect([mine.status, mine.body.id]).toEqual([200, routeId]);
    expect((await get('otherDriver', '/driver/route')).body.id).toBe(kwesiRoute);
    const tomorrow = toBusinessDate(new Date(clock.now().getTime() + 86_400_000));
    expect(codes(await get('driver', `/driver/route?date=${tomorrow}`))).toEqual([404, 'NOT_FOUND']);
    for (const who of ['storekeeper', 'cashier', 'sales']) expect((await get(who, '/driver/route')).status, who).toBe(403);
  });

  it('takes nothing at a doorstep before the run starts: not on the way, not a proof, not a failure', async () => {
    const at = clock.now().toISOString();
    expect(codes(await post('driver', `/driver/deliveries/${crates[0]!.deliveryId}/on-the-way`, { occurredAt: at }))).toEqual([422, 'DELIVERY_INVALID', 'ROUTE_NOT_STARTED']);
    expect(codes(await post('driver', `/driver/deliveries/${crates[0]!.deliveryId}/fail`, { id: nextId(), failureReasonCode: 'CUSTOMER_NOT_AVAILABLE', nextAction: 'REATTEMPT', occurredAt: at }))).toEqual([422, 'DELIVERY_INVALID', 'ROUTE_NOT_STARTED']);
    expect(codes(await prove('driver', crates[0]!.deliveryId, crates[0]!.due, 1))).toEqual([422, 'DELIVERY_INVALID', 'ROUTE_NOT_STARTED']);
    expect(await count("SELECT count(*)::text AS n FROM del.delivery WHERE id = $1 AND status = 'ASSIGNED'", [crates[0]!.deliveryId])).toBe(1);
  });

  it('reorders a planned run at the version read: the same stops only; the Driver may not', async () => {
    const order = [crates[2]!.deliveryId, crates[0]!.deliveryId, crates[1]!.deliveryId];
    expect((await put('driver', `/routes/${routeId}/stops`, { version: 1, deliveryIds: order })).status).toBe(403);
    expect(codes(await put('manager', `/routes/${routeId}/stops`, { version: 7, deliveryIds: order }))[0]).toBe(409);
    expect(codes(await put('manager', `/routes/${routeId}/stops`, { version: 1, deliveryIds: order.slice(1) }))).toEqual([422, 'ROUTE_INVALID', 'NOT_THE_SAME_STOPS']);
    expect(codes(await put('manager', `/routes/${routeId}/stops`, { version: 1, deliveryIds: [...order.slice(1), kwesi.deliveryId] }))).toEqual([422, 'ROUTE_INVALID', 'NOT_THE_SAME_STOPS']);
    const moved = await put('manager', `/routes/${routeId}/stops`, { version: 1, deliveryIds: order });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect([moved.body.version, moved.body.stops.map((s: { delivery: { id: string } }) => s.delivery.id)]).toEqual([2, order]);
    expect((await admin().query<{ delivery_id: string }>('SELECT delivery_id FROM del.route_stop WHERE route_id = $1 ORDER BY stop_no', [routeId])).rows.map((r) => r.delivery_id)).toEqual(order);
  });

  it('starts the run on its day; the Driver may not; a started run is neither reordered nor started again', async () => {
    expect((await post('driver', `/routes/${routeId}/start`, {})).status).toBe(403);
    const started = await post('manager', `/routes/${routeId}/start`, {});
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    expect([started.body.status, started.body.startedAt]).toEqual(['IN_PROGRESS', clock.now().toISOString()]);
    expect(codes(await post('manager', `/routes/${routeId}/start`, {}))).toEqual([422, 'INVALID_STATE_TRANSITION', 'IN_PROGRESS']);
    expect(codes(await put('manager', `/routes/${routeId}/stops`, { version: started.body.version as number, deliveryIds: crates.map((c) => c.deliveryId) }))).toEqual([422, 'INVALID_STATE_TRANSITION', 'IN_PROGRESS']);
    expect((await post('manager', `/routes/${kwesiRoute}/start`, {})).status).toBe(200);
  });

  it("marks the driver's own stop on the way once, with its time and one customer message; another driver is refused", async () => {
    const stop = crates[2]!.deliveryId;
    expect((await post('otherDriver', `/driver/deliveries/${stop}/on-the-way`, { occurredAt: clock.now().toISOString() })).status).toBe(403);
    clock.advanceBy(60_000);
    const at = clock.now().toISOString();
    const first = await post('driver', `/driver/deliveries/${stop}/on-the-way`, { occurredAt: at, etaMinutes: 20 });
    expect([first.status, first.body.status]).toEqual([200, 'OUT_FOR_DELIVERY']);
    const again = await post('driver', `/driver/deliveries/${stop}/on-the-way`, { occurredAt: at });
    expect([again.status, again.body.status]).toEqual([200, 'OUT_FOR_DELIVERY']);
    expect((await one<{ at: Date }>('SELECT on_the_way_at AS at FROM del.delivery WHERE id = $1', [stop])).at.toISOString()).toBe(at);
    expect(await count("SELECT count(*)::text AS n FROM platform.outbox_message WHERE event_type = 'del.DeliveryOnTheWay' AND subject_id = $1", [stop])).toBe(1);
    const message = await one<{ payload: Record<string, unknown> }>("SELECT payload FROM platform.outbox_message WHERE event_type = 'del.DeliveryOnTheWay' AND subject_id = $1", [stop]);
    expect(message.payload).toMatchObject({ deliveryId: stop, driverId: id('driver'), etaMinutes: 20 });
    expect(JSON.stringify(message.payload)).not.toContain('244512876');
  });

  it('refuses to close a run with goods on the van, naming every stop still aboard', async () => {
    const refused = await post('manager', `/routes/${routeId}/complete`, {});
    expect(codes(refused)).toEqual([422, 'ROUTE_INVALID', 'GOODS_ON_VAN', 'GOODS_ON_VAN', 'GOODS_ON_VAN']);
    expect((refused.body.error.details as { field: string }[]).map((d) => d.field).sort()).toEqual(crates.map((c) => `/stops/${c.deliveryId}`).sort());
    expect(await count("SELECT count(*)::text AS n FROM del.route WHERE id = $1 AND status = 'IN_PROGRESS'", [routeId])).toBe(1);
  });

  it('records a failed attempt once, the goods still aboard and the order DELIVERY_FAILED; a resend answers it; a wrong reason is refused', async () => {
    const stop = crates[2]!;
    clock.advanceBy(60_000);
    const attempt = { id: nextId(), failureReasonCode: 'CUSTOMER_NOT_AVAILABLE', nextAction: 'REATTEMPT', latitude: '5.770000', longitude: '-0.110000', occurredAt: clock.now().toISOString() };
    expect(codes(await post('driver', `/driver/deliveries/${stop.deliveryId}/fail`, { ...attempt, failureReasonCode: 'CUSTOMER_PAID_SHORT' }))).toEqual([422, 'DELIVERY_INVALID', 'REASON_NOT_ALLOWED']);
    expect(codes(await post('driver', `/driver/deliveries/${stop.deliveryId}/fail`, { ...attempt, failureReasonCode: 'NO_SUCH_REASON' }))).toEqual([422, 'DELIVERY_INVALID', 'REASON_UNKNOWN']);
    expect(codes(await post('driver', `/driver/deliveries/${stop.deliveryId}/fail`, { ...attempt, latitude: undefined }))).toEqual([422, 'DELIVERY_INVALID', 'POSITION_INCOMPLETE']);
    expect((await post('otherDriver', `/driver/deliveries/${stop.deliveryId}/fail`, attempt)).status).toBe(403);
    for (const who of ['storekeeper', 'cashier', 'sales']) expect((await post(who, `/driver/deliveries/${stop.deliveryId}/fail`, attempt)).status, who).toBe(403);
    const failed = await post('driver', `/driver/deliveries/${stop.deliveryId}/fail`, attempt);
    expect([failed.status, failed.body.status, failed.body.attemptCount]).toEqual([200, 'FAILED', 1]);
    const resent = await post('driver', `/driver/deliveries/${stop.deliveryId}/fail`, attempt);
    expect([resent.status, resent.body.status, resent.body.attemptCount]).toEqual([200, 'FAILED', 1]);
    expect(await count("SELECT count(*)::text AS n FROM del.delivery_attempt WHERE delivery_id = $1 AND outcome = 'FAILED' AND failure_reason_code = 'CUSTOMER_NOT_AVAILABLE' AND next_action = 'REATTEMPT'", [stop.deliveryId])).toBe(1);
    expect(codes(await post('driver', `/driver/deliveries/${crates[0]!.deliveryId}/fail`, attempt))).toEqual([422, 'DELIVERY_INVALID', 'ID_IN_USE']);
    expect((await one<{ status: string }>('SELECT status FROM ord.sales_order WHERE id = $1', [stop.orderId])).status).toBe('DELIVERY_FAILED');
    expect(codes(await post('driver', `/driver/deliveries/${stop.deliveryId}/on-the-way`, { occurredAt: clock.now().toISOString() }))).toEqual([422, 'INVALID_STATE_TRANSITION', 'FAILED']);
    // The crate is still on the van, the farm's stock: never issued for the sale.
    expect(await count("SELECT count(*)::text AS n FROM inv.stock_movement WHERE movement_type = 'SALE_ISSUE' AND source_document_id = $1", [stop.orderId])).toBe(0);
  });

  it('refuses the close while a failed stop is aboard and the cash collected on the run is still held', async () => {
    for (const [i, c] of crates.slice(0, 2).entries()) {
      const done = await prove('driver', c.deliveryId, c.due, 10 + i);
      expect(done.status, JSON.stringify(done.body)).toBe(200);
    }
    const read = await get('manager', `/routes/${routeId}`);
    expect(read.body).toMatchObject({ stopsOnVan: 1, codCollectedPesewas: 2 * crates[0]!.due, codHeldPesewas: 2 * crates[0]!.due, handIns: [] });
    expect(codes(await post('manager', `/routes/${routeId}/complete`, {}))).toEqual([422, 'ROUTE_INVALID', 'GOODS_ON_VAN', 'CASH_NOT_HANDED_IN']);
    expect((await get('manager', `/routes/${routeId}`)).body.status).toBe('IN_PROGRESS');
  });

  it('closes a run once every stop is delivered and its cash handed in at a till shift, and records that hand-in against it', async () => {
    expect((await prove('otherDriver', kwesi.deliveryId, kwesi.due, 30)).status).toBe(200);
    expect(codes(await post('manager', `/routes/${kwesiRoute}/complete`, {}))).toEqual([422, 'ROUTE_INVALID', 'CASH_NOT_HANDED_IN']);
    const handed = await handIn().send({ driverId: id('otherDriver'), declaredPesewas: kwesi.due });
    expect(handed.status, JSON.stringify(handed.body)).toBe(201);
    expect((await one<{ route_id: string }>('SELECT route_id FROM del.driver_cash_handed_in WHERE reconciliation_id = $1', [handed.body.id])).route_id).toBe(kwesiRoute);
    expect((await post('driver', `/routes/${kwesiRoute}/complete`, {})).status).toBe(403);
    const key = randomUUID();
    const closed = await post('manager', `/routes/${kwesiRoute}/complete`, {}, key);
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect(closed.body).toMatchObject({ status: 'COMPLETED', stopsOnVan: 0, codCollectedPesewas: kwesi.due, codHeldPesewas: 0, handIns: [{ id: handed.body.id }], completedAt: clock.now().toISOString() });
    expect((await post('manager', `/routes/${kwesiRoute}/complete`, {}, key)).body.version).toBe(closed.body.version);
    expect(codes(await post('manager', `/routes/${kwesiRoute}/complete`, {}))).toEqual([422, 'INVALID_STATE_TRANSITION', 'COMPLETED']);
    const event = await one<{ payload: Record<string, unknown> }>("SELECT payload FROM platform.outbox_message WHERE event_type = 'del.RouteCompleted' AND subject_id = $1", [kwesiRoute]);
    expect(event.payload).toMatchObject({ routeId: kwesiRoute, driverId: id('otherDriver'), codCollectedPesewas: kwesi.due, reconciliationIds: [handed.body.id], deliveryIds: [kwesi.deliveryId] });
    expect(await count("SELECT count(*)::text AS n FROM platform.audit_event WHERE entity_type = 'Route' AND entity_id = $1 AND action IN ('CREATE', 'START', 'COMPLETE')", [kwesiRoute])).toBe(3);
  });

  it('after the hand-in, refuses Kwabena\'s close only for the failed crate still on the van', async () => {
    const handed = await handIn().send({ driverId: id('driver'), declaredPesewas: 2 * crates[0]!.due });
    expect(handed.status, JSON.stringify(handed.body)).toBe(201);
    expect(codes(await post('manager', `/routes/${routeId}/complete`, {}))).toEqual([422, 'ROUTE_INVALID', 'GOODS_ON_VAN']);
    expect((await get('manager', `/routes/${routeId}`)).body).toMatchObject({ codHeldPesewas: 0, handIns: [{ id: handed.body.id }] });
  });

  it('holds the rules in the database itself', async () => {
    const app = database.pool('app');
    // Closing with a stop on the van, or with cash held, is refused at commit (ck_route_closed).
    const closeBySql = async (prepare: string | null) => {
      const client = await admin().connect();
      try {
        await client.query('BEGIN');
        if (prepare !== null) await client.query(prepare, [crates[2]!.deliveryId]);
        await client.query("UPDATE del.route SET status = 'COMPLETED', posted_at = now(), posted_by = $2, version = version + 1 WHERE id = $1", [routeId, id('manager')]);
        await client.query('SET CONSTRAINTS ALL IMMEDIATE');
        return undefined;
      } catch (error) {
        return (error as { code?: string }).code;
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    };
    expect(await closeBySql(null)).toBe('HK010');
    // Returned to stock is a way off the van: the same close is then taken.
    expect(await closeBySql("UPDATE del.delivery SET status = 'RETURNED', posted_at = now(), posted_by = created_by, version = version + 1 WHERE id = $1")).toBeUndefined();
    expect(await sqlStateOf(app.query('UPDATE del.route SET driver_id = $2, version = version + 1 WHERE id = $1', [routeId, id('otherDriver')]))).toBe(SQLSTATE.documentFrozen);
    expect(await sqlStateOf(app.query("UPDATE del.route SET status = 'PLANNED', started_at = NULL, started_by = NULL, version = version + 1 WHERE id = $1", [routeId]))).toBe(SQLSTATE.documentFrozen);
    expect(await sqlStateOf(app.query('UPDATE del.route SET version = version + 1 WHERE id = $1', [kwesiRoute]))).toBe(SQLSTATE.documentFrozen);
    expect(await sqlStateOf(app.query('UPDATE del.route_stop SET stop_no = 9 WHERE route_id = $1 AND stop_no = 1', [routeId]))).toBe('HK010');
    expect(await sqlStateOf(app.query('DELETE FROM del.route_stop WHERE route_id = $1', [routeId]))).toBe(SQLSTATE.insufficientPrivilege);
    // A stop is the route driver's loaded delivery, on a planned route.
    const plannedId = nextId();
    const tomorrow = toBusinessDate(new Date(clock.now().getTime() + 86_400_000));
    await app.query("INSERT INTO del.route (id, driver_id, route_date, vehicle_location_id, status, branch_id, created_at, created_by, updated_at, updated_by) VALUES ($1, $2, $3::date, $4, 'PLANNED', $5, now(), $2, now(), $2)", [plannedId, id('driver'), tomorrow, id('location:VAN1'), branchId]);
    const stopOf = (deliveryId: string) => app.query('INSERT INTO del.route_stop (route_id, stop_no, delivery_id, created_at, created_by, updated_at, updated_by) VALUES ($1, 1, $2, now(), $3, now(), $3)', [plannedId, deliveryId, id('manager')]);
    expect(await sqlStateOf(stopOf(crates[0]!.deliveryId))).toBe('HK010');
    expect(await sqlStateOf(app.query("INSERT INTO del.route (id, driver_id, route_date, vehicle_location_id, status, branch_id, created_at, created_by, updated_at, updated_by) VALUES ($1, $2, $3::date, $4, 'IN_PROGRESS', $5, now(), $2, now(), $2)", [nextId(), id('otherDriver'), tomorrow, id('location:VAN1'), branchId]))).toBe(SQLSTATE.documentFrozen);
    expect(await sqlStateOf(app.query("INSERT INTO del.route (id, driver_id, route_date, vehicle_location_id, status, branch_id, created_at, created_by, updated_at, updated_by) VALUES ($1, $2, $3::date, $4, 'PLANNED', $5, now(), $2, now(), $2)", [nextId(), id('driver'), tomorrow, id('location:VAN1'), branchId]))).toBe(SQLSTATE.uniqueViolation);
    // A delivery on a planned run takes nothing at the doorstep, and keeps its driver and van while the run is live.
    const fresh = await dispatchedCrate('driver');
    expect((await stopOf(fresh.deliveryId)).rowCount).toBe(1);
    expect(await sqlStateOf(app.query("UPDATE del.delivery SET status = 'OUT_FOR_DELIVERY', version = version + 1 WHERE id = $1", [fresh.deliveryId]))).toBe(SQLSTATE.documentFrozen);
    expect(await sqlStateOf(app.query('UPDATE del.delivery SET driver_id = $2, version = version + 1 WHERE id = $1', [fresh.deliveryId, id('otherDriver')]))).toBe(SQLSTATE.documentFrozen);
  });
});
