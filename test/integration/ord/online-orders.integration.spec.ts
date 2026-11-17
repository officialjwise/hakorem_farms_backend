import { randomUUID } from 'node:crypto';
import { ManualClock } from '@hakorem/kernel';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ReservationExpiry } from '../../../src/modules/inv';
import { runAsSystem } from '../../../src/platform/context/request-context';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { PAYSTACK_MTN_TEST_PHONE, paystackEnvironment, startFakePaystack, type FakePaystack } from '../../support/fake-paystack';
import { consoleGet, consolePost, createUser, login, relaxRateLimits, SYSTEM_PRINCIPAL, testStartTime, type RoleCode, type TestSession } from '../../support/iam';
import { initiateCharge, journalOf, referenceFor, runSweep, trialBalanceSum } from '../../support/pay';
import { startTestApp, TEST_ORIGIN, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';
import { SQLSTATE, sqlStateOf } from '../../support/sql-state';

/**
 * Online placement (FR-SHP-005, FR-ORD-001, FR-ORD-005, FR-ORD-014, FR-PAY-003, FR-PAY-008, CR-029, A-232) over the
 * seeded farm, against the local Paystack fake (A-218: its MTN test number pays at once, and the charge clears only by
 * the provider's own answer). A guest places a checkout's order: the order is ONLINE and PLACED, its lines priced by the
 * engine with the checkout's figures, and a charge for the estimate is sent. The order is confirmed only when the
 * payment clears for it (not held as unmatched): the checkout's stock moves to the order and the checkout completes.
 * A hold that lapses first cancels the order and releases the charge, so the late money is held unmatched; a failed
 * charge cancels the order and gives the cart back. Figures are hand calculations from the seeded prices: big eggs
 * 6,000 a crate online, beef 3,213 a kg online (a 15 kg pack estimates 48,195), Dodowa's zone 1,500.
 */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let fake: FakePaystack;
const ids = new Map<string, string>();
const id = (name: string) => ids.get(name)!;
const sessions = new Map<string, TestSession>();
const as = (name: string) => sessions.get(name)!;
const admin = () => database.pool('admin');
const SCHEDULER = '01900000-0000-7000-8000-000000000004';

interface Guest {
  readonly cartId: string;
  readonly cookie: string;
}

const dodowa = { recipientName: 'Ama Serwaa Ofori', recipientPhone: '0244512876', line1: 'Two houses after the Presby church', area: 'Dodowa', city: 'Dodowa', region: 'Greater Accra' };
const collection = { contactName: 'Ama Serwaa Ofori', contactPhone: '+233244512876', fulfilmentMode: 'COLLECTION', paymentTerms: 'PREPAID' };
const momo = { paymentMethod: 'MOBILE_MONEY', payerPhone: PAYSTACK_MTN_TEST_PHONE, network: 'MTN' };

const write = (method: 'post' | 'put', path: string, guest: Guest | null, body?: object, key: string = randomUUID()) => {
  const req = request(api.server)[method](`/v1${path}`).set('Origin', TEST_ORIGIN).set('Idempotency-Key', key);
  if (guest !== null) req.set('Cookie', guest.cookie);
  return body === undefined ? req : req.send(body);
};
const read = (path: string, guest: Guest | null = null) => {
  const req = request(api.server).get(`/v1${path}`);
  return guest === null ? req : req.set('Cookie', guest.cookie);
};

async function newCart(): Promise<Guest> {
  const created = await request(api.server).post('/v1/shop/carts').set('Origin', TEST_ORIGIN).set('Idempotency-Key', randomUUID());
  expect(created.status).toBe(201);
  const cookie = (created.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('__Host-hk_guest='))!;
  return { cartId: created.body.id as string, cookie: cookie.split(';')[0]! };
}

/** A guest's cart with these lines, at checkout: answers the guest and the checkout's id. */
async function atCheckout(lines: ReadonlyArray<[string, string]>, body: object = collection): Promise<{ guest: Guest; checkoutId: string }> {
  const guest = await newCart();
  for (const [sku, quantity] of lines) expect((await write('post', `/shop/carts/${guest.cartId}/lines`, guest, { productId: id(sku), quantity: `${quantity}.000` })).status).toBe(200);
  const started = await write('post', `/shop/carts/${guest.cartId}/checkout`, guest, body);
  expect(started.status, JSON.stringify(started.body)).toBe(201);
  return { guest, checkoutId: started.body.id as string };
}

const place = (guest: Guest | null, checkoutId: string, body: object = momo, key: string = randomUUID()) => write('post', `/shop/checkouts/${checkoutId}/place`, guest, body, key);
const expire = () => runAsSystem({ principalId: SCHEDULER, displayName: 'Scheduler' }, randomUUID(), () => api.app.get(ReservationExpiry).run({ kind: 'SYSTEM', principalId: SCHEDULER }));

async function reserved(holderId: string): Promise<Array<{ product: string; qty: string; status: string; expires: boolean }>> {
  const { rows } = await admin().query<{ sku: string; qty: string; status: string; expires: boolean }>(
    'SELECT p.sku, r.qty::text AS qty, r.status, r.expires_at IS NOT NULL AS expires FROM inv.stock_reservation r JOIN mdm.product p ON p.id = r.product_id WHERE r.holder_document_id = $1 ORDER BY p.sku, r.status, r.qty',
    [holderId],
  );
  return rows.map((r) => ({ product: r.sku, qty: r.qty, status: r.status, expires: r.expires }));
}

async function orderRow(orderId: string) {
  const { rows } = await admin().query<Record<string, unknown>>(
    `SELECT channel, status, payment_terms, fulfilment_mode, customer_id, contact_name, contact_phone_e164, source_document_id, salesperson_id, delivery_zone_id,
            delivery_fee_pesewas::int AS fee, estimated_total_pesewas::int AS estimated, maximum_total_pesewas::int AS maximum, cancel_reason_code, credit_check,
            delivery_address_snapshot->>'area' AS area
       FROM ord.sales_order WHERE id = $1`,
    [orderId],
  );
  return rows[0]!;
}

async function linesOf(orderId: string) {
  const { rows } = await admin().query<Record<string, unknown>>(
    `SELECT p.sku, l.qty_ordered::text AS qty, l.uom, l.price_source, l.price_basis, l.resolved_unit_price_pesewas::int AS resolved, l.agreed_unit_price_pesewas::int AS agreed,
            l.variance_pesewas::int AS variance, l.variance_requires_approval AS flagged, l.estimated_weight_kg::text AS weight, l.tolerance_percent::text AS tolerance,
            l.estimated_line_total_pesewas::int AS total, l.line_status, l.reservation_id IS NOT NULL AS held, l.price_list_entry_id IS NOT NULL AS ruled
       FROM ord.sales_order_line l JOIN mdm.product p ON p.id = l.product_id WHERE l.sales_order_id = $1 ORDER BY l.line_no`,
    [orderId],
  );
  return rows;
}

async function paymentOf(orderId: string) {
  const { rows } = await admin().query<{ id: string; status: string; amount: number; method: string }>(
    'SELECT id, status, amount_pesewas::int AS amount, method_kind AS method FROM pay.payment WHERE order_document_id = $1 ORDER BY received_at',
    [orderId],
  );
  return rows;
}

const checkoutStatus = async (checkoutId: string) => (await admin().query<{ status: string; order_id: string | null }>('SELECT status, order_id FROM shp.checkout_session WHERE id = $1', [checkoutId])).rows[0]!;
const outboxCount = async (type: string, subjectId: string) =>
  Number((await admin().query<{ n: string }>('SELECT count(*)::text AS n FROM platform.outbox_message WHERE event_type = $1 AND subject_id = $2', [type, subjectId])).rows[0]!.n);
const historyOf = async (orderId: string) => (await admin().query<{ from_status: string | null; to_status: string }>('SELECT from_status, to_status FROM ord.order_status_history WHERE sales_order_id = $1 ORDER BY recorded_at, id', [orderId])).rows.map((r) => [r.from_status, r.to_status]);

function keysOf(value: unknown, found: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) value.forEach((v) => keysOf(v, found));
  else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      found.add(key);
      keysOf(item, found);
    }
  }
  return found;
}

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  await relaxRateLimits(database);
  for (const key of ['rate_limit.public.per_address_1m', 'rate_limit.checkout.per_address_10m']) {
    await database.pool('app').query(
      `INSERT INTO platform.setting (id, key, value, value_type, valid_from, description, created_by, updated_by)
       VALUES ($1, $2, '100000', 'INTEGER', now() - interval '1 day', 'Raised for a test file', $3, $3)`,
      [randomUUID(), key, SYSTEM_PRINCIPAL],
    );
  }
  fake = await startFakePaystack(() => clock.now());
  api = await startTestApp(database, { clock, environment: { ...paystackEnvironment(fake), AUTH_ACCESS_TTL_SECONDS: '43200' } });
  await runSeedUnits(database.pool('app'), api.app, seedUnits({ SEED_STAFF_PASSWORD: `Seed-${randomUUID()}` }));
  for (const row of (await admin().query<{ code: string; id: string }>('SELECT sku AS code, id FROM mdm.product')).rows) ids.set(row.code, row.id);
  ids.set('zone:DDW', (await admin().query<{ id: string }>("SELECT z.id FROM mdm.delivery_zone z JOIN mdm.branch b ON b.id = z.branch_id WHERE b.code = 'DDW' ORDER BY z.code LIMIT 1")).rows[0]!.id);
  const branchId = (await admin().query<{ id: string }>("SELECT id FROM mdm.branch WHERE code = 'DDW'")).rows[0]!.id;
  ids.set('tema', (await admin().query<{ id: string }>("SELECT id FROM mdm.customer WHERE name = 'Tema Cold Store Ltd (SEED)'")).rows[0]!.id);
  ids.set('other', (await admin().query<{ id: string }>('SELECT id FROM mdm.customer WHERE id <> $1 AND deleted_at IS NULL ORDER BY customer_no LIMIT 1', [id('tema')])).rows[0]!.id);
  const people: [string, string, RoleCode][] = [
    ['sales', 'Kojo Antwi', 'SALES'],
    ['cashier', 'Adwoa Darko', 'CASHIER'],
  ];
  for (const [key, name, role] of people) sessions.set(key, await login(api.server, await createUser(database, { name, grants: [{ role, branchId }] })));
  const customer = await createUser(database, { name: 'Esi Asante', realm: 'CUSTOMER' });
  await admin().query('UPDATE mdm.customer SET principal_id = $1, version = version + 1 WHERE id = $2', [customer.principalId, id('tema')]);
  sessions.set('customer', await login(api.server, customer));
  const stranger = await createUser(database, { name: 'Kwame Mensah', realm: 'CUSTOMER' });
  await admin().query('UPDATE mdm.customer SET principal_id = $1, version = version + 1 WHERE id = $2', [stranger.principalId, id('other')]);
  sessions.set('stranger', await login(api.server, stranger));
});

afterAll(async () => {
  await api?.close();
  await fake?.close();
  await database?.drop();
});

describe('placeOrder: a guest places the checkout and the charge is sent (FR-SHP-005, FR-PAY-003)', () => {
  let guest: Guest;
  let checkoutId: string;
  let placed: request.Response;
  let key: string;

  beforeAll(async () => {
    ({ guest, checkoutId } = await atCheckout([['EGG-0003', '2']]));
    key = randomUUID();
    placed = await place(guest, checkoutId, momo, key);
  });

  it('answers 201 with the order, a signed tracking token and the pending charge; the checkout awaits payment', () => {
    expect(placed.status, JSON.stringify(placed.body)).toBe(201);
    expect(placed.body.orderNo).toMatch(/^SO-\d{4}-DDW-\d{6}$/);
    expect(placed.body.trackingToken).toMatch(/^trk_[A-Za-z0-9_-]{40,}$/);
    expect(placed.body.trackingToken).not.toContain(placed.body.orderId);
    expect(placed.body.payment).toMatchObject({ status: 'PENDING', redirectUrl: null });
    expect(placed.body.payment.instructions).toContain('GHS 120.00');
    expect(placed.body.checkout).toMatchObject({ id: checkoutId, status: 'AWAITING_PAYMENT', orderId: placed.body.orderId, estimatedTotalPesewas: 12_000 });
  });

  it('writes one ONLINE order PLACED for the guest, from the checkout, every line priced by the engine at the checkout’s figures', async () => {
    const orderId = placed.body.orderId as string;
    expect(await orderRow(orderId)).toMatchObject({
      channel: 'ONLINE',
      status: 'PLACED',
      payment_terms: 'PREPAID',
      fulfilment_mode: 'COLLECTION',
      customer_id: null,
      contact_name: 'Ama Serwaa Ofori',
      contact_phone_e164: '+233244512876',
      source_document_id: checkoutId,
      salesperson_id: null,
      fee: 0,
      estimated: 12_000,
      maximum: 12_000,
    });
    expect(await linesOf(orderId)).toEqual([
      expect.objectContaining({ sku: 'EGG-0003', qty: '2.000', price_source: 'ENGINE', price_basis: 'PER_UNIT', resolved: 6_000, agreed: 6_000, variance: 0, flagged: false, total: 12_000, line_status: 'OPEN', ruled: true }),
    ]);
    expect(await historyOf(orderId)).toEqual([[null, 'PLACED']]);
    expect(await outboxCount('ord.OrderPlaced', orderId)).toBe(1);
  });

  it('records the charge PENDING for exactly the estimate and sends it once; the stock stays with the checkout', async () => {
    const orderId = placed.body.orderId as string;
    expect(await paymentOf(orderId)).toEqual([{ id: placed.body.payment.paymentId, status: 'PENDING', amount: 12_000, method: 'MOBILE_MONEY' }]);
    expect(fake.transactions.get(referenceFor(placed.body.payment.paymentId as string))).toMatchObject({ amount: 12_000 });
    expect(await reserved(checkoutId)).toEqual([{ product: 'EGG-0003', qty: '2.000', status: 'ACTIVE', expires: true }]);
    expect(await reserved(orderId)).toEqual([]);
    expect((await read(`/shop/carts/${guest.cartId}`, guest)).body).toMatchObject({ status: 'CHECKOUT', checkoutId });
  });

  it('answers a replay with the same order and sends no second charge; another key finds the checkout closed', async () => {
    const charges = fake.calls.filter((c) => c.path === '/charge').length;
    const again = await place(guest, checkoutId, momo, key);
    expect([again.status, again.body.orderId, again.body.payment.paymentId]).toEqual([201, placed.body.orderId, placed.body.payment.paymentId]);
    expect(fake.calls.filter((c) => c.path === '/charge').length).toBe(charges);
    const other = await place(guest, checkoutId);
    expect([other.status, other.body.error.code]).toEqual([409, 'CHECKOUT_NOT_OPEN']);
    expect(Number((await admin().query<{ n: string }>('SELECT count(*)::text AS n FROM ord.sales_order WHERE source_document_id = $1', [checkoutId])).rows[0]!.n)).toBe(1);
  });

  it('tells a stranger and a request with no cookie that the checkout does not exist', async () => {
    const { checkoutId: mine } = await atCheckout([['EGG-0003', '1']]);
    const stranger = await newCart();
    expect((await place(stranger, mine)).status).toBe(404);
    expect((await place(null, mine)).status).toBe(404);
    expect((await checkoutStatus(mine)).status).toBe('STARTED');
  });

  it('confirms the order once its payment clears: the stock moves to the order, the checkout completes and the cart has no checkout again (CR-029)', async () => {
    const orderId = placed.body.orderId as string;
    const paymentId = placed.body.payment.paymentId as string;
    clock.advanceBy(31_000);
    await runSweep(api);
    expect((await paymentOf(orderId))[0]).toMatchObject({ status: 'CLEARED', amount: 12_000 });
    expect(await journalOf(database, paymentId, 'pay.PaymentCleared')).toEqual([
      ['1120', 'D', 12_000, expect.any(String)],
      ['2200', 'C', 12_000, expect.any(String)],
    ]);
    expect(await orderRow(orderId)).toMatchObject({ status: 'CONFIRMED', credit_check: 'NOT_REQUIRED' });
    expect(await historyOf(orderId)).toEqual([
      [null, 'PLACED'],
      ['PLACED', 'CONFIRMED'],
    ]);
    expect(await reserved(orderId)).toEqual([{ product: 'EGG-0003', qty: '2.000', status: 'ACTIVE', expires: false }]);
    expect(await reserved(checkoutId)).toEqual([{ product: 'EGG-0003', qty: '2.000', status: 'RELEASED', expires: true }]);
    expect((await linesOf(orderId))[0]).toMatchObject({ held: true });
    expect(await checkoutStatus(checkoutId)).toEqual({ status: 'COMPLETED', order_id: orderId });
    expect((await read(`/shop/carts/${guest.cartId}`, guest)).body).toMatchObject({ status: 'CONVERTED', checkoutId: null });
    expect(await outboxCount('ord.OrderConfirmed', orderId)).toBe(1);
    const staff = await consoleGet(api.server, as('sales'), `/v1/orders/${orderId}`);
    expect(staff.body).toMatchObject({ channel: 'ONLINE', status: 'CONFIRMED', paymentStatus: 'DEPOSIT_HELD', paidPesewas: 12_000, outstandingPesewas: 0 });
    expect(await trialBalanceSum(database)).toBe('0');
  });

  it('changes nothing on a second sweep or a late expiry run', async () => {
    const orderId = placed.body.orderId as string;
    await runSweep(api);
    clock.advanceBy(20 * 60_000);
    await expire();
    expect(await orderRow(orderId)).toMatchObject({ status: 'CONFIRMED' });
    expect(await outboxCount('ord.OrderConfirmed', orderId)).toBe(1);
    expect(await reserved(orderId)).toEqual([{ product: 'EGG-0003', qty: '2.000', status: 'ACTIVE', expires: false }]);
  });
});

describe('placeOrder for cash on delivery: confirmed at once, the delivery and its fee on the order', () => {
  it('places 2 crates to Dodowa at 13,500 (12,000 and the fee of 1,500), confirmed with no charge, the checkout completed', async () => {
    const { guest, checkoutId } = await atCheckout([['EGG-0003', '2']], { contactName: 'Kofi Boateng', contactPhone: '0201234567', fulfilmentMode: 'DELIVERY', address: dodowa, paymentTerms: 'COD' });
    const placed = await place(guest, checkoutId, { paymentMethod: 'COD' });
    expect(placed.status, JSON.stringify(placed.body)).toBe(201);
    expect(placed.body.payment).toBeNull();
    const orderId = placed.body.orderId as string;
    expect(await orderRow(orderId)).toMatchObject({ status: 'CONFIRMED', payment_terms: 'COD', fulfilment_mode: 'DELIVERY', delivery_zone_id: id('zone:DDW'), fee: 1_500, estimated: 13_500, maximum: 13_500, area: 'Dodowa', credit_check: 'NOT_REQUIRED' });
    expect(await paymentOf(orderId)).toEqual([]);
    expect(await reserved(orderId)).toEqual([{ product: 'EGG-0003', qty: '2.000', status: 'ACTIVE', expires: false }]);
    expect(placed.body.checkout).toMatchObject({ status: 'COMPLETED', orderId });
    expect((await read(`/shop/carts/${guest.cartId}`, guest)).body).toMatchObject({ status: 'CONVERTED', checkoutId: null });
  });
});

describe('placeOrder refuses what this phase does not take, and changes nothing', () => {
  it('refuses a method that does not match the terms, a card, a mobile money charge without its phone or network, and a coupon', async () => {
    const { guest, checkoutId } = await atCheckout([['EGG-0003', '1']]);
    const cases: Array<[object, string]> = [
      [{ paymentMethod: 'COD' }, 'PAYMENT_METHOD_MISMATCH'],
      [{ paymentMethod: 'CARD' }, 'CARD_NOT_AVAILABLE'],
      [{ paymentMethod: 'MOBILE_MONEY', network: 'MTN' }, 'PAYER_PHONE_REQUIRED'],
      [{ paymentMethod: 'MOBILE_MONEY', payerPhone: PAYSTACK_MTN_TEST_PHONE }, 'NETWORK_REQUIRED'],
    ];
    for (const [body, rule] of cases) {
      const refused = await place(guest, checkoutId, body);
      expect([refused.status, refused.body.error.code, refused.body.error.details[0].code], rule).toEqual([422, 'CHECKOUT_INVALID', rule]);
    }
    expect((await checkoutStatus(checkoutId)).status).toBe('STARTED');
    const coupon = await newCart();
    await write('post', `/shop/carts/${coupon.cartId}/lines`, coupon, { productId: id('EGG-0003'), quantity: '1.000' });
    expect((await write('put', `/shop/carts/${coupon.cartId}/coupon`, coupon, { code: 'welcome10' })).status).toBe(200);
    const started = await write('post', `/shop/carts/${coupon.cartId}/checkout`, coupon, collection);
    expect(started.status).toBe(201);
    const discounted = await place(coupon, started.body.id as string);
    expect([discounted.status, discounted.body.error?.details?.[0]?.code]).toEqual([422, 'PROMOTION_NOT_AVAILABLE']);
    expect(Number((await admin().query<{ n: string }>('SELECT count(*)::text AS n FROM ord.sales_order WHERE source_document_id = ANY($1::uuid[])', [[checkoutId, started.body.id]])).rows[0]!.n)).toBe(0);
  });

  it('refuses a price the engine no longer gives (422 ORDER_INVALID PRICE_CHANGED), placing nothing', async () => {
    const { guest, checkoutId } = await atCheckout([['EGG-0003', '2']]);
    // As if the online list changed after the checkout priced the line: the checkout says 5,900, the engine 6,000.
    // Lines are written once (trg on shp.checkout_line), so the test steps past the trigger as the superuser.
    await admin().query(`BEGIN; SET LOCAL session_replication_role = replica; UPDATE shp.checkout_line SET unit_price_pesewas = 5900 WHERE checkout_id = '${checkoutId}'; COMMIT`);
    const refused = await place(guest, checkoutId);
    expect([refused.status, refused.body.error.code, refused.body.error.details[0].code]).toEqual([422, 'ORDER_INVALID', 'PRICE_CHANGED']);
    expect((await checkoutStatus(checkoutId)).status).toBe('STARTED');
    expect(await paymentOf(checkoutId)).toEqual([]);
  });

  it('refuses a checkout whose hold has lapsed (409 CHECKOUT_NOT_OPEN)', async () => {
    const { guest, checkoutId } = await atCheckout([['EGG-0003', '1']]);
    clock.advanceBy(16 * 60_000);
    const late = await place(guest, checkoutId);
    expect([late.status, late.body.error.code]).toEqual([409, 'CHECKOUT_NOT_OPEN']);
  });
});

describe('catch weight at placement (ADR-0021): the estimate is charged, the tolerance kept on the line', () => {
  it('places one 15 kg beef pack at 3,213 a kg: 48,195 estimated, the checkout’s maximum, the pack’s weight and tolerance on the line', async () => {
    const { guest, checkoutId } = await atCheckout([['MEAT-0005', '1']]);
    const shown = (await read(`/shop/checkouts/${checkoutId}`, guest)).body;
    const placed = await place(guest, checkoutId);
    expect(placed.status, JSON.stringify(placed.body)).toBe(201);
    const orderId = placed.body.orderId as string;
    expect(await orderRow(orderId)).toMatchObject({ estimated: 48_195, maximum: shown.maximumTotalPesewas });
    expect(await linesOf(orderId)).toEqual([
      expect.objectContaining({ sku: 'MEAT-0005', qty: '1.000', uom: shown.lines[0].uom, price_basis: 'PER_KG', resolved: 3_213, agreed: 3_213, weight: '15.000', total: 48_195, variance: 0 }),
    ]);
    expect((await linesOf(orderId))[0]!['tolerance']).not.toBeNull();
    expect(await paymentOf(orderId)).toEqual([expect.objectContaining({ amount: 48_195, status: 'PENDING' })]);
  });
});

describe('the order stops waiting when its hold lapses or its charge fails (FR-ORD-014, FR-PAY-008)', () => {
  it('cancels the order when the checkout’s hold expires and releases the charge: money paid afterwards is held unmatched, never the order’s', async () => {
    const { guest, checkoutId } = await atCheckout([['EGG-0003', '1']]);
    const placed = await place(guest, checkoutId);
    const orderId = placed.body.orderId as string;
    const paymentId = placed.body.payment.paymentId as string;
    // The customer has not approved yet: the fake's MTN number pays at once, so the test holds the transaction open.
    fake.transactions.get(referenceFor(paymentId))!.status = 'ongoing';
    fake.transactions.get(referenceFor(paymentId))!.paidAt = null;
    clock.advanceBy(16 * 60_000);
    await expire();
    expect(await orderRow(orderId)).toMatchObject({ status: 'CANCELLED', cancel_reason_code: 'PAYMENT_NOT_RECEIVED' });
    expect(await checkoutStatus(checkoutId)).toMatchObject({ status: 'EXPIRED' });
    expect((await read(`/shop/carts/${guest.cartId}`, guest)).body).toMatchObject({ status: 'ACTIVE', checkoutId: null });
    const released = await admin().query<{ released: boolean }>('SELECT released_at IS NOT NULL AS released FROM pay.provider_transaction WHERE payment_id = $1', [paymentId]);
    expect(released.rows[0]!.released).toBe(true);
    fake.approve(referenceFor(paymentId));
    await runSweep(api);
    expect((await paymentOf(orderId))[0]).toMatchObject({ status: 'CLEARED' });
    const breaks = await admin().query<{ kind: string }>('SELECT kind FROM pay.reconciliation_break WHERE payment_id = $1', [paymentId]);
    expect(breaks.rows.map((b) => b.kind)).toEqual(['UNMATCHED_PAYMENT']);
    expect(await orderRow(orderId)).toMatchObject({ status: 'CANCELLED' });
    expect(await reserved(orderId)).toEqual([]);
    expect(await outboxCount('ord.OrderConfirmed', orderId)).toBe(0);
    expect(await trialBalanceSum(database)).toBe('0');
  });

  it('never confirms on money paid after the charge window, even before the expiry job has ended the hold', async () => {
    const { guest, checkoutId } = await atCheckout([['EGG-0003', '1']]);
    const placed = await place(guest, checkoutId);
    const orderId = placed.body.orderId as string;
    const paymentId = placed.body.payment.paymentId as string;
    fake.transactions.get(referenceFor(paymentId))!.status = 'ongoing';
    fake.transactions.get(referenceFor(paymentId))!.paidAt = null;
    clock.advanceBy(16 * 60_000);
    fake.approve(referenceFor(paymentId));
    await runSweep(api);
    expect((await paymentOf(orderId))[0]).toMatchObject({ status: 'CLEARED' });
    expect((await admin().query<{ kind: string }>('SELECT kind FROM pay.reconciliation_break WHERE payment_id = $1', [paymentId])).rows.map((b) => b.kind)).toEqual(['UNMATCHED_PAYMENT']);
    expect(await orderRow(orderId)).toMatchObject({ status: 'PLACED' });
    expect(await reserved(orderId)).toEqual([]);
    await expire();
    expect(await orderRow(orderId)).toMatchObject({ status: 'CANCELLED', cancel_reason_code: 'PAYMENT_NOT_RECEIVED' });
    expect(await reserved(orderId)).toEqual([]);
    expect(await trialBalanceSum(database)).toBe('0');
  });

  it('never confirms on less than the estimate: a smaller payment a cashier takes against the order leaves it waiting', async () => {
    const { guest, checkoutId } = await atCheckout([['EGG-0003', '2']]);
    const placed = await place(guest, checkoutId);
    const orderId = placed.body.orderId as string;
    fake.transactions.get(referenceFor(placed.body.payment.paymentId as string))!.status = 'ongoing';
    fake.transactions.get(referenceFor(placed.body.payment.paymentId as string))!.paidAt = null;
    const part = await initiateCharge(api.server, as('cashier'), { amountPesewas: 1_000, orderId, payerPhone: '+233551234987', network: 'MTN' });
    expect(part.status, JSON.stringify(part.body)).toBe(201);
    clock.advanceBy(31_000);
    await runSweep(api);
    expect((await paymentOf(orderId)).map((p) => [p.amount, p.status])).toEqual([
      [12_000, 'PENDING'],
      [1_000, 'CLEARED'],
    ]);
    expect(await orderRow(orderId)).toMatchObject({ status: 'PLACED' });
    expect(await reserved(orderId)).toEqual([]);
    expect(await reserved(checkoutId)).toEqual([{ product: 'EGG-0003', qty: '2.000', status: 'ACTIVE', expires: true }]);
  });

  it('cancels the order when its charge fails, releasing the checkout’s stock and giving the cart back', async () => {
    const { guest, checkoutId } = await atCheckout([['EGG-0003', '1']]);
    const placed = await place(guest, checkoutId);
    const orderId = placed.body.orderId as string;
    fake.transactions.get(referenceFor(placed.body.payment.paymentId as string))!.status = 'failed';
    fake.transactions.get(referenceFor(placed.body.payment.paymentId as string))!.paidAt = null;
    clock.advanceBy(31_000);
    await runSweep(api);
    expect((await paymentOf(orderId))[0]).toMatchObject({ status: 'FAILED' });
    expect(await orderRow(orderId)).toMatchObject({ status: 'CANCELLED', cancel_reason_code: 'PAYMENT_NOT_RECEIVED' });
    expect(await reserved(checkoutId)).toEqual([{ product: 'EGG-0003', qty: '1.000', status: 'RELEASED', expires: true }]);
    expect(await checkoutStatus(checkoutId)).toMatchObject({ status: 'CANCELLED' });
    expect((await read(`/shop/carts/${guest.cartId}`, guest)).body).toMatchObject({ status: 'ACTIVE', checkoutId: null });
  });

  it('a staff cancellation of a placed online order releases the checkout’s stock and its pending charge', async () => {
    const { guest, checkoutId } = await atCheckout([['EGG-0003', '1']]);
    const placed = await place(guest, checkoutId);
    const orderId = placed.body.orderId as string;
    const cancelled = await consolePost(api.server, as('sales'), `/v1/orders/${orderId}/cancel`).send({ reasonCode: 'CUSTOMER_CANCELLED' });
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    expect(await reserved(checkoutId)).toEqual([{ product: 'EGG-0003', qty: '1.000', status: 'RELEASED', expires: true }]);
    expect(await checkoutStatus(checkoutId)).toMatchObject({ status: 'CANCELLED' });
    expect((await read(`/shop/carts/${guest.cartId}`, guest)).body).toMatchObject({ status: 'ACTIVE', checkoutId: null });
    const released = await admin().query<{ released: boolean }>('SELECT released_at IS NOT NULL AS released FROM pay.provider_transaction WHERE payment_id = $1', [placed.body.payment.paymentId]);
    expect(released.rows[0]!.released).toBe(true);
    expect(await orderRow(orderId)).toMatchObject({ status: 'CANCELLED', cancel_reason_code: 'CUSTOMER_CANCELLED' });
  });
});

describe('the database holds one online order per checkout, and a checkout awaiting payment names its order', () => {
  it('refuses a second ONLINE order from the same checkout and an awaiting checkout with no order, by direct SQL', async () => {
    const { guest, checkoutId } = await atCheckout([['EGG-0003', '1']]);
    const placed = await place(guest, checkoutId);
    expect(placed.status).toBe(201);
    const copy = randomUUID();
    const app = database.pool('app');
    await app.query("INSERT INTO platform.business_document (id, doc_type, owner_module, branch_id, actor_id) SELECT $1, 'SALES_ORDER', 'ord', branch_id, $2 FROM ord.sales_order WHERE id = $3", [copy, SYSTEM_PRINCIPAL, placed.body.orderId]);
    const second = app.query(
      `INSERT INTO ord.sales_order (id, channel, contact_name, contact_phone_e164, status, payment_terms, fulfilment_mode, source_document_id, tax_inclusive, estimated_total_pesewas, maximum_total_pesewas, placed_at, branch_id, created_by, updated_by)
       SELECT $1, 'ONLINE', contact_name, contact_phone_e164, 'PLACED', payment_terms, fulfilment_mode, source_document_id, true, estimated_total_pesewas, maximum_total_pesewas, placed_at, branch_id, $2, $2 FROM ord.sales_order WHERE id = $3`,
      [copy, SYSTEM_PRINCIPAL, placed.body.orderId],
    );
    expect(await sqlStateOf(second)).toBe(SQLSTATE.uniqueViolation);
    const { checkoutId: open } = await atCheckout([['EGG-0003', '1']]);
    expect(await sqlStateOf(app.query("UPDATE shp.checkout_session SET status = 'AWAITING_PAYMENT', version = version + 1 WHERE id = $1", [open]))).toBe(SQLSTATE.checkViolation);
  });
});

describe('trackOrder: the signed link, read by anyone holding it', () => {
  it('shows the order’s progress without the customer’s details, and refuses a tampered token or the order id', async () => {
    const { guest, checkoutId } = await atCheckout([['EGG-0003', '1']]);
    const placed = await place(guest, checkoutId);
    const token = placed.body.trackingToken as string;
    const tracked = await read(`/shop/orders/track/${token}`);
    expect(tracked.status).toBe(200);
    expect(tracked.body).toMatchObject({ orderNo: placed.body.orderNo, status: 'PLACED', fulfilmentMode: 'COLLECTION', delivery: null, estimatedTotalPesewas: 6_000, finalTotalPesewas: null, paidPesewas: 0, currency: 'GHS' });
    expect(tracked.body.lines).toEqual([{ name: expect.any(String), quantity: '1.000', uom: expect.any(String), weightKg: null }]);
    expect(tracked.body.steps[0]).toMatchObject({ status: 'PLACED', done: true });
    expect(tracked.body.steps.slice(1).every((s: { done: boolean }) => !s.done)).toBe(true);
    const keys = [...keysOf(tracked.body)].map((k) => k.toLowerCase());
    expect(keys.filter((k) => /phone|contact|address|cost|floor|ceiling|variance|customer/.test(k))).toEqual([]);
    const tampered = `${token.slice(0, -2)}${token.endsWith('AA') ? 'BB' : 'AA'}`;
    expect((await read(`/shop/orders/track/${tampered}`)).status).toBe(404);
    expect((await read(`/shop/orders/track/${placed.body.orderId as string}`)).status).toBe(404);
    expect((await read('/shop/orders/track/trk_')).status).toBe(404);
  });
});

describe('listMyOrders and getMyOrder: a customer reads only their own orders', () => {
  let mine: string;
  let theirs: string;

  beforeAll(async () => {
    const order = (customerId: string) => ({ channel: 'ONLINE', customerId, fulfilmentMode: 'COLLECTION', paymentTerms: 'COD', lines: [{ productId: id('EGG-0003'), quantity: '3.000' }] });
    const a = await consolePost(api.server, as('sales'), '/v1/orders').send(order(id('tema')));
    const b = await consolePost(api.server, as('sales'), '/v1/orders').send(order(id('other')));
    expect([a.status, b.status]).toEqual([201, 201]);
    mine = a.body.id as string;
    theirs = b.body.id as string;
  });

  it('lists the customer’s own orders newest first, with totals, and never another customer’s', async () => {
    const listed = await consoleGet(api.server, as('customer'), '/v1/me/orders');
    expect(listed.status).toBe(200);
    const rows = listed.body.data as Array<{ id: string }>;
    expect(rows.map((r) => r.id)).toContain(mine);
    expect(rows.map((r) => r.id)).not.toContain(theirs);
    expect(rows.find((r) => r.id === mine)).toMatchObject({ status: 'PLACED', paymentStatus: 'UNPAID', itemCount: 1, totalPesewas: 18_000, currency: 'GHS' });
    expect(listed.body.page).toMatchObject({ hasMore: false, nextCursor: null });
    const stranger = await consoleGet(api.server, as('stranger'), '/v1/me/orders');
    expect((stranger.body.data as Array<{ id: string }>).map((r) => r.id)).toEqual([theirs]);
  });

  it('reads one of my orders with no cost, floor, ceiling or variance, and answers 404 for another customer’s', async () => {
    const got = await consoleGet(api.server, as('customer'), `/v1/me/orders/${mine}`);
    expect(got.status).toBe(200);
    expect(got.body).toMatchObject({ id: mine, status: 'PLACED', paymentStatus: 'UNPAID', fulfilmentMode: 'COLLECTION', deliveryAddress: null, delivery: null, deliveryFeePesewas: 0, estimatedTotalPesewas: 18_000, finalTotalPesewas: null, paidPesewas: 0, documents: [], pendingConsent: null });
    expect(got.body.lines).toEqual([{ name: expect.any(String), quantity: '3.000', uom: expect.any(String), weightKg: null, unitPricePesewas: 6_000, lineTotalPesewas: 18_000, status: 'OPEN' }]);
    const keys = [...keysOf(got.body)].map((k) => k.toLowerCase());
    expect(keys.filter((k) => /cost|floor|ceiling|variance|resolved|salesperson|pricelist/.test(k))).toEqual([]);
    expect((await consoleGet(api.server, as('customer'), `/v1/me/orders/${theirs}`)).status).toBe(404);
    expect((await consoleGet(api.server, as('customer'), `/v1/me/orders/${randomUUID()}`)).status).toBe(404);
  });

  it('refuses a staff session and an anonymous caller: the customer realm’s routes know neither', async () => {
    expect((await consoleGet(api.server, as('cashier'), '/v1/me/orders')).status).toBe(401);
    expect((await consoleGet(api.server, as('sales'), `/v1/me/orders/${mine}`)).status).toBe(401);
    expect((await read('/me/orders')).status).toBe(401);
    // And a customer is never staff: entering or cancelling an order is refused to the customer realm.
    expect((await consolePost(api.server, as('customer'), '/v1/orders').send({ channel: 'ONLINE', customerId: id('tema'), fulfilmentMode: 'COLLECTION', paymentTerms: 'COD', lines: [] })).status).toBe(401);
    expect((await consolePost(api.server, as('customer'), `/v1/orders/${mine}/cancel`).send({ reasonCode: 'CUSTOMER_CANCELLED' })).status).toBe(401);
  });
});
