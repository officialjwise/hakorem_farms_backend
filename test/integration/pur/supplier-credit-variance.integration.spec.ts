import { randomUUID } from 'node:crypto';
import { ManualClock, toBusinessDate } from '@hakorem/kernel';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { totpAt } from '../../../src/modules/iam/domain/totp';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { consoleGet, consolePost, createUser, enrolAndLogin, login, relaxRateLimits, testStartTime, type TestSession } from '../../support/iam';
import { databaseErrorOf } from '../../../src/platform/database/unit-of-work';
import { startTestApp, TEST_ORIGIN, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * B07 continued 1b over the seeded farm (FR-PUR-010, FR-PUR-011, FR-PUR-013, FR-PUR-014, A-172 to A-174, ADR-0017,
 * ADR-0035): supplier credit notes never exceed what their invoice has left, in the handler and the database, and send
 * goods back through INV; an approved variance lets a mismatched invoice be paid, never by its maker; a paid payment's
 * remittance data is fixed once (scores are `supplier-scores.integration.spec.ts`). Farm terms: broilers from Awutu Poultry Farm
 * at GHS 55.00 a head into the pens.
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
const count = async (sql: string, values: unknown[]) => (await admin().query<{ n: number }>(sql, values)).rows[0]!.n;

async function stepUp(session: TotpSession): Promise<void> {
  clock.advanceBy(30_000);
  const response = await post(session, '/auth/step-up', { code: totpAt(session.secret, Math.floor(clock.now().getTime() / 1000)) });
  expect(response.status).toBe(200);
}

async function approve(checker: TotpSession, approvalRequestId: string) {
  await stepUp(checker);
  return post(checker, `/iam/approvals/${approvalRequestId}/approve`, { reason: 'Checked against the delivery note' });
}

async function reject(checker: TotpSession, approvalRequestId: string) {
  await stepUp(checker);
  return post(checker, `/iam/approvals/${approvalRequestId}/reject`, { reason: 'Ask the supplier for a corrected invoice' });
}

interface SentOrder {
  readonly id: string;
  readonly lineId: string;
}

/** An order of broilers made by the pens storekeeper, within the limit, and sent. */
async function sentOrder(supplierName: string, qty: string, unitPricePesewas: number, expectedOn?: string): Promise<SentOrder> {
  const created = await post(pensStorekeeper, '/purchase-orders', {
    supplierId: supplier(supplierName),
    deliverToLocationId: id('location:PENS'),
    orderDate: today(),
    ...(expectedOn === undefined ? {} : { expectedOn }),
    lines: [{ productId: id('product:LIV-BROILER'), qtyOrdered: qty, unitPricePesewas }],
  });
  expect(created.status).toBe(201);
  expect((await post(pensStorekeeper, `/purchase-orders/${created.body.id}/submit`)).status).toBe(200);
  expect((await post(manager, `/purchase-orders/${created.body.id}/send`, { channels: ['WHATSAPP'] })).status).toBe(200);
  return { id: created.body.id, lineId: created.body.lines[0].id };
}

/** A posted receipt of broilers against the order line; returns the lot the birds came in as. */
async function receive(supplierName: string, order: SentOrder, qty: string, qtyRejected?: string): Promise<string> {
  const draft = await post(pensStorekeeper, '/goods-receipts', {
    kind: 'PURCHASE',
    supplierId: supplier(supplierName),
    locationId: id('location:PENS'),
    purchaseOrderId: order.id,
    deliveryNoteRef: `DN-${randomUUID().slice(0, 6)}`,
    receivedAt: new Date(clock.now().getTime() - 60_000).toISOString(),
    lines: [
      {
        productId: id('product:LIV-BROILER'),
        purchaseOrderLineId: order.lineId,
        qtyReceived: qty,
        ...(qtyRejected === undefined ? {} : { qtyRejected }),
        valuePesewas: 5_500 * Number.parseInt(qty, 10),
        batchNo: `BR-${randomUUID().slice(0, 8)}`,
      },
    ],
  });
  expect(draft.status).toBe(201);
  const posted = await post(pensStorekeeper, `/goods-receipts/${draft.body.id}/post`);
  expect(posted.status).toBe(200);
  return (await admin().query<{ stock_unit_id: string }>('SELECT stock_unit_id FROM inv.stock_movement WHERE source_document_id = $1 LIMIT 1', [draft.body.id])).rows[0]!.stock_unit_id;
}

function invoiceBody(supplierName: string, order: SentOrder, qty: string, unitPricePesewas: number) {
  return {
    kind: 'INVOICE',
    supplierId: supplier(supplierName),
    supplierInvoiceNo: `INV-${randomUUID().slice(0, 8)}`,
    invoiceDate: today(),
    purchaseOrderId: order.id,
    lines: [{ description: 'Broilers, live, 6 weeks', purchaseOrderLineId: order.lineId, qty, unitPricePesewas, taxCategoryId: id('tax:LIVE_ANIMALS') }],
  };
}

/** An invoice entered by `maker`, matched; approved too when `approveIt`. */
async function invoiceFor(maker: TestSession, supplierName: string, order: SentOrder, qty: string, unitPricePesewas: number, approveIt = true): Promise<string> {
  const created = await post(maker, '/supplier-invoices', invoiceBody(supplierName, order, qty, unitPricePesewas));
  expect(created.status).toBe(201);
  await post(maker, `/supplier-invoices/${created.body.id}/match`);
  if (approveIt) expect((await post(maker, `/supplier-invoices/${created.body.id}/approve`)).status).toBe(200);
  return created.body.id as string;
}

function creditBody(supplierName: string, originalInvoiceId: string, line: object, over: object = {}) {
  return {
    kind: 'CREDIT_NOTE',
    supplierId: supplier(supplierName),
    supplierInvoiceNo: `CN-${randomUUID().slice(0, 8)}`,
    invoiceDate: today(),
    originalInvoiceId,
    lines: [{ taxCategoryId: id('tax:LIVE_ANIMALS'), ...line }],
    ...over,
  };
}

/** Two broilers of a lot sent back as weak on arrival, credited at 5,500 each: 11,000. */
const twoBack = (order: SentOrder, lot: string) => ({
  description: 'Two broilers returned, weak on arrival',
  purchaseOrderLineId: order.lineId,
  qty: '2.000',
  unitPricePesewas: 5_500,
  returnFromLocationId: id('location:PENS'),
  returnStockUnitId: lot,
});

/** A cash payment prepared by the accountant, approved by the manager and marked paid. */
async function paidInCash(supplierName: string, allocations: { supplierInvoiceId: string; amountPesewas: number }[], reference: string) {
  const created = await post(accountant, '/supplier-payments', { supplierId: supplier(supplierName), method: 'CASH', allocations });
  expect(created.status).toBe(201);
  const submitted = await post(accountant, `/supplier-payments/${created.body.id}/submit`);
  expect(submitted.status).toBe(202);
  expect((await approve(manager, submitted.body.approvalRequestId)).status).toBe(200);
  const key = randomUUID();
  const paid = await post(accountant, `/supplier-payments/${created.body.id}/mark-paid`, { paidAt: clock.now().toISOString(), externalReference: reference }, key);
  expect(paid.status).toBe(200);
  return { id: created.body.id as string, key };
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

describe('wrong roles are refused on every write and read this phase adds (ADR-0035)', () => {
  it('refuses credit notes, their submission and variances to the Storekeeper, Manager, Cashier, Sales, Driver, Farm hand and Investor', async () => {
    const order = await sentOrder('Awutu Poultry Farm', '20.000', 5_500);
    const lot = await receive('Awutu Poultry Farm', order, '20.000');
    const invoice = await invoiceFor(accountant, 'Awutu Poultry Farm', order, '20.000', 5_500);
    for (const session of [pensStorekeeper, manager, cashier, sales, driver, farmHand, investor]) {
      expect((await post(session, '/supplier-invoices', creditBody('Awutu Poultry Farm', invoice, twoBack(order, lot), { returnReasonCode: 'RETURN_QUALITY' }))).status).toBe(403);
      expect((await post(session, `/supplier-invoices/${invoice}/submit`)).status).toBe(403);
      expect((await post(session, `/supplier-invoices/${invoice}/variance`, { reason: 'Agreed by phone' })).status).toBe(403);
    }
    expect(await count('SELECT count(*)::int AS n FROM pur.supplier_invoice WHERE original_invoice_id = $1', [invoice])).toBe(0);
  });

  it('refuses scores and remittance data to the Storekeeper, Cashier, Sales, Driver, Farm hand and Investor', async () => {
    for (const session of [pensStorekeeper, cashier, sales, driver, farmHand, investor]) {
      expect((await get(session, `/supplier-scores?periodStart=${today().slice(0, 7)}-01`)).status).toBe(403);
      expect((await get(session, `/supplier-payments/${randomUUID()}/remittance`)).status).toBe(403);
    }
  });

  it('refuses a variance approval to the Accountant, who asks for variances but holds no approver permission', async () => {
    const order = await sentOrder('Awutu Poultry Farm', '20.000', 5_500);
    await receive('Awutu Poultry Farm', order, '20.000');
    const invoice = await invoiceFor(owner, 'Awutu Poultry Farm', order, '20.000', 5_600, false);
    const asked = await post(accountant, `/supplier-invoices/${invoice}/variance`, { reason: 'Awutu raised the price after the order' });
    expect(asked.status).toBe(202);
    const other = await enrolAndLogin(api.server, await createUser(database, { name: 'Ama Serwaa', grants: [{ role: 'ACCOUNTANT', branchId: id('branch:DDW') }] }), () => clock.now());
    expect((await approve(other, asked.body.approvalRequestId)).status).toBe(403);
    expect((await get(owner, `/supplier-invoices/${invoice}`)).body).toMatchObject({ status: 'MISMATCH', matchStatus: 'MISMATCH', approvalRequestId: asked.body.approvalRequestId });
  });
});

describe('a supplier credit note cannot exceed its invoice (FR-PUR-011: the gate)', () => {
  let order: SentOrder;
  let lot: string;
  let invoice: string;
  let credit: string;

  beforeAll(async () => {
    order = await sentOrder('Awutu Poultry Farm', '20.000', 5_500);
    lot = await receive('Awutu Poultry Farm', order, '20.000');
    invoice = await invoiceFor(accountant, 'Awutu Poultry Farm', order, '20.000', 5_500);
  });

  it('takes a credit of 11,000 against the 110,000 invoice as a DRAFT that changes nothing yet', async () => {
    const created = await post(accountant, '/supplier-invoices', creditBody('Awutu Poultry Farm', invoice, twoBack(order, lot), { returnReasonCode: 'RETURN_QUALITY' }));
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ kind: 'CREDIT_NOTE', status: 'DRAFT', originalInvoiceId: invoice, grossPesewas: 11_000, outstandingPesewas: 0, matchStatus: 'UNMATCHED', returnReasonCode: 'RETURN_QUALITY' });
    expect(created.body.lines[0]).toMatchObject({ qty: '2.000', lineNetPesewas: 11_000, returnFromLocationId: id('location:PENS'), returnStockUnitId: lot });
    credit = created.body.id;
    expect((await get(accountant, `/supplier-invoices/${invoice}`)).body).toMatchObject({ grossPesewas: 110_000, creditedPesewas: 0, outstandingPesewas: 110_000 });
  });

  it('refuses a second credit of 100,000, since only 99,000 is left uncredited, and a payment of more than 99,000', async () => {
    const second = await post(accountant, '/supplier-invoices', creditBody('Awutu Poultry Farm', invoice, { description: 'Price allowance', qty: '1.000', unitPricePesewas: 100_000 }));
    expect(second.status).toBe(422);
    expect(second.body.error.code).toBe('CREDIT_NOTE_EXCEEDS_INVOICE');
    const payment = await post(accountant, '/supplier-payments', { supplierId: supplier('Awutu Poultry Farm'), method: 'CASH', allocations: [{ supplierInvoiceId: invoice, amountPesewas: 99_001 }] });
    expect(payment.status).toBe(422);
    expect(payment.body.error.code).toBe('ALLOCATION_EXCEEDS_AVAILABLE');
  });

  it('is refused by the database itself when a credit past the invoice is written directly', async () => {
    const original = (await admin().query<{ tax_scheme_version_id: string; branch_id: string; created_by: string }>('SELECT tax_scheme_version_id, branch_id, created_by FROM pur.supplier_invoice WHERE id = $1', [invoice])).rows[0]!;
    const client = await admin().connect();
    try {
      await client.query('BEGIN');
      const docId = randomUUID();
      await client.query("INSERT INTO platform.business_document (id, doc_type, owner_module, branch_id, actor_id) VALUES ($1, 'SUPPLIER_INVOICE', 'pur', $2, $3)", [docId, original.branch_id, original.created_by]);
      await client.query(
        `INSERT INTO pur.supplier_invoice (id, kind, supplier_id, supplier_invoice_no, invoice_date, due_date, original_invoice_id, net_pesewas, tax_pesewas, gross_pesewas,
                                           tax_scheme_version_id, status, branch_id, created_by, updated_by)
         VALUES ($1, 'CREDIT_NOTE', $2, 'CN-DIRECT', $3, $3, $4, 100000, 0, 100000, $5, 'DRAFT', $6, $7, $7)`,
        [docId, supplier('Awutu Poultry Farm'), today(), invoice, original.tax_scheme_version_id, original.branch_id, original.created_by],
      );
      await client.query(
        `INSERT INTO pur.supplier_invoice_line (id, supplier_invoice_id, line_no, description, qty, unit_price_pesewas, line_net_pesewas, tax_category_id)
         VALUES ($1, $2, 1, 'Allowance', 1, 100000, 100000, $3)`,
        [randomUUID(), docId, id('tax:LIVE_ANIMALS')],
      );
      const failure = await client.query('COMMIT').then(
        () => null,
        (error: unknown) => error,
      );
      expect(databaseErrorOf(failure)?.code).toBe('HK010');
      expect(databaseErrorOf(failure)?.constraint).toBe('ck_supplier_credit_note_cap');
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });

  it('waits for a different person on submit, refuses its maker as checker, and on approval leaves 99,000 payable and sends the two birds back', async () => {
    const submitted = await post(accountant, `/supplier-invoices/${credit}/submit`);
    expect(submitted.status).toBe(202);
    expect(submitted.body).toMatchObject({ status: 'PENDING_APPROVAL', kind: 'SUPPLIER_CREDIT_NOTE' });
    expect((await patch(accountant, `/supplier-invoices/${credit}`, { version: 2, supplierInvoiceNo: 'CN-CHANGED' })).body.error.code).toBe('APPROVAL_PENDING');
    const byMaker = await approve(accountant, submitted.body.approvalRequestId);
    expect(byMaker.status).toBe(422);
    expect(byMaker.body.error.code).toBe('MAKER_CANNOT_CHECK');
    expect((await get(accountant, `/supplier-invoices/${invoice}`)).body.creditedPesewas).toBe(0);

    const approved = await approve(owner, submitted.body.approvalRequestId);
    expect(approved.status).toBe(200);
    expect((await get(accountant, `/supplier-invoices/${credit}`)).body).toMatchObject({ status: 'APPROVED', matchStatus: 'NOT_REQUIRED', approvalRequestId: submitted.body.approvalRequestId });
    expect((await get(accountant, `/supplier-invoices/${invoice}`)).body).toMatchObject({ status: 'APPROVED', grossPesewas: 110_000, creditedPesewas: 11_000, paidPesewas: 0, outstandingPesewas: 99_000 });

    const { rows } = await admin().query<{ qty: string; reason_code: string; from_location_id: string; stock_unit_id: string }>(
      "SELECT qty_base::text AS qty, reason_code, from_location_id, stock_unit_id FROM inv.stock_movement WHERE movement_type = 'SUPPLIER_RETURN' AND source_document_id = $1",
      [credit],
    );
    expect(rows).toEqual([{ qty: '2.000', reason_code: 'RETURN_QUALITY', from_location_id: id('location:PENS'), stock_unit_id: lot }]);
    const event = (await admin().query<{ payload: { grossPesewas: number; originalInvoiceId: string; returns: { qty: string }[] } }>("SELECT payload FROM platform.outbox_message WHERE event_type = 'pur.SupplierCreditNoteApproved' AND subject_id = $1", [credit])).rows;
    expect(event).toHaveLength(1);
    expect(event[0]!.payload).toMatchObject({ grossPesewas: 11_000, originalInvoiceId: invoice, returns: [{ qty: '2.000' }] });
    expect(await count("SELECT count(*)::int AS n FROM platform.outbox_message WHERE event_type = 'inv.SupplierReturnIssued' AND payload->>'sourceDocumentId' = $1", [credit])).toBe(1);
  });

  it('pays the 99,000 left exactly, which settles the invoice, and fixes its remittance data once (FR-PUR-013)', async () => {
    const reference = `CASH-${randomUUID().slice(0, 6)}`;
    const payment = await paidInCash('Awutu Poultry Farm', [{ supplierInvoiceId: invoice, amountPesewas: 99_000 }], reference);
    expect((await get(accountant, `/supplier-invoices/${invoice}`)).body).toMatchObject({ status: 'PAID', paidPesewas: 99_000, creditedPesewas: 11_000, outstandingPesewas: 0 });
    const remittance = await get(manager, `/supplier-payments/${payment.id}/remittance`);
    expect(remittance.status).toBe(200);
    expect(remittance.body).toMatchObject({ supplierPaymentId: payment.id, method: 'CASH', amountPesewas: 99_000, currency: 'GHS', externalReference: reference, remittanceDocumentId: null });
    expect(remittance.body.lines).toEqual([
      { supplierInvoiceId: invoice, supplierInvoiceNo: expect.any(String), invoiceDate: today(), grossPesewas: 110_000, creditedPesewas: 11_000, amountPesewas: 99_000, outstandingAfterPesewas: 0 },
    ]);
    // A replay answers the same, a second marking is refused, and there is still one advice and one event.
    expect((await post(accountant, `/supplier-payments/${payment.id}/mark-paid`, { paidAt: clock.now().toISOString(), externalReference: reference }, payment.key)).status).toBe(200);
    expect((await post(accountant, `/supplier-payments/${payment.id}/mark-paid`, { paidAt: clock.now().toISOString(), externalReference: `${reference}-2` })).status).toBe(422);
    expect(await count('SELECT count(*)::int AS n FROM pur.supplier_remittance WHERE supplier_payment_id = $1', [payment.id])).toBe(1);
    expect(await count("SELECT count(*)::int AS n FROM platform.outbox_message WHERE event_type = 'pur.SupplierRemittanceReady' AND subject_id = $1", [payment.id])).toBe(1);
    const again = await admin()
      .query('INSERT INTO pur.supplier_remittance (id, supplier_payment_id, supplier_id, method, amount_pesewas, paid_at, external_reference, lines, branch_id, actor_id) SELECT $1, supplier_payment_id, supplier_id, method, amount_pesewas, paid_at, external_reference, lines, branch_id, actor_id FROM pur.supplier_remittance WHERE supplier_payment_id = $2', [randomUUID(), payment.id])
      .then(() => null, (error: unknown) => error);
    expect(databaseErrorOf(again)?.code).toBe('23505');
    const changed = await admin().query("UPDATE pur.supplier_remittance SET external_reference = 'X' WHERE supplier_payment_id = $1", [payment.id]).then(() => null, (error: unknown) => error);
    expect(databaseErrorOf(changed)?.code).not.toBeUndefined();
  });

  it('has no remittance data for a payment not yet paid, and the database refuses one', async () => {
    const order2 = await sentOrder('Awutu Poultry Farm', '10.000', 5_500);
    await receive('Awutu Poultry Farm', order2, '10.000');
    const invoice2 = await invoiceFor(accountant, 'Awutu Poultry Farm', order2, '10.000', 5_500);
    const created = await post(accountant, '/supplier-payments', { supplierId: supplier('Awutu Poultry Farm'), method: 'CASH', allocations: [{ supplierInvoiceId: invoice2, amountPesewas: 55_000 }] });
    expect((await get(accountant, `/supplier-payments/${created.body.id}/remittance`)).status).toBe(404);
    const direct = await admin()
      .query(
        `INSERT INTO pur.supplier_remittance (id, supplier_payment_id, supplier_id, method, amount_pesewas, paid_at, external_reference, lines, branch_id, actor_id)
         SELECT $1, p.id, p.supplier_id, p.method, p.amount_pesewas, now(), 'NOT-PAID', '[{}]'::jsonb, p.branch_id, p.created_by FROM pur.supplier_payment p WHERE p.id = $2`,
        [randomUUID(), created.body.id],
      )
      .then(() => null, (error: unknown) => error);
    expect(databaseErrorOf(direct)?.code).toBe('HK010');
  });

  it('refuses a credit against an invoice not approved, one of another supplier, goods sent back with no reason, and an invoice carrying credit fields', async () => {
    const order3 = await sentOrder('Awutu Poultry Farm', '10.000', 5_500);
    const lot3 = await receive('Awutu Poultry Farm', order3, '10.000');
    const draftInvoice = await invoiceFor(accountant, 'Awutu Poultry Farm', order3, '10.000', 5_500, false);
    const notApproved = await post(accountant, '/supplier-invoices', creditBody('Awutu Poultry Farm', draftInvoice, { description: 'Allowance', qty: '1.000', unitPricePesewas: 100 }));
    expect(notApproved.body.error.details).toEqual([expect.objectContaining({ field: '/originalInvoiceId', code: 'ORIGINAL_NOT_APPROVED' })]);
    expect((await post(accountant, `/supplier-invoices/${draftInvoice}/approve`)).status).toBe(200);
    const otherSupplier = await post(accountant, '/supplier-invoices', creditBody('Kpone Livestock Traders', draftInvoice, { description: 'Allowance', qty: '1.000', unitPricePesewas: 100 }));
    expect(otherSupplier.body.error.details).toEqual([expect.objectContaining({ code: 'ORIGINAL_OF_ANOTHER_SUPPLIER' })]);
    const noReason = await post(accountant, '/supplier-invoices', creditBody('Awutu Poultry Farm', draftInvoice, twoBack(order3, lot3)));
    expect(noReason.body.error.details).toEqual([expect.objectContaining({ field: '/returnReasonCode', code: 'RETURN_REASON_REQUIRED' })]);
    const wrongReason = await post(accountant, '/supplier-invoices', creditBody('Awutu Poultry Farm', draftInvoice, twoBack(order3, lot3), { returnReasonCode: 'MORT_DISEASE' }));
    expect(wrongReason.body.error.details).toEqual([expect.objectContaining({ field: '/returnReasonCode', code: 'RETURN_REASON_INVALID' })]);
    const invoiceWithCredit = await post(accountant, '/supplier-invoices', { ...invoiceBody('Awutu Poultry Farm', order3, '1.000', 5_500), originalInvoiceId: draftInvoice });
    expect(invoiceWithCredit.body.error.details).toEqual([expect.objectContaining({ field: '/originalInvoiceId', code: 'NOT_FOR_INVOICE' })]);
    // A credit note is never matched or approved directly, and its invoice is not cancelled while it lives.
    const credit3 = await post(accountant, '/supplier-invoices', creditBody('Awutu Poultry Farm', draftInvoice, { description: 'Allowance', qty: '1.000', unitPricePesewas: 500 }));
    expect(credit3.status).toBe(201);
    expect((await post(accountant, `/supplier-invoices/${credit3.body.id}/approve`)).body.error.details).toEqual([expect.objectContaining({ code: 'CREDIT_NOTE_NEEDS_APPROVAL' })]);
    expect((await post(accountant, `/supplier-invoices/${draftInvoice}/cancel`, { reason: 'Entered twice' })).body.error.details).toEqual([expect.objectContaining({ code: 'CREDIT_NOTE_ENTERED' })]);
    // Rejected, the credit goes back to an editable DRAFT and nothing was credited.
    const submitted = await post(accountant, `/supplier-invoices/${credit3.body.id}/submit`);
    expect((await reject(owner, submitted.body.approvalRequestId)).status).toBe(200);
    expect((await get(accountant, `/supplier-invoices/${credit3.body.id}`)).body).toMatchObject({ status: 'DRAFT', approvalRequestId: null });
    expect((await get(accountant, `/supplier-invoices/${draftInvoice}`)).body.creditedPesewas).toBe(0);
  });

  it('is refused by the database when a credit note is approved by the person who entered it, or the credited amount is written by hand', async () => {
    const draft = (await admin().query<{ id: string; created_by: string }>("SELECT id, created_by FROM pur.supplier_invoice WHERE kind = 'CREDIT_NOTE' AND status = 'DRAFT' ORDER BY id DESC LIMIT 1")).rows[0]!;
    const selfApproved = await admin()
      .query(
        `UPDATE pur.supplier_invoice SET version = version + 1, status = 'APPROVED', match_status = 'NOT_REQUIRED', matched_at = now(), posted_at = now(), posted_by = created_by,
                approval_request_id = (SELECT id FROM iam.approval_request WHERE subject_document_id = $1 LIMIT 1)
          WHERE id = $1`,
        [draft.id],
      )
      .then(() => null, (error: unknown) => error);
    expect(databaseErrorOf(selfApproved)?.code).toBe('23514');
    const byHand = await admin().query('UPDATE pur.supplier_invoice SET version = version + 1, credited_pesewas = 1 WHERE id = $1', [invoice]).then(() => null, (error: unknown) => error);
    expect(databaseErrorOf(byHand)?.code).not.toBeUndefined();
  });
});

describe('an approved variance lets a mismatched invoice be paid, never by its maker (FR-PUR-010: the gate)', () => {
  it('pays 20 at 5,600 (1.82 percent over) only after a different person approves the variance', async () => {
    const order = await sentOrder('Awutu Poultry Farm', '20.000', 5_500);
    await receive('Awutu Poultry Farm', order, '20.000');
    const invoice = await invoiceFor(accountant, 'Awutu Poultry Farm', order, '20.000', 5_600, false);
    expect((await get(accountant, `/supplier-invoices/${invoice}`)).body).toMatchObject({ status: 'MISMATCH', grossPesewas: 112_000 });
    const blocked = await post(accountant, '/supplier-payments', { supplierId: supplier('Awutu Poultry Farm'), method: 'CASH', allocations: [{ supplierInvoiceId: invoice, amountPesewas: 112_000 }] });
    expect(blocked.body.error.code).toBe('THREE_WAY_MATCH_FAILED');

    const asked = await post(accountant, `/supplier-invoices/${invoice}/variance`, { reason: 'Awutu raised the price after the order; agreed by phone' });
    expect(asked.status).toBe(202);
    expect(asked.body).toMatchObject({ kind: 'SUPPLIER_INVOICE_VARIANCE', status: 'PENDING_APPROVAL' });
    expect((await post(accountant, `/supplier-invoices/${invoice}/match`)).body.error.code).toBe('APPROVAL_PENDING');
    expect((await post(accountant, `/supplier-invoices/${invoice}/variance`, { reason: 'Again' })).body.error.code).toBe('APPROVAL_PENDING');
    const approved = await approve(manager, asked.body.approvalRequestId);
    expect(approved.status).toBe(200);
    const after = (await get(accountant, `/supplier-invoices/${invoice}`)).body;
    expect(after).toMatchObject({ status: 'APPROVED', matchStatus: 'VARIANCE_APPROVED', varianceReason: 'Awutu raised the price after the order; agreed by phone', outstandingPesewas: 112_000 });
    expect(after.lines[0]).toMatchObject({ matchStatus: 'MISMATCH', matchReasons: ['PRICE_OUTSIDE_TOLERANCE'] });
    const event = (await admin().query<{ payload: { varianceApprovalRequestId: string } }>("SELECT payload FROM platform.outbox_message WHERE event_type = 'pur.SupplierInvoiceMatched' AND subject_id = $1", [invoice])).rows;
    expect(event.map((e) => e.payload.varianceApprovalRequestId)).toEqual([asked.body.approvalRequestId]);
    const payment = await post(accountant, '/supplier-payments', { supplierId: supplier('Awutu Poultry Farm'), method: 'CASH', allocations: [{ supplierInvoiceId: invoice, amountPesewas: 112_000 }] });
    expect(payment.status).toBe(201);
  });

  it('refuses the person who asked, and the person who entered the invoice, as approver', async () => {
    const order = await sentOrder('Awutu Poultry Farm', '20.000', 5_500);
    await receive('Awutu Poultry Farm', order, '20.000');
    const invoice = await invoiceFor(owner, 'Awutu Poultry Farm', order, '20.000', 5_600, false);
    const asked = await post(accountant, `/supplier-invoices/${invoice}/variance`, { reason: 'Price rise agreed' });
    expect(asked.status).toBe(202);
    const byInvoiceMaker = await approve(owner, asked.body.approvalRequestId);
    expect(byInvoiceMaker.status).toBe(422);
    expect(byInvoiceMaker.body.error.code).toBe('INVOICE_MAKER_CANNOT_APPROVE');
    const order2 = await sentOrder('Awutu Poultry Farm', '20.000', 5_500);
    await receive('Awutu Poultry Farm', order2, '20.000');
    const invoice2 = await invoiceFor(accountant, 'Awutu Poultry Farm', order2, '20.000', 5_600, false);
    const askedByOwner = await post(owner, `/supplier-invoices/${invoice2}/variance`, { reason: 'Price rise agreed' });
    const byRequester = await approve(owner, askedByOwner.body.approvalRequestId);
    expect(byRequester.status).toBe(422);
    expect(byRequester.body.error.code).toBe('MAKER_CANNOT_CHECK');
    // Refused, the invoice stays MISMATCH and may be corrected.
    expect((await reject(manager, askedByOwner.body.approvalRequestId)).status).toBe(200);
    expect((await get(accountant, `/supplier-invoices/${invoice2}`)).body).toMatchObject({ status: 'MISMATCH', approvalRequestId: null, varianceReason: null });
    expect(await count("SELECT count(*)::int AS n FROM pur.supplier_invoice WHERE id = $1 AND posted_by IS NULL", [invoice])).toBe(1);
  });

  it('never covers goods that were not received: 22 invoiced against 20 received is refused', async () => {
    const order = await sentOrder('Awutu Poultry Farm', '22.000', 5_500);
    await receive('Awutu Poultry Farm', order, '20.000');
    const invoice = await invoiceFor(accountant, 'Awutu Poultry Farm', order, '22.000', 5_500, false);
    const asked = await post(accountant, `/supplier-invoices/${invoice}/variance`, { reason: 'Pay it all' });
    expect(asked.status).toBe(422);
    expect(asked.body.error.code).toBe('VARIANCE_NOT_ALLOWED');
    expect(asked.body.error.details).toEqual([expect.objectContaining({ field: '/lines/0', code: 'QTY_EXCEEDS_RECEIVED' })]);
    // And the database refuses the same, and an approval by the invoice's maker, written directly.
    const covered = await admin()
      .query(
        `UPDATE pur.supplier_invoice SET version = version + 1, status = 'APPROVED', match_status = 'VARIANCE_APPROVED', approval_request_id = (SELECT id FROM iam.approval_request LIMIT 1),
                variance_reason = 'Direct', posted_at = now(), posted_by = (SELECT p.id FROM iam.principal p WHERE p.id <> created_by LIMIT 1) WHERE id = $1`,
        [invoice],
      )
      .then(() => null, (error: unknown) => error);
    expect(databaseErrorOf(covered)?.code).toBe('HK010');
    expect(databaseErrorOf(covered)?.constraint).toBe('ck_supplier_invoice_variance_cover');
  });
});
