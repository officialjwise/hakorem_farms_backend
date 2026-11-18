import { randomUUID } from 'node:crypto';
import { ManualClock, toBusinessDate } from '@hakorem/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { totpAt } from '../../../src/modules/iam/domain/totp';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { consoleGet, consolePost, createBranch, createUser, enrolAndLogin, login, relaxRateLimits, testStartTime, type TestSession } from '../../support/iam';
import { startTestApp, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * The supplier's account (B09u, the owner's decisions of 2026-11-17):
 * - CR-043: approving a supplier invoice for payment refuses the person who entered it, in the domain and the database.
 * - F10g: a supplier credit note the Owner's claim raised and the Accountant drafted is approved by a Manager, and never
 *   by either of them.
 * - CR-042: getSupplierBalance answers what is owed, awaiting approval, claimed, in payment and paid, each figure
 *   asserted against a SQL sum taken straight from PUR's tables, within the branches the caller reads.
 * - CR-044: a line's price variance is per unit of the line's unit, and its whole-line figure is that times the quantity.
 */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
type TotpSession = TestSession & { readonly secret: Buffer };
let owner: TotpSession;
let manager: TotpSession;
let accountant: TotpSession;
let elsewhereOwner: TotpSession;
let elsewhereAccountant: TotpSession;
let storekeeper: TestSession;
let cashier: TestSession;
let supplierId: string;
let elsewhereBranch: string;
const ids = new Map<string, string>();

const id = (code: string) => ids.get(code)!;
const post = (session: TestSession, path: string, body: object = {}, key: string = randomUUID()) => consolePost(api.server, session, `/v1${path}`, key).send(body);
const get = (session: TestSession, path: string) => consoleGet(api.server, session, `/v1${path}`);
const admin = () => database.pool('admin');
const today = () => toBusinessDate(clock.now());

async function stepUp(session: TotpSession) {
  clock.advanceBy(30_000);
  expect((await post(session, '/auth/step-up', { code: totpAt(session.secret, Math.floor(clock.now().getTime() / 1000)) })).status).toBe(200);
}

async function approve(checker: TotpSession, approvalRequestId: string) {
  await stepUp(checker);
  return post(checker, `/iam/approvals/${approvalRequestId}/approve`, { reason: 'Checked against the supplier’s paper' });
}

/** An expense invoice (transport, no order) entered and matched by `maker` at `branchId`; its id. */
async function expenseInvoice(maker: TestSession, amount: number, branchId: string, match = true): Promise<string> {
  const created = await post(maker, '/supplier-invoices', {
    kind: 'INVOICE',
    supplierId,
    supplierInvoiceNo: `ABK-${randomUUID().slice(0, 8)}`,
    invoiceDate: today(),
    branchId,
    lines: [{ description: 'Transport of egg crates from Abokobi', qty: '1.000', unitPricePesewas: amount, taxCategoryId: id('tax:EGG-0003') }],
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  if (match) expect((await post(maker, `/supplier-invoices/${created.body.id}/match`)).body.matchStatus).toBe('NOT_REQUIRED');
  return created.body.id as string;
}

/** An approved and sent order for `crates` crates of big eggs at `price` a crate; its order and line ids. */
async function ordered(crates: string, price: number): Promise<{ order: string; line: string }> {
  const created = await post(storekeeper, '/purchase-orders', {
    supplierId,
    deliverToLocationId: id('location:SHOP'),
    orderDate: today(),
    lines: [{ productId: id('product:EGG-0003'), uom: 'CRATE', qtyOrdered: crates, unitPricePesewas: price }],
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  expect((await post(storekeeper, `/purchase-orders/${created.body.id}/submit`)).status).toBe(200);
  expect((await post(owner, `/purchase-orders/${created.body.id}/send`, { channels: ['WHATSAPP'] })).status).toBe(200);
  return { order: created.body.id as string, line: created.body.lines[0].id as string };
}

/** One crate delivered with 7 of its 30 eggs cracked, posted by the storekeeper; the receipt's id. */
async function crackedCrate(order: { order: string; line: string }): Promise<string> {
  const receipt = await post(storekeeper, '/goods-receipts', {
    kind: 'PURCHASE',
    supplierId,
    locationId: id('location:SHOP'),
    purchaseOrderId: order.order,
    receivedAt: new Date(clock.now().getTime() - 60_000).toISOString(),
    lines: [
      {
        productId: id('product:EGG-0003'),
        purchaseOrderLineId: order.line,
        batchNo: `ABK-${randomUUID().slice(0, 8)}`,
        expiresOn: toBusinessDate(new Date(clock.now().getTime() + 14 * 86_400_000)),
        qtyReceived: '23.000',
        qtyRejected: '7.000',
        rejectionReasonCode: 'CRACKED',
        valuePesewas: 3_642,
      },
    ],
  });
  expect(receipt.status, JSON.stringify(receipt.body)).toBe(201);
  expect((await post(storekeeper, `/goods-receipts/${receipt.body.id}/post`)).status).toBe(200);
  return receipt.body.id as string;
}

/** Each figure of the balance straight from PUR's tables, for the supplier at the given branches. */
async function fromSql(branches: readonly string[]) {
  const one = async (sql: string) => Number((await admin().query<{ n: string }>(sql, [supplierId, branches])).rows[0]!.n);
  return {
    owedPesewas: await one(
      `SELECT coalesce(sum(gross_pesewas - credited_pesewas - paid_pesewas), 0)::text AS n FROM pur.supplier_invoice
        WHERE supplier_id = $1 AND branch_id = ANY($2::uuid[]) AND kind = 'INVOICE' AND status = 'APPROVED'`,
    ),
    awaitingApprovalPesewas: await one(
      `SELECT coalesce(sum(gross_pesewas), 0)::text AS n FROM pur.supplier_invoice
        WHERE supplier_id = $1 AND branch_id = ANY($2::uuid[]) AND kind = 'INVOICE' AND status IN ('DRAFT', 'MATCHED', 'MISMATCH')`,
    ),
    claimedPesewas: await one(`SELECT coalesce(sum(claimed_pesewas), 0)::text AS n FROM pur.supplier_claim WHERE supplier_id = $1 AND branch_id = ANY($2::uuid[]) AND status = 'OPEN'`),
    inPaymentPesewas: await one(
      `SELECT coalesce(sum(amount_pesewas), 0)::text AS n FROM pur.supplier_payment WHERE supplier_id = $1 AND branch_id = ANY($2::uuid[]) AND status IN ('PENDING_APPROVAL', 'APPROVED')`,
    ),
    paidPesewas: await one(`SELECT coalesce(sum(amount_pesewas), 0)::text AS n FROM pur.supplier_payment WHERE supplier_id = $1 AND branch_id = ANY($2::uuid[]) AND status = 'PAID'`),
  };
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
       UNION ALL SELECT 'tax:' || sku, tax_category_id FROM mdm.product`,
    )
  ).rows) {
    ids.set(row.code, row.id);
  }
  const branchId = id('branch:DDW');
  elsewhereBranch = (await createBranch(database, 'ABK')).branchId;
  owner = await enrolAndLogin(api.server, await createUser(database, { name: 'Kwabena Owusu', grants: [{ role: 'OWNER', branchId }] }), () => clock.now());
  manager = await enrolAndLogin(api.server, await createUser(database, { name: 'Akosua Boateng', grants: [{ role: 'MANAGER', branchId }] }), () => clock.now());
  accountant = await enrolAndLogin(api.server, await createUser(database, { name: 'Yaw Agyeman', grants: [{ role: 'ACCOUNTANT', branchId }] }), () => clock.now());
  elsewhereOwner = await enrolAndLogin(api.server, await createUser(database, { name: 'Adjoa Mensah', grants: [{ role: 'OWNER', branchId: elsewhereBranch }] }), () => clock.now());
  elsewhereAccountant = await enrolAndLogin(api.server, await createUser(database, { name: 'Kojo Asante', grants: [{ role: 'ACCOUNTANT', branchId: elsewhereBranch }] }), () => clock.now());
  storekeeper = await login(api.server, await createUser(database, { name: 'Kofi Mensah', grants: [{ role: 'STOREKEEPER', branchId, locationId: id('location:SHOP') }] }));
  cashier = await login(api.server, await createUser(database, { name: 'Adwoa Darko', grants: [{ role: 'CASHIER', branchId, locationId: id('location:SHOP') }] }));
  const supplier = await post(owner, '/suppliers', { name: 'Abokobi Egg Traders (TEST)', contactName: 'Ama Tetteh', phone: '0244771290', address: 'Abokobi' });
  expect(supplier.status, JSON.stringify(supplier.body)).toBe(201);
  supplierId = supplier.body.id as string;
});

afterAll(async () => {
  await api?.close();
  await database.drop();
});

describe('CR-043: approving a supplier invoice for payment refuses the person who entered it', () => {
  it('refuses the accountant who entered and matched it with 422 INVOICE_MAKER_CANNOT_APPROVE, leaves it MATCHED and posts nothing, then lets the Owner approve it', async () => {
    const invoice = await expenseInvoice(accountant, 7_500, id('branch:DDW'));
    const byMaker = await post(accountant, `/supplier-invoices/${invoice}/approve`);
    expect(byMaker.status, JSON.stringify(byMaker.body)).toBe(422);
    expect(byMaker.body.error.code).toBe('INVOICE_MAKER_CANNOT_APPROVE');
    expect(byMaker.body.error.correlationId).toEqual(expect.any(String));
    expect((await get(accountant, `/supplier-invoices/${invoice}`)).body.status).toBe('MATCHED');
    expect((await admin().query('SELECT 1 FROM fin.journal_entry WHERE source_document_id = $1', [invoice])).rowCount).toBe(0);
    expect((await admin().query("SELECT 1 FROM platform.outbox_message WHERE event_type = 'pur.ExpenseInvoiceApproved' AND subject_id = $1", [invoice])).rowCount).toBe(0);
    const byOwner = await post(owner, `/supplier-invoices/${invoice}/approve`);
    expect(byOwner.status, JSON.stringify(byOwner.body)).toBe(200);
    expect(byOwner.body).toMatchObject({ status: 'APPROVED', outstandingPesewas: 7_500 });
  });

  it('is held by the database too: an invoice approved by its maker by direct SQL is refused by ck_supplier_invoice_approver', async () => {
    const invoice = await expenseInvoice(accountant, 1_250, id('branch:DDW'));
    const client = await database.pool('app').connect();
    try {
      await client.query('BEGIN');
      await expect(client.query("UPDATE pur.supplier_invoice SET status = 'APPROVED', posted_at = now(), posted_by = created_by, version = version + 1 WHERE id = $1", [invoice])).rejects.toMatchObject({
        code: '23514',
        constraint: 'ck_supplier_invoice_approver',
      });
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});

describe('F10g: a supplier credit note the Owner’s claim raised and the Accountant drafted', () => {
  let creditNote: string;
  let approvalRequestId: string;
  let claim: string;
  let invoice: string;

  beforeAll(async () => {
    const order = await ordered('1.000', 4_751);
    const receipt = await crackedCrate(order);
    const raised = await post(owner, `/goods-receipts/${receipt}/claims`, { note: 'Seven cracked in the top tray' });
    expect(raised.status, JSON.stringify(raised.body)).toBe(201);
    claim = raised.body.id as string;
    const entered = await post(accountant, '/supplier-invoices', {
      kind: 'INVOICE',
      supplierId,
      supplierInvoiceNo: `ABK-${randomUUID().slice(0, 8)}`,
      invoiceDate: today(),
      purchaseOrderId: order.order,
      lines: [{ description: 'Big eggs, crate of 30', purchaseOrderLineId: order.line, qty: '1.000', unitPricePesewas: 4_751, taxCategoryId: id('tax:EGG-0003') }],
    });
    expect(entered.status, JSON.stringify(entered.body)).toBe(201);
    invoice = entered.body.id as string;
    expect((await post(accountant, `/supplier-invoices/${invoice}/match`)).body.matchStatus).toBe('MATCHED');
    expect((await post(owner, `/supplier-invoices/${invoice}/approve`)).status).toBe(200);
    const drafted = await post(accountant, `/supplier-claims/${claim}/credit-note`, { originalInvoiceId: invoice, supplierInvoiceNo: 'ABK-CN-0001', invoiceDate: today() });
    expect(drafted.status, JSON.stringify(drafted.body)).toBe(201);
    creditNote = drafted.body.id as string;
    const submitted = await post(accountant, `/supplier-invoices/${creditNote}/submit`);
    expect(submitted.status).toBe(202);
    approvalRequestId = submitted.body.approvalRequestId as string;
  });

  it('refuses the Owner who raised the claim and the Accountant who drafted the credit note, and credits nothing', async () => {
    const byOwner = await approve(owner, approvalRequestId);
    expect(byOwner.status).toBe(422);
    expect(byOwner.body.error.code).toBe('INVOICE_MAKER_CANNOT_APPROVE');
    const byAccountant = await approve(accountant, approvalRequestId);
    expect(byAccountant.status).toBe(422);
    expect(byAccountant.body.error.code).toBe('MAKER_CANNOT_CHECK');
    expect((await get(accountant, `/supplier-invoices/${creditNote}`)).body.status).toBe('DRAFT');
    expect((await get(accountant, `/supplier-invoices/${invoice}`)).body).toMatchObject({ creditedPesewas: 0, outstandingPesewas: 4_751 });
  });

  it('is approved by a Manager, who now holds the approval: the claim is settled and the supplier is owed 3,642', async () => {
    const byManager = await approve(manager, approvalRequestId);
    expect(byManager.status, JSON.stringify(byManager.body)).toBe(200);
    expect((await get(accountant, `/supplier-invoices/${creditNote}`)).body.status).toBe('APPROVED');
    expect((await get(accountant, `/supplier-claims/${claim}`)).body).toMatchObject({ status: 'SETTLED', settlement: 'CREDIT_NOTE' });
    expect((await get(accountant, `/supplier-invoices/${invoice}`)).body).toMatchObject({ creditedPesewas: 1_109, outstandingPesewas: 3_642 });
  });
});

describe('CR-042: getSupplierBalance', () => {
  beforeAll(async () => {
    const ddw = id('branch:DDW');
    // Owed: 60,000 approved and 40,000 approved with 15,000 of it in a payment waiting for approval.
    const owed = await expenseInvoice(accountant, 60_000, ddw);
    expect((await post(owner, `/supplier-invoices/${owed}/approve`)).status).toBe(200);
    const inPayment = await expenseInvoice(accountant, 40_000, ddw);
    expect((await post(owner, `/supplier-invoices/${inPayment}/approve`)).status).toBe(200);
    const waiting = await post(accountant, '/supplier-payments', { supplierId, method: 'CASH', allocations: [{ supplierInvoiceId: inPayment, amountPesewas: 15_000 }] });
    expect(waiting.status, JSON.stringify(waiting.body)).toBe(201);
    expect((await post(accountant, `/supplier-payments/${waiting.body.id}/submit`)).status).toBe(202);
    // Paid: 30,000 approved, paid in full by a payment a Manager approved.
    const paid = await expenseInvoice(accountant, 30_000, ddw);
    expect((await post(owner, `/supplier-invoices/${paid}/approve`)).status).toBe(200);
    const payment = await post(accountant, '/supplier-payments', { supplierId, method: 'CASH', allocations: [{ supplierInvoiceId: paid, amountPesewas: 30_000 }] });
    const submitted = await post(accountant, `/supplier-payments/${payment.body.id}/submit`);
    expect((await approve(manager, submitted.body.approvalRequestId as string)).status).toBe(200);
    expect((await post(accountant, `/supplier-payments/${payment.body.id}/mark-paid`, { paidAt: clock.now().toISOString(), externalReference: 'ABK-CASH-01' })).status).toBe(200);
    // Awaiting approval: one matched (25,000) and one draft (12,345); a cancelled one counts nowhere.
    await expenseInvoice(accountant, 25_000, ddw);
    await expenseInvoice(accountant, 12_345, ddw, false);
    const cancelled = await expenseInvoice(accountant, 99_000, ddw);
    expect((await post(accountant, `/supplier-invoices/${cancelled}/cancel`, { reason: 'Entered against the wrong supplier' })).status).toBe(200);
    // Claimed: an open claim of 1,109 from a second cracked crate.
    const order = await ordered('1.000', 4_751);
    const receipt = await crackedCrate(order);
    expect((await post(accountant, `/goods-receipts/${receipt}/claims`)).status).toBe(201);
    // Elsewhere: 8,800 owed at the other branch, which a Dodowa reader never sees.
    const there = await expenseInvoice(elsewhereAccountant, 8_800, elsewhereBranch);
    expect((await post(elsewhereOwner, `/supplier-invoices/${there}/approve`)).status).toBe(200);
  });

  it('answers each figure exactly as the SQL sums over PUR’s tables at the caller’s branch, and the hand total', async () => {
    const answer = await get(accountant, `/suppliers/${supplierId}/balance`);
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    const sql = await fromSql([id('branch:DDW')]);
    expect(answer.body).toMatchObject({ ...sql, currency: 'GHS', supplier: { id: supplierId, name: 'Abokobi Egg Traders (TEST)' } });
    // By hand: 7,500 (CR-043's invoice) + 3,642 (the credited crate) + 60,000 + 40,000 owed; 25,000 + 12,345 + 1,250
    // (CR-043's database test, rolled back, so still MATCHED) awaiting; 1,109 claimed; 15,000 in payment; 30,000 paid.
    expect(sql).toEqual({ owedPesewas: 111_142, awaitingApprovalPesewas: 38_595, claimedPesewas: 1_109, inPaymentPesewas: 15_000, paidPesewas: 30_000 });
    expect(Date.parse(answer.body.asOf as string)).toBe(clock.now().getTime());
  });

  it('answers the Owner of another branch only what is held there, and a Dodowa reader nothing of it', async () => {
    const there = await get(elsewhereOwner, `/suppliers/${supplierId}/balance`);
    expect(there.status).toBe(200);
    expect(there.body).toMatchObject({ ...(await fromSql([elsewhereBranch])), owedPesewas: 8_800 });
    expect((await get(owner, `/suppliers/${supplierId}/balance`)).body.owedPesewas).toBe(111_142);
  });

  it('answers zero for every figure of a supplier with nothing on its account, never a negative', async () => {
    const quiet = await post(owner, '/suppliers', { name: 'Dawhenya Crates (TEST)', phone: '0244771291' });
    const answer = await get(manager, `/suppliers/${quiet.body.id}/balance`);
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ owedPesewas: 0, awaitingApprovalPesewas: 0, claimedPesewas: 0, inPaymentPesewas: 0, paidPesewas: 0 });
  });

  it('refuses a role without pur.supplier_invoice.read with 403, a made-up supplier with 404, and an anonymous caller with 401', async () => {
    expect((await get(cashier, `/suppliers/${supplierId}/balance`)).status).toBe(403);
    expect((await get(storekeeper, `/suppliers/${supplierId}/balance`)).status).toBe(403);
    expect((await get(owner, `/suppliers/${randomUUID()}/balance`)).status).toBe(404);
    const { default: request } = await import('supertest');
    expect((await request(api.server).get(`/v1/suppliers/${supplierId}/balance`)).status).toBe(401);
  });
});

describe('CR-044: a line’s price variance is per unit, with its whole-line figure beside it', () => {
  it('answers 39 a crate over the order price and 117 over for the line of 3 crates at 4,790 against 4,751', async () => {
    const order = await ordered('3.000', 4_751);
    const receipt = await post(storekeeper, '/goods-receipts', {
      kind: 'PURCHASE',
      supplierId,
      locationId: id('location:SHOP'),
      purchaseOrderId: order.order,
      receivedAt: new Date(clock.now().getTime() - 60_000).toISOString(),
      lines: [{ productId: id('product:EGG-0003'), purchaseOrderLineId: order.line, uom: 'CRATE', batchNo: `ABK-${randomUUID().slice(0, 8)}`, expiresOn: toBusinessDate(new Date(clock.now().getTime() + 14 * 86_400_000)), qtyReceived: '3.000', valuePesewas: 14_253 }],
    });
    expect(receipt.status, JSON.stringify(receipt.body)).toBe(201);
    expect((await post(storekeeper, `/goods-receipts/${receipt.body.id}/post`)).status).toBe(200);
    const entered = await post(accountant, '/supplier-invoices', {
      kind: 'INVOICE',
      supplierId,
      supplierInvoiceNo: `ABK-${randomUUID().slice(0, 8)}`,
      invoiceDate: today(),
      purchaseOrderId: order.order,
      lines: [{ description: 'Big eggs, 3 crates', purchaseOrderLineId: order.line, qty: '3.000', unitPricePesewas: 4_790, taxCategoryId: id('tax:EGG-0003') }],
    });
    const matched = await post(accountant, `/supplier-invoices/${entered.body.id}/match`);
    expect(matched.status, JSON.stringify(matched.body)).toBe(200);
    expect(matched.body.lines[0]).toMatchObject({ qty: '3.000', uom: 'CRATE', qtyVariance: '0.000', priceVariancePesewas: 39, priceVarianceLinePesewas: 117, priceVarianceDirection: 'OVER', matchStatus: 'MATCHED' });
  });
});
