import { randomUUID } from 'node:crypto';
import { ManualClock, toBusinessDate } from '@hakorem/kernel';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { totpAt } from '../../../src/modules/iam/domain/totp';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { consoleGet, consolePost, createUser, enrolAndLogin, login, relaxRateLimits, testStartTime, type TestSession } from '../../support/iam';
import { SQLSTATE, sqlStateOf } from '../../support/sql-state';
import { startTestApp, TEST_ORIGIN, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * Purchase to pay over the seeded farm (FR-PUR-005 to FR-PUR-010, FR-PUR-012, SA-08, A-164, ADR-0017, ADR-0035), the B7
 * gate's first half: the three-way match blocks payment where order, receipt and supplier invoice disagree, in the
 * handler and in the database. An order above 200,000 pesewas waits for a different person; receipts against an order
 * line never pass ordered plus tolerance; a payment is approved by someone other than its maker. Farm terms: 20 broilers
 * from Awutu Poultry Farm at GHS 55.00 a head, broiler grower feed bought by the 50 kg bag.
 */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
type TotpSession = TestSession & { readonly secret: Buffer };
let manager: TotpSession;
let owner: TotpSession;
let accountant: TotpSession;
let pensStorekeeper: TestSession;
let cashier: TestSession;
let sales: TestSession;
let driver: TestSession;
let farmHand: TestSession;
let investor: TestSession;
const ids = new Map<string, string>();

const id = (code: string) => ids.get(code)!;
const post = (session: TestSession, path: string, body: object = {}, key: string = randomUUID()) => consolePost(api.server, session, `/v1${path}`, key).send(body);
const patch = (session: TestSession, path: string, body: object, key: string = randomUUID()) =>
  request(api.server).patch(`/v1${path}`).set('Cookie', session.jar.header()).set('X-CSRF-Token', session.csrfToken).set('Origin', TEST_ORIGIN).set('Idempotency-Key', key).send(body);
const get = (session: TestSession, path: string) => consoleGet(api.server, session, `/v1${path}`);
const admin = () => database.pool('admin');
const today = () => toBusinessDate(clock.now());
const supplier = (name: string) => id(`supplier:${name} (SEED)`);

async function stepUp(session: TotpSession): Promise<void> {
  clock.advanceBy(30_000);
  const response = await post(session, '/auth/step-up', { code: totpAt(session.secret, Math.floor(clock.now().getTime() / 1000)) });
  expect(response.status).toBe(200);
}

async function approve(checker: TotpSession, approvalRequestId: string) {
  await stepUp(checker);
  return post(checker, `/iam/approvals/${approvalRequestId}/approve`, { reason: 'Checked against the quote' });
}

/** Twenty broilers from Awutu at 5,500 a head: 110,000, within the limit. */
function broilerOrder(qty = '20.000', unitPricePesewas = 5_500) {
  return {
    supplierId: supplier('Awutu Poultry Farm'),
    deliverToLocationId: id('location:PENS'),
    orderDate: today(),
    lines: [{ productId: id('product:LIV-BROILER'), qtyOrdered: qty, unitPricePesewas }],
  };
}

/** An order made, submitted within the limit and sent: what a receipt and an invoice are entered against. */
async function sentOrder(qty = '20.000', unitPricePesewas = 5_500): Promise<{ id: string; lineId: string }> {
  const created = await post(pensStorekeeper, '/purchase-orders', broilerOrder(qty, unitPricePesewas));
  expect(created.status).toBe(201);
  expect((await post(pensStorekeeper, `/purchase-orders/${created.body.id}/submit`)).status).toBe(200);
  expect((await post(manager, `/purchase-orders/${created.body.id}/send`, { channels: ['WHATSAPP'] })).status).toBe(200);
  return { id: created.body.id, lineId: created.body.lines[0].id };
}

/** A goods receipt of broilers against an order line, posted by the pens storekeeper. */
async function receive(order: { id: string; lineId: string }, qty: string) {
  const draft = await post(pensStorekeeper, '/goods-receipts', {
    kind: 'PURCHASE',
    supplierId: supplier('Awutu Poultry Farm'),
    locationId: id('location:PENS'),
    purchaseOrderId: order.id,
    deliveryNoteRef: `APF-${randomUUID().slice(0, 6)}`,
    receivedAt: new Date(clock.now().getTime() - 60_000).toISOString(),
    lines: [{ productId: id('product:LIV-BROILER'), purchaseOrderLineId: order.lineId, qtyReceived: qty, valuePesewas: 5_500 * Number.parseInt(qty, 10), batchNo: `BR-${randomUUID().slice(0, 8)}` }],
  });
  expect(draft.status).toBe(201);
  return post(pensStorekeeper, `/goods-receipts/${draft.body.id}/post`);
}

function invoiceAgainst(order: { id: string; lineId: string }, over: { qty?: string; unitPricePesewas?: number; no?: string } = {}) {
  return {
    kind: 'INVOICE',
    supplierId: supplier('Awutu Poultry Farm'),
    supplierInvoiceNo: over.no ?? `APF-INV-${randomUUID().slice(0, 6)}`,
    invoiceDate: today(),
    purchaseOrderId: order.id,
    lines: [
      {
        description: 'Broilers, live, 6 weeks',
        purchaseOrderLineId: order.lineId,
        qty: over.qty ?? '20.000',
        unitPricePesewas: over.unitPricePesewas ?? 5_500,
        taxCategoryId: id('tax:LIVE_ANIMALS'),
      },
    ],
  };
}

/** An approved expense invoice (transport) of `amount`, needing no match, for the payment tests. */
async function approvedExpenseInvoice(amount: number): Promise<string> {
  const created = await post(accountant, '/supplier-invoices', {
    kind: 'INVOICE',
    supplierId: supplier('Kpone Livestock Traders'),
    supplierInvoiceNo: `KLT-${randomUUID().slice(0, 6)}`,
    invoiceDate: today(),
    branchId: id('branch:DDW'),
    lines: [{ description: 'Transport of goats from Kpone', qty: '1.000', unitPricePesewas: amount, taxCategoryId: id('tax:LIVE_ANIMALS') }],
  });
  expect(created.status).toBe(201);
  expect((await post(accountant, `/supplier-invoices/${created.body.id}/match`)).body.matchStatus).toBe('NOT_REQUIRED');
  expect((await post(accountant, `/supplier-invoices/${created.body.id}/approve`)).status).toBe(200);
  return created.body.id as string;
}

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock });
  await runSeedUnits(database.pool('app'), api.app, seedUnits({ SEED_STAFF_PASSWORD: `Seed-${randomUUID()}` }));
  for (const row of (
    await admin().query<{ code: string; id: string }>(
      `SELECT 'branch:' || code AS code, id FROM mdm.branch
       UNION ALL SELECT 'location:' || l.code, l.id FROM mdm.location l JOIN mdm.branch b ON b.id = l.branch_id WHERE b.code = 'DDW'
       UNION ALL SELECT 'product:' || sku, id FROM mdm.product
       UNION ALL SELECT 'supplier:' || name, id FROM mdm.supplier
       UNION ALL SELECT 'tax:' || code, id FROM mdm.tax_category`,
    )
  ).rows) {
    ids.set(row.code, row.id);
  }
  const branchId = id('branch:DDW');
  manager = await enrolAndLogin(api.server, await createUser(database, { name: 'Akosua Boateng', grants: [{ role: 'MANAGER', branchId }] }), () => clock.now());
  owner = await enrolAndLogin(api.server, await createUser(database, { name: 'Kwabena Owusu', grants: [{ role: 'OWNER', branchId }] }), () => clock.now());
  accountant = await enrolAndLogin(api.server, await createUser(database, { name: 'Yaw Agyeman', grants: [{ role: 'ACCOUNTANT', branchId }] }), () => clock.now());
  pensStorekeeper = await login(api.server, await createUser(database, { name: 'Kwesi Ofori', grants: [{ role: 'STOREKEEPER', branchId, locationId: id('location:PENS') }] }));
  cashier = await login(api.server, await createUser(database, { name: 'Adwoa Darko', grants: [{ role: 'CASHIER', branchId, locationId: id('location:SHOP') }] }));
  sales = await login(api.server, await createUser(database, { name: 'Esi Appiah', grants: [{ role: 'SALES', branchId }] }));
  driver = await login(api.server, await createUser(database, { name: 'Selorm Agbeko', grants: [{ role: 'DRIVER', branchId }] }));
  farmHand = await login(api.server, await createUser(database, { name: 'Abdul-Rahman Iddrisu', grants: [{ role: 'FARM_HAND', branchId, locationId: id('location:PENS') }] }));
  investor = await login(api.server, await createUser(database, { name: 'Nana Ama Ofori', grants: [{ role: 'INVESTOR', branchId }] }));
});

afterAll(async () => {
  await api.close();
  await database.drop();
});

describe('wrong roles are refused on every purchase-to-pay write (ADR-0035)', () => {
  it('refuses a purchase order to the Accountant, Cashier, Sales, Driver, Farm hand and Investor', async () => {
    for (const session of [accountant, cashier, sales, driver, farmHand, investor]) {
      expect((await post(session, '/purchase-orders', broilerOrder())).status).toBe(403);
      expect((await post(session, `/purchase-orders/${randomUUID()}/send`, { channels: ['EMAIL'] })).status).toBe(403);
      expect((await post(session, `/purchase-orders/${randomUUID()}/close`, { reason: 'Refused' })).status).toBe(403);
    }
    expect((await get(investor, '/purchase-orders')).status).toBe(403);
  });

  it('refuses supplier invoices and payments to the Storekeeper, Manager (invoice writes and paying), Cashier, Sales, Driver, Farm hand and Investor', async () => {
    const order = await sentOrder();
    for (const session of [pensStorekeeper, cashier, sales, driver, farmHand, investor]) {
      expect((await post(session, '/supplier-invoices', invoiceAgainst(order))).status).toBe(403);
      expect((await post(session, '/supplier-payments', { supplierId: supplier('Awutu Poultry Farm'), method: 'MOBILE_MONEY', allocations: [] })).status).toBe(403);
      expect((await get(session, '/supplier-invoices')).status).toBe(403);
      expect((await get(session, '/supplier-payments')).status).toBe(403);
    }
    expect((await post(manager, '/supplier-invoices', invoiceAgainst(order))).status).toBe(403);
    // The Manager may prepare a payment since the owner's cross-approval (A-171); an unknown invoice is refused, not the role.
    expect((await post(manager, '/supplier-payments', { supplierId: supplier('Awutu Poultry Farm'), method: 'CASH', allocations: [{ supplierInvoiceId: randomUUID(), amountPesewas: 1 }] })).status).toBe(422);
    expect((await post(manager, `/supplier-invoices/${randomUUID()}/match`)).status).toBe(403);
    expect((await post(manager, `/supplier-invoices/${randomUUID()}/approve`)).status).toBe(403);
    expect((await post(manager, `/supplier-payments/${randomUUID()}/mark-paid`, { paidAt: clock.now().toISOString(), externalReference: 'MOMO-1' })).status).toBe(403);
    const { rows } = await admin().query<{ n: number }>('SELECT count(*)::int AS n FROM pur.supplier_invoice WHERE supplier_id = $1', [supplier('Awutu Poultry Farm')]);
    expect(rows[0]!.n).toBe(0);
  });
});

describe('a purchase order and its approval limit (FR-PUR-005)', () => {
  it('approves 20 broilers at 5,500 (110,000) on submit, with exact totals', async () => {
    const created = await post(pensStorekeeper, '/purchase-orders', broilerOrder());
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ status: 'DRAFT', netPesewas: 110_000, taxPesewas: 0, grossPesewas: 110_000, currency: 'GHS', orderNo: null });
    expect(created.body.lines[0]).toMatchObject({ qtyOrdered: '20.000', uom: 'HEAD', baseUom: 'HEAD', qtyOrderedBase: '20.000', qtyReceived: '0.000', qtyOutstanding: '20.000', lineNetPesewas: 110_000 });
    const submitted = await post(pensStorekeeper, `/purchase-orders/${created.body.id}/submit`);
    expect(submitted.status).toBe(200);
    expect(submitted.body).toMatchObject({ status: 'APPROVED', approvalRequestId: null });
  });

  it('holds an order of 250,000 for a different approver, refuses the requester and sending it meanwhile', async () => {
    const created = await post(pensStorekeeper, '/purchase-orders', broilerOrder('50.000', 5_000));
    expect(created.body.grossPesewas).toBe(250_000);
    const submitted = await post(pensStorekeeper, `/purchase-orders/${created.body.id}/submit`);
    expect(submitted.status).toBe(202);
    expect(submitted.body).toMatchObject({ status: 'PENDING_APPROVAL', kind: 'PURCHASE_ORDER', subject: { id: created.body.id, docType: 'PURCHASE_ORDER' } });
    expect((await post(manager, `/purchase-orders/${created.body.id}/send`, { channels: ['EMAIL'] })).body.error.code).toBe('INVALID_STATE_TRANSITION');
    // The Manager made this one: the Manager cannot also check it.
    const mine = await post(manager, '/purchase-orders', broilerOrder('50.000', 5_000));
    const pending = await post(manager, `/purchase-orders/${mine.body.id}/submit`);
    expect(pending.status).toBe(202);
    const self = await approve(manager, pending.body.approvalRequestId);
    expect([self.status, self.body.error.code]).toEqual([422, 'MAKER_CANNOT_CHECK']);
    const approved = await approve(manager, submitted.body.approvalRequestId);
    expect(approved.status).toBe(200);
    const after = await get(manager, `/purchase-orders/${created.body.id}`);
    expect(after.body).toMatchObject({ status: 'APPROVED', approvalRequestId: submitted.body.approvalRequestId });
  });

  it('is refused by the database when an order above its threshold is approved without an approval request', async () => {
    const created = await post(pensStorekeeper, '/purchase-orders', broilerOrder('50.000', 5_000));
    const failure = admin().query(
      `UPDATE pur.purchase_order SET version = version + 1, status = 'APPROVED', approval_threshold_pesewas = 200001, posted_at = now(), posted_by = created_by WHERE id = $1`,
      [created.body.id],
    );
    expect(await sqlStateOf(failure)).toBe(SQLSTATE.checkViolation);
  });

  it('converts a line bought by the 50 kg bag to kilograms through the product conversion, and refuses a unit with none', async () => {
    const bags = await post(manager, '/purchase-orders', {
      supplierId: supplier('Awutu Poultry Farm'),
      deliverToLocationId: id('location:STORE'),
      orderDate: today(),
      lines: [{ productId: id('product:FEED-BRL-GROWER'), uom: 'BAG', qtyOrdered: '10.000', unitPricePesewas: 45_025 }],
    });
    expect(bags.status).toBe(201);
    expect(bags.body.lines[0]).toMatchObject({ uom: 'BAG', qtyOrdered: '10.000', baseUom: 'KG', qtyOrderedBase: '500.000', unitPricePesewas: 45_025, lineNetPesewas: 450_250 });
    const crates = await post(manager, '/purchase-orders', {
      supplierId: supplier('Awutu Poultry Farm'),
      deliverToLocationId: id('location:STORE'),
      orderDate: today(),
      lines: [{ productId: id('product:FEED-BRL-GROWER'), uom: 'CRATE', qtyOrdered: '1.000', unitPricePesewas: 100 }],
    });
    expect([crates.status, crates.body.error.code, crates.body.error.details[0].code]).toEqual([422, 'PURCHASE_ORDER_INVALID', 'NO_CONVERSION']);
  });

  it('rounds a half pesewa up once at the line: 2.5 bags at 45,025 is 112,563', async () => {
    const half = await post(manager, '/purchase-orders', {
      supplierId: supplier('Awutu Poultry Farm'),
      deliverToLocationId: id('location:STORE'),
      orderDate: today(),
      lines: [{ productId: id('product:FEED-BRL-GROWER'), uom: 'BAG', qtyOrdered: '2.500', unitPricePesewas: 45_025 }],
    });
    expect(half.body).toMatchObject({ netPesewas: 112_563, grossPesewas: 112_563 });
    expect(half.body.lines[0].qtyOrderedBase).toBe('125.000');
  });
});

describe('receiving against an order (FR-PUR-006, FR-PUR-007)', () => {
  it('leaves 8 outstanding after 12 of 20, refuses 9 more and completes with 8', async () => {
    const order = await sentOrder();
    expect((await receive(order, '12.000')).status).toBe(200);
    let seen = await get(manager, `/purchase-orders/${order.id}`);
    expect(seen.body.status).toBe('PARTIALLY_RECEIVED');
    expect(seen.body.lines[0]).toMatchObject({ qtyReceived: '12.000', qtyOutstanding: '8.000' });
    const over = await receive(order, '9.000');
    expect([over.status, over.body.error.code]).toEqual([422, 'RECEIPT_EXCEEDS_ORDER']);
    expect((await receive(order, '8.000')).status).toBe(200);
    seen = await get(manager, `/purchase-orders/${order.id}`);
    expect(seen.body.status).toBe('RECEIVED');
    expect(seen.body.lines[0]).toMatchObject({ qtyReceived: '20.000', qtyOutstanding: '0.000' });
  });

  it('refuses to cancel after a partial receipt and short-closes 15 of 20 with 5 outstanding recorded', async () => {
    const order = await sentOrder();
    await receive(order, '15.000');
    const cancel = await post(manager, `/purchase-orders/${order.id}/cancel`, { reason: 'Supplier ran short' });
    expect([cancel.status, cancel.body.error.code, cancel.body.error.details[0].code]).toEqual([422, 'PURCHASE_ORDER_INVALID', 'RECEIVED_ALREADY']);
    const closed = await post(manager, `/purchase-orders/${order.id}/close`, { reason: 'Supplier ran short; 5 birds not coming' });
    expect(closed.status).toBe(200);
    expect(closed.body.status).toBe('CLOSED');
    expect(closed.body.lines[0].qtyOutstanding).toBe('5.000');
    const { rows } = await admin().query<{ metadata: { outstanding: { qtyOutstanding: string }[] } }>(
      `SELECT metadata FROM platform.audit_event WHERE entity_id = $1 AND action = 'CLOSE'`,
      [order.id],
    );
    expect(rows[0]!.metadata.outstanding[0]!.qtyOutstanding).toBe('5.000');
  });

  it('refuses a receipt line that names an order of another supplier', async () => {
    const order = await sentOrder();
    const draft = await post(pensStorekeeper, '/goods-receipts', {
      kind: 'PURCHASE',
      supplierId: supplier('Kpone Livestock Traders'),
      locationId: id('location:PENS'),
      purchaseOrderId: order.id,
      receivedAt: new Date(clock.now().getTime() - 60_000).toISOString(),
      lines: [{ productId: id('product:LIV-BROILER'), purchaseOrderLineId: order.lineId, qtyReceived: '1.000', valuePesewas: 5_500, batchNo: `BR-${randomUUID().slice(0, 8)}` }],
    });
    const posted = await post(pensStorekeeper, `/goods-receipts/${draft.body.id}/post`);
    expect([posted.status, posted.body.error.code]).toEqual([422, 'RECEIPT_ORDER_MISMATCH']);
    expect((await get(manager, `/purchase-orders/${order.id}`)).body.lines[0].qtyReceived).toBe('0.000');
  });
});

describe('supplier invoices (FR-PUR-008)', () => {
  it('refuses a second invoice number from one supplier and takes the same number from another', async () => {
    const order = await sentOrder();
    await receive(order, '20.000');
    expect((await post(accountant, '/supplier-invoices', invoiceAgainst(order, { no: 'INV-0088' }))).status).toBe(201);
    const again = await post(accountant, '/supplier-invoices', invoiceAgainst(order, { no: 'INV-0088' }));
    expect([again.status, again.body.error.code]).toEqual([422, 'DUPLICATE_SUPPLIER_INVOICE']);
    const other = await post(accountant, '/supplier-invoices', {
      kind: 'INVOICE',
      supplierId: supplier('Kpone Livestock Traders'),
      supplierInvoiceNo: 'INV-0088',
      invoiceDate: today(),
      branchId: id('branch:DDW'),
      lines: [{ description: 'Transport', qty: '1.000', unitPricePesewas: 15_000, taxCategoryId: id('tax:LIVE_ANIMALS') }],
    });
    expect(other.status).toBe(201);
  });

  it('refuses lines whose sum differs from the total the supplier printed', async () => {
    const order = await sentOrder();
    const stated = await post(accountant, '/supplier-invoices', { ...invoiceAgainst(order), statedGrossPesewas: 110_001 });
    expect([stated.status, stated.body.error.details[0].code]).toEqual([422, 'STATED_TOTAL_DIFFERS']);
    const exact = await post(accountant, '/supplier-invoices', { ...invoiceAgainst(order), statedGrossPesewas: 110_000 });
    expect(exact.status).toBe(201);
    expect(exact.body).toMatchObject({ status: 'DRAFT', matchStatus: 'UNMATCHED', netPesewas: 110_000, taxPesewas: 0, grossPesewas: 110_000, outstandingPesewas: 110_000 });
    expect(exact.body.lines[0].levies.map((l: { levyCode: string; amountPesewas: number; isReclaimable: boolean }) => [l.levyCode, l.amountPesewas])).toEqual([
      ['VAT', 0],
      ['NHIL', 0],
      ['GETFUND', 0],
    ]);
  });
});

describe('the three-way match blocks payment on disagreement (FR-PUR-009, FR-PUR-010: the B7 gate)', () => {
  let order: { id: string; lineId: string };

  beforeAll(async () => {
    order = await sentOrder();
    expect((await receive(order, '20.000')).status).toBe(200);
  });

  it('matches 20 at 5,550 (0.91 percent over the order price) and approves it for payment', async () => {
    const created = await post(accountant, '/supplier-invoices', invoiceAgainst(order, { unitPricePesewas: 5_550 }));
    const matched = await post(accountant, `/supplier-invoices/${created.body.id}/match`);
    expect(matched.body).toMatchObject({ status: 'MATCHED', matchStatus: 'MATCHED' });
    expect(matched.body.lines[0]).toMatchObject({ matchStatus: 'MATCHED', matchReasons: [], qtyVariance: '0.000', priceVariancePesewas: 50, priceVarianceDirection: 'OVER' });
    // That invoice now holds the 20 received: a second one for the same birds would be invoicing them twice.
    const twice = await post(accountant, '/supplier-invoices', invoiceAgainst(order));
    expect((await post(accountant, `/supplier-invoices/${twice.body.id}/match`)).body.lines[0].matchReasons).toEqual(['QTY_EXCEEDS_RECEIVED']);
    const approved = await post(accountant, `/supplier-invoices/${created.body.id}/approve`);
    expect(approved.body.status).toBe('APPROVED');
    const { rows } = await admin().query<{ payload: { lines: { netPesewas: number; orderValuePesewas: number }[] } }>(
      `SELECT payload FROM platform.outbox_message WHERE event_type = 'pur.SupplierInvoiceMatched' AND subject_id = $1`,
      [created.body.id],
    );
    expect(rows[0]!.payload.lines[0]).toMatchObject({ netPesewas: 111_000, orderValuePesewas: 110_000 });
  });

  it('mismatches 20 at 5,600 (1.82 percent) on price, refuses approval and refuses payment, and the database refuses a direct allocation', async () => {
    const second = await sentOrder();
    await receive(second, '20.000');
    const created = await post(accountant, '/supplier-invoices', invoiceAgainst(second, { unitPricePesewas: 5_600 }));
    const matched = await post(accountant, `/supplier-invoices/${created.body.id}/match`);
    expect(matched.body).toMatchObject({ status: 'MISMATCH', matchStatus: 'MISMATCH' });
    expect(matched.body.lines[0]).toMatchObject({ matchReasons: ['PRICE_OUTSIDE_TOLERANCE'], priceVariancePesewas: 100, priceVarianceDirection: 'OVER' });
    const approval = await post(accountant, `/supplier-invoices/${created.body.id}/approve`);
    expect([approval.status, approval.body.error.code]).toEqual([422, 'THREE_WAY_MATCH_FAILED']);
    const payment = await post(accountant, '/supplier-payments', {
      supplierId: supplier('Awutu Poultry Farm'),
      method: 'MOBILE_MONEY',
      allocations: [{ supplierInvoiceId: created.body.id, amountPesewas: 112_000 }],
    });
    expect([payment.status, payment.body.error.code]).toEqual([422, 'THREE_WAY_MATCH_FAILED']);
    // A script going round the handler meets the trigger: no allocation to an unmatched invoice.
    const docId = randomUUID();
    const client = await admin().connect();
    try {
      await client.query('BEGIN');
      await client.query(`INSERT INTO platform.business_document (id, doc_type, owner_module, branch_id, actor_id) VALUES ($1, 'SUPPLIER_PAYMENT', 'pur', $2, $3)`, [docId, id('branch:DDW'), matched.body.createdBy.id]);
      await client.query(`INSERT INTO pur.supplier_payment (id, supplier_id, method, amount_pesewas, status, branch_id, created_by, updated_by) VALUES ($1, $2, 'CASH', 112000, 'DRAFT', $3, $4, $4)`, [
        docId,
        supplier('Awutu Poultry Farm'),
        id('branch:DDW'),
        matched.body.createdBy.id,
      ]);
      const failure = client.query(
        `INSERT INTO pur.supplier_payment_allocation (id, supplier_payment_id, supplier_invoice_id, amount_pesewas, actor_id) VALUES ($1, $2, $3, 112000, $4)`,
        [randomUUID(), docId, created.body.id, matched.body.createdBy.id],
      );
      expect(await sqlStateOf(failure)).toBe('HK010');
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
    // Correcting the invoice to the order price clears the mismatch, and then it can be approved and paid.
    const corrected = await patch(accountant, `/supplier-invoices/${created.body.id}`, { version: matched.body.version, lines: invoiceAgainst(second).lines });
    expect(corrected.body).toMatchObject({ status: 'DRAFT', matchStatus: 'UNMATCHED' });
    expect((await post(accountant, `/supplier-invoices/${created.body.id}/match`)).body.matchStatus).toBe('MATCHED');
    expect((await post(accountant, `/supplier-invoices/${created.body.id}/approve`)).body.status).toBe('APPROVED');
  });

  it('mismatches 22 invoiced against 20 received on quantity', async () => {
    const third = await sentOrder();
    await receive(third, '20.000');
    const created = await post(accountant, '/supplier-invoices', invoiceAgainst(third, { qty: '22.000' }));
    const matched = await post(accountant, `/supplier-invoices/${created.body.id}/match`);
    expect(matched.body.lines[0]).toMatchObject({ matchStatus: 'MISMATCH', matchReasons: ['QTY_EXCEEDS_RECEIVED'], qtyVariance: '2.000' });
  });

  it('mismatches an invoice for birds that were never received', async () => {
    const unreceived = await sentOrder();
    const created = await post(accountant, '/supplier-invoices', invoiceAgainst(unreceived));
    const matched = await post(accountant, `/supplier-invoices/${created.body.id}/match`);
    expect(matched.body).toMatchObject({ matchStatus: 'MISMATCH' });
    expect(matched.body.lines[0].qtyVariance).toBe('20.000');
  });
});

describe('supplier payments (FR-PUR-012)', () => {
  it('pays 110,000 across invoices of 60,000 and 50,000 exactly, refuses 110,001, and needs a different approver', async () => {
    // A mobile money payment pays only a wallet a different person approved (FR-PUR-002, B07 continued, A-166, A-169).
    const kpone = supplier('Kpone Livestock Traders');
    const profile = await get(owner, `/suppliers/${kpone}/profile`);
    const wallet = await request(api.server)
      .put(`/v1/suppliers/${kpone}/profile`)
      .set('Cookie', owner.jar.header())
      .set('X-CSRF-Token', owner.csrfToken)
      .set('Origin', TEST_ORIGIN)
      .set('Idempotency-Key', randomUUID())
      .send({ version: profile.body.version, payoutDetails: { method: 'MOBILE_MONEY', momoNetwork: 'MTN', momoNumber: '+233240000021' } });
    expect(wallet.status).toBe(202);
    const secondOwner = await enrolAndLogin(api.server, await createUser(database, { name: 'Adjoa Owusu', grants: [{ role: 'OWNER', branchId: id('branch:DDW') }] }), () => clock.now());
    expect((await approve(secondOwner, wallet.body.approvalRequestId)).status).toBe(200);
    const first = await approvedExpenseInvoice(60_000);
    const second = await approvedExpenseInvoice(50_000);
    const over = await post(accountant, '/supplier-payments', {
      supplierId: supplier('Kpone Livestock Traders'),
      method: 'MOBILE_MONEY',
      allocations: [
        { supplierInvoiceId: first, amountPesewas: 60_001 },
        { supplierInvoiceId: second, amountPesewas: 50_000 },
      ],
    });
    expect([over.status, over.body.error.code]).toEqual([422, 'ALLOCATION_EXCEEDS_AVAILABLE']);
    const created = await post(accountant, '/supplier-payments', {
      supplierId: supplier('Kpone Livestock Traders'),
      method: 'MOBILE_MONEY',
      scheduledFor: today(),
      allocations: [
        { supplierInvoiceId: first, amountPesewas: 60_000 },
        { supplierInvoiceId: second, amountPesewas: 50_000 },
      ],
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ status: 'DRAFT', amountPesewas: 110_000, currency: 'GHS', bankAccount: null });
    // The invoices are fully promised to this payment: another for one pesewa more is refused.
    const extra = await post(accountant, '/supplier-payments', { supplierId: supplier('Kpone Livestock Traders'), method: 'CASH', allocations: [{ supplierInvoiceId: first, amountPesewas: 1 }] });
    expect(extra.body.error.code).toBe('ALLOCATION_EXCEEDS_AVAILABLE');
    const early = await post(accountant, `/supplier-payments/${created.body.id}/mark-paid`, { paidAt: clock.now().toISOString(), externalReference: 'MOMO-7781' });
    expect(early.body.error.code).toBe('INVALID_STATE_TRANSITION');
    const submitted = await post(accountant, `/supplier-payments/${created.body.id}/submit`);
    expect(submitted.status).toBe(202);
    expect(submitted.body.kind).toBe('SUPPLIER_PAYMENT');
    const self = await approve(accountant, submitted.body.approvalRequestId);
    expect(self.status).toBe(403);
    const approved = await approve(manager, submitted.body.approvalRequestId);
    expect(approved.status).toBe(200);
    const paid = await post(accountant, `/supplier-payments/${created.body.id}/mark-paid`, { paidAt: clock.now().toISOString(), externalReference: 'MOMO-7781' });
    expect(paid.status).toBe(200);
    expect(paid.body).toMatchObject({ status: 'PAID', externalReference: 'MOMO-7781', approvalRequestId: submitted.body.approvalRequestId });
    for (const invoiceId of [first, second]) {
      expect((await get(accountant, `/supplier-invoices/${invoiceId}`)).body).toMatchObject({ status: 'PAID', outstandingPesewas: 0 });
    }
    const { rows } = await admin().query<{ n: number }>(`SELECT count(*)::int AS n FROM platform.outbox_message WHERE event_type = 'pur.SupplierPaymentMade' AND subject_id = $1`, [created.body.id]);
    expect(rows[0]!.n).toBe(1);
  });

  it('refuses the maker as checker even when the maker holds the approver permission', async () => {
    const invoice = await approvedExpenseInvoice(20_000);
    const created = await post(owner, '/supplier-payments', { supplierId: supplier('Kpone Livestock Traders'), method: 'CASH', allocations: [{ supplierInvoiceId: invoice, amountPesewas: 20_000 }] });
    const submitted = await post(owner, `/supplier-payments/${created.body.id}/submit`);
    const self = await approve(owner, submitted.body.approvalRequestId);
    expect([self.status, self.body.error.code]).toEqual([422, 'MAKER_CANNOT_CHECK']);
  });

  it('lets only one of two payments racing for the same invoice promise it', async () => {
    const invoice = await approvedExpenseInvoice(30_000);
    const body = { supplierId: supplier('Kpone Livestock Traders'), method: 'CASH', allocations: [{ supplierInvoiceId: invoice, amountPesewas: 30_000 }] };
    const results = await Promise.all([post(accountant, '/supplier-payments', body), post(owner, '/supplier-payments', body)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 422]);
    expect(results.find((r) => r.status === 422)!.body.error.code).toBe('ALLOCATION_EXCEEDS_AVAILABLE');
    const { rows } = await admin().query<{ amount: string }>('SELECT sum(amount_pesewas)::text AS amount FROM pur.supplier_payment_allocation WHERE supplier_invoice_id = $1', [invoice]);
    expect(rows[0]!.amount).toBe('30000');
  });

  it('keeps an allocation append-only', async () => {
    const { rows } = await admin().query<{ id: string }>('SELECT id FROM pur.supplier_payment_allocation LIMIT 1');
    // The application role holds no UPDATE or DELETE on a LEDGER table, and the trigger refuses even the owner.
    expect(await sqlStateOf(database.pool('app').query('UPDATE pur.supplier_payment_allocation SET amount_pesewas = 1 WHERE id = $1', [rows[0]!.id]))).toBe(SQLSTATE.insufficientPrivilege);
    expect(await sqlStateOf(database.pool('app').query('DELETE FROM pur.supplier_payment_allocation WHERE id = $1', [rows[0]!.id]))).toBe(SQLSTATE.insufficientPrivilege);
    expect(await sqlStateOf(admin().query('UPDATE pur.supplier_payment_allocation SET amount_pesewas = 1 WHERE id = $1', [rows[0]!.id]))).toBe(SQLSTATE.ledgerImmutable);
    expect(await sqlStateOf(admin().query('DELETE FROM pur.supplier_payment_allocation WHERE id = $1', [rows[0]!.id]))).toBe(SQLSTATE.ledgerImmutable);
  });
});
