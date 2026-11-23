import { randomUUID } from 'node:crypto';
import { createUuidV7Generator, ManualClock } from '@hakorem/kernel';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { PAYSTACK_MTN_TEST_PHONE, paystackEnvironment, startFakePaystack, type FakePaystack } from '../../support/fake-paystack';
import { consoleGet, consolePost, createBranch, createUser, enrolAndLogin, login, relaxRateLimits, testStartTime, type RoleCode, type TestSession } from '../../support/iam';
import { journalOf, runSweep, trialBalanceSum } from '../../support/pay';
import { SQLSTATE, sqlStateOf } from '../../support/sql-state';
import { startTestApp, TEST_ORIGIN, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * Dispatch, delivery and the cash on delivery (FR-ORD-011, FR-BIL-005, FR-DEL-003, FR-DEL-004, FR-DEL-008, FR-DEL-009,
 * ADR-0021, ADR-0091, CR-055 point 1, CR-056, A-337 to A-341): the B11 continued gate, over the seeded farm. Hand
 * figures from the seeded prices: beef MEAT-0005 online 3,213 a kg in 15 kg packs, tolerance 10 percent; the cold room
 * holds one beef lot of 45 kg and the shop 900 big eggs in one lot.
 * - Order A, two packs paid ahead by mobile money at the estimate, 96,390 (3,213 x 30.000): picked 15.200 and 15.600 kg,
 *   30.800 kg at 98,960 (98,960.4 half-up once). Dispatch issues the receipt for 98,960, allocates the 96,390 paid and
 *   fixes 2,570 due on delivery; the driver collects 2,000 with a reason, 570 short.
 * - Order B, one pack of goat meat paid ahead at its estimate (15.000 kg): picked 14.000 kg, so one kilogram's price is
 *   asked back (WEIGHED_BELOW_PAID) and nothing is due; delivered with no cash, it completes.
 * - Order C, one crate of big eggs on cash on delivery: dispatch refused when the shop no longer holds the 30 eggs
 *   picked, then dispatched; the driver collects the crate's price exactly and the order completes.
 */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let fake: FakePaystack;
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
const guestWrite = (path: string, guest: Guest, body?: object) => {
  const req = request(api.server).post(`/v1${path}`).set('Origin', TEST_ORIGIN).set('Idempotency-Key', randomUUID()).set('Cookie', guest.cookie);
  return body === undefined ? req : req.send(body);
};

/** A guest's delivery order of these lines, paid ahead by mobile money (cleared by the provider's sweep) or on cash on delivery. */
async function onlineOrder(lines: ReadonlyArray<[string, string]>, pay: 'MOMO' | 'COD'): Promise<string> {
  const created = await request(api.server).post('/v1/shop/carts').set('Origin', TEST_ORIGIN).set('Idempotency-Key', randomUUID());
  const cookie = (created.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('__Host-hk_guest='))!;
  const guest = { cartId: created.body.id as string, cookie: cookie.split(';')[0]! };
  for (const [sku, quantity] of lines) expect((await guestWrite(`/shop/carts/${guest.cartId}/lines`, guest, { productId: id(sku), quantity })).status).toBe(200);
  const terms = pay === 'COD' ? 'COD' : 'PREPAID';
  const started = await guestWrite(`/shop/carts/${guest.cartId}/checkout`, guest, { contactName: 'Kofi Boateng', contactPhone: '0201234567', fulfilmentMode: 'DELIVERY', address: dodowa, paymentTerms: terms });
  expect(started.status, JSON.stringify(started.body)).toBe(201);
  const body = pay === 'COD' ? { paymentMethod: 'COD' } : { paymentMethod: 'MOBILE_MONEY', payerPhone: PAYSTACK_MTN_TEST_PHONE, network: 'MTN' };
  const placed = await guestWrite(`/shop/checkouts/${started.body.id as string}/place`, guest, body);
  expect(placed.status, JSON.stringify(placed.body)).toBe(201);
  if (pay === 'MOMO') {
    clock.advanceBy(31_000);
    await runSweep(api);
  }
  return placed.body.orderId as string;
}

const post = (who: string, path: string, body: object, key = randomUUID()) => consolePost(api.server, as(who), `/v1${path}`, key).send(body);
const get = (who: string, path: string) => consoleGet(api.server, as(who), `/v1${path}`);
const order = async (orderId: string) => (await get('manager', `/orders/${orderId}`)).body;
const one = async <T extends object>(sql: string, params: unknown[]) => (await admin().query<T & Record<string, unknown>>(sql, params)).rows[0]!;
const count = async (sql: string, params: unknown[]) => Number((await one<{ n: string }>(sql, params)).n);
const outbox = (type: string, subjectId: string) => count('SELECT count(*)::text AS n FROM platform.outbox_message WHERE event_type = $1 AND subject_id = $2', [type, subjectId]);
const payloadOf = async (type: string, subjectId: string) => (await one<{ payload: Record<string, unknown> }>('SELECT payload FROM platform.outbox_message WHERE event_type = $1 AND subject_id = $2', [type, subjectId])).payload;
const onHand = async (location: string, sku: string) =>
  (await one<{ q: string }>('SELECT COALESCE(sum(b.on_hand_qty), 0)::text AS q FROM inv.stock_balance b JOIN mdm.product p ON p.id = b.product_id WHERE b.location_id = $1 AND p.sku = $2', [id(`location:${location}`), sku])).q;
const movements = async (sourceDocumentId: string) =>
  (
    await admin().query<{ type: string; from: string; to: string; qty: string; weight: string | null }>(
      `SELECT m.movement_type AS type, f.code AS from, t.code AS to, m.qty_base::text AS qty, m.weight_kg::text AS weight
         FROM inv.stock_movement m JOIN mdm.location f ON f.id = m.from_location_id JOIN mdm.location t ON t.id = m.to_location_id
        WHERE m.source_document_id = $1 ORDER BY m.occurred_at, m.qty_base`,
      [sourceDocumentId],
    )
  ).rows.map((r) => [r.type, r.from, r.to, r.qty, r.weight]);
const pick = (orderLineId: string, unit: string, qty: string, weightKg?: string) => ({ id: nextId(), orderLineId, stockUnitId: id(unit), qty, ...(weightKg === undefined ? {} : { weightKg, weightSource: 'SCALE' }) });
/** A JPEG as a phone's camera writes it: its bytes distinct per seed. */
const photo = (seed: number) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(1_020, seed)]);
const upload = (who: string, seed: number, purpose = 'PROOF_OF_DELIVERY') => consolePost(api.server, as(who), '/v1/files').field('purpose', purpose).attach('file', photo(seed), 'door.jpg');

/** An order picked and packed at a location: answers the pick list. */
async function packed(orderId: string, location: string, picks: (lineId: string) => object[]): Promise<string> {
  const made = await post('storekeeper', `/orders/${orderId}/fulfilments`, { pickLocationId: id(`location:${location}`) });
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  const lineId = (await order(orderId)).lines[0].id as string;
  const picked = await post('storekeeper', `/fulfilments/${made.body.id as string}/picks`, { picks: picks(lineId) });
  expect(picked.status, JSON.stringify(picked.body)).toBe(200);
  const sealed = await post('storekeeper', `/fulfilments/${made.body.id as string}/pack`, { packageCount: 1 });
  expect(sealed.status, JSON.stringify(sealed.body)).toBe(200);
  return made.body.id as string;
}

/** The server's own account of a 500, for a failing expectation's message. */
const errors = () => JSON.stringify(api.logLines().filter((l) => JSON.stringify(l).includes('rror')).slice(-2)).slice(0, 3000);
const dispatchBody = () => ({ driverId: id('driver'), vehicleLocationId: id('location:VAN1') });
const proof = (extra: object = {}) => ({ id: nextId(), recipientName: 'Ama Serwaa Ofori', photoFileId: id('photo'), latitude: '5.787421', longitude: '-0.112345', positionAccuracyM: 8, capturedAt: clock.now().toISOString(), ...extra });

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
  fake = await startFakePaystack(() => clock.now());
  api = await startTestApp(database, { clock, environment: { ...paystackEnvironment(fake), AUTH_ACCESS_TTL_SECONDS: '43200' } });
  await runSeedUnits(database.pool('app'), api.app, seedUnits({ SEED_STAFF_PASSWORD: `Seed-${randomUUID()}` }));
  for (const row of (await admin().query<{ code: string; id: string }>('SELECT sku AS code, id FROM mdm.product')).rows) ids.set(row.code, row.id);
  branchId = (await admin().query<{ id: string }>("SELECT id FROM mdm.branch WHERE code = 'DDW'")).rows[0]!.id;
  for (const row of (await admin().query<{ code: string; id: string }>('SELECT l.code, l.id FROM mdm.location l WHERE l.branch_id = $1', [branchId])).rows) ids.set(`location:${row.code}`, row.id);
  for (const row of (await admin().query<{ sku: string; id: string }>("SELECT p.sku, u.id FROM inv.stock_unit u JOIN mdm.product p ON p.id = u.product_id WHERE p.sku IN ('MEAT-0005', 'MEAT-0007', 'EGG-0003') AND u.tracking = 'LOT'")).rows) ids.set(`lot:${row.sku}`, row.id);
  const staff: [string, string, RoleCode][] = [
    ['storekeeper', 'Yaw Boateng', 'STOREKEEPER'],
    ['sales', 'Kojo Antwi', 'SALES'],
    ['cashier', 'Adwoa Darko', 'CASHIER'],
    ['driver', 'Kwabena Asare', 'DRIVER'],
    ['otherDriver', 'Kwesi Appiah', 'DRIVER'],
  ];
  for (const [key, name, role] of staff) {
    const user = await createUser(database, { name, grants: [{ role, branchId }] });
    ids.set(key, user.principalId);
    sessions.set(key, await login(api.server, user));
  }
  sessions.set('manager', await enrolAndLogin(api.server, await createUser(database, { name: 'Abena Owusu', grants: [{ role: 'MANAGER', branchId }] }), () => clock.now()));
  const elsewhere = await createBranch(database, 'TMA');
  sessions.set('otherManager', await enrolAndLogin(api.server, await createUser(database, { name: 'Efua Quaye', grants: [{ role: 'MANAGER', branchId: elsewhere.branchId }] }), () => clock.now()));
});

afterAll(async () => {
  await api?.close();
  await fake?.close();
  await database?.drop();
});

describe('dispatch issues the invoice on the weighed quantity and fixes the cash due (FR-ORD-011, FR-BIL-005, ADR-0021, the B11 continued gate)', () => {
  let orderA: string;
  let listA: string;
  let deliveryA: string;
  let key: ReturnType<typeof randomUUID>;
  let first: request.Response;

  beforeAll(async () => {
    orderA = await onlineOrder([['MEAT-0005', '2.000']], 'MOMO');
    listA = await packed(orderA, 'COLD', (line) => [pick(line, 'lot:MEAT-0005', '1.000', '15.200'), pick(line, 'lot:MEAT-0005', '1.000', '15.600')]);
  });

  it('has the order paid ahead at the estimate and packed at the weighed total', async () => {
    const o = await order(orderA);
    expect(o).toMatchObject({ status: 'PACKED', estimatedTotalPesewas: 96_390, deliveryFeePesewas: 0, paymentStatus: 'DEPOSIT_HELD' });
    expect(o.lines[0]).toMatchObject({ fulfilledWeightKg: '30.800', finalLineTotalPesewas: 98_960 });
  });

  it('refuses every role but the Manager and the Owner, and another branch, writing nothing (CR-056)', async () => {
    for (const who of ['storekeeper', 'sales', 'cashier', 'driver', 'otherManager']) {
      const refused = await post(who, `/fulfilments/${listA}/dispatch`, dispatchBody());
      expect(refused.status, who).toBe(403);
    }
    expect((await request(api.server).post(`/v1/fulfilments/${listA}/dispatch`).set('Origin', TEST_ORIGIN).set('Idempotency-Key', randomUUID()).send(dispatchBody())).status).toBe(401);
    expect(await count('SELECT count(*)::text AS n FROM del.delivery WHERE order_document_id = $1', [orderA])).toBe(0);
  });

  it('refuses a dispatch without its driver and vehicle, to someone who does not drive, or onto a place that is not a vehicle', async () => {
    const none = await post('manager', `/fulfilments/${listA}/dispatch`, {});
    expect([none.status, none.body.error.code, none.body.error.details.map((d: { code: string }) => d.code)]).toEqual([422, 'FULFILMENT_INVALID', ['DRIVER_REQUIRED', 'VEHICLE_REQUIRED']]);
    const cashier = await post('manager', `/fulfilments/${listA}/dispatch`, { ...dispatchBody(), driverId: id('cashier') });
    expect([cashier.status, cashier.body.error.code, cashier.body.error.details[0].code]).toEqual([422, 'DELIVERY_INVALID', 'NOT_A_DRIVER']);
    const cold = await post('manager', `/fulfilments/${listA}/dispatch`, { ...dispatchBody(), vehicleLocationId: id('location:COLD') });
    expect([cold.status, cold.body.error?.details[0].code], JSON.stringify(cold.body).slice(0, 600) + errors()).toEqual([422, 'NOT_A_VEHICLE']);
    expect(await count("SELECT count(*)::text AS n FROM bil.billing_document WHERE order_document_id = $1 AND kind <> 'PROFORMA'", [orderA])).toBe(0);
    expect((await order(orderA)).status).toBe('PACKED');
  });

  it('dispatches: the receipt for 98,960 on 30.800 kg, the 96,390 paid allocated, 2,570 due on delivery, the goods onto the van', async () => {
    key = randomUUID();
    first = await post('manager', `/fulfilments/${listA}/dispatch`, dispatchBody(), key);
    expect(first.status, errors()).toBe(200);
    expect(first.body).toMatchObject({ id: listA, status: 'DISPATCHED', weighedTotalPesewas: 98_960 });
    const o = await order(orderA);
    expect(o).toMatchObject({ status: 'DISPATCHED', finalTotalPesewas: 98_960, paidPesewas: 96_390, outstandingPesewas: 2_570, paymentStatus: 'PART_PAID' });
    expect(o.billingDocument).toMatchObject({ docType: 'RECEIPT' });
    expect(o.delivery).toMatchObject({ status: 'ASSIGNED', slotDate: null });
    const doc = (await get('manager', `/billing-documents/${o.billingDocument.id as string}`)).body;
    expect(doc.grossPesewas).toBe(98_960);
    expect(doc.lines.map((l: { quantity: string; uom: string; weightKg: string | null; lineGrossPesewas?: number }) => [l.quantity, l.uom, l.weightKg])).toEqual([['30.800', 'KG', '30.800']]);
    const delivery = (await get('manager', `/deliveries?orderId=${orderA}`)).body.data;
    expect(delivery).toHaveLength(1);
    deliveryA = delivery[0].id as string;
    expect(delivery[0]).toMatchObject({
      status: 'ASSIGNED',
      order: { id: orderA, docType: 'SALES_ORDER' },
      recipientName: 'Ama Serwaa Ofori',
      recipientPhone: '+233244512876',
      driver: { id: id('driver'), displayName: 'Kwabena Asare' },
      vehicle: { id: id('location:VAN1'), code: 'VAN1', kind: 'VEHICLE' },
      codDuePesewas: 2_570,
      codCollectedPesewas: null,
      attemptCount: 0,
      proof: null,
      currency: 'GHS',
      branchId,
    });
    expect(delivery[0].deliveryNo).toMatch(/^DLN-\d{4}-DDW-\d{6}$/);
    expect(delivery[0].contents).toEqual([{ orderLineId: o.lines[0].id, name: 'Beef, 15 kg pack', quantity: '2.000', uom: o.lines[0].uom, weightKg: '30.800' }]);
  });

  it('moves each pack from the cold room onto the van, once, and ends the order\'s promises', async () => {
    expect(await movements(listA)).toEqual([
      ['TRANSFER_INTERNAL', 'COLD', 'VAN1', '15.200', '15.200'],
      ['TRANSFER_INTERNAL', 'COLD', 'VAN1', '15.600', '15.600'],
    ]);
    expect(await onHand('VAN1', 'MEAT-0005')).toBe('30.800');
    expect(await onHand('COLD', 'MEAT-0005')).toBe('14.200');
    expect(await count("SELECT count(*)::text AS n FROM inv.stock_reservation WHERE holder_document_id = $1 AND status = 'ACTIVE'", [orderA])).toBe(0);
    expect(await count('SELECT count(*)::text AS n FROM ord.fulfilment_line WHERE fulfilment_id = $1 AND stock_movement_id IS NOT NULL', [listA])).toBe(2);
  });

  it('posts the receipt and the allocation, and the books still balance', async () => {
    const payment = (await one<{ id: string }>('SELECT id FROM pay.payment WHERE order_document_id = $1 AND driver_id IS NULL', [orderA])).id;
    expect(await journalOf(database, payment, 'pay.DepositAllocated')).toEqual([
      ['2200', 'D', 96_390, 'Walk-in customer'],
      ['1200', 'C', 96_390, 'Walk-in customer'],
    ]);
    expect(await trialBalanceSum(database)).toBe('0');
  });

  it("writes the customer's dispatch message to the outbox once, in the dispatch's transaction, and a replay changes nothing", async () => {
    expect(await outbox('ord.OrderDispatched', orderA)).toBe(1);
    expect(await payloadOf('ord.OrderDispatched', orderA)).toMatchObject({ finalTotalPesewas: 98_960, allocatedPesewas: 96_390, refundRequestedPesewas: 0, codDuePesewas: 2_570, lines: [{ quantity: '2.000', weightKg: '30.800' }] });
    const again = await post('manager', `/fulfilments/${listA}/dispatch`, dispatchBody(), key);
    expect([again.status, again.body]).toEqual([200, first.body]);
    const other = await post('manager', `/fulfilments/${listA}/dispatch`, dispatchBody());
    expect([other.status, other.body.error.code]).toEqual([422, 'INVALID_STATE_TRANSITION']);
    expect(await outbox('ord.OrderDispatched', orderA)).toBe(1);
    expect(await count("SELECT count(*)::text AS n FROM bil.billing_document WHERE order_document_id = $1 AND kind <> 'PROFORMA'", [orderA])).toBe(1);
    expect(await count('SELECT count(*)::text AS n FROM del.delivery WHERE order_document_id = $1', [orderA])).toBe(1);
  });

  describe('the driver reads and records only their own delivery (FR-DEL-004, CR-056)', () => {
    it('shows the driver their delivery with the cash to collect, and refuses it to another driver and to the office by that door', async () => {
      const mine = await get('driver', `/driver/deliveries/${deliveryA}`);
      expect([mine.status, mine.body.codDuePesewas]).toEqual([200, 2_570]);
      for (const who of ['otherDriver', 'manager', 'storekeeper', 'cashier']) expect((await get(who, `/driver/deliveries/${deliveryA}`)).status, who).toBe(403);
      expect((await get('driver', `/driver/deliveries/${randomUUID()}`)).status).toBe(404);
      expect((await get('manager', `/deliveries/${deliveryA}`)).status).toBe(200);
      for (const who of ['driver', 'storekeeper', 'cashier', 'sales', 'otherManager']) expect((await get(who, `/deliveries/${deliveryA}`)).status, who).toBe(403);
      expect((await get('otherManager', `/deliveries?orderId=${orderA}`)).body.data).toEqual([]);
    });

    it('lets the driver upload a proof photograph and a signature, and nothing else', async () => {
      const uploaded = await upload('driver', 1);
      expect(uploaded.status, JSON.stringify(uploaded.body)).toBe(201);
      ids.set('photo', uploaded.body.id as string);
      expect((await upload('driver', 2, 'SIGNATURE')).status).toBe(201);
      for (const purpose of ['EVIDENCE', 'PRODUCT_IMAGE', 'SUPPLIER_INVOICE', 'IMPORT']) expect((await upload('driver', 3, purpose)).status, purpose).toBe(403);
      const theirs = await upload('otherDriver', 4);
      ids.set('otherPhoto', theirs.body.id as string);
    });

    it('refuses a proof with a name only, a file that is not the driver\'s proof, more cash than is due, or less without a reason', async () => {
      const codes = async (body: object) => {
        const r = await post('driver', `/driver/deliveries/${deliveryA}/proof`, body);
        return [r.status, r.body.error?.code, (r.body.error?.details ?? []).map((d: { code: string }) => d.code)];
      };
      expect(await codes(proof({ photoFileId: undefined, codCollectedPesewas: 2_570 }))).toEqual([422, 'DELIVERY_INVALID', ['EVIDENCE_REQUIRED']]);
      expect(await codes(proof({ photoFileId: id('otherPhoto'), codCollectedPesewas: 2_570 }))).toEqual([422, 'DELIVERY_INVALID', ['FILE_NOT_YOURS']]);
      expect(await codes(proof({ photoFileId: randomUUID(), codCollectedPesewas: 2_570 }))).toEqual([422, 'DELIVERY_INVALID', ['FILE_UNKNOWN']]);
      expect(await codes(proof({ codCollectedPesewas: 2_571 }))).toEqual([422, 'DELIVERY_INVALID', ['ABOVE_DUE']]);
      expect(await codes(proof({ codCollectedPesewas: 2_000 }))).toEqual([422, 'DELIVERY_INVALID', ['REASON_REQUIRED']]);
      expect(await codes(proof({ codCollectedPesewas: 2_000, codVarianceReasonCode: 'CUSTOMER_PAID_SHORT' }))).toEqual([422, 'DELIVERY_INVALID', ['NOTE_REQUIRED']]);
      expect(await codes(proof({ codCollectedPesewas: 2_000, codVarianceReasonCode: 'OVERCHARGED', codVarianceNote: 'x' }))).toEqual([422, 'DELIVERY_INVALID', ['REASON_NOT_ALLOWED']]);
      const theirs = await post('otherDriver', `/driver/deliveries/${deliveryA}/proof`, proof({ photoFileId: id('otherPhoto'), codCollectedPesewas: 2_570 }));
      expect(theirs.status).toBe(403);
      for (const who of ['manager', 'storekeeper', 'cashier']) expect((await post(who, `/driver/deliveries/${deliveryA}/proof`, proof({ codCollectedPesewas: 2_570 }))).status, who).toBe(403);
      expect((await get('manager', `/deliveries/${deliveryA}`)).body).toMatchObject({ status: 'ASSIGNED', proof: null });
      // The amount due is the server's from dispatch: nobody changes it while the delivery is out, whoever writes.
      expect(await sqlStateOf(database.pool('app').query('UPDATE del.delivery SET cod_due_pesewas = 0, version = version + 1 WHERE id = $1', [deliveryA]))).toBe(SQLSTATE.documentFrozen);
      expect(await sqlStateOf(admin().query('UPDATE del.delivery SET cod_due_pesewas = 0, version = version + 1 WHERE id = $1', [deliveryA]))).toBe(SQLSTATE.documentFrozen);
    });
  });

  describe('cash on delivery lands against the driver (FR-DEL-009, the B11 continued gate)', () => {
    let proofBody: ReturnType<typeof proof>;

    it('records the proof with 2,000 collected of 2,570, the reason and the 570 short; the order is delivered, not completed', async () => {
      proofBody = proof({ codCollectedPesewas: 2_000, codVarianceReasonCode: 'CUSTOMER_PAID_SHORT', codVarianceNote: 'Paid 20 cedis, will send the rest by MoMo' });
      const done = await post('driver', `/driver/deliveries/${deliveryA}/proof`, proofBody);
      expect(done.status, JSON.stringify(done.body)).toBe(200);
      expect(done.body).toMatchObject({ status: 'DELIVERED', codDuePesewas: 2_570, codCollectedPesewas: 2_000, attemptCount: 1 });
      expect(done.body.proof).toMatchObject({ id: proofBody.id, recipientName: 'Ama Serwaa Ofori', photoFileId: id('photo'), codCollectedPesewas: 2_000, codVarianceReasonCode: 'CUSTOMER_PAID_SHORT', latitude: '5.787421' });
      expect(await order(orderA)).toMatchObject({ status: 'DELIVERED', paidPesewas: 98_390, outstandingPesewas: 570 });
      expect(await payloadOf('del.DeliveryCompleted', deliveryA)).toMatchObject({ codDuePesewas: 2_570, codCollectedPesewas: 2_000, codShortPesewas: 570, codVarianceReasonCode: 'CUSTOMER_PAID_SHORT' });
    });

    it('holds the cash as a payment with the driver, never a till, posted Dr 1020 against the driver and Cr 1200', async () => {
      const payment = await one<{ id: string; kind: string; driver: string; register: string | null; shift: string | null; amount: string; allocated: string }>(
        "SELECT id, method_kind AS kind, driver_id AS driver, register_ref AS register, shift_document_id AS shift, amount_pesewas::text AS amount, allocated_pesewas::text AS allocated FROM pay.payment WHERE order_document_id = $1 AND driver_id IS NOT NULL",
        [orderA],
      );
      expect(payment).toMatchObject({ kind: 'CASH', driver: id('driver'), register: null, shift: null, amount: '2000', allocated: '2000' });
      expect(await journalOf(database, deliveryA, 'del.CodCollected')).toEqual([
        ['1020', 'D', 2_000, 'Kwabena Asare'],
        ['1200', 'C', 2_000, 'Walk-in customer'],
      ]);
      expect(await outbox('pay.PaymentCleared', payment.id)).toBe(0);
      expect(await trialBalanceSum(database)).toBe('0');
    });

    it('issues the goods from the van to the customer, once each pack, and names each line its issue', async () => {
      const issued = await movements(orderA);
      expect(issued).toEqual([
        ['SALE_ISSUE', 'VAN1', 'V-CUSTOMER', '15.200', '15.200'],
        ['SALE_ISSUE', 'VAN1', 'V-CUSTOMER', '15.600', '15.600'],
      ]);
      expect(await onHand('VAN1', 'MEAT-0005')).toBe('0.000');
      expect(await count('SELECT count(*)::text AS n FROM ord.fulfilment_issue i JOIN ord.fulfilment_line l ON l.id = i.fulfilment_line_id WHERE l.fulfilment_id = $1', [listA])).toBe(2);
      expect((await order(orderA)).lines[0].stockMovementId).not.toBeNull();
    });

    it('answers a resent proof with the delivery as it stands and records nothing again; its id on another delivery is refused', async () => {
      const again = await post('driver', `/driver/deliveries/${deliveryA}/proof`, proofBody);
      expect([again.status, again.body.status, again.body.proof.id]).toEqual([200, 'DELIVERED', proofBody.id]);
      expect(await count('SELECT count(*)::text AS n FROM pay.payment WHERE order_document_id = $1 AND driver_id IS NOT NULL', [orderA])).toBe(1);
      expect(await count("SELECT count(*)::text AS n FROM fin.journal_entry WHERE source_document_id = $1 AND event_code = 'del.CodCollected'", [deliveryA])).toBe(1);
      expect(await outbox('del.DeliveryCompleted', deliveryA)).toBe(1);
      ids.set('usedProof', proofBody.id);
    });
  });
});

describe('a lighter weighed total is refunded at dispatch, and a delivery with nothing due completes (ADR-0021)', () => {
  let orderB: string;
  let deliveryB: string;

  it('asks back one kilogram\'s price when a goat meat pack paid ahead at 15.000 kg weighs 14.000 kg, and fixes nothing due', async () => {
    orderB = await onlineOrder([['MEAT-0007', '1.000']], 'MOMO');
    const before = await order(orderB);
    const price = before.lines[0].agreedUnitPricePesewas as number;
    const fee = before.deliveryFeePesewas as number;
    // Hand figures: the estimate is 15 x the price per kg; 14.000 kg weighs 14 x it, once, half-up (an integer already).
    expect(before).toMatchObject({ estimatedTotalPesewas: 15 * price + fee, paymentStatus: 'DEPOSIT_HELD' });
    const list = await packed(orderB, 'COLD', (line) => [pick(line, 'lot:MEAT-0007', '1.000', '14.000')]);
    const sent = await post('manager', `/fulfilments/${list}/dispatch`, dispatchBody());
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    const o = await order(orderB);
    const doc = (await get('manager', `/billing-documents/${o.billingDocument.id as string}`)).body;
    expect(doc.grossPesewas).toBe(14 * price + fee);
    expect(doc.lines.map((l: { lineKind: string }) => l.lineKind)).toEqual(fee === 0 ? ['PRODUCT'] : ['PRODUCT', 'DELIVERY_FEE']);
    const refund = await one<{ amount: string; reason: string; status: string }>('SELECT r.amount_pesewas::text AS amount, r.reason_code AS reason, r.status FROM pay.refund r JOIN pay.payment p ON p.id = r.original_payment_id WHERE p.order_document_id = $1', [orderB]);
    expect(refund).toEqual({ amount: String(price), reason: 'WEIGHED_BELOW_PAID', status: 'PENDING_APPROVAL' });
    deliveryB = (await get('manager', `/deliveries?orderId=${orderB}`)).body.data[0].id as string;
    expect((await get('manager', `/deliveries/${deliveryB}`)).body.codDuePesewas).toBe(0);
    expect(await payloadOf('ord.OrderDispatched', orderB)).toMatchObject({ refundRequestedPesewas: price, codDuePesewas: 0 });
  });

  it('takes a proof with no cash and no reason, and completes the order; a reason with nothing short is refused', async () => {
    const reasoned = await post('driver', `/driver/deliveries/${deliveryB}/proof`, proof({ codCollectedPesewas: 0, codVarianceReasonCode: 'CUSTOMER_PAID_SHORT' }));
    expect([reasoned.status, reasoned.body.error.details[0].code]).toEqual([422, 'REASON_NOT_NEEDED']);
    const reused = await post('driver', `/driver/deliveries/${deliveryB}/proof`, proof({ id: id('usedProof'), codCollectedPesewas: 0 }));
    expect([reused.status, reused.body.error.details[0].code]).toEqual([422, 'ID_IN_USE']);
    const done = await post('driver', `/driver/deliveries/${deliveryB}/proof`, proof({ codCollectedPesewas: 0 }));
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(await order(orderB)).toMatchObject({ status: 'COMPLETED', outstandingPesewas: 0 });
    expect(await count('SELECT count(*)::text AS n FROM pay.payment WHERE order_document_id = $1 AND driver_id IS NOT NULL', [orderB])).toBe(0);
    expect(await count("SELECT count(*)::text AS n FROM fin.journal_entry WHERE source_document_id = $1 AND event_code = 'del.CodCollected'", [deliveryB])).toBe(0);
    expect(await trialBalanceSum(database)).toBe('0');
  });
});

describe('dispatch never takes a location below zero online (ADR-0081, ADR-0091), and cash collected exactly completes the order', () => {
  let orderC: string;
  let listC: string;
  let deliveryC: string;
  const footprint = async () =>
    [
      await count('SELECT count(*)::text AS n FROM bil.billing_document', []),
      await count('SELECT count(*)::text AS n FROM del.delivery', []),
      await count('SELECT count(*)::text AS n FROM inv.stock_movement', []),
      await count('SELECT count(*)::text AS n FROM platform.outbox_message', []),
    ].join('/');

  it('refuses the dispatch, writing nothing, when the shop no longer holds the 30 eggs picked', async () => {
    orderC = await onlineOrder([['EGG-0003', '1.000']], 'COD');
    listC = await packed(orderC, 'SHOP', (line) => [pick(line, 'lot:EGG-0003', '1.000')]);
    // The eggs leave the shop by another door after packing (A-332: a pick moves nothing; the order's promise ended).
    await admin().query("UPDATE inv.stock_reservation SET status = 'RELEASED', released_reason = 'Test: promise ended', version = version + 1 WHERE holder_document_id = $1 AND status = 'ACTIVE'", [orderC]);
    const shop = await onHand('SHOP', 'EGG-0003');
    const lossId = randomUUID();
    await admin().query(
      `INSERT INTO inv.stock_movement (id, movement_type, product_id, stock_unit_id, branch_id, from_location_id, to_location_id, qty_base, reason_code, source_document_id, occurred_at, actor_id)
       VALUES ($1, 'ADJUST_LOSS', $2, $3, $4, $5, (SELECT id FROM mdm.location WHERE branch_id = $4 AND kind = 'LOSS'), $6::numeric - 20, 'BREAKAGE', $7, now(), '01900000-0000-7000-8000-000000000001')`,
      [lossId, id('EGG-0003'), id('lot:EGG-0003'), branchId, id('location:SHOP'), shop, orderC],
    );
    expect(await onHand('SHOP', 'EGG-0003')).toBe('20.000');
    const before = await footprint();
    const refused = await post('manager', `/fulfilments/${listC}/dispatch`, dispatchBody());
    expect([refused.status, refused.body.error.code]).toEqual([422, 'INSUFFICIENT_STOCK']);
    expect(await footprint()).toBe(before);
    expect((await order(orderC)).status).toBe('PACKED');
    await admin().query(
      `INSERT INTO inv.stock_movement (id, movement_type, product_id, stock_unit_id, branch_id, from_location_id, to_location_id, qty_base, reason_code, source_document_id, reverses_movement_id, occurred_at, actor_id)
       SELECT $1, movement_type, product_id, stock_unit_id, branch_id, to_location_id, from_location_id, qty_base, reason_code, source_document_id, id, now(), actor_id FROM inv.stock_movement WHERE id = $2`,
      [randomUUID(), lossId],
    );
  });

  it('dispatches once the eggs are back; the driver collects the crate\'s price exactly and the order completes', async () => {
    const sent = await post('manager', `/fulfilments/${listC}/dispatch`, dispatchBody());
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    const o = await order(orderC);
    const gross = (await get('manager', `/billing-documents/${o.billingDocument.id as string}`)).body.grossPesewas as number;
    deliveryC = (await get('manager', `/deliveries?orderId=${orderC}`)).body.data[0].id as string;
    expect((await get('driver', `/driver/deliveries/${deliveryC}`)).body).toMatchObject({ codDuePesewas: gross, contents: [{ quantity: '1.000', weightKg: null }] });
    const done = await post('driver', `/driver/deliveries/${deliveryC}/proof`, proof({ codCollectedPesewas: gross }));
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(await order(orderC)).toMatchObject({ status: 'COMPLETED', paymentStatus: 'PAID', outstandingPesewas: 0 });
    expect(await journalOf(database, deliveryC, 'del.CodCollected')).toEqual([
      ['1020', 'D', gross, 'Kwabena Asare'],
      ['1200', 'C', gross, 'Walk-in customer'],
    ]);
    expect((await movements(orderC)).filter((m) => m[0] === 'SALE_ISSUE')).toEqual([['SALE_ISSUE', 'VAN1', 'V-CUSTOMER', '30.000', null]]);
    expect(await trialBalanceSum(database)).toBe('0');
  });

  it('holds the rules in the database: the cash due never changes, a proof is never changed, needs its evidence, and a delivered delivery has one', async () => {
    const app = database.pool('app');
    expect(await sqlStateOf(app.query('UPDATE del.delivery SET cod_due_pesewas = 1 WHERE id = $1', [deliveryC]))).toBe(SQLSTATE.documentFrozen);
    expect(await sqlStateOf(app.query('DELETE FROM del.proof_of_delivery WHERE delivery_id = $1', [deliveryC]))).toBe(SQLSTATE.insufficientPrivilege);
    expect(await sqlStateOf(admin().query("UPDATE del.proof_of_delivery SET recipient_name = 'Someone else' WHERE delivery_id = $1", [deliveryC]))).toBe(SQLSTATE.ledgerImmutable);
    expect(await sqlStateOf(admin().query("UPDATE del.delivery_attempt SET outcome = 'FAILED' WHERE delivery_id = $1", [deliveryC]))).toBe(SQLSTATE.ledgerImmutable);
    const due = (await one<{ due: string }>('SELECT cod_due_pesewas::text AS due FROM del.delivery WHERE id = $1', [deliveryC])).due;
    const proofRow = (photo: string | null, collected: string, payment: string | null) =>
      admin().query(
        `INSERT INTO del.proof_of_delivery (id, delivery_id, recipient_name, photo_file_id, cod_collected_pesewas, payment_id, captured_at, created_by)
         VALUES ($1, $2, 'Anyone', $3, $4::bigint, $5, now(), '01900000-0000-7000-8000-000000000001')`,
        [randomUUID(), deliveryC, photo, collected, payment],
      );
    const paid = (await one<{ id: string }>('SELECT payment_id AS id FROM del.proof_of_delivery WHERE delivery_id = $1', [deliveryC])).id;
    expect(await sqlStateOf(proofRow(id('photo'), String(Number(due) + 1), paid))).toBe('HK010');
    expect(await sqlStateOf(proofRow(null, due, paid))).toBe(SQLSTATE.checkViolation);
    expect(await sqlStateOf(proofRow(id('photo'), due, null))).toBe(SQLSTATE.checkViolation);
    expect(await sqlStateOf(proofRow(id('photo'), due, paid))).toBe(SQLSTATE.uniqueViolation);
    expect(await sqlStateOf(admin().query("UPDATE del.delivery SET status = 'ASSIGNED', version = version + 1 WHERE id = $1", [deliveryC]))).toBe(SQLSTATE.documentFrozen);
  });
});
