import { randomUUID } from 'node:crypto';
import { createUuidV7Generator, ManualClock, toBusinessDate } from '@hakorem/kernel';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { consoleGet, consolePost, createBranch, createUser, enrolAndLogin, login, relaxRateLimits, testStartTime, type RoleCode, type TestSession } from '../../support/iam';
import { SQLSTATE, sqlStateOf } from '../../support/sql-state';
import { startTestApp, TEST_ORIGIN, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * A delivery's driver, vehicle and slot after dispatch (FR-DEL-001 to FR-DEL-004, FR-DEL-011; A-362), the first part of
 * the B11 continued 5 gate, over the seeded farm. Eight guests' crates of big eggs are dispatched onto VAN1 for Kwabena
 * Asare. Eight managers book them into a slot of five at once and exactly five get in; a booking moves from one slot to
 * another or fails and stays; today's slots close at the zone's cut-off and once started. A crate is reassigned to Kwesi
 * Appiah on a second van and its goods follow; a crate on a started run keeps its driver and van, fails at the door and
 * is reattempted on its run's day, the order DISPATCHED again; a crate whose write-off waits for approval is neither
 * reattempted nor reassigned. Every figure is read by SQL.
 */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
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
const eggsAt = async (location: string) =>
  (await one<{ q: string }>("SELECT COALESCE(sum(b.on_hand_qty), 0)::text AS q FROM inv.stock_balance b JOIN mdm.product p ON p.id = b.product_id WHERE b.location_id = $1 AND p.sku = 'EGG-0003'", [id(`location:${location}`)])).q;
const booked = async (slot: string) => (await one<{ booked: number }>('SELECT booked FROM del.delivery_slot WHERE id = $1', [id(`slot:${slot}`)])).booked;
const deliveryRow = (deliveryId: string) =>
  one<{ status: string; slot_id: string | null; driver_id: string; vehicle_location_id: string; attempt_count: number }>('SELECT status, slot_id, driver_id, vehicle_location_id, attempt_count FROM del.delivery WHERE id = $1', [deliveryId]);
/** Everything a reassignment or a booking leaves behind, to show a refusal wrote none of it. */
const footprint = () =>
  count(`SELECT ((SELECT coalesce(sum(version), 0) FROM del.delivery) + (SELECT coalesce(sum(booked), 0) FROM del.delivery_slot) + (SELECT count(*) FROM inv.stock_movement)
                 + (SELECT count(*) FROM platform.outbox_message WHERE event_type IN ('del.DeliveryReassigned', 'del.DeliveryRescheduled')))::text AS n`);
const hhmm = (at: Date) => at.toISOString().slice(11, 16);
const setCutoff = (time: string) => admin().query('UPDATE mdm.delivery_zone SET cutoff_time = $1, version = version + 1 WHERE id = $2', [time, id('zone')]);
const setThreshold = (pesewas: number) => admin().query("UPDATE iam.approval_policy SET threshold_pesewas = $1, version = version + 1 WHERE kind = 'STOCK_WRITE_OFF' AND branch_id IS NULL", [pesewas]);

const dodowa = { recipientName: 'Ama Serwaa Ofori', recipientPhone: '0244512876', line1: 'Two houses after the Presby church', area: 'Dodowa', city: 'Dodowa', region: 'Greater Accra' };

interface Crate {
  readonly orderId: string;
  readonly deliveryId: string;
}

/** A guest's order of one crate of big eggs on cash on delivery, dispatched onto VAN1 to Kwabena Asare. */
async function dispatchedCrate(deliverySlotId?: string): Promise<Crate> {
  const created = await request(api.server).post('/v1/shop/carts').set('Origin', TEST_ORIGIN).set('Idempotency-Key', randomUUID());
  const cookie = (created.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('__Host-hk_guest='))!.split(';')[0]!;
  const cartId = created.body.id as string;
  const guest = (path: string, body: object) => request(api.server).post(`/v1${path}`).set('Origin', TEST_ORIGIN).set('Idempotency-Key', randomUUID()).set('Cookie', cookie).send(body);
  expect((await guest(`/shop/carts/${cartId}/lines`, { productId: id('EGG-0003'), quantity: '1.000' })).status).toBe(200);
  const started = await guest(`/shop/carts/${cartId}/checkout`, { contactName: 'Kofi Boateng', contactPhone: '0201234567', fulfilmentMode: 'DELIVERY', address: dodowa, paymentTerms: 'COD', ...(deliverySlotId === undefined ? {} : { deliverySlotId }) });
  expect(started.status, JSON.stringify(started.body)).toBe(201);
  const placed = await guest(`/shop/checkouts/${started.body.id as string}/place`, { paymentMethod: 'COD' });
  expect(placed.status, JSON.stringify(placed.body)).toBe(201);
  const orderId = placed.body.orderId as string;
  const made = await post('storekeeper', `/orders/${orderId}/fulfilments`, { pickLocationId: id('location:SHOP') });
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  const lineId = (await get('manager', `/orders/${orderId}`)).body.lines[0].id as string;
  expect((await post('storekeeper', `/fulfilments/${made.body.id as string}/picks`, { picks: [{ id: nextId(), orderLineId: lineId, stockUnitId: id('lot:EGG-0003'), qty: '1.000' }] })).status).toBe(200);
  expect((await post('storekeeper', `/fulfilments/${made.body.id as string}/pack`, { packageCount: 1 })).status).toBe(200);
  const sent = await post('manager', `/fulfilments/${made.body.id as string}/dispatch`, { driverId: id('driver'), vehicleLocationId: id('location:VAN1') });
  expect(sent.status, JSON.stringify(sent.body)).toBe(200);
  const delivery = (await get('manager', `/deliveries?orderId=${orderId}`)).body.data[0];
  return { orderId, deliveryId: delivery.id as string };
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
  api = await startTestApp(database, { clock, environment: { AUTH_ACCESS_TTL_SECONDS: '43200', AUTH_STAFF_REFRESH_IDLE_SECONDS: '172800' } });
  await runSeedUnits(database.pool('app'), api.app, seedUnits({ SEED_STAFF_PASSWORD: `Seed-${randomUUID()}` }));
  for (const row of (await admin().query<{ code: string; id: string }>('SELECT sku AS code, id FROM mdm.product')).rows) ids.set(row.code, row.id);
  branchId = (await admin().query<{ id: string }>("SELECT id FROM mdm.branch WHERE code = 'DDW'")).rows[0]!.id;
  for (const row of (await admin().query<{ code: string; id: string }>('SELECT l.code, l.id FROM mdm.location l WHERE l.branch_id = $1', [branchId])).rows) ids.set(`location:${row.code}`, row.id);
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
  const van = await post('owner', '/locations', { branchId, code: 'VAN2', name: 'Delivery van GT 5120-26 (TEST)', kind: 'VEHICLE' });
  expect(van.status, JSON.stringify(van.body)).toBe(201);
  ids.set('location:VAN2', van.body.id as string);
});

afterAll(async () => {
  await api?.close();
  await database?.drop();
});

describe("a delivery's driver, vehicle and slot after dispatch: reassigned, booked and reattempted (FR-DEL-001 to FR-DEL-004, FR-DEL-011)", () => {
  const crates: Crate[] = [];
  const c = (n: number) => crates[n]!;
  let cutoff = '';
  let threshold = '';

  beforeAll(async () => {
    const zone = await one<{ id: string; cutoff: string }>("SELECT z.id, to_char(z.cutoff_time, 'HH24:MI') AS cutoff FROM mdm.delivery_zone z WHERE z.branch_id = $1 AND 'Dodowa' = ANY (z.areas)", [branchId]);
    ids.set('zone', zone.id);
    cutoff = zone.cutoff;
    threshold = (await one<{ t: string }>("SELECT threshold_pesewas::text AS t FROM iam.approval_policy WHERE kind = 'STOCK_WRITE_OFF' AND branch_id IS NULL")).t;
    // Two slots later today (the clock has at least 20 minutes before midnight), and three tomorrow.
    const now = clock.now().getTime();
    const at = (minutes: number) => hhmm(new Date(now + minutes * 60_000));
    const tomorrow = toBusinessDate(new Date(now + 86_400_000));
    for (const [date, times] of [
      [today, [{ startsAt: at(9), endsAt: at(10), capacity: 5 }, { startsAt: at(14), endsAt: at(15), capacity: 5 }]],
      [tomorrow, [{ startsAt: '06:15', endsAt: '07:00', capacity: 5 }, { startsAt: '07:15', endsAt: '08:00', capacity: 1 }, { startsAt: '19:15', endsAt: '20:00', capacity: 8 }]],
    ] as const) {
      const made = await post('manager', '/delivery-slots/generate', { zoneId: zone.id, from: date, to: date, weekdays: [1, 2, 3, 4, 5, 6, 7], times });
      expect(made.status, JSON.stringify(made.body)).toBe(201);
    }
    const slot = async (date: string, startsAt: string) => (await one<{ id: string }>("SELECT id FROM del.delivery_slot WHERE delivery_zone_id = $1 AND slot_date = $2 AND to_char(starts_at, 'HH24:MI') = $3", [zone.id, date, startsAt])).id;
    ids.set('slot:TA', await slot(today, at(9)));
    ids.set('slot:TB', await slot(today, at(14)));
    ids.set('slot:S5', await slot(tomorrow, '06:15'));
    ids.set('slot:S1', await slot(tomorrow, '07:15'));
    ids.set('slot:S8', await slot(tomorrow, '19:15'));
    for (let n = 0; n < 8; n += 1) crates.push(await dispatchedCrate());
    expect(await eggsAt('VAN1')).toBe('240.000');
  });

  it("refuses both to the Driver, the Storekeeper, the Cashier, Sales and another branch's Manager, writing nothing", async () => {
    const before = await footprint();
    for (const who of ['driver', 'storekeeper', 'cashier', 'sales', 'otherManager']) {
      expect((await post(who, `/deliveries/${c(0).deliveryId}/assign`, { driverId: id('otherDriver'), vehicleLocationId: id('location:VAN2') })).status, who).toBe(403);
      expect((await post(who, `/deliveries/${c(0).deliveryId}/reschedule`, { slotId: id('slot:S5'), reason: 'Customer asked for the morning' })).status, who).toBe(403);
    }
    expect((await post('manager', `/deliveries/${c(0).deliveryId}/reschedule`, { slotId: id('slot:S5'), reason: '   ' })).status).toBe(400);
    expect((await post('manager', `/deliveries/${c(0).deliveryId}/assign`, { driverId: id('otherDriver'), vehicleLocationId: id('location:VAN2'), note: 'x' })).status).toBe(400);
    expect((await post('manager', `/deliveries/${randomUUID()}/assign`, { driverId: id('otherDriver'), vehicleLocationId: id('location:VAN2') })).status).toBe(404);
    expect(await footprint()).toBe(before);
  });

  it('books eight deliveries into a slot of five at once and lets exactly five in (FR-DEL-001)', async () => {
    const answers = await Promise.all(crates.map((crate) => post('manager', `/deliveries/${crate.deliveryId}/reschedule`, { slotId: id('slot:S5'), reason: 'Booked for the morning run' })));
    const statuses = answers.map((a) => (a.status === 200 ? 200 : codes(a).join(':')));
    expect(statuses.filter((s) => s === 200)).toHaveLength(5);
    expect(statuses.filter((s) => s === '422:DELIVERY_INVALID:SLOT_FULL')).toHaveLength(3);
    expect(await booked('S5')).toBe(5);
    expect(await count('SELECT count(*)::text AS n FROM del.delivery WHERE slot_id = $1', [id('slot:S5')])).toBe(5);
    // The three left out book the larger evening slot, so every crate holds one booking.
    for (const [n, a] of answers.entries()) {
      if (a.status === 200) {
        expect(a.body.slot).toMatchObject({ id: id('slot:S5'), startsAt: '06:15', endsAt: '07:00' });
        continue;
      }
      expect((await post('manager', `/deliveries/${c(n).deliveryId}/reschedule`, { slotId: id('slot:S8'), reason: 'Booked for the evening run' })).status).toBe(200);
    }
    expect(await booked('S8')).toBe(3);
    expect(await count("SELECT count(*)::text AS n FROM platform.outbox_message WHERE event_type = 'del.DeliveryRescheduled'")).toBe(8);
  });

  it('moves a booking from one slot to another, or fails and leaves it where it was (FR-DEL-003)', async () => {
    const [first, second] = [c(0).deliveryId, c(1).deliveryId];
    const slotOf = async (deliveryId: string) => (await deliveryRow(deliveryId)).slot_id!;
    const from = await slotOf(first);
    const held = async (slotId: string) => (await one<{ booked: number }>('SELECT booked FROM del.delivery_slot WHERE id = $1', [slotId])).booked;
    const was = await held(from);
    const key = randomUUID();
    const moved = await post('manager', `/deliveries/${first}/reschedule`, { slotId: id('slot:S1'), reason: 'Customer travelling later' }, key);
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect([await held(from), await booked('S1')]).toEqual([was - 1, 1]);
    const replay = await post('manager', `/deliveries/${first}/reschedule`, { slotId: id('slot:S1'), reason: 'Customer travelling later' }, key);
    expect(replay.body).toEqual(moved.body);
    expect([await held(from), await booked('S1')]).toEqual([was - 1, 1]);

    const before = await footprint();
    const stays = await slotOf(second);
    expect(codes(await post('manager', `/deliveries/${second}/reschedule`, { slotId: id('slot:S1'), reason: 'Also later' }))).toEqual([422, 'DELIVERY_INVALID', 'SLOT_FULL']);
    expect(codes(await post('manager', `/deliveries/${second}/reschedule`, { slotId: stays, reason: 'Same again' }))).toEqual([422, 'DELIVERY_INVALID', 'SAME_SLOT']);
    expect(codes(await post('manager', `/deliveries/${second}/reschedule`, { slotId: randomUUID(), reason: 'No such slot' }))).toEqual([422, 'DELIVERY_INVALID', 'SLOT_UNKNOWN']);
    expect(await footprint()).toBe(before);
    expect(await slotOf(second)).toBe(stays);
    const summary = (await get('manager', `/orders/${c(0).orderId}`)).body.delivery;
    expect(summary).toMatchObject({ id: first, slotStartsAt: '07:15', slotEndsAt: '08:00' });
  });

  it("closes today's slots at the zone's cut-off and once they start, in Africa/Accra (FR-DEL-002)", async () => {
    const before = await footprint();
    await setCutoff('00:00');
    expect(codes(await post('manager', `/deliveries/${c(2).deliveryId}/reschedule`, { slotId: id('slot:TA'), reason: 'Today after all' }))).toEqual([422, 'DELIVERY_INVALID', 'PAST_CUT_OFF']);
    expect(await footprint()).toBe(before);
    await setCutoff('23:59');
    expect((await post('manager', `/deliveries/${c(2).deliveryId}/reschedule`, { slotId: id('slot:TA'), reason: 'Today after all' })).status).toBe(200);
    clock.advanceBy(10 * 60_000);
    const started = await footprint();
    expect(codes(await post('manager', `/deliveries/${c(3).deliveryId}/reschedule`, { slotId: id('slot:TA'), reason: 'Today too' }))).toEqual([422, 'DELIVERY_INVALID', 'SLOT_STARTED']);
    expect(await footprint()).toBe(started);
  });

  it('reassigns a crate to another driver on another van, its goods following it van to van, audited (FR-DEL-004)', async () => {
    const target = c(4).deliveryId;
    const key = randomUUID();
    const moved = await post('manager', `/deliveries/${target}/assign`, { driverId: id('otherDriver'), vehicleLocationId: id('location:VAN2') }, key);
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect(moved.body).toMatchObject({ status: 'ASSIGNED', driver: { id: id('otherDriver'), displayName: 'Kwesi Appiah' }, vehicle: { id: id('location:VAN2'), code: 'VAN2', kind: 'VEHICLE' } });
    expect(await post('manager', `/deliveries/${target}/assign`, { driverId: id('otherDriver'), vehicleLocationId: id('location:VAN2') }, key).then((r) => r.body)).toEqual(moved.body);
    const movements = await admin().query<{ type: string; from: string; to: string; qty: string }>(
      `SELECT m.movement_type AS type, f.code AS from, t.code AS to, m.qty_base::text AS qty FROM inv.stock_movement m
         JOIN mdm.location f ON f.id = m.from_location_id JOIN mdm.location t ON t.id = m.to_location_id WHERE m.source_document_id = $1`,
      [target],
    );
    expect(movements.rows).toEqual([{ type: 'TRANSFER_INTERNAL', from: 'VAN1', to: 'VAN2', qty: '30.000' }]);
    expect([await eggsAt('VAN1'), await eggsAt('VAN2')]).toEqual(['210.000', '30.000']);
    expect(await deliveryRow(target)).toMatchObject({ driver_id: id('otherDriver'), vehicle_location_id: id('location:VAN2'), status: 'ASSIGNED' });
    expect(await count("SELECT count(*)::text AS n FROM platform.audit_event WHERE entity_id = $1 AND action = 'REASSIGN'", [target])).toBe(1);
    expect(await count("SELECT count(*)::text AS n FROM platform.outbox_message WHERE event_type = 'del.DeliveryReassigned' AND subject_id = $1", [target])).toBe(1);
    // The ownership rule follows the delivery: the old driver can no longer open it, the new one can.
    expect((await get('driver', `/driver/deliveries/${target}`)).status).toBe(403);
    expect((await get('otherDriver', `/driver/deliveries/${target}`)).status).toBe(200);

    const before = await footprint();
    expect(codes(await post('manager', `/deliveries/${target}/assign`, { driverId: id('otherDriver'), vehicleLocationId: id('location:VAN2') }))).toEqual([422, 'DELIVERY_INVALID', 'UNCHANGED']);
    expect(codes(await post('manager', `/deliveries/${target}/assign`, { driverId: id('storekeeper'), vehicleLocationId: id('location:VAN2') }))).toEqual([422, 'DELIVERY_INVALID', 'NOT_A_DRIVER']);
    expect(codes(await post('manager', `/deliveries/${target}/assign`, { driverId: id('driver'), vehicleLocationId: id('location:SHOP') }))).toEqual([422, 'DELIVERY_INVALID', 'NOT_A_VEHICLE']);
    expect(await footprint()).toBe(before);

    // Another driver on the same van moves nothing.
    const stock = await count('SELECT count(*)::text AS n FROM inv.stock_movement');
    expect((await post('manager', `/deliveries/${c(5).deliveryId}/assign`, { driverId: id('otherDriver'), vehicleLocationId: id('location:VAN1') })).status).toBe(200);
    expect(await count('SELECT count(*)::text AS n FROM inv.stock_movement')).toBe(stock);
  });

  it('never takes a van below zero: a van that no longer holds the goods refuses the move, nothing written', async () => {
    const taken = await post('manager', '/stock-adjustments', { locationId: id('location:VAN2'), reasonCode: 'BREAKAGE', lines: [{ productId: id('EGG-0003'), stockUnitId: id('lot:EGG-0003'), direction: 'LOSS', qty: '30.000' }] });
    expect(taken.status, JSON.stringify(taken.body)).toBe(201);
    expect((await post('manager', `/stock-adjustments/${taken.body.id as string}/submit`, {})).status).toBe(200);
    const before = await footprint();
    expect(codes(await post('manager', `/deliveries/${c(4).deliveryId}/assign`, { driverId: id('driver'), vehicleLocationId: id('location:VAN1') })).slice(0, 2)).toEqual([422, 'INSUFFICIENT_STOCK']);
    expect(await footprint()).toBe(before);
    expect(await deliveryRow(c(4).deliveryId)).toMatchObject({ driver_id: id('otherDriver'), vehicle_location_id: id('location:VAN2') });
    expect(await eggsAt('VAN2')).toBe('0.000');
  });

  it("keeps a stop of a started run on its driver and van, and reattempts it on its run's day, the order DISPATCHED again (FR-DEL-011)", async () => {
    const stop = c(7).deliveryId;
    const made = await post('manager', '/routes', { driverId: id('driver'), routeDate: today, vehicleLocationId: id('location:VAN1'), deliveryIds: [stop] });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    expect((await post('manager', `/routes/${made.body.id as string}/start`, {})).status).toBe(200);
    expect(codes(await post('manager', `/deliveries/${stop}/assign`, { driverId: id('otherDriver'), vehicleLocationId: id('location:VAN1') }))).toEqual([422, 'DELIVERY_INVALID', 'ON_A_RUN']);
    const fail = () => post('driver', `/driver/deliveries/${stop}/fail`, { id: nextId(), failureReasonCode: 'CUSTOMER_NOT_AVAILABLE', nextAction: 'REATTEMPT', occurredAt: clock.now().toISOString() });
    expect((await fail()).status).toBe(200);
    expect((await one<{ status: string }>('SELECT status FROM ord.sales_order WHERE id = $1', [c(7).orderId])).status).toBe('DELIVERY_FAILED');

    const before = await footprint();
    expect(codes(await post('manager', `/deliveries/${stop}/reschedule`, { slotId: id('slot:S1'), reason: 'Tomorrow' }))).toEqual([422, 'DELIVERY_INVALID', 'NOT_ON_RUN_DAY', 'SLOT_FULL']);
    expect(codes(await post('manager', `/deliveries/${stop}/reschedule`, { slotId: id('slot:S8'), reason: 'Tomorrow evening' }))).toEqual([422, 'DELIVERY_INVALID', 'NOT_ON_RUN_DAY']);
    expect(await footprint()).toBe(before);

    const reattempt = await post('manager', `/deliveries/${stop}/reschedule`, { slotId: id('slot:TB'), reason: 'Customer home after four' });
    expect(reattempt.status, JSON.stringify(reattempt.body)).toBe(200);
    expect(reattempt.body).toMatchObject({ status: 'ASSIGNED', attemptCount: 1, slot: { id: id('slot:TB') } });
    expect((await one<{ status: string }>('SELECT status FROM ord.sales_order WHERE id = $1', [c(7).orderId])).status).toBe('DISPATCHED');
    expect(await count("SELECT count(*)::text AS n FROM ord.order_status_history WHERE sales_order_id = $1 AND from_status = 'DELIVERY_FAILED' AND to_status = 'DISPATCHED'", [c(7).orderId])).toBe(1);
    expect(await booked('TB')).toBe(1);
    expect(await count("SELECT count(*)::text AS n FROM platform.audit_event WHERE entity_id = $1 AND action = 'REATTEMPT'", [stop])).toBe(1);
    // The route shows the booked slot's times.
    const tb = await one<{ starts: string; ends: string }>("SELECT to_char(starts_at, 'HH24:MI') AS starts, to_char(ends_at, 'HH24:MI') AS ends FROM del.delivery_slot WHERE id = $1", [id('slot:TB')]);
    const route = (await get('manager', `/routes/${made.body.id as string}`)).body;
    expect(route.stops[0].delivery).toMatchObject({ id: stop, slotStartsAt: tb.starts, slotEndsAt: tb.ends });

    // Failed again, it is reattempted in the same slot without a second booking.
    expect((await fail()).status).toBe(200);
    expect((await post('manager', `/deliveries/${stop}/reschedule`, { slotId: id('slot:TB'), reason: 'One more try' })).status).toBe(200);
    expect(await booked('TB')).toBe(1);
    expect(await deliveryRow(stop)).toMatchObject({ status: 'ASSIGNED', attempt_count: 2, slot_id: id('slot:TB') });
  });

  it('neither reattempts nor reassigns a failed crate whose write-off waits for approval, writing nothing', async () => {
    const crate = c(6).deliveryId;
    expect((await post('driver', `/driver/deliveries/${crate}/fail`, { id: nextId(), failureReasonCode: 'CUSTOMER_NOT_AVAILABLE', nextAction: 'RETURN_TO_STOCK', occurredAt: clock.now().toISOString() })).status).toBe(200);
    await setThreshold(1);
    try {
      expect((await post('manager', `/deliveries/${crate}/write-off`, { reasonCode: 'UNACCOUNTED_ON_VAN', note: 'Not on the van at the depot' })).status).toBe(202);
    } finally {
      await setThreshold(Number(threshold));
    }
    const before = await footprint();
    expect(codes(await post('manager', `/deliveries/${crate}/reschedule`, { slotId: id('slot:TB'), reason: 'Try again' }))).toEqual([422, 'DELIVERY_INVALID', 'WRITE_OFF_PENDING']);
    expect(codes(await post('manager', `/deliveries/${crate}/assign`, { driverId: id('otherDriver'), vehicleLocationId: id('location:VAN1') }))).toEqual([422, 'DELIVERY_INVALID', 'WRITE_OFF_PENDING']);
    expect(await footprint()).toBe(before);
  });

  it('holds the counts in the database: booked moves only with a delivery, and never above capacity', async () => {
    expect(await sqlStateOf(database.pool('app').query('UPDATE del.delivery_slot SET booked = booked + 1, version = version + 1 WHERE id = $1', [id('slot:S8')]))).toBe('HK004');
    // S1 holds the first crate's one booking; the second crate moved into it by hand is refused by the slot's own check.
    const stays = (await deliveryRow(c(1).deliveryId)).slot_id!;
    expect(await sqlStateOf(database.pool('app').query('UPDATE del.delivery SET slot_id = $1, version = version + 1 WHERE id = $2', [id('slot:S1'), c(1).deliveryId]))).toBe(SQLSTATE.checkViolation);
    expect((await deliveryRow(c(1).deliveryId)).slot_id).toBe(stays);
    // Every slot's count is exactly the live deliveries booked into it.
    const drift = await count(`SELECT count(*)::text AS n FROM del.delivery_slot s
                                WHERE s.booked <> (SELECT count(*) FROM del.delivery d WHERE d.slot_id = s.id AND d.status NOT IN ('CANCELLED', 'RETURNED', 'WRITTEN_OFF'))`);
    expect(drift).toBe(0);
    expect(await booked('S1')).toBe(1);
  });

  afterAll(async () => {
    await setCutoff(cutoff);
  });
});

describe("the checkout's chosen slot is carried onto the delivery and booked at dispatch (A-362 (e), B11 continued 8)", () => {
  it('books the chosen slot while it has room, and dispatches unbooked once it is full, naming both on the event', async () => {
    const zone = (await one<{ id: string }>("SELECT z.id FROM mdm.delivery_zone z WHERE z.branch_id = $1 AND 'Dodowa' = ANY (z.areas)", [branchId])).id;
    const later = toBusinessDate(new Date(clock.now().getTime() + 3 * 86_400_000));
    const made = await post('manager', '/delivery-slots/generate', { zoneId: zone, from: later, to: later, weekdays: [1, 2, 3, 4, 5, 6, 7], times: [{ startsAt: '10:15', endsAt: '11:00', capacity: 1 }] });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const slotId = (await one<{ id: string }>("SELECT id FROM del.delivery_slot WHERE delivery_zone_id = $1 AND slot_date = $2 AND to_char(starts_at, 'HH24:MI') = '10:15'", [zone, later])).id;
    const first = await dispatchedCrate(slotId);
    expect((await one<{ slot: string | null }>('SELECT delivery_slot_id AS slot FROM ord.sales_order WHERE id = $1', [first.orderId])).slot).toBe(slotId);
    expect((await deliveryRow(first.deliveryId)).slot_id).toBe(slotId);
    expect((await one<{ booked: number }>('SELECT booked FROM del.delivery_slot WHERE id = $1', [slotId])).booked).toBe(1);
    const sent = (await one<{ payload: Record<string, unknown> }>("SELECT payload FROM platform.outbox_message WHERE event_type = 'ord.OrderDispatched' AND subject_id = $1", [first.orderId])).payload;
    expect([sent['chosenSlotId'], sent['bookedSlotId']]).toEqual([slotId, slotId]);
    // The second customer chose the same slot of one before the first was dispatched: it is full now.
    const second = await dispatchedCrate(slotId);
    expect((await deliveryRow(second.deliveryId)).slot_id).toBeNull();
    expect((await one<{ booked: number }>('SELECT booked FROM del.delivery_slot WHERE id = $1', [slotId])).booked).toBe(1);
    const unbooked = (await one<{ payload: Record<string, unknown> }>("SELECT payload FROM platform.outbox_message WHERE event_type = 'ord.OrderDispatched' AND subject_id = $1", [second.orderId])).payload;
    expect([unbooked['chosenSlotId'], unbooked['bookedSlotId']]).toEqual([slotId, null]);
  });
});
