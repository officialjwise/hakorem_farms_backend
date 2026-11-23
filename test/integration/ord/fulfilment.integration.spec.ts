import { randomUUID } from 'node:crypto';
import { createUuidV7Generator, ManualClock } from '@hakorem/kernel';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { consoleGet, consolePost, createBranch, createUser, enrolAndLogin, login, relaxRateLimits, testStartTime, type RoleCode, type TestSession } from '../../support/iam';
import { SQLSTATE, sqlStateOf } from '../../support/sql-state';
import { startTestApp, TEST_ORIGIN, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * Picking (FR-ORD-008 to FR-ORD-011, FR-ORD-013, FR-ORD-014, ADR-0021, CR-053, CR-054, CR-056, A-332 to A-335) over the
 * seeded farm. Hand calculations from the seeded prices: beef MEAT-0005 online 3,213 a kg, a 15 kg pack, tolerance 10
 * percent. Two packs estimate 30.000 kg and 96,390 (3,213 x 30); the most without consent is 96,390 + 9,639 = 106,029,
 * and the weight limits 27.000 and 33.000 kg. Packs of 15.200 and 15.600 kg weigh 30.800 kg and price 98,960
 * (98,960.4, half-up once over the line); 34.000 kg prices 109,242, above both limits. One pack at 13.000 kg (below
 * 13.500) prices 41,769. The cold room holds one beef lot of 45 kg; the shop 900 big eggs in one lot (30 crates).
 */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let branchId: string;
const nextId = () => createUuidV7Generator(clock)();
const ids = new Map<string, string>();
const id = (name: string) => ids.get(name)!;
const sessions = new Map<string, TestSession>();
const as = (name: string) => sessions.get(name)!;
const admin = () => database.pool('admin');

interface Guest {
  readonly cartId: string;
  readonly cookie: string;
}
const dodowa = { recipientName: 'Ama Serwaa Ofori', recipientPhone: '0244512876', line1: 'Two houses after the Presby church', area: 'Dodowa', city: 'Dodowa', region: 'Greater Accra' };
const cod = { contactName: 'Kofi Boateng', contactPhone: '0201234567', fulfilmentMode: 'DELIVERY', address: dodowa, paymentTerms: 'COD' };
const guestWrite = (path: string, guest: Guest, body?: object) => {
  const req = request(api.server).post(`/v1${path}`).set('Origin', TEST_ORIGIN).set('Idempotency-Key', randomUUID()).set('Cookie', guest.cookie);
  return body === undefined ? req : req.send(body);
};

/** A guest's cash-on-delivery order of these lines, confirmed at placement (A-232): answers its id. */
async function onlineOrder(lines: ReadonlyArray<[string, string]>): Promise<string> {
  const created = await request(api.server).post('/v1/shop/carts').set('Origin', TEST_ORIGIN).set('Idempotency-Key', randomUUID());
  const cookie = (created.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('__Host-hk_guest='))!;
  const guest = { cartId: created.body.id as string, cookie: cookie.split(';')[0]! };
  for (const [sku, quantity] of lines) expect((await guestWrite(`/shop/carts/${guest.cartId}/lines`, guest, { productId: id(sku), quantity })).status).toBe(200);
  const started = await guestWrite(`/shop/carts/${guest.cartId}/checkout`, guest, cod);
  expect(started.status, JSON.stringify(started.body)).toBe(201);
  const placed = await guestWrite(`/shop/checkouts/${started.body.id as string}/place`, guest, { paymentMethod: 'COD' });
  expect(placed.status, JSON.stringify(placed.body)).toBe(201);
  return placed.body.orderId as string;
}

/** A staff order for Tema Cold Store of eggs by the crate, on cash on delivery, confirmed. */
async function temaOrder(crates: string): Promise<string> {
  const created = await consolePost(api.server, as('sales'), '/v1/orders').send({ channel: 'WHOLESALE', customerId: id('tema'), fulfilmentMode: 'COLLECTION', paymentTerms: 'COD', lines: [{ productId: id('EGG-0003'), quantity: crates, uom: 'CRATE' }] });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const confirmed = await consolePost(api.server, as('sales'), `/v1/orders/${created.body.id as string}/confirm`).send();
  expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
  return created.body.id as string;
}

const post = (who: string, path: string, body: object, key = randomUUID()) => consolePost(api.server, as(who), `/v1${path}`, key).send(body);
const get = (who: string, path: string) => consoleGet(api.server, as(who), `/v1${path}`);
const lineOf = async (orderId: string) => (await get('manager', `/orders/${orderId}`)).body.lines[0];
const pick = (orderLineId: string, unit: string, weightKg: string, extra: object = {}) => ({ id: nextId(), orderLineId, stockUnitId: id(unit), qty: '1.000', weightKg, weightSource: 'SCALE', ...extra });
const historyOf = async (orderId: string) => (await admin().query<{ from_status: string | null; to_status: string }>('SELECT from_status, to_status FROM ord.order_status_history WHERE sales_order_id = $1 ORDER BY recorded_at, id', [orderId])).rows.map((r) => `${r.from_status ?? '-'}>${r.to_status}`);
const outbox = async (type: string, subjectId: string) => Number((await admin().query<{ n: string }>('SELECT count(*)::text AS n FROM platform.outbox_message WHERE event_type = $1 AND subject_id = $2', [type, subjectId])).rows[0]!.n);
const pickRows = async (fulfilmentId: string) =>
  (await admin().query<{ weight: string | null; withdrawn: boolean }>('SELECT weight_kg::text AS weight, withdrawn_at IS NOT NULL AS withdrawn FROM ord.fulfilment_line WHERE fulfilment_id = $1 ORDER BY recorded_at, id', [fulfilmentId])).rows;
const consents = async (orderId: string) =>
  (await admin().query<{ kind: string; status: string; method: string | null; weighed: number | null }>('SELECT kind, status, method, weighed_total_pesewas::int AS weighed FROM ord.order_consent WHERE sales_order_id = $1 ORDER BY asked_at, id', [orderId])).rows;

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
  branchId = (await admin().query<{ id: string }>("SELECT id FROM mdm.branch WHERE code = 'DDW'")).rows[0]!.id;
  for (const row of (await admin().query<{ code: string; id: string }>('SELECT l.code, l.id FROM mdm.location l WHERE l.branch_id = $1', [branchId])).rows) ids.set(`location:${row.code}`, row.id);
  for (const row of (await admin().query<{ sku: string; id: string }>("SELECT p.sku, u.id FROM inv.stock_unit u JOIN mdm.product p ON p.id = u.product_id WHERE p.sku IN ('MEAT-0005', 'EGG-0003') AND u.tracking = 'LOT'")).rows) ids.set(`lot:${row.sku}`, row.id);
  ids.set('tema', (await admin().query<{ id: string }>("SELECT id FROM mdm.customer WHERE name = 'Tema Cold Store Ltd (SEED)'")).rows[0]!.id);
  const staff: [string, string, RoleCode][] = [
    ['storekeeper', 'Yaw Boateng', 'STOREKEEPER'],
    ['sales', 'Kojo Antwi', 'SALES'],
    ['cashier', 'Adwoa Darko', 'CASHIER'],
    ['driver', 'Kwabena Asare', 'DRIVER'],
  ];
  for (const [key, name, role] of staff) sessions.set(key, await login(api.server, await createUser(database, { name, grants: [{ role, branchId }] })));
  sessions.set('manager', await enrolAndLogin(api.server, await createUser(database, { name: 'Abena Owusu', grants: [{ role: 'MANAGER', branchId }] }), () => clock.now()));
  const elsewhere = await createBranch(database, 'TMA');
  sessions.set('otherManager', await enrolAndLogin(api.server, await createUser(database, { name: 'Efua Quaye', grants: [{ role: 'MANAGER', branchId: elsewhere.branchId }] }), () => clock.now()));
  const customer = await createUser(database, { name: 'Esi Asante', realm: 'CUSTOMER' });
  await admin().query('UPDATE mdm.customer SET principal_id = $1, version = version + 1 WHERE id = $2', [customer.principalId, id('tema')]);
  sessions.set('customer', await login(api.server, customer));
});

afterAll(async () => {
  await api?.close();
  await database?.drop();
});

describe('a catch-weight order re-prices at pick and waits for consent beyond its tolerance (FR-ORD-009, FR-ORD-010, the B11 gate)', () => {
  let orderId: string;
  let lineId: string;
  let fulfilmentId: string;
  const first = { a: '', b: '' };

  beforeAll(async () => {
    orderId = await onlineOrder([['MEAT-0005', '2.000']]);
    lineId = (await lineOf(orderId)).id as string;
  });

  it('makes a pick list of the confirmed order at the cold room, numbered PCK, and moves the order to PICKING', async () => {
    const order = (await get('manager', `/orders/${orderId}`)).body;
    expect(order).toMatchObject({ status: 'CONFIRMED', estimatedTotalPesewas: 96_390, deliveryFeePesewas: 0, fulfilments: [], pendingConsent: null });
    expect(order.lines[0]).toMatchObject({ qtyOrdered: '2.000', priceBasis: 'PER_KG', agreedUnitPricePesewas: 3_213, estimatedWeightKg: '30.000', estimatedLineTotalPesewas: 96_390 });
    const made = await post('storekeeper', `/orders/${orderId}/fulfilments`, { pickLocationId: id('location:COLD') });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    fulfilmentId = made.body.id as string;
    expect(made.body.fulfilmentNo).toMatch(/^PCK-\d{4}-DDW-\d{6}$/);
    expect(made.body).toMatchObject({ status: 'PICK_LIST', order: { id: orderId, docType: 'SALES_ORDER' }, pickLocation: { code: 'COLD' }, picker: null, lines: [], weighedTotalPesewas: null, withinTolerance: null });
    expect(made.body.pickList).toEqual([
      {
        orderLineId: lineId,
        product: { id: id('MEAT-0005'), sku: 'MEAT-0005', name: 'Beef, 15 kg pack' },
        qtyToPick: '2.000',
        uom: order.lines[0].uom,
        estimatedWeightKg: '30.000',
        suggestedStockUnits: [expect.objectContaining({ id: id('lot:MEAT-0005'), tracking: 'LOT' })],
        status: 'OPEN',
        pickedQty: '0.000',
        pickedWeightKg: null,
        minimumWeightKg: '27.000',
        maximumWeightKg: '33.000',
        toleranceState: null,
      },
    ]);
    const after = (await get('manager', `/orders/${orderId}`)).body;
    expect(after.status).toBe('PICKING');
    expect(after.fulfilments).toEqual([{ id: fulfilmentId, docType: 'FULFILMENT', number: made.body.fulfilmentNo }]);
    expect(await historyOf(orderId)).toEqual(['->PLACED', 'PLACED>CONFIRMED', 'CONFIRMED>PICKING']);
    const listed = await get('storekeeper', `/fulfilments?orderId=${orderId}`);
    expect(listed.body.data.map((f: { id: string }) => f.id)).toEqual([fulfilmentId]);
  });

  it('prices packs of 15.200 and 15.600 kg at 30.800 kg and 98,960, half-up once over the line, within its tolerance', async () => {
    const a = pick(lineId, 'lot:MEAT-0005', '15.200');
    const b = pick(lineId, 'lot:MEAT-0005', '15.600');
    first.a = a.id;
    first.b = b.id;
    const key = randomUUID();
    const picked = await post('storekeeper', `/fulfilments/${fulfilmentId}/picks`, { picks: [a, b] }, key);
    expect(picked.status, JSON.stringify(picked.body)).toBe(200);
    expect(picked.body).toMatchObject({ status: 'PICKING', picker: { displayName: 'Yaw Boateng' }, weighedTotalPesewas: 98_960, withinTolerance: true });
    expect(picked.body.lines.map((l: { weightKg: string; linePricePesewas: number }) => [l.weightKg, l.linePricePesewas])).toEqual([
      ['15.200', 48_838],
      ['15.600', 50_123],
    ]);
    expect(picked.body.pickList[0]).toMatchObject({ pickedQty: '2.000', pickedWeightKg: '30.800', toleranceState: 'WITHIN' });
    expect(await lineOf(orderId)).toMatchObject({ qtyFulfilled: '2.000', fulfilledWeightKg: '30.800', weightSource: 'SCALE', finalLineTotalPesewas: 98_960 });
    expect((await get('manager', `/orders/${orderId}`)).body).toMatchObject({ status: 'PICKING', pendingConsent: null });

    const replay = await post('storekeeper', `/fulfilments/${fulfilmentId}/picks`, { picks: [a, b] }, key);
    expect(replay.body).toEqual(picked.body);
    const resent = await post('storekeeper', `/fulfilments/${fulfilmentId}/picks`, { picks: [a, b] });
    expect(resent.status).toBe(200);
    expect(await pickRows(fulfilmentId)).toEqual([
      { weight: '15.200', withdrawn: false },
      { weight: '15.600', withdrawn: false },
    ]);
    const reused = await post('storekeeper', `/fulfilments/${fulfilmentId}/picks`, { picks: [{ ...a, weightKg: '15.300' }] });
    expect(reused.status).toBe(422);
    expect(reused.body.error).toMatchObject({ code: 'FULFILMENT_INVALID', details: [expect.objectContaining({ code: 'PICK_ID_REUSED' })] });
  });

  it('refuses a third pack of a line of two, and a catch-weight pack with no weight', async () => {
    const third = await post('storekeeper', `/fulfilments/${fulfilmentId}/picks`, { picks: [pick(lineId, 'lot:MEAT-0005', '14.000')] });
    expect(third.status).toBe(422);
    expect(third.body.error.details).toEqual([expect.objectContaining({ field: '/pickList/1', code: 'PICK_OVER' })]);
    const unweighed = await post('storekeeper', `/fulfilments/${fulfilmentId}/picks`, { withdraw: [first.b], picks: [{ id: nextId(), orderLineId: lineId, stockUnitId: id('lot:MEAT-0005'), qty: '1.000' }] });
    expect(unweighed.status).toBe(422);
    expect(unweighed.body.error.details).toEqual([expect.objectContaining({ code: 'WEIGHT_REQUIRED' })]);
  });

  it('asks the customer when a swapped pack takes the line to 34.000 kg and 109,242, and the order waits AWAITING_CUSTOMER', async () => {
    const heavy = pick(lineId, 'lot:MEAT-0005', '18.800');
    const swapped = await post('storekeeper', `/fulfilments/${fulfilmentId}/picks`, { withdraw: [first.b], picks: [heavy] });
    expect(swapped.status, JSON.stringify(swapped.body)).toBe(200);
    expect(swapped.body).toMatchObject({ weighedTotalPesewas: 109_242, withinTolerance: false });
    expect(swapped.body.pickList[0]).toMatchObject({ pickedWeightKg: '34.000', toleranceState: 'ABOVE' });
    const order = (await get('manager', `/orders/${orderId}`)).body;
    expect(order.status).toBe('AWAITING_CUSTOMER');
    expect(order.pendingConsent).toMatchObject({ kind: 'HIGHER_TOTAL', lineId, proposed: null, proposedTotalPesewas: null, weighedTotalPesewas: 109_242 });
    expect(await outbox('ord.CustomerConsentRequested', orderId)).toBe(1);
    const packed = await post('storekeeper', `/fulfilments/${fulfilmentId}/pack`, { packageCount: 2 });
    expect(packed.status).toBe(422);
    expect(packed.body.error.details).toEqual([expect.objectContaining({ code: 'CONSENT_PENDING' })]);
    first.b = heavy.id;
  });

  it('withdraws the question when a swap brings the line back within its tolerance, and asks again when it goes above once more', async () => {
    const back = pick(lineId, 'lot:MEAT-0005', '15.000');
    const within = await post('storekeeper', `/fulfilments/${fulfilmentId}/picks`, { withdraw: [first.b], picks: [back] });
    expect(within.body).toMatchObject({ weighedTotalPesewas: 97_033, withinTolerance: true });
    expect((await get('manager', `/orders/${orderId}`)).body).toMatchObject({ status: 'PICKING', pendingConsent: null });
    expect(await consents(orderId)).toEqual([{ kind: 'HIGHER_TOTAL', status: 'WITHDRAWN', method: 'SYSTEM', weighed: 109_242 }]);
    const heavy = pick(lineId, 'lot:MEAT-0005', '18.800');
    expect((await post('storekeeper', `/fulfilments/${fulfilmentId}/picks`, { withdraw: [back.id], picks: [heavy] })).status).toBe(200);
    expect((await get('manager', `/orders/${orderId}`)).body.status).toBe('AWAITING_CUSTOMER');
    expect(await historyOf(orderId)).toEqual(['->PLACED', 'PLACED>CONFIRMED', 'CONFIRMED>PICKING', 'PICKING>AWAITING_CUSTOMER', 'AWAITING_CUSTOMER>PICKING', 'PICKING>AWAITING_CUSTOMER']);
  });

  it('records the customer’s consent only by someone who holds ord.order.update and only of the kind asked; then the pick list packs at 109,242', async () => {
    const byStorekeeper = await post('storekeeper', `/orders/${orderId}/consent`, { kind: 'HIGHER_TOTAL', accepted: true, method: 'PHONE' });
    expect(byStorekeeper.status).toBe(403);
    const wrongKind = await post('manager', `/orders/${orderId}/consent`, { kind: 'SUBSTITUTION', accepted: true, method: 'PHONE' });
    expect(wrongKind.status).toBe(422);
    expect(wrongKind.body.error.details).toEqual([expect.objectContaining({ code: 'CONSENT_KIND_MISMATCH' })]);
    const agreed = await post('manager', `/orders/${orderId}/consent`, { kind: 'HIGHER_TOTAL', accepted: true, method: 'PHONE', note: 'Kofi agreed on the phone at 10:40' });
    expect(agreed.status, JSON.stringify(agreed.body)).toBe(200);
    expect(agreed.body).toMatchObject({ status: 'PICKING', pendingConsent: null });
    expect((await get('storekeeper', `/fulfilments/${fulfilmentId}`)).body.withinTolerance).toBe(true);
    const packed = await post('storekeeper', `/fulfilments/${fulfilmentId}/pack`, { packageCount: 2 });
    expect(packed.status, JSON.stringify(packed.body)).toBe(200);
    expect(packed.body).toMatchObject({ status: 'PACKED', packageCount: 2, weighedTotalPesewas: 109_242 });
    expect((await get('manager', `/orders/${orderId}`)).body.status).toBe('PACKED');
    expect(await outbox('ord.FulfilmentPacked', fulfilmentId)).toBe(1);
    expect(await outbox('ord.CustomerConsentAnswered', orderId)).toBe(1);
    const late = await post('storekeeper', `/fulfilments/${fulfilmentId}/picks`, { picks: [pick(lineId, 'lot:MEAT-0005', '1.000')] });
    expect(late.status).toBe(422);
    expect(late.body.error.code).toBe('INVALID_STATE_TRANSITION');
  });
});

describe('a pick never takes stock promised to someone else, and a line below its tolerance packs at the lower total (A-332, ADR-0081)', () => {
  let orderId: string;
  let lineId: string;
  let fulfilmentId: string;

  beforeAll(async () => {
    orderId = await onlineOrder([['MEAT-0005', '1.000']]);
    lineId = (await lineOf(orderId)).id as string;
    fulfilmentId = (await post('storekeeper', `/orders/${orderId}/fulfilments`, { pickLocationId: id('location:COLD') })).body.id as string;
  });

  it('refuses a 20.000 kg pack when the cold room’s 45 kg are all promised and this order holds 15 of them', async () => {
    const { rows } = await admin().query<{ held: string }>("SELECT sum(qty)::text AS held FROM inv.stock_reservation WHERE product_id = $1 AND status = 'ACTIVE'", [id('MEAT-0005')]);
    expect(rows[0]!.held).toBe('45.000');
    const greedy = await post('storekeeper', `/fulfilments/${fulfilmentId}/picks`, { picks: [pick(lineId, 'lot:MEAT-0005', '20.000')] });
    expect(greedy.status).toBe(422);
    expect(greedy.body.error.details).toEqual([expect.objectContaining({ field: '/picks/0/qty', code: 'STOCK_SHORT' })]);
    expect(await pickRows(fulfilmentId)).toEqual([]);
  });

  it('prompts for another pack at 13.000 kg (below 13.500) and packs at 41,769', async () => {
    const light = await post('storekeeper', `/fulfilments/${fulfilmentId}/picks`, { picks: [pick(lineId, 'lot:MEAT-0005', '13.000', { weightSource: 'MANUAL' })] });
    expect(light.status, JSON.stringify(light.body)).toBe(200);
    expect(light.body.pickList[0]).toMatchObject({ toleranceState: 'BELOW', minimumWeightKg: '13.500', maximumWeightKg: '16.500' });
    expect(light.body).toMatchObject({ weighedTotalPesewas: 41_769, withinTolerance: true });
    expect(await lineOf(orderId)).toMatchObject({ fulfilledWeightKg: '13.000', weightSource: 'MANUAL', finalLineTotalPesewas: 41_769 });
    const packed = await post('storekeeper', `/fulfilments/${fulfilmentId}/pack`, { packageCount: 1 });
    expect(packed.status, JSON.stringify(packed.body)).toBe(200);
    expect((await get('manager', `/orders/${orderId}`)).body.status).toBe('PACKED');
  });
});

describe('a short pick only with the customer’s agreement (CR-054 point 2), answered by the customer in their account', () => {
  let orderId: string;
  let lineId: string;
  let fulfilmentId: string;

  beforeAll(async () => {
    orderId = await temaOrder('3.000');
    lineId = (await lineOf(orderId)).id as string;
    fulfilmentId = (await post('storekeeper', `/orders/${orderId}/fulfilments`, { pickLocationId: id('location:SHOP') })).body.id as string;
  });

  it('picks two crates of three and refuses to pack them until the customer agrees', async () => {
    const two = await post('storekeeper', `/fulfilments/${fulfilmentId}/picks`, { picks: [{ id: nextId(), orderLineId: lineId, stockUnitId: id('lot:EGG-0003'), qty: '2.000' }] });
    expect(two.status, JSON.stringify(two.body)).toBe(200);
    expect(two.body.pickList[0]).toMatchObject({ qtyToPick: '3.000', pickedQty: '2.000', toleranceState: null, minimumWeightKg: null });
    const over = await post('storekeeper', `/fulfilments/${fulfilmentId}/picks`, { picks: [{ id: nextId(), orderLineId: lineId, stockUnitId: id('lot:EGG-0003'), qty: '2.000' }] });
    expect(over.body.error.details).toEqual([expect.objectContaining({ code: 'PICK_OVER' })]);
    const packed = await post('storekeeper', `/fulfilments/${fulfilmentId}/pack`, { packageCount: 1 });
    expect(packed.status).toBe(422);
    expect(packed.body.error.details).toEqual([{ field: '/pickList/1', code: 'SHORT_PICK_NOT_AGREED', message: expect.any(String) }]);
  });

  it('proposes two crates; the customer sees the question and agrees in their account; the pick list packs at two', async () => {
    const asked = await post('storekeeper', `/orders/${orderId}/short-picks`, { lineId, quantity: '2.000', note: 'One crate found cracked' });
    expect(asked.status, JSON.stringify(asked.body)).toBe(200);
    expect(asked.body).toMatchObject({ status: 'AWAITING_CUSTOMER', pendingConsent: { kind: 'SHORT_PICK', lineId, proposed: { productId: id('EGG-0003'), quantity: '2.000', uom: 'CRATE' }, proposedTotalPesewas: null } });
    const again = await post('storekeeper', `/orders/${orderId}/short-picks`, { lineId, quantity: '1.000', note: 'Another' });
    expect(again.body.error.details).toEqual([expect.objectContaining({ code: 'CONSENT_PENDING' })]);
    const mine = await consoleGet(api.server, as('customer'), `/v1/me/orders/${orderId}`);
    expect(mine.body.pendingConsent).toMatchObject({ kind: 'SHORT_PICK', proposedTotalPesewas: null });
    const answered = await consolePost(api.server, as('customer'), `/v1/me/orders/${orderId}/consent`).send({ accepted: true });
    expect(answered.status, JSON.stringify(answered.body)).toBe(200);
    expect(answered.body).toMatchObject({ status: 'PICKING', pendingConsent: null });
    expect(await consents(orderId)).toEqual([{ kind: 'SHORT_PICK', status: 'ACCEPTED', method: 'CUSTOMER_ACCOUNT', weighed: null }]);
    const packed = await post('storekeeper', `/fulfilments/${fulfilmentId}/pack`, { packageCount: 1 });
    expect(packed.status, JSON.stringify(packed.body)).toBe(200);
    expect((await get('manager', `/orders/${orderId}`)).body.status).toBe('PACKED');
  });
});

describe('a refusal cancels the line, and the last line the order (FR-ORD-013, FR-ORD-014)', () => {
  it('cancels a one-line order whose customer refuses a smaller quantity: its pick list cancelled, its stock released', async () => {
    const orderId = await temaOrder('2.000');
    const lineId = (await lineOf(orderId)).id as string;
    const fulfilmentId = (await post('storekeeper', `/orders/${orderId}/fulfilments`, { pickLocationId: id('location:SHOP') })).body.id as string;
    expect((await post('storekeeper', `/fulfilments/${fulfilmentId}/picks`, { picks: [{ id: nextId(), orderLineId: lineId, stockUnitId: id('lot:EGG-0003'), qty: '1.000' }] })).status).toBe(200);
    expect((await post('storekeeper', `/orders/${orderId}/short-picks`, { lineId, quantity: '1.000', note: 'One crate cracked' })).status).toBe(200);
    const refused = await post('manager', `/orders/${orderId}/consent`, { kind: 'SHORT_PICK', accepted: false, method: 'PHONE', note: 'Needs both crates or none' });
    expect(refused.status, JSON.stringify(refused.body)).toBe(200);
    expect(refused.body).toMatchObject({ status: 'CANCELLED', pendingConsent: null });
    expect(refused.body.lines[0].lineStatus).toBe('CANCELLED');
    expect((await get('storekeeper', `/fulfilments/${fulfilmentId}`)).body.status).toBe('CANCELLED');
    expect(await pickRows(fulfilmentId)).toEqual([{ weight: null, withdrawn: true }]);
    const held = await admin().query<{ status: string }>('SELECT status FROM inv.stock_reservation WHERE holder_document_id = $1', [orderId]);
    expect(held.rows.map((r) => r.status)).toEqual(held.rows.map(() => 'RELEASED'));
    expect(await historyOf(orderId)).toEqual(['->PLACED', 'PLACED>CONFIRMED', 'CONFIRMED>PICKING', 'PICKING>AWAITING_CUSTOMER', 'AWAITING_CUSTOMER>CANCELLED']);
  });

  it('never lets the person who asked record the customer’s answer by phone (A-334)', async () => {
    const orderId = await temaOrder('2.000');
    const lineId = (await lineOf(orderId)).id as string;
    expect((await post('manager', `/orders/${orderId}/fulfilments`, { pickLocationId: id('location:SHOP') })).status).toBe(201);
    expect((await post('manager', `/orders/${orderId}/short-picks`, { lineId, quantity: '1.000', note: 'One crate cracked' })).status).toBe(200);
    const self = await post('manager', `/orders/${orderId}/consent`, { kind: 'SHORT_PICK', accepted: true, method: 'PHONE' });
    expect(self.status).toBe(422);
    expect(self.body.error.details).toEqual([expect.objectContaining({ code: 'CONSENT_ASKER_CANNOT_ANSWER' })]);
    expect((await get('manager', `/orders/${orderId}`)).body.status).toBe('AWAITING_CUSTOMER');
  });

  it('cancels a picking order with cancelOrder: its pick lists cancelled and its picks withdrawn, nothing moved', async () => {
    const orderId = await temaOrder('1.000');
    const lineId = (await lineOf(orderId)).id as string;
    const fulfilmentId = (await post('storekeeper', `/orders/${orderId}/fulfilments`, { pickLocationId: id('location:SHOP') })).body.id as string;
    expect((await post('storekeeper', `/fulfilments/${fulfilmentId}/picks`, { picks: [{ id: nextId(), orderLineId: lineId, stockUnitId: id('lot:EGG-0003'), qty: '1.000' }] })).status).toBe(200);
    const cancelled = await post('manager', `/orders/${orderId}/cancel`, { reasonCode: 'CUSTOMER_CANCELLED' });
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    expect(cancelled.body.status).toBe('CANCELLED');
    expect((await get('storekeeper', `/fulfilments/${fulfilmentId}`)).body.status).toBe('CANCELLED');
    expect(await pickRows(fulfilmentId)).toEqual([{ weight: null, withdrawn: true }]);
    const moved = await admin().query<{ n: number }>('SELECT count(*)::int AS n FROM inv.stock_movement WHERE source_document_id = $1', [fulfilmentId]);
    expect(moved.rows[0]!.n).toBe(0);
  });
});

describe('a substitute accepted replaces the line, priced by the engine and reserved (FR-ORD-013, CR-054 point 3)', () => {
  it('refuses the same product and a unit the substitute is not sold by; replaces the crate line with a single-egg line on the customer’s word', async () => {
    const orderId = await temaOrder('1.000');
    const lineId = (await lineOf(orderId)).id as string;
    const fulfilmentId = (await post('storekeeper', `/orders/${orderId}/fulfilments`, { pickLocationId: id('location:SHOP') })).body.id as string;
    const same = await post('storekeeper', `/orders/${orderId}/substitutions`, { lineId, productId: id('EGG-0003'), quantity: '1.000', note: 'x' });
    expect(same.body.error.details).toEqual([expect.objectContaining({ code: 'SAME_PRODUCT' })]);
    // Left out, the unit is the line's (a crate), which yam is not sold by.
    const badUnit = await post('storekeeper', `/orders/${orderId}/substitutions`, { lineId, productId: id('PRD-0005'), quantity: '1.000', note: 'x' });
    expect(badUnit.body.error.details).toEqual([expect.objectContaining({ field: '/uom', code: 'UNIT_NOT_SOLD' })]);
    const asked = await post('storekeeper', `/orders/${orderId}/substitutions`, { lineId, productId: id('PRD-0005'), quantity: '2.000', uom: 'TUBER', note: 'No big eggs left; two tubers of yam instead' });
    expect(asked.status, JSON.stringify(asked.body)).toBe(200);
    const proposal = asked.body.pendingConsent;
    expect(proposal).toMatchObject({ kind: 'SUBSTITUTION', lineId, proposed: { productId: id('PRD-0005'), quantity: '2.000' } });
    const byStorekeeper = await post('storekeeper', `/orders/${orderId}/consent`, { kind: 'SUBSTITUTION', accepted: true, method: 'PHONE' });
    expect(byStorekeeper.status).toBe(403);
    const accepted = await post('manager', `/orders/${orderId}/consent`, { kind: 'SUBSTITUTION', accepted: true, method: 'WHATSAPP', note: 'Accepted on WhatsApp' });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    const [original, substitute] = accepted.body.lines as [Record<string, unknown>, Record<string, unknown>];
    expect(original).toMatchObject({ id: lineId, lineStatus: 'SUBSTITUTED' });
    expect(substitute).toMatchObject({ lineNo: 2, product: { id: id('PRD-0005') }, qtyOrdered: '2.000', lineStatus: 'OPEN', priceSource: 'ENGINE', estimatedLineTotalPesewas: proposal.proposedTotalPesewas });
    expect(proposal.proposedTotalPesewas).toBe(2 * (substitute['agreedUnitPricePesewas'] as number));
    const sub = await admin().query<{ substituted_for_line_id: string; reserved: string }>(
      "SELECT l.substituted_for_line_id, (SELECT sum(r.qty)::text FROM inv.stock_reservation r WHERE r.holder_document_id = l.sales_order_id AND r.product_id = l.product_id AND r.status = 'ACTIVE') AS reserved FROM ord.sales_order_line l WHERE l.id = $1",
      [substitute['id']],
    );
    expect(sub.rows[0]).toEqual({ substituted_for_line_id: lineId, reserved: '2.000' });
    const eggsHeld = await admin().query<{ n: number }>("SELECT count(*)::int AS n FROM inv.stock_reservation WHERE holder_document_id = $1 AND product_id = $2 AND status = 'ACTIVE'", [orderId, id('EGG-0003')]);
    expect(eggsHeld.rows[0]!.n).toBe(0);
    const list = (await get('storekeeper', `/fulfilments/${fulfilmentId}`)).body;
    expect(list.pickList.map((p: { orderLineId: string; status: string; qtyToPick: string }) => [p.orderLineId, p.status, p.qtyToPick])).toEqual([
      [lineId, 'CANCELLED', '1.000'],
      [substitute['id'], 'OPEN', '2.000'],
    ]);
  });
});

describe('every write refuses the wrong role and every read the wrong branch (CR-056, ADR-0035)', () => {
  let orderId: string;
  let fulfilmentId: string;

  beforeAll(async () => {
    orderId = await temaOrder('1.000');
    fulfilmentId = (await post('manager', `/orders/${orderId}/fulfilments`, { pickLocationId: id('location:SHOP') })).body.id as string;
  });

  it('refuses the Cashier, the Driver and Sales a pick list, a pick, a pack, a cancel and a proposal', async () => {
    const lineId = (await lineOf(orderId)).id as string;
    for (const who of ['cashier', 'driver', 'sales']) {
      expect((await post(who, `/orders/${orderId}/fulfilments`, { pickLocationId: id('location:SHOP') })).status, who).toBe(403);
      expect((await post(who, `/fulfilments/${fulfilmentId}/picks`, { picks: [] })).status, who).toBe(403);
      expect((await post(who, `/fulfilments/${fulfilmentId}/pack`, { packageCount: 1 })).status, who).toBe(403);
      expect((await post(who, `/fulfilments/${fulfilmentId}/cancel`, { reason: 'x' })).status, who).toBe(403);
      expect((await post(who, `/orders/${orderId}/short-picks`, { lineId, quantity: '0.000', note: 'x' })).status, who).toBe(403);
      expect((await post(who, `/orders/${orderId}/consent`, { kind: 'SHORT_PICK', accepted: true, method: 'PHONE' })).status, who).toBe(403);
    }
    for (const who of ['cashier', 'driver', 'sales']) expect((await get(who, `/fulfilments/${fulfilmentId}`)).status, who).toBe(403);
  });

  it('refuses another branch’s Manager the pick list by its id, lists it to nobody there, and answers 401 to no session', async () => {
    expect((await get('otherManager', `/fulfilments/${fulfilmentId}`)).status).toBe(403);
    expect((await get('otherManager', `/fulfilments?orderId=${orderId}`)).body.data).toEqual([]);
    expect((await post('otherManager', `/fulfilments/${fulfilmentId}/cancel`, { reason: 'x' })).status).toBe(403);
    expect((await request(api.server).get(`/v1/fulfilments/${fulfilmentId}`)).status).toBe(401);
    expect((await get('manager', `/fulfilments/${randomUUID()}`)).status).toBe(404);
  });

  it('gives a customer only their own order’s question: another order is 404', async () => {
    const guestOrder = await onlineOrder([['EGG-0003', '1.000']]);
    const other = await consolePost(api.server, as('customer'), `/v1/me/orders/${guestOrder}/consent`).send({ accepted: true });
    expect(other.status).toBe(404);
    const nothing = await consolePost(api.server, as('customer'), `/v1/me/orders/${orderId}/consent`).send({ accepted: true });
    expect(nothing.status).toBe(422);
    expect(nothing.body.error.details).toEqual([expect.objectContaining({ code: 'NO_CONSENT_PENDING' })]);
  });

  it('cancels a pick list not packed, its picks withdrawn, the order still picking', async () => {
    const cancelled = await post('storekeeper', `/fulfilments/${fulfilmentId}/cancel`, { reason: 'Picked from the wrong shelf' });
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    expect(cancelled.body.status).toBe('CANCELLED');
    expect((await get('manager', `/orders/${orderId}`)).body.status).toBe('PICKING');
    const again = await post('storekeeper', `/orders/${orderId}/fulfilments`, { pickLocationId: id('location:SHOP') });
    expect(again.status).toBe(201);
    expect(again.body.pickList[0].qtyToPick).toBe('1.000');
  });
});

describe('the database holds the picking rules (migration 0294)', () => {
  it('refuses a pick list asking more than the line ordered, a pick above its pick list, a changed pick, a second question and an answer by its asker', async () => {
    const orderId = await temaOrder('1.000');
    const line = await lineOf(orderId);
    const made = (await post('storekeeper', `/orders/${orderId}/fulfilments`, { pickLocationId: id('location:SHOP') })).body;
    const app = database.pool('app');
    const listLine = (await admin().query<{ id: string }>('SELECT id FROM ord.pick_list_line WHERE fulfilment_id = $1', [made.id])).rows[0]!.id;
    const actor = (await admin().query<{ created_by: string }>('SELECT created_by FROM ord.fulfilment WHERE id = $1', [made.id])).rows[0]!.created_by;
    const tooMuch = app.query("INSERT INTO ord.pick_list_line (id, fulfilment_id, sales_order_line_id, line_no, qty_to_pick, status, created_by, updated_by) VALUES ($1, $2, $3, 2, 1, 'OPEN', $4, $4)", [randomUUID(), made.id, line.id, actor]);
    expect(await sqlStateOf(tooMuch)).toBe('HK010');
    const overPick = app.query(
      `INSERT INTO ord.fulfilment_line (id, fulfilment_id, pick_list_line_id, sales_order_line_id, stock_unit_id, qty, qty_base, recorded_at, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, 2, 60, now(), $6, $6)`,
      [randomUUID(), made.id, listLine, line.id, id('lot:EGG-0003'), actor],
    );
    expect(await sqlStateOf(overPick)).toBe('HK010');
    const pickId = randomUUID();
    await app.query(
      `INSERT INTO ord.fulfilment_line (id, fulfilment_id, pick_list_line_id, sales_order_line_id, stock_unit_id, qty, qty_base, recorded_at, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, 1, 30, now(), $6, $6)`,
      [pickId, made.id, listLine, line.id, id('lot:EGG-0003'), actor],
    );
    expect(await sqlStateOf(app.query('UPDATE ord.fulfilment_line SET qty = 0.5 WHERE id = $1', [pickId]))).toBe('HK004');
    expect(await sqlStateOf(app.query('DELETE FROM ord.fulfilment_line WHERE id = $1', [pickId]))).toBe(SQLSTATE.insufficientPrivilege);
    expect(await sqlStateOf(app.query("UPDATE ord.fulfilment SET status = 'PACKED', packed_at = now(), package_count = 1, version = version + 1 WHERE id = $1", [made.id]))).toBe('HK004');
    const ask = (consentId: string) =>
      app.query(
        `INSERT INTO ord.order_consent (id, sales_order_id, sales_order_line_id, kind, status, proposed_qty, proposed_uom, asked_at, branch_id, created_by, updated_by)
         VALUES ($1, $2, $3, 'SHORT_PICK', 'PENDING', 0, 'CRATE', now(), $4, $5, $5)`,
        [consentId, orderId, line.id, branchId, actor],
      );
    const consentId = randomUUID();
    await ask(consentId);
    expect(await sqlStateOf(ask(randomUUID()))).toBe(SQLSTATE.uniqueViolation);
    const selfAnswer = app.query("UPDATE ord.order_consent SET status = 'ACCEPTED', answered_by = $2, answered_at = now(), method = 'PHONE', version = version + 1 WHERE id = $1", [consentId, actor]);
    expect(await sqlStateOf(selfAnswer)).toBe(SQLSTATE.checkViolation);
    const wrongShape = app.query(
      `INSERT INTO ord.order_consent (id, sales_order_id, sales_order_line_id, kind, status, asked_at, branch_id, created_by, updated_by)
       VALUES ($1, $2, $3, 'SUBSTITUTION', 'PENDING', now(), $4, $5, $5)`,
      [randomUUID(), orderId, line.id, branchId, actor],
    );
    expect(await sqlStateOf(wrongShape)).toBe(SQLSTATE.checkViolation);
  });

  it('refuses a pick list of an order that is not confirmed or picking, and one that moves backwards', async () => {
    const created = await consolePost(api.server, as('sales'), '/v1/orders').send({ channel: 'WHOLESALE', customerId: id('tema'), fulfilmentMode: 'COLLECTION', paymentTerms: 'COD', lines: [{ productId: id('EGG-0003'), quantity: '1.000', uom: 'CRATE' }] });
    const placed = await post('storekeeper', `/orders/${created.body.id as string}/fulfilments`, { pickLocationId: id('location:SHOP') });
    expect(placed.status).toBe(422);
    expect(placed.body.error).toMatchObject({ code: 'INVALID_STATE_TRANSITION', details: [expect.objectContaining({ code: 'PLACED' })] });
    const orderId = await temaOrder('1.000');
    const made = (await post('storekeeper', `/orders/${orderId}/fulfilments`, { pickLocationId: id('location:SHOP') })).body;
    expect((await post('storekeeper', `/fulfilments/${made.id as string}/cancel`, { reason: 'Not needed' })).status).toBe(200);
    const back = database.pool('app').query("UPDATE ord.fulfilment SET status = 'PICK_LIST', cancel_reason = NULL, cancelled_by = NULL, cancelled_at = NULL, version = version + 1 WHERE id = $1", [made.id]);
    expect(await sqlStateOf(back)).toBe('HK004');
    const virtual = (await admin().query<{ id: string }>('SELECT id FROM mdm.location WHERE branch_id = $1 AND is_virtual ORDER BY code LIMIT 1', [branchId])).rows[0]!.id;
    const wrongPlace = await post('storekeeper', `/orders/${orderId}/fulfilments`, { pickLocationId: virtual });
    expect(wrongPlace.status).toBe(422);
    expect(wrongPlace.body.error.details).toEqual([expect.objectContaining({ field: '/pickLocationId', code: 'NOT_A_PICK_LOCATION' })]);
  });
});
