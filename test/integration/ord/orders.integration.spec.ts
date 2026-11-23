import { randomUUID } from 'node:crypto';
import { createUuidV7Generator, ManualClock } from '@hakorem/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SalePosting, type SaleRequest } from '../../../src/modules/ord';
import { runWithRequestContext, type Actor } from '../../../src/platform/context/request-context';
import { UnitOfWork } from '../../../src/platform/database/unit-of-work';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { paystackEnvironment, startFakePaystack, type FakePaystack } from '../../support/fake-paystack';
import { consoleGet, consolePost, createBranch, createUser, enrolAndLogin, login, relaxRateLimits, SYSTEM_PRINCIPAL, testStartTime, type RoleCode, type TestSession } from '../../support/iam';
import { approveAndDeliver, initiateCharge, referenceFor, trialBalanceSum } from '../../support/pay';
import { startTestApp, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';
import { openTestShift, tillOf } from '../../support/till';

/**
 * The order record's endpoints (FR-ORD-001, FR-ORD-002, FR-ORD-003, FR-ORD-004, FR-ORD-005, FR-ORD-016, ADR-0035, A-224):
 * every read and write refused to a role without its permission and at another branch; an order entered PLACED with
 * every line priced by the engine to the pesewa and nothing reserved; a confirmation that reserves every line or keeps
 * the order PLACED naming each shortfall; the last crate confirmed once when two people confirm at once; the payment
 * or credit check; and one list across channels, a sale posted by `SalePosting.postIn` included.
 */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let fake: FakePaystack;
let branchId: string;
const ids = new Map<string, string>();
const id = (name: string) => ids.get(name)!;
const sessions = new Map<string, TestSession>();
const as = (name: string) => sessions.get(name)!;
const admin = () => database.pool('admin');

const order = (body: Record<string, unknown> = {}) => ({
  channel: 'WHOLESALE',
  customerId: id('tema'),
  fulfilmentMode: 'COLLECTION',
  paymentTerms: 'COD',
  lines: [{ productId: id('eggs'), quantity: '4.000', uom: 'CRATE' }],
  ...body,
});
const create = (session: TestSession, body: Record<string, unknown>, key = randomUUID()) => consolePost(api.server, session, '/v1/orders', key).send(body);
const confirm = (session: TestSession, orderId: string, key = randomUUID()) => consolePost(api.server, session, `/v1/orders/${orderId}/confirm`, key).send();
const reservations = async (orderId: string) =>
  (
    await admin().query<{ product: string; qty: string; status: string }>(
      `SELECT p.sku AS product, r.qty::text AS qty, r.status FROM inv.stock_reservation r JOIN mdm.product p ON p.id = r.product_id WHERE r.holder_document_id = $1 ORDER BY p.sku, r.qty`,
      [orderId],
    )
  ).rows;

async function receiveCabbage(qty: string): Promise<void> {
  const documentId = randomUUID();
  const app = database.pool('app');
  await app.query("INSERT INTO platform.business_document (id, doc_type, owner_module, branch_id, actor_id) VALUES ($1, 'GOODS_RECEIPT', 'inv', $2, $3)", [documentId, branchId, SYSTEM_PRINCIPAL]);
  await app.query(
    `INSERT INTO inv.stock_movement (id, movement_type, product_id, branch_id, from_location_id, to_location_id, qty_base, value_pesewas, cost_element, source_document_id, occurred_at, actor_id)
     VALUES ($1, 'RECEIPT_PURCHASE', $2, $3, $4, $5, $6, 500, 'PURCHASE', $7, $8, $9)`,
    [randomUUID(), id('cabbage'), branchId, id('SUPPLIER'), id('SHOP'), qty, documentId, clock.now(), SYSTEM_PRINCIPAL],
  );
}

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  await relaxRateLimits(database);
  fake = await startFakePaystack(() => clock.now());
  api = await startTestApp(database, { clock, environment: { ...paystackEnvironment(fake), AUTH_ACCESS_TTL_SECONDS: '43200' } });
  await runSeedUnits(database.pool('app'), api.app, seedUnits({ SEED_STAFF_PASSWORD: `Seed-${randomUUID()}` }));
  branchId = (await admin().query<{ id: string }>("SELECT id FROM mdm.branch WHERE code = 'DDW'")).rows[0]!.id;
  for (const code of ['SHOP', 'PENS']) ids.set(code, (await admin().query<{ id: string }>('SELECT id FROM mdm.location WHERE branch_id = $1 AND code = $2', [branchId, code])).rows[0]!.id);
  ids.set('SUPPLIER', (await admin().query<{ id: string }>("SELECT id FROM mdm.location WHERE branch_id = $1 AND kind = 'SUPPLIER'", [branchId])).rows[0]!.id);
  for (const [name, sku] of [
    ['goat', 'LIV-0004'],
    ['eggs', 'EGG-0003'],
    ['cabbage', 'PRD-0002'],
    ['beef', 'MEAT-0005'],
    ['yam', 'PRD-0005'],
  ] as const) {
    ids.set(name, (await admin().query<{ id: string }>('SELECT id FROM mdm.product WHERE sku = $1', [sku])).rows[0]!.id);
  }
  ids.set('G-0143', (await admin().query<{ id: string }>("SELECT id FROM inv.stock_unit WHERE identifier = 'G-0143'")).rows[0]!.id);
  ids.set('eggLot', (await admin().query<{ id: string }>("SELECT id FROM inv.stock_unit WHERE identifier = 'EGG-BIG-2026-1110'")).rows[0]!.id);
  ids.set('tema', (await admin().query<{ id: string }>("SELECT id FROM mdm.customer WHERE name = 'Tema Cold Store Ltd (SEED)'")).rows[0]!.id);
  const other = await createBranch(database, 'KSI');
  const people: [string, string, RoleCode, string][] = [
    ['sales', 'Kojo Antwi', 'SALES', branchId],
    ['sales2', 'Efua Boateng', 'SALES', branchId],
    ['manager', 'Ama Owusu', 'MANAGER', branchId],
    ['cashier', 'Adwoa Darko', 'CASHIER', branchId],
    ['storekeeper', 'Yaw Asante', 'STOREKEEPER', branchId],
    ['investor', 'Nana Ofori', 'INVESTOR', branchId],
    ['elsewhere', 'Kwesi Appiah', 'SALES', other.branchId],
  ];
  for (const [key, name, role, at] of people) {
    const user = await createUser(database, { name, grants: [{ role, branchId: at }] });
    ids.set(`user:${key}`, user.principalId);
    sessions.set(key, role === 'MANAGER' ? await enrolAndLogin(api.server, user, () => clock.now()) : await login(api.server, user));
  }
});

afterAll(async () => {
  await api?.close();
  await fake?.close();
  await database?.drop();
});

describe('authorisation on every order operation (ADR-0035, deny by default)', () => {
  let placed: string;

  beforeAll(async () => {
    placed = (await create(as('sales'), order())).body.id as string;
  });

  it('refuses every read and write to the Investor, who holds no order permission', async () => {
    expect((await consoleGet(api.server, as('investor'), '/v1/orders')).status).toBe(403);
    expect((await consoleGet(api.server, as('investor'), `/v1/orders/${placed}`)).status).toBe(403);
    expect((await consoleGet(api.server, as('investor'), `/v1/orders/${placed}/history`)).status).toBe(403);
    expect((await create(as('investor'), order())).status).toBe(403);
    expect((await confirm(as('investor'), placed)).status).toBe(403);
  });

  it('lets the Storekeeper read the order it picks (CR-056, B11) but never enter or confirm one', async () => {
    expect((await consoleGet(api.server, as('storekeeper'), `/v1/orders/${placed}`)).status).toBe(200);
    expect((await consoleGet(api.server, as('storekeeper'), `/v1/orders/${placed}/history`)).status).toBe(200);
    expect((await create(as('storekeeper'), order())).status).toBe(403);
    expect((await confirm(as('storekeeper'), placed)).status).toBe(403);
  });

  it('lets the Cashier read orders but never enter or confirm one', async () => {
    expect((await consoleGet(api.server, as('cashier'), `/v1/orders/${placed}`)).status).toBe(200);
    const created = await create(as('cashier'), order());
    expect(created.status).toBe(403);
    expect(created.body.error.code).toBe('FORBIDDEN');
    expect((await confirm(as('cashier'), placed)).status).toBe(403);
    expect(await reservations(placed)).toEqual([]);
  });

  it('refuses a salesperson of another branch the order, its history and its confirmation, and lists none of it', async () => {
    expect((await consoleGet(api.server, as('elsewhere'), `/v1/orders/${placed}`)).status).toBe(403);
    expect((await consoleGet(api.server, as('elsewhere'), `/v1/orders/${placed}/history`)).status).toBe(403);
    expect((await confirm(as('elsewhere'), placed)).status).toBe(403);
    const listed = await consoleGet(api.server, as('elsewhere'), '/v1/orders');
    expect(listed.status).toBe(200);
    expect(listed.body.data).toEqual([]);
  });

  it('answers 404 for an order that does not exist', async () => {
    expect((await consoleGet(api.server, as('sales'), `/v1/orders/${randomUUID()}`)).status).toBe(404);
  });
});

describe('createOrder (FR-ORD-001, FR-ORD-003, FR-ORD-004)', () => {
  it('enters a wholesale order PLACED, every line priced by the engine to the pesewa, nothing reserved', async () => {
    const key = randomUUID();
    const body = order({
      lines: [
        { productId: id('eggs'), quantity: '4.000', uom: 'CRATE' },
        { productId: id('cabbage'), quantity: '3.000', agreedUnitPricePesewas: 1_100, varianceReasonCode: 'REGULAR_CUSTOMER' },
      ],
      notes: 'Collecting Friday morning',
    });
    const created = await create(as('sales'), body, key);
    expect(created.status).toBe(201);
    const o = created.body;
    expect(o).toMatchObject({
      channel: 'WHOLESALE',
      status: 'PLACED',
      paymentStatus: 'UNPAID',
      customer: { id: id('tema'), publicId: expect.stringMatching(/^cus_[0-9A-HJKMNP-TV-Z]{16}$/), name: 'Tema Cold Store Ltd (SEED)' },
      paymentTerms: 'COD',
      fulfilmentMode: 'COLLECTION',
      salesperson: { id: id('user:sales'), displayName: 'Kojo Antwi' },
      taxInclusive: true,
      estimatedTotalPesewas: 27_300,
      maximumTotalPesewas: 27_300,
      finalTotalPesewas: null,
      paidPesewas: 0,
      outstandingPesewas: 27_300,
      billingDocument: null,
      creditCheck: null,
      placedAt: clock.now().toISOString(),
      notes: 'Collecting Friday morning',
      branchId,
    });
    expect(o.orderNo).toMatch(/^SO-\d{4}-DDW-\d{6}$/);
    expect(
      o.lines.map((l: Record<string, unknown>) => [
        l['lineNo'],
        l['qtyOrdered'],
        l['priceBasis'],
        l['resolvedUnitPricePesewas'],
        l['floorUnitPricePesewas'],
        l['ceilingUnitPricePesewas'],
        l['agreedUnitPricePesewas'],
        l['variancePesewas'],
        l['varianceDirection'],
        l['varianceReasonCode'],
        l['estimatedLineTotalPesewas'],
        l['lineStatus'],
      ]),
    ).toEqual([
      [1, '4.000', 'PER_UNIT', 6_000, 6_000, 6_000, 6_000, 0, null, null, 24_000, 'OPEN'],
      [2, '3.000', 'PER_UNIT', 1_000, 800, 1_200, 1_100, 300, 'ABOVE', 'REGULAR_CUSTOMER', 3_300, 'OPEN'],
    ]);
    expect(o.lines.every((l: Record<string, unknown>) => l['priceSource'] === 'ENGINE' && typeof l['priceListEntryId'] === 'string')).toBe(true);
    expect(await reservations(o.id)).toEqual([]);

    const history = await consoleGet(api.server, as('sales'), `/v1/orders/${o.id}/history`);
    expect(history.body.data).toEqual([{ fromStatus: null, toStatus: 'PLACED', reason: null, actor: { id: id('user:sales'), displayName: 'Kojo Antwi' }, occurredAt: clock.now().toISOString() }]);
    const placedEvents = await admin().query("SELECT payload FROM platform.outbox_message WHERE event_type = 'ord.OrderPlaced' AND subject_id = $1", [o.id]);
    expect(placedEvents.rows.map((r) => r.payload)).toEqual([
      { orderId: o.id, orderNo: o.orderNo, channel: 'WHOLESALE', branchId, customerId: id('tema'), paymentTerms: 'COD', estimatedTotalPesewas: 27_300, placedAt: clock.now().toISOString() },
    ]);
    const audited = await admin().query("SELECT count(*)::int AS n FROM platform.audit_event WHERE entity_id = $1 AND action = 'CREATE' AND module = 'ord'", [o.id]);
    expect(audited.rows[0].n).toBe(1);

    const replay = await create(as('sales'), body, key);
    expect(replay.status).toBe(201);
    expect(replay.body.id).toBe(o.id);
    const reused = await create(as('sales'), order(), key);
    expect(reused.status).toBe(409);
    expect((await admin().query('SELECT count(*)::int AS n FROM ord.sales_order WHERE id = $1', [o.id])).rows[0].n).toBe(1);
  });

  it('enters a price below list, and one above the ceiling, PLACED to wait for an approval (A-230); a variance with no reason writes nothing', async () => {
    for (const agreed of [999, 1_201]) {
      const waiting = await create(as('sales'), order({ lines: [{ productId: id('cabbage'), quantity: '2.000', agreedUnitPricePesewas: agreed, varianceReasonCode: 'REGULAR_CUSTOMER' }] }));
      expect(waiting.status, String(agreed)).toBe(202);
      expect(waiting.body).toMatchObject({ status: 'PENDING_APPROVAL', kind: 'PRICE_OVERRIDE', subject: { docType: 'SALES_ORDER' } });
      expect(await reservations(waiting.body.subject.id)).toEqual([]);
    }
    const before = (await admin().query('SELECT count(*)::int AS n FROM ord.sales_order')).rows[0].n;
    const noReason = await create(as('sales'), order({ lines: [{ productId: id('cabbage'), quantity: '2.000', agreedUnitPricePesewas: 1_100 }] }));
    expect(noReason.status).toBe(422);
    expect(noReason.body.error.details).toEqual([expect.objectContaining({ field: '/lines/0/varianceReasonCode', code: 'VARIANCE_REASON_REQUIRED' })]);
    expect((await admin().query('SELECT count(*)::int AS n FROM ord.sales_order')).rows[0].n).toBe(before);
  });

  it('names every rule an order breaks: delivery, a coupon, an unknown customer, a repeated product, a goat on a line of two, a goat with no tag', async () => {
    const refused = await create(
      as('sales'),
      order({
        customerId: randomUUID(),
        fulfilmentMode: 'DELIVERY',
        couponCode: 'WELCOME10',
      }),
    );
    expect(refused.status).toBe(422);
    expect(refused.body.error.code).toBe('ORDER_INVALID');
    expect(refused.body.error.details.map((d: { field: string; code: string }) => `${d.field}:${d.code}`)).toEqual([
      '/fulfilmentMode:FULFILMENT_NOT_AVAILABLE',
      '/couponCode:COUPON_NOT_AVAILABLE',
      '/customerId:CUSTOMER_NOT_ACTIVE',
    ]);
    const lines = await create(
      as('sales'),
      order({
        lines: [
          { productId: id('eggs'), quantity: '1.000', uom: 'CRATE' },
          { productId: id('eggs'), quantity: '2.000', uom: 'CRATE' },
          { productId: id('goat'), stockUnitId: id('G-0143'), quantity: '2.000' },
          { productId: id('goat'), quantity: '1.000' },
        ],
      }),
    );
    expect(lines.status).toBe(422);
    expect(lines.body.error.details.map((d: { field: string; code: string }) => `${d.field}:${d.code}`)).toEqual([
      '/lines/1/productId:PRODUCT_REPEATED',
      '/lines/2/quantity:ONE_ANIMAL_PER_LINE',
      '/lines/3/stockUnitId:STOCK_UNIT_REQUIRED',
    ]);
  });

  it('refuses a line priced by the kilogram until catch weight is built, and a sale on the order of a goat names its tag', async () => {
    const beef = await create(as('sales'), order({ lines: [{ productId: id('beef'), quantity: '15.000' }] }));
    expect(beef.status).toBe(422);
    expect(beef.body.error.details).toEqual([expect.objectContaining({ field: '/lines/0/productId', code: 'CATCH_WEIGHT_NOT_AVAILABLE' })]);
    const goat = await create(as('sales'), order({ lines: [{ productId: id('goat'), stockUnitId: id('G-0143'), quantity: '1.000' }] }));
    expect(goat.status).toBe(201);
    expect(goat.body.lines[0]).toMatchObject({ stockUnit: { id: id('G-0143'), identifier: 'G-0143', tracking: 'SERIAL' }, qtyOrdered: '1.000', priceBasis: 'PER_HEAD', lineStatus: 'OPEN' });
  });

  it('takes a line in crates or in eggs, each at its own price, and refuses a unit the eggs are not sold by (B09e)', async () => {
    const mixed = await create(as('sales'), order({ lines: [{ productId: id('eggs'), quantity: '2.000', uom: 'CRATE' }, { productId: id('cabbage'), quantity: '1.000' }] }));
    expect(mixed.status).toBe(201);
    expect(mixed.body.lines[0]).toMatchObject({ qtyOrdered: '2.000', uom: 'CRATE', resolvedUnitPricePesewas: 6_000, estimatedLineTotalPesewas: 12_000 });
    const singles = await create(as('sales'), order({ lines: [{ productId: id('eggs'), quantity: '12.000' }] }));
    expect(singles.body.lines[0]).toMatchObject({ qtyOrdered: '12.000', uom: 'EGG', resolvedUnitPricePesewas: 220, estimatedLineTotalPesewas: 2_640 });
    const bag = await create(as('sales'), order({ lines: [{ productId: id('eggs'), quantity: '1.000', uom: 'BAG' }] }));
    expect(bag.status).toBe(422);
    expect(bag.body.error).toMatchObject({ code: 'ORDER_INVALID', details: [expect.objectContaining({ field: '/lines/0/uom', code: 'NO_CONVERSION' })] });
  });

  it('refuses an order at no branch: a person who enters orders nowhere whole is told to name none', async () => {
    const fieldHand = await createUser(database, { name: 'Abena Sarpong', grants: [{ role: 'SALES', branchId, locationId: id('SHOP') }] });
    const session = await login(api.server, fieldHand);
    const refused = await create(session, order());
    expect(refused.status).toBe(422);
    expect(refused.body.error.details).toEqual([expect.objectContaining({ code: 'BRANCH_REQUIRED' })]);
  });
});

describe('confirmOrder (FR-ORD-005)', () => {
  it('reserves every line for the order, moves it CONFIRMED and records the change once', async () => {
    const placed = (await create(as('sales'), order({ lines: [{ productId: id('eggs'), quantity: '4.000', uom: 'CRATE' }] }))).body;
    const key = randomUUID();
    const confirmed = await confirm(as('manager'), placed.id, key);
    expect(confirmed.status).toBe(200);
    expect(confirmed.body).toMatchObject({ id: placed.id, status: 'CONFIRMED', creditCheck: 'NOT_REQUIRED', estimatedTotalPesewas: 24_000, outstandingPesewas: 24_000, version: placed.version + 1 });
    expect(await reservations(placed.id)).toEqual([{ product: 'EGG-0003', qty: '120.000', status: 'ACTIVE' }]);
    const held = await admin().query<{ reservation_id: string; unit: string }>(
      'SELECT l.reservation_id, r.stock_unit_id AS unit FROM ord.sales_order_line l JOIN inv.stock_reservation r ON r.id = l.reservation_id WHERE l.sales_order_id = $1',
      [placed.id],
    );
    expect(held.rows).toEqual([{ reservation_id: expect.any(String), unit: id('eggLot') }]);
    const history = await consoleGet(api.server, as('sales'), `/v1/orders/${placed.id}/history`);
    expect(history.body.data.map((c: { fromStatus: string | null; toStatus: string; actor: { displayName: string } }) => [c.fromStatus, c.toStatus, c.actor.displayName])).toEqual([
      [null, 'PLACED', 'Kojo Antwi'],
      ['PLACED', 'CONFIRMED', 'Ama Owusu'],
    ]);
    const events = await admin().query("SELECT payload FROM platform.outbox_message WHERE event_type = 'ord.OrderConfirmed' AND subject_id = $1", [placed.id]);
    expect(events.rows.map((r) => r.payload)).toEqual([
      {
        orderId: placed.id,
        orderNo: placed.orderNo,
        branchId,
        customerId: id('tema'),
        creditCheck: 'NOT_REQUIRED',
        reservationIds: [held.rows[0]!.reservation_id],
        confirmedAt: clock.now().toISOString(),
      },
    ]);

    const replay = await confirm(as('manager'), placed.id, key);
    expect(replay.status).toBe(200);
    expect(await reservations(placed.id)).toHaveLength(1);
    const again = await confirm(as('manager'), placed.id);
    expect(again.status).toBe(422);
    expect(again.body.error).toMatchObject({ code: 'INVALID_STATE_TRANSITION', details: [expect.objectContaining({ code: 'CONFIRMED' })] });
  });

  it('keeps an order for 26 heads with 25 available PLACED, naming the shortfall of 1, and reserves all 26 once one more is received', async () => {
    const placed = (await create(as('sales'), order({ lines: [{ productId: id('cabbage'), quantity: '26.000' }] }))).body;
    const short = await confirm(as('sales'), placed.id);
    expect(short.status).toBe(422);
    expect(short.body.error.code).toBe('STOCK_UNAVAILABLE');
    expect(short.body.error.details).toEqual([{ field: '/lines/1', code: 'NOT_ENOUGH_STOCK', message: 'Not enough stock for this line: 1.000 short of 26.000.' }]);
    expect((await consoleGet(api.server, as('sales'), `/v1/orders/${placed.id}`)).body.status).toBe('PLACED');
    expect(await reservations(placed.id)).toEqual([]);

    await receiveCabbage('1.000');
    const confirmed = await confirm(as('sales'), placed.id);
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.status).toBe('CONFIRMED');
    expect(await reservations(placed.id)).toEqual([{ product: 'PRD-0002', qty: '26.000', status: 'ACTIVE' }]);
  });

  it('confirms the last 26 crates (780 eggs) once when two people confirm two orders for them at the same moment', async () => {
    const left = await admin().query<{ qty: string }>('SELECT sum(on_hand_qty - reserved_qty)::numeric(14,3)::text AS qty FROM inv.stock_balance WHERE product_id = $1 AND location_id = $2', [
      id('eggs'),
      id('SHOP'),
    ]);
    expect(left.rows[0]!.qty).toBe('780.000');
    const first = (await create(as('sales'), order({ lines: [{ productId: id('eggs'), quantity: '26.000', uom: 'CRATE' }] }))).body;
    const second = (await create(as('sales2'), order({ lines: [{ productId: id('eggs'), quantity: '26.000', uom: 'CRATE' }] }))).body;
    const answers = await Promise.all([confirm(as('sales'), first.id), confirm(as('sales2'), second.id)]);
    expect(answers.map((a) => a.status).sort()).toEqual([200, 422]);
    const refused = answers.find((a) => a.status === 422)!;
    expect(refused.body.error.details).toEqual([expect.objectContaining({ code: 'NOT_ENOUGH_STOCK', message: 'Not enough stock for this line: 780.000 short of 780.000.' })]);
    const held = [...(await reservations(first.id)), ...(await reservations(second.id))];
    expect(held).toEqual([{ product: 'EGG-0003', qty: '780.000', status: 'ACTIVE' }]);
  });

  it('confirms a prepaid order only once its estimate is received in a cleared payment', async () => {
    await receiveCabbage('2.000');
    const placed = (await create(as('sales'), order({ paymentTerms: 'PREPAID', lines: [{ productId: id('cabbage'), quantity: '2.000' }] }))).body;
    expect(placed.estimatedTotalPesewas).toBe(2_000);
    const unpaid = await confirm(as('sales'), placed.id);
    expect(unpaid.status).toBe(422);
    expect(unpaid.body.error).toMatchObject({ code: 'ORDER_INVALID', details: [expect.objectContaining({ field: '/paymentTerms', code: 'PREPAYMENT_SHORT' })] });

    const short = await initiateCharge(api.server, as('sales'), { amountPesewas: 1_999, orderId: placed.id, customerId: id('tema') });
    expect(short.status).toBe(201);
    await approveAndDeliver(api.server, fake, referenceFor(short.body.id));
    expect((await consoleGet(api.server, as('sales'), `/v1/orders/${placed.id}`)).body).toMatchObject({ paidPesewas: 1_999, outstandingPesewas: 1, paymentStatus: 'DEPOSIT_HELD' });
    const stillShort = await confirm(as('sales'), placed.id);
    expect(stillShort.body.error.details).toEqual([expect.objectContaining({ code: 'PREPAYMENT_SHORT' })]);

    const rest = await initiateCharge(api.server, as('sales'), { amountPesewas: 1, orderId: placed.id, customerId: id('tema') });
    await approveAndDeliver(api.server, fake, referenceFor(rest.body.id));
    const confirmed = await confirm(as('sales'), placed.id);
    expect(confirmed.status).toBe(200);
    expect(confirmed.body).toMatchObject({ status: 'CONFIRMED', creditCheck: 'NOT_REQUIRED', paidPesewas: 2_000, outstandingPesewas: 0, paymentStatus: 'DEPOSIT_HELD' });
  });

  it('refuses a credit order while no credit policy answers for its customer, and reserves nothing', async () => {
    // A customer with no business account (B10 continued gives the seeded Tema Cold Store one): no policy answers.
    const walkIn = (await admin().query<{ id: string }>("SELECT id FROM mdm.customer WHERE customer_no = 'C-00001'")).rows[0]!.id;
    const placed = (await create(as('sales'), order({ customerId: walkIn, paymentTerms: 'CREDIT', lines: [{ productId: id('yam'), quantity: '2.000' }] }))).body;
    const refused = await confirm(as('manager'), placed.id);
    expect(refused.status).toBe(422);
    expect(refused.body.error).toMatchObject({ code: 'ORDER_INVALID', details: [expect.objectContaining({ field: '/paymentTerms', code: 'CREDIT_CHECK_UNAVAILABLE' })] });
    expect(await reservations(placed.id)).toEqual([]);
    expect((await consoleGet(api.server, as('manager'), `/v1/orders/${placed.id}`)).body.status).toBe('PLACED');
  });
});

describe('listOrders and getOrder across channels (FR-ORD-001, FR-ORD-016)', () => {
  let saleId: string;

  beforeAll(async () => {
    const sales = api.app.get(SalePosting);
    const uow = api.app.get(UnitOfWork);
    const actor: Actor = { principalId: id('user:manager'), kind: 'USER', displayName: 'Ama Owusu', realm: 'STAFF', sessionId: null, steppedUpAt: null };
    const request: SaleRequest = {
      orderId: createUuidV7Generator(clock)(),
      channel: 'WHOLESALE',
      branchId,
      fulfilmentMode: 'COUNTER',
      taxInclusive: true,
      lines: [{ productId: id('yam'), fromLocationId: id('SHOP'), quantity: '2.000' }],
      tenders: [{ methodCode: 'CASH', amountPesewas: 4_000n, register: { id: '019a8000-0000-7000-8000-00000000a7a2', code: 'T2' } }],
    };
    const sold = await runWithRequestContext({ correlationId: randomUUID(), ip: null, userAgent: 'orders test', actor }, () =>
      uow.run({ isolation: 'serializable', seriesLocks: sales.locksFor(branchId) }, async (tx) => sales.postIn(tx, actor, { shiftDocumentId: await openTestShift(tx, actor.principalId, request.branchId, tillOf(request)), ...request })),
    );
    saleId = sold.id;
  });

  it('shows a sale posted by SalePosting as a completed order with its receipt, paid in full', async () => {
    const got = await consoleGet(api.server, as('cashier'), `/v1/orders/${saleId}`);
    expect(got.status).toBe(200);
    expect(got.body).toMatchObject({
      id: saleId,
      channel: 'WHOLESALE',
      status: 'COMPLETED',
      fulfilmentMode: 'COUNTER',
      paymentTerms: 'IMMEDIATE',
      customer: null,
      paymentStatus: 'PAID',
      outstandingPesewas: 0,
      billingDocument: { docType: 'RECEIPT' },
    });
    expect(got.body.paidPesewas).toBe(got.body.finalTotalPesewas);
    expect(got.body.billingDocument.number).toMatch(/^RCP-/);
    expect(got.body.lines[0]).toMatchObject({ lineStatus: 'FULFILLED', qtyFulfilled: '2.000', stockException: null });
    const history = await consoleGet(api.server, as('cashier'), `/v1/orders/${saleId}/history`);
    expect(history.body.data.map((c: { toStatus: string }) => c.toStatus)).toEqual(['PLACED', 'COMPLETED']);
  });

  it('lists every channel in one list newest first, filtered by status, channel and order number, a page at a time', async () => {
    const all = await consoleGet(api.server, as('sales'), '/v1/orders?limit=100');
    expect(all.status).toBe(200);
    const ids = all.body.data.map((o: { id: string }) => o.id);
    expect(ids).toContain(saleId);
    expect([...ids].sort().reverse()).toEqual(ids);
    const completed = await consoleGet(api.server, as('sales'), '/v1/orders?status=COMPLETED&limit=100');
    expect(completed.body.data.map((o: { id: string }) => o.id)).toEqual([saleId]);
    const placed = await consoleGet(api.server, as('sales'), '/v1/orders?status=PLACED&channel=WHOLESALE&limit=100');
    expect(placed.body.data.every((o: { status: string; channel: string }) => o.status === 'PLACED' && o.channel === 'WHOLESALE')).toBe(true);
    const sale = all.body.data.find((o: { id: string }) => o.id === saleId);
    const byNumber = await consoleGet(api.server, as('sales'), `/v1/orders?q=${encodeURIComponent(sale.orderNo)}`);
    expect(byNumber.body.data.map((o: { id: string }) => o.id)).toEqual([saleId]);

    const first = await consoleGet(api.server, as('sales'), '/v1/orders?limit=2');
    expect(first.body.page).toMatchObject({ limit: 2, hasMore: true });
    const second = await consoleGet(api.server, as('sales'), `/v1/orders?limit=2&cursor=${encodeURIComponent(first.body.page.nextCursor)}`);
    expect(second.body.data.map((o: { id: string }) => o.id)).toEqual(ids.slice(2, 4));
  });

  it('leaves the trial balance at zero: entering and confirming orders posts nothing', async () => {
    expect(await trialBalanceSum(database)).toBe('0');
  });
});
