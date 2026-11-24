import { randomUUID } from 'node:crypto';
import { formatCedis, ManualClock, toBusinessDate } from '@hakorem/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { addDays } from '../../../src/seed/seed-calendar';
import { seedUnits } from '../../../src/seed/seed-units';
import type { Actor } from '../../../src/platform/context/request-context';
import { stepUp, type TotpSession } from '../../support/fin';
import { consoleGet, consolePost, createBranch, createUser, enrolAndLogin, login, relaxRateLimits, SYSTEM_PRINCIPAL, testStartTime, type RoleCode, type TestSession, type TestUser } from '../../support/iam';
import { issueInvoice, trialBalanceSum } from '../../support/pay';
import { startTestApp, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * An order on account delivered and collected (the owner, 2026-11-23; A-331 (a); B11 continued 8's gate, first part),
 * over the seeded farm: big eggs EGG-0003 by the crate from the shop, the Dodowa zone's fee 1,500 (waived over 50,000).
 * Every limit is set around the order's exact gross, read from the seeded crate price `p`, and every refusal's figure is
 * asserted to the pesewa against exposure taken straight from BIL's, PAY's and ORD's own tables:
 * - a staff delivery order takes the customer's own address, its zone and the zone's fee; another customer's address,
 *   none at all, or a slot are refused;
 * - at dispatch the credit check judges the gross sent against everything else owed, the order's own estimate never
 *   counted twice: exactly at the limit dispatches; the invoice is due on the customer's terms, nothing is due to the
 *   driver; one pesewa over is refused, nothing written, then goes to its approval with a written reason and dispatches
 *   once a different person approves;
 * - a backorder of an order on account is judged again at its own dispatch, on its own quantities;
 * - a collection on account is judged at the hand-over and left due on the terms, nothing at the till.
 */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let branchId: string;
let crate: number;
const FEE = 1_500;
const TERMS = 30;
const ids = new Map<string, string>();
const id = (name: string) => ids.get(name)!;
const sessions = new Map<string, TestSession>();
const users = new Map<string, TestUser>();
const as = (name: string) => sessions.get(name)!;
const admin = () => database.pool('admin');
const app = () => database.pool('app');
const today = () => toBusinessDate(clock.now());
const actorOf = (who: string): Actor => ({ principalId: users.get(who)!.principalId, kind: 'USER', displayName: who, realm: 'STAFF', sessionId: null, steppedUpAt: null });
const post = (who: string, path: string, body: object = {}, key = randomUUID()) => consolePost(api.server, as(who), `/v1${path}`, key).send(body);
const get = (who: string, path: string) => consoleGet(api.server, as(who), `/v1${path}`);
const order = async (orderId: string) => (await get('manager', `/orders/${orderId}`)).body;
const one = async <T extends object>(sql: string, params: unknown[]) => (await admin().query<T & Record<string, unknown>>(sql, params)).rows[0]!;
const count = async (sql: string, params: unknown[]) => Number((await one<{ n: string }>(sql, params)).n);
const payloadOf = async (type: string, subjectId: string) => (await one<{ payload: Record<string, unknown> }>('SELECT payload FROM platform.outbox_message WHERE event_type = $1 AND subject_id = $2', [type, subjectId])).payload;
const dispatchBody = (extra: object = {}) => ({ driverId: id('driver'), vehicleLocationId: id('location:VAN1'), ...extra });
const CONFIRMED_UNINVOICED = ['CONFIRMED', 'PICKING', 'AWAITING_CUSTOMER', 'PACKED', 'READY_FOR_COLLECTION', 'DISPATCHED', 'DELIVERED', 'DELIVERY_FAILED'];
let customers = 0;

async function approve(who: string, approvalRequestId: string, reason = 'Checked') {
  await stepUp(api.server, as(who) as TotpSession, clock);
  return post(who, `/iam/approvals/${approvalRequestId}/approve`, { reason });
}

/** A business customer with an open account at Dodowa and a saved address in Dodowa, its limit approved by the Manager. */
async function account(name: string, limit: number): Promise<{ customerId: string; addressId: string }> {
  const customerId = randomUUID();
  customers += 1;
  await app().query(
    "INSERT INTO mdm.customer (id, customer_no, kind, name, tier_id, status, created_by, updated_by) VALUES ($1, $2, 'BUSINESS', $3, '01900000-0000-7000-8000-000000000302', 'ACTIVE', $4, $4)",
    [customerId, `C-8${String(customers).padStart(4, '0')}`, name, SYSTEM_PRINCIPAL],
  );
  const addressId = randomUUID();
  await app().query(
    `INSERT INTO mdm.customer_address (id, customer_id, label, recipient_name, recipient_phone_e164, line1, area, city, region, is_default, created_by, updated_by)
     VALUES ($1, $2, 'Shop', 'Esi Mensah', '+233244512876', 'Behind the Dodowa lorry station', 'Dodowa', 'Dodowa', 'Greater Accra', true, $3, $3)`,
    [addressId, customerId, SYSTEM_PRINCIPAL],
  );
  const opened = await post('owner', '/business-accounts', { customerId, branchId, creditLimitPesewas: limit, paymentTermsDays: TERMS, reason: 'Opening terms (TEST)' });
  if (limit === 0) {
    expect(opened.status, JSON.stringify(opened.body)).toBe(201);
    return { customerId, addressId };
  }
  expect(opened.status, JSON.stringify(opened.body)).toBe(202);
  expect((await approve('manager', opened.body.approvalRequestId as string)).status).toBe(200);
  return { customerId, addressId };
}

/** Exposure straight from the owning tables: BIL's issued documents less PAY's net allocations, plus ORD's confirmed credit orders not invoiced. */
async function exposureTruth(customerId: string, excludingOrderId: string): Promise<number> {
  const { rows } = await admin().query<{ n: string }>(
    `SELECT ((SELECT COALESCE(sum(d.gross_pesewas), 0) FROM bil.billing_document d
               WHERE d.customer_id = $1 AND d.status = 'ISSUED' AND d.kind IN ('INVOICE', 'RECEIPT', 'DEBIT_NOTE'))
           - (SELECT COALESCE(sum(CASE a.direction WHEN 'APPLY' THEN a.amount_pesewas ELSE -a.amount_pesewas END), 0)
                FROM pay.payment_allocation a JOIN bil.billing_document d ON d.id = a.billing_document_id WHERE d.customer_id = $1)
           + (SELECT COALESCE(sum(o.estimated_total_pesewas), 0) FROM ord.sales_order o
               WHERE o.customer_id = $1 AND o.payment_terms = 'CREDIT' AND o.billing_document_id IS NULL AND o.status = ANY($2::text[]) AND o.id <> $3))::text AS n`,
    [customerId, CONFIRMED_UNINVOICED, excludingOrderId],
  );
  return Number(rows[0]!.n);
}

/** A confirmed credit order of `crates` crates for the customer, delivered to its address or collected. */
async function creditOrder(c: { customerId: string; addressId: string }, crates: number, mode: 'DELIVERY' | 'COLLECTION' = 'DELIVERY'): Promise<string> {
  const made = await post('sales', '/orders', {
    channel: 'WHOLESALE',
    customerId: c.customerId,
    fulfilmentMode: mode,
    paymentTerms: 'CREDIT',
    ...(mode === 'DELIVERY' ? { deliveryAddressId: c.addressId } : {}),
    lines: [{ productId: id('EGG-0003'), quantity: `${crates}.000`, uom: 'CRATE' }],
  });
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  const confirmed = await post('manager', `/orders/${made.body.id as string}/confirm`);
  expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
  return made.body.id as string;
}

/** The order's pick list made at the shop, `picked` crates picked, packed, the rest back-ordered when short. */
async function packed(orderId: string, picked: number): Promise<string> {
  const made = await post('storekeeper', `/orders/${orderId}/fulfilments`, { pickLocationId: id('location:SHOP') });
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  const line = (await order(orderId)).lines[0];
  const picks = Array.from({ length: picked }, () => ({ id: randomUUID(), orderLineId: line.id as string, stockUnitId: id('lot:EGG-0003'), qty: '1.000' }));
  expect((await post('storekeeper', `/fulfilments/${made.body.id as string}/picks`, { picks })).status).toBe(200);
  const short = picked < Number(line.qtyOrdered);
  const sealed = await post('storekeeper', `/fulfilments/${made.body.id as string}/pack`, short ? { packageCount: 1, backorderLineIds: [line.id] } : { packageCount: 1 });
  expect(sealed.status, JSON.stringify(sealed.body)).toBe(200);
  return made.body.id as string;
}

const invoiceOf = async (orderId: string) => one<{ kind: string; gross: string; due_date: string | null; issue_date: string }>("SELECT d.kind, d.gross_pesewas::text AS gross, d.due_date::text AS due_date, d.issue_date::text AS issue_date FROM bil.billing_document d JOIN ord.sales_order o ON o.billing_document_id = d.id WHERE o.id = $1", [orderId]);
const documentsOf = (orderId: string) => count("SELECT count(*)::text AS n FROM bil.billing_document WHERE order_document_id = $1 AND kind IN ('INVOICE', 'RECEIPT')", [orderId]);
const statusOf = async (orderId: string) => (await one<{ status: string }>('SELECT status FROM ord.sales_order WHERE id = $1', [orderId])).status;

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock, environment: { AUTH_ACCESS_TTL_SECONDS: '43200' } });
  await runSeedUnits(app(), api.app, seedUnits({ SEED_STAFF_PASSWORD: `Seed-${randomUUID()}` }));
  for (const row of (await admin().query<{ code: string; id: string }>('SELECT sku AS code, id FROM mdm.product')).rows) ids.set(row.code, row.id);
  branchId = (await admin().query<{ id: string }>("SELECT id FROM mdm.branch WHERE code = 'DDW'")).rows[0]!.id;
  for (const row of (await admin().query<{ code: string; id: string }>('SELECT l.code, l.id FROM mdm.location l WHERE l.branch_id = $1', [branchId])).rows) ids.set(`location:${row.code}`, row.id);
  ids.set('lot:EGG-0003', (await one<{ id: string }>("SELECT u.id FROM inv.stock_unit u JOIN mdm.product p ON p.id = u.product_id WHERE p.sku = 'EGG-0003' AND u.tracking = 'LOT'", [])).id);
  const people: [string, string, RoleCode, boolean][] = [
    ['owner', 'Kwabena Owusu', 'OWNER', true],
    ['manager', 'Akosua Boateng', 'MANAGER', true],
    ['accountant', 'Yaw Agyeman', 'ACCOUNTANT', true],
    ['sales', 'Esi Appiah', 'SALES', false],
    ['storekeeper', 'Kwesi Ofori', 'STOREKEEPER', false],
    ['driver', 'Kwabena Asare', 'DRIVER', false],
    ['cashier', 'Adwoa Darko', 'CASHIER', false],
  ];
  for (const [who, name, role, privileged] of people) {
    const user = await createUser(database, { name, grants: [{ role, branchId }] });
    users.set(who, user);
    ids.set(who, user.principalId);
    sessions.set(who, privileged ? await enrolAndLogin(api.server, user, () => clock.now()) : await login(api.server, user));
  }
  const tema = await createBranch(database, 'TMA');
  sessions.set('temaManager', await enrolAndLogin(api.server, await createUser(database, { name: 'Efua Quaye', grants: [{ role: 'MANAGER', branchId: tema.branchId }] }), () => clock.now()));
  // The seeded crate price, as the engine prices a wholesale crate today.
  const probe = await account('Probe Traders (TEST)', 0);
  const priced = await post('sales', '/orders', { channel: 'WHOLESALE', customerId: probe.customerId, fulfilmentMode: 'COLLECTION', paymentTerms: 'COD', lines: [{ productId: id('EGG-0003'), quantity: '1.000', uom: 'CRATE' }] });
  expect(priced.status, JSON.stringify(priced.body)).toBe(201);
  crate = Number(priced.body.lines[0].agreedUnitPricePesewas);
  expect(crate).toBeGreaterThan(0);
});

afterAll(async () => {
  await api?.close();
  await database?.drop();
});

describe("a staff delivery order takes the customer's own address, its zone and the zone's fee (B11 continued 8)", () => {
  it('refuses a delivery with no address, with another customer\'s address, or with a slot, writing nothing', async () => {
    const a = await account('Address Rules Traders (TEST)', 0);
    const b = await account('Other Address Traders (TEST)', 0);
    const base = { channel: 'WHOLESALE', customerId: a.customerId, fulfilmentMode: 'DELIVERY', paymentTerms: 'CREDIT', lines: [{ productId: id('EGG-0003'), quantity: '1.000', uom: 'CRATE' }] };
    const before = await count('SELECT count(*)::text AS n FROM ord.sales_order WHERE customer_id = $1', [a.customerId]);
    const none = await post('sales', '/orders', base);
    expect([none.status, none.body.error?.details?.map((d: { code: string }) => d.code)]).toEqual([422, ['DELIVERY_ADDRESS_REQUIRED']]);
    const other = await post('sales', '/orders', { ...base, deliveryAddressId: b.addressId });
    expect([other.status, other.body.error?.details?.[0]]).toEqual([422, expect.objectContaining({ field: '/deliveryAddressId', code: 'ADDRESS_NOT_OF_CUSTOMER' })]);
    const unknown = await post('sales', '/orders', { ...base, deliveryAddressId: randomUUID() });
    expect(unknown.body.error?.details?.[0]?.code).toBe('ADDRESS_NOT_OF_CUSTOMER');
    const slot = await post('sales', '/orders', { ...base, deliveryAddressId: a.addressId, deliverySlotId: randomUUID() });
    expect(slot.body.error?.details?.map((d: { code: string }) => d.code)).toEqual(['SLOT_NOT_AVAILABLE']);
    expect(await count('SELECT count(*)::text AS n FROM ord.sales_order WHERE customer_id = $1', [a.customerId])).toBe(before);
  });

  it("snapshots the address and charges the Dodowa zone's 1,500 on top of the goods", async () => {
    const a = await account('Fee Traders (TEST)', 0);
    const made = await post('sales', '/orders', { channel: 'WHOLESALE', customerId: a.customerId, fulfilmentMode: 'DELIVERY', paymentTerms: 'COD', deliveryAddressId: a.addressId, lines: [{ productId: id('EGG-0003'), quantity: '2.000', uom: 'CRATE' }] });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    expect(made.body).toMatchObject({ fulfilmentMode: 'DELIVERY', deliveryFeePesewas: FEE, estimatedTotalPesewas: 2 * crate + FEE });
    const row = await one<{ zone: string; snapshot: Record<string, unknown> }>('SELECT z.code AS zone, o.delivery_address_snapshot AS snapshot FROM ord.sales_order o JOIN mdm.delivery_zone z ON z.id = o.delivery_zone_id WHERE o.id = $1', [made.body.id]);
    expect(row.snapshot).toMatchObject({ recipientName: 'Esi Mensah', recipientPhone: '+233244512876', area: 'Dodowa', city: 'Dodowa', region: 'Greater Accra' });
    expect(row.zone).toBeTruthy();
  });
});

describe('an order on account is credit-checked at dispatch on what is sent (the owner, 2026-11-23)', () => {
  let atLimit: { customerId: string; addressId: string };
  let orderA: string;
  let listA: string;

  it('dispatches an order taking the account exactly to its limit: the estimate is never counted beside the gross', async () => {
    atLimit = await account('At The Limit Traders (TEST)', 3 * crate + FEE);
    orderA = await creditOrder(atLimit, 3);
    listA = await packed(orderA, 3);
    expect(await exposureTruth(atLimit.customerId, orderA)).toBe(0);
    for (const who of ['sales', 'storekeeper', 'driver', 'cashier', 'accountant', 'temaManager']) {
      const refused = await post(who, `/fulfilments/${listA}/dispatch`, dispatchBody({ creditOverrideReason: 'Regular buyer' }));
      expect(refused.status, who).toBe(403);
    }
    const sent = await post('manager', `/fulfilments/${listA}/dispatch`, dispatchBody());
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    expect(await statusOf(orderA)).toBe('DISPATCHED');
  });

  it('issues the invoice on the quantity sent, due on the customer\'s terms, with nothing due to the driver', async () => {
    const doc = await invoiceOf(orderA);
    expect(doc).toEqual({ kind: 'INVOICE', gross: String(3 * crate + FEE), issue_date: today(), due_date: addDays(today(), TERMS) });
    const delivery = (await get('manager', `/deliveries?orderId=${orderA}`)).body.data;
    expect(delivery[0]).toMatchObject({ codDuePesewas: 0 });
    expect(await payloadOf('ord.OrderDispatched', orderA)).toMatchObject({ finalTotalPesewas: 3 * crate + FEE, codDuePesewas: 0, dueDate: addDays(today(), TERMS) });
    // The invoice now stands as the customer's open item; the order is no longer counted as uninvoiced.
    expect(await exposureTruth(atLimit.customerId, randomUUID())).toBe(3 * crate + FEE);
    expect(await trialBalanceSum(database)).toBe('0');
  });

  let overOrder: string;
  let overList: string;
  let over: { customerId: string; addressId: string };

  it('refuses one pesewa over the limit at dispatch, naming GHS 0.01, writing nothing and keeping the number', async () => {
    over = await account('One Pesewa Over At Dispatch Ltd (TEST)', 2 * crate + FEE + 100);
    overOrder = await creditOrder(over, 2);
    overList = await packed(overOrder, 2);
    // A sale invoiced to the customer after the confirmation takes the account over by one pesewa at dispatch.
    await issueInvoice(api, actorOf('accountant'), clock, { branchId, customerId: over.customerId, productId: id('EGG-0003') }, 101n, addDays(today(), TERMS));
    expect(await exposureTruth(over.customerId, overOrder)).toBe(101);
    const numbers = await count("SELECT count(*)::text AS n FROM bil.billing_document WHERE kind = 'INVOICE'", []);
    const refused = await post('manager', `/fulfilments/${overList}/dispatch`, dispatchBody());
    expect(refused.status, JSON.stringify(refused.body)).toBe(422);
    expect(refused.body.error.code).toBe('CREDIT_LIMIT_EXCEEDED');
    expect(refused.body.error.details.map((d: { code: string }) => d.code)).toEqual(['OVER_LIMIT', 'OVERRIDE_REASON_REQUIRED']);
    expect(refused.body.error.details[0].message).toBe(`This order would take One Pesewa Over At Dispatch Ltd (TEST) GHS 0.01 over its ${formatCedis(BigInt(2 * crate + FEE + 100))} credit limit.`);
    expect(refused.body.error.details[1].message).toBe('To ask for a credit override, dispatch again with a written reason.');
    expect([await statusOf(overOrder), await documentsOf(overOrder)]).toEqual(['PACKED', 0]);
    expect(await count("SELECT count(*)::text AS n FROM bil.billing_document WHERE kind = 'INVOICE'", [])).toBe(numbers);
    expect(await count("SELECT count(*)::text AS n FROM del.delivery WHERE order_document_id = $1", [overOrder])).toBe(0);
  });

  it('asks for the override of the gross with a written reason (202), approved only by someone who did not ask, then dispatches it', async () => {
    const key = randomUUID();
    const asked = await post('manager', `/fulfilments/${overList}/dispatch`, dispatchBody({ creditOverrideReason: 'Pays every Friday' }), key);
    expect(asked.status, JSON.stringify(asked.body)).toBe(202);
    expect(asked.body).toMatchObject({ status: 'PENDING_APPROVAL', kind: 'CREDIT_OVERRIDE', subject: { id: overOrder, docType: 'SALES_ORDER' } });
    const replay = await post('manager', `/fulfilments/${overList}/dispatch`, dispatchBody({ creditOverrideReason: 'Pays every Friday' }), key);
    expect([replay.status, replay.body.approvalRequestId]).toEqual([202, asked.body.approvalRequestId]);
    expect([await statusOf(overOrder), await documentsOf(overOrder)]).toEqual(['PACKED', 0]);
    const waiting = await post('manager', `/fulfilments/${overList}/dispatch`, dispatchBody());
    expect(waiting.body.error.details.map((d: { code: string }) => d.code)).toEqual(['OVER_LIMIT', 'APPROVAL_PENDING']);
    const approvalId = asked.body.approvalRequestId as string;
    const own = await approve('manager', approvalId);
    expect(own.status).not.toBe(200);
    expect((await approve('owner', approvalId, 'Known buyer')).status).toBe(200);
    const override = await one<{ order_pesewas: string; over_limit_pesewas: string }>('SELECT order_pesewas::text, over_limit_pesewas::text FROM whl.credit_override WHERE order_id = $1', [overOrder]);
    expect(override).toEqual({ order_pesewas: String(2 * crate + FEE), over_limit_pesewas: '1' });
    const sent = await post('manager', `/fulfilments/${overList}/dispatch`, dispatchBody());
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    expect(await invoiceOf(overOrder)).toMatchObject({ gross: String(2 * crate + FEE), due_date: addDays(today(), TERMS) });
    expect(await trialBalanceSum(database)).toBe('0');
  });

  it('judges a backorder of an order on account again at its own dispatch, on its own quantities', async () => {
    const c = await account('Backorder On Account Ltd (TEST)', 3 * crate + FEE);
    const first = await creditOrder(c, 3);
    const list = await packed(first, 2);
    expect((await post('manager', `/fulfilments/${list}/dispatch`, dispatchBody())).status).toBe(200);
    expect(await invoiceOf(first)).toMatchObject({ gross: String(2 * crate + FEE) });
    const backorder = (await one<{ id: string }>('SELECT id FROM ord.sales_order WHERE parent_order_id = $1', [first])).id;
    expect(await order(backorder)).toMatchObject({ paymentTerms: 'CREDIT', deliveryFeePesewas: 0, estimatedTotalPesewas: crate, status: 'CONFIRMED' });
    // A sale on account since leaves room for less than the backorder's one crate: its dispatch is refused on its own gross.
    await issueInvoice(api, actorOf('accountant'), clock, { branchId, customerId: c.customerId, productId: id('EGG-0003') }, 2n, addDays(today(), TERMS));
    expect(await exposureTruth(c.customerId, backorder)).toBe(2 * crate + FEE + 2);
    const rest = await packed(backorder, 1);
    const refused = await post('manager', `/fulfilments/${rest}/dispatch`, dispatchBody());
    expect([refused.status, refused.body.error?.code]).toEqual([422, 'CREDIT_LIMIT_EXCEEDED']);
    expect(refused.body.error.details[0].message).toContain('GHS 0.02 over');
    expect([await statusOf(backorder), await documentsOf(backorder)]).toEqual(['PACKED', 0]);
  });
});

describe('an order on account collected is credit-checked at the hand-over and left due on its terms', () => {
  it('refuses one pesewa over, then hands over within the limit: the invoice due on the terms, nothing at the till', async () => {
    const c = await account('Collect On Account Ltd (TEST)', 2 * crate);
    const collection = await creditOrder(c, 2, 'COLLECTION');
    const list = await packed(collection, 2);
    await issueInvoice(api, actorOf('accountant'), clock, { branchId, customerId: c.customerId, productId: id('EGG-0003') }, 1n, addDays(today(), TERMS));
    const refused = await post('manager', `/fulfilments/${list}/collect`, {});
    expect([refused.status, refused.body.error?.code, refused.body.error?.details?.[1]?.message]).toEqual([422, 'CREDIT_LIMIT_EXCEEDED', 'To ask for a credit override, hand over again with a written reason.']);
    expect([await statusOf(collection), await documentsOf(collection)]).toEqual(['PACKED', 0]);
    for (const who of ['sales', 'storekeeper', 'cashier', 'temaManager']) expect((await post(who, `/fulfilments/${list}/collect`, { creditOverrideReason: 'Regular' })).status, who).toBe(403);
    // Another customer's hand-over exactly at the limit goes.
    const bumped = await account('Collect Within Ltd (TEST)', 2 * crate);
    const within = await creditOrder(bumped, 2, 'COLLECTION');
    const withinList = await packed(within, 2);
    const handed = await post('manager', `/fulfilments/${withinList}/collect`, {});
    expect(handed.status, JSON.stringify(handed.body)).toBe(200);
    expect(await statusOf(within)).toBe('READY_FOR_COLLECTION');
    expect(await invoiceOf(within)).toEqual({ kind: 'INVOICE', gross: String(2 * crate), issue_date: today(), due_date: addDays(today(), TERMS) });
    expect(await payloadOf('ord.OrderCollected', within)).toMatchObject({ dueAtTillPesewas: 0, dueDate: addDays(today(), TERMS), completed: false });
    expect(await trialBalanceSum(database)).toBe('0');
  });
});
