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
 * A claim raised from a posted goods receipt's rejected lines (the owner's decision 5 of 2026-11-17, CR-036, ADR-0076).
 *
 * The claim is the receipt's rejected lines at the order price, split exactly with the kernel's allocate between what was
 * accepted and what is claimed, never keyed by hand. It moves no stock and posts nothing, and it is settled once:
 * - by the invoice that left the rejected eggs out; or
 * - by a credit note drafted from it against the invoice that charged them.
 * The supplier's balance comes out to the pesewa either way, and 2010 and 5140 net to zero for the delivery.
 *
 * The people are always different: Kofi receives the goods, Yaw raises the claim and drafts the credit note, and the
 * Owner approves it. When the Owner raised the claim, the Owner is refused as approver.
 */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
type TotpSession = TestSession & { readonly secret: Buffer };
let owner: TotpSession;
let accountant: TotpSession;
let secondAccountant: TotpSession;
let storekeeper: TestSession;
let cashier: TestSession;
const ids = new Map<string, string>();

const id = (code: string) => ids.get(code)!;
const AWUTU = 'supplier:Awutu Poultry Farm (SEED)';
const post = (session: TestSession, path: string, body: object = {}, key: string = randomUUID()) => consolePost(api.server, session, `/v1${path}`, key).send(body);
const get = (session: TestSession, path: string) => consoleGet(api.server, session, `/v1${path}`);
const admin = () => database.pool('admin');
const today = () => toBusinessDate(clock.now());
const count = async (sql: string, values: unknown[]) => (await admin().query<{ n: number }>(sql, values)).rows[0]!.n;

async function approve(checker: TotpSession, approvalRequestId: string) {
  clock.advanceBy(30_000);
  expect((await post(checker, '/auth/step-up', { code: totpAt(checker.secret, Math.floor(clock.now().getTime() / 1000)) })).status).toBe(200);
  return post(checker, `/iam/approvals/${approvalRequestId}/approve`, { reason: 'Checked against the delivery note and the photographs' });
}

/** An approved and sent order for `crates` crates of big eggs at `price` a crate; its order and line ids. */
async function ordered(crates: string, price: number): Promise<{ order: string; line: string }> {
  const created = await post(storekeeper, '/purchase-orders', {
    supplierId: id(AWUTU),
    deliverToLocationId: id('location:SHOP'),
    orderDate: today(),
    lines: [{ productId: id('product:EGG-0003'), uom: 'CRATE', qtyOrdered: crates, unitPricePesewas: price }],
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  expect((await post(storekeeper, `/purchase-orders/${created.body.id}/submit`)).status).toBe(200);
  expect((await post(owner, `/purchase-orders/${created.body.id}/send`, { channels: ['WHATSAPP'] })).status).toBe(200);
  return { order: created.body.id as string, line: created.body.lines[0].id as string };
}

/** A receipt drafted and posted by the storekeeper; the line as entered. */
async function received(order: { order: string; line: string }, line: Record<string, unknown>, post_ = true): Promise<string> {
  const receipt = await post(storekeeper, '/goods-receipts', {
    kind: 'PURCHASE',
    supplierId: id(AWUTU),
    locationId: id('location:SHOP'),
    purchaseOrderId: order.order,
    receivedAt: new Date(clock.now().getTime() - 60_000).toISOString(),
    lines: [{ productId: id('product:EGG-0003'), purchaseOrderLineId: order.line, batchNo: `EGG-${randomUUID().slice(0, 8)}`, expiresOn: toBusinessDate(new Date(clock.now().getTime() + 14 * 86_400_000)), ...line }],
  });
  expect(receipt.status, JSON.stringify(receipt.body)).toBe(201);
  if (post_) expect((await post(storekeeper, `/goods-receipts/${receipt.body.id}/post`)).status).toBe(200);
  return receipt.body.id as string;
}

/** The supplier's invoice for `crates` crates at `price`, entered, matched and approved by the accountant. */
async function invoiced(order: { order: string; line: string }, crates: string, price: number, approved = true) {
  const invoice = await post(accountant, '/supplier-invoices', {
    kind: 'INVOICE',
    supplierId: id(AWUTU),
    supplierInvoiceNo: `APF-${randomUUID().slice(0, 8)}`,
    invoiceDate: today(),
    purchaseOrderId: order.order,
    lines: [{ description: 'Big eggs, crate of 30', purchaseOrderLineId: order.line, qty: crates, unitPricePesewas: price, taxCategoryId: id('tax:EGG-0003') }],
  });
  expect(invoice.status, JSON.stringify(invoice.body)).toBe(201);
  const matched = await post(accountant, `/supplier-invoices/${invoice.body.id}/match`);
  expect(matched.status, JSON.stringify(matched.body)).toBe(200);
  if (approved && matched.body.matchStatus === 'MATCHED') expect((await post(secondAccountant, `/supplier-invoices/${invoice.body.id}/approve`)).status).toBe(200);
  return matched.body as { id: string; matchStatus: string; lines: { matchReasons: string[] }[] };
}

/** Each account's balance, debit positive, over the journals these documents posted. */
async function ledger(documents: readonly string[]): Promise<Record<string, number>> {
  const { rows } = await admin().query<{ code: string; balance: string }>(
    `SELECT a.code, sum(CASE l.side WHEN 'D' THEN l.amount_pesewas ELSE -l.amount_pesewas END)::text AS balance
       FROM fin.journal_line l JOIN fin.journal_entry e ON e.id = l.journal_entry_id JOIN fin.account a ON a.id = l.account_id
      WHERE e.source_document_id = ANY($1::uuid[]) GROUP BY a.code`,
    [documents],
  );
  return Object.fromEntries(rows.map((r) => [r.code, Number(r.balance)]));
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
       UNION ALL SELECT 'tax:' || sku, tax_category_id FROM mdm.product
       UNION ALL SELECT 'supplier:' || name, id FROM mdm.supplier`,
    )
  ).rows) {
    ids.set(row.code, row.id);
  }
  const branchId = id('branch:DDW');
  owner = await enrolAndLogin(api.server, await createUser(database, { name: 'Kwabena Owusu', grants: [{ role: 'OWNER', branchId }] }), () => clock.now());
  accountant = await enrolAndLogin(api.server, await createUser(database, { name: 'Yaw Agyeman', grants: [{ role: 'ACCOUNTANT', branchId }] }), () => clock.now());
  secondAccountant = await enrolAndLogin(api.server, await createUser(database, { name: 'Efua Quaye', grants: [{ role: 'ACCOUNTANT', branchId }] }), () => clock.now());
  storekeeper = await login(api.server, await createUser(database, { name: 'Kofi Mensah', grants: [{ role: 'STOREKEEPER', branchId, locationId: id('location:SHOP') }] }));
  cashier = await login(api.server, await createUser(database, { name: 'Adwoa Darko', grants: [{ role: 'CASHIER', branchId, locationId: id('location:SHOP') }] }));
});

afterAll(async () => {
  await api?.close();
  await database.drop();
});

describe('a claim raised from a crate at 4,751 with 7 of 30 eggs cracked, the invoice charging the whole crate', () => {
  let order: { order: string; line: string };
  let receipt: string;
  let claim: string;
  let invoice: string;
  let credit: string;

  beforeAll(async () => {
    order = await ordered('1.000', 4_751);
    receipt = await received(order, { qtyReceived: '23.000', qtyRejected: '7.000', rejectionReasonCode: 'CRACKED', valuePesewas: 3_642 });
  });

  it('splits the crate into 3,642 accepted and 1,109 claimed from the base quantities and the line reason, linked to its receipt and order', async () => {
    const raised = await post(accountant, `/goods-receipts/${receipt}/claims`, { note: 'Seven cracked in the top tray' });
    expect(raised.status, JSON.stringify(raised.body)).toBe(201);
    claim = raised.body.id as string;
    expect(raised.body).toMatchObject({
      status: 'OPEN',
      claimedPesewas: 1_109,
      currency: 'GHS',
      goodsReceipt: { id: receipt, docType: 'GOODS_RECEIPT' },
      purchaseOrder: { id: order.order, docType: 'PURCHASE_ORDER' },
      receivedBy: { displayName: 'Kofi Mensah' },
      createdBy: { displayName: 'Yaw Agyeman' },
      note: 'Seven cracked in the top tray',
      creditNote: null,
      settlement: null,
      settledBy: null,
    });
    expect(raised.body.lines).toEqual([
      expect.objectContaining({
        lineNo: 1,
        purchaseOrderLineId: order.line,
        rejectionReasonCode: 'CRACKED',
        baseUom: 'EGG',
        qtyDeliveredBase: '30.000',
        qtyAcceptedBase: '23.000',
        qtyRejectedBase: '7.000',
        orderUom: 'CRATE',
        orderUnitPricePesewas: 4_751,
        lineValuePesewas: 4_751,
        acceptedValuePesewas: 3_642,
        claimedValuePesewas: 1_109,
      }),
    ]);
  });

  it('moves no stock, posts nothing and publishes the claim for the daily exception report with abuse case 34', async () => {
    expect(await count('SELECT count(*)::int AS n FROM inv.stock_movement WHERE source_document_id = $1', [claim])).toBe(0);
    expect(await count('SELECT count(*)::int AS n FROM fin.journal_entry WHERE source_document_id = $1', [claim])).toBe(0);
    const events = (await admin().query<{ payload: Record<string, unknown> }>("SELECT payload FROM platform.outbox_message WHERE event_type = 'pur.SupplierClaimRaised' AND subject_id = $1", [claim])).rows;
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({
      supplierClaimId: claim,
      goodsReceiptId: receipt,
      claimedPesewas: 1_109,
      abuseCases: [34],
      lines: [{ rejectionReasonCode: 'CRACKED', qtyAcceptedBase: '23.000', qtyRejectedBase: '7.000', claimedValuePesewas: 1_109 }],
    });
    expect(events[0]!.payload['receivedBy']).not.toBe(events[0]!.payload['raisedBy']);
  });

  it('is answered by its receipt and listed on the supplier account while open', async () => {
    const byReceipt = await get(accountant, `/goods-receipts/${receipt}/claims`);
    expect(byReceipt.status).toBe(200);
    expect(byReceipt.body.data.map((c: { id: string }) => c.id)).toEqual([claim]);
    const open = await get(owner, `/supplier-claims?supplierId=${id(AWUTU)}&status=OPEN`);
    expect(open.body.data.map((c: { id: string }) => c.id)).toContain(claim);
    expect((await get(owner, `/supplier-claims/${claim}`)).body.claimedPesewas).toBe(1_109);
  });

  it('matches an invoice for the whole crate only because the claim is open, and refuses to settle the claim by it', async () => {
    const matched = await invoiced(order, '1.000', 4_751);
    invoice = matched.id;
    expect(matched.matchStatus).toBe('MATCHED');
    const settled = await post(accountant, `/supplier-claims/${claim}/settle`, { supplierInvoiceId: invoice });
    expect(settled.status).toBe(422);
    expect(settled.body.error).toMatchObject({ code: 'SUPPLIER_CLAIM_INVALID', details: [{ field: '/supplierInvoiceId', code: 'CLAIM_INVOICED' }] });
  });

  it('drafts the credit note from the claim at exactly 1,109, linked both ways, and only once', async () => {
    const drafted = await post(accountant, `/supplier-claims/${claim}/credit-note`, { originalInvoiceId: invoice, supplierInvoiceNo: 'APF-CN-0701', invoiceDate: today() });
    expect(drafted.status, JSON.stringify(drafted.body)).toBe(201);
    credit = drafted.body.id as string;
    expect(drafted.body).toMatchObject({ kind: 'CREDIT_NOTE', status: 'DRAFT', originalInvoiceId: invoice, supplierClaimId: claim, netPesewas: 1_109, grossPesewas: 1_109 });
    expect(drafted.body.lines).toEqual([expect.objectContaining({ qty: '7.000', uom: 'EGG', unitPricePesewas: 0, lineNetPesewas: 1_109, purchaseOrderLineId: order.line })]);
    expect(drafted.body.lines[0].supplierClaimLineId).toEqual(expect.any(String));
    expect((await get(accountant, `/supplier-claims/${claim}`)).body).toMatchObject({ status: 'OPEN', creditNote: { id: credit, supplierInvoiceNo: 'APF-CN-0701', status: 'DRAFT' } });
    const again = await post(accountant, `/supplier-claims/${claim}/credit-note`, { originalInvoiceId: invoice, supplierInvoiceNo: 'APF-CN-0702', invoiceDate: today() });
    expect(again.status).toBe(422);
    expect(again.body.error.details).toEqual([expect.objectContaining({ code: 'CREDIT_NOTE_EXISTS' })]);
  });

  it('posts nothing before the credit note is approved, then settles the claim and leaves the supplier owed 3,642 with 2010 and 5140 at zero', async () => {
    expect(await count('SELECT count(*)::int AS n FROM fin.journal_entry WHERE source_document_id = $1', [credit])).toBe(0);
    const submitted = await post(accountant, `/supplier-invoices/${credit}/submit`);
    expect(submitted.status).toBe(202);
    const approved = await approve(owner, submitted.body.approvalRequestId as string);
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect((await get(accountant, `/supplier-claims/${claim}`)).body).toMatchObject({
      status: 'SETTLED',
      settlement: 'CREDIT_NOTE',
      settledBy: { id: credit, kind: 'CREDIT_NOTE', supplierInvoiceNo: 'APF-CN-0701' },
    });
    expect((await get(accountant, `/supplier-invoices/${invoice}`)).body).toMatchObject({ grossPesewas: 4_751, creditedPesewas: 1_109, outstandingPesewas: 3_642 });
    const balances = await ledger([receipt, invoice, credit]);
    expect(balances['2010'] ?? 0).toBe(0);
    expect(balances['5140'] ?? 0).toBe(0);
    expect(balances['2000']).toBe(-3_642);
    expect(await count('SELECT count(*)::int AS n FROM inv.stock_movement WHERE source_document_id = ANY($1::uuid[])', [[claim, credit]])).toBe(0);
  });

  it('refuses a second invoice for the credited eggs', async () => {
    const again = await invoiced(order, '1.000', 4_751, false);
    expect(again.matchStatus).toBe('MISMATCH');
    expect(again.lines[0]!.matchReasons).toEqual(['QTY_EXCEEDS_RECEIVED']);
  });
});

describe('a claim for one of three crates at 4,751, the rejection entered in crates', () => {
  it('claims exactly 4,751 and leaves the supplier owed 9,502 when the invoice charged all three and the credit note took the crate off', async () => {
    const order = await ordered('3.000', 4_751);
    const receipt = await received(order, { uom: 'CRATE', qtyReceived: '2.000', qtyRejected: '1.000', rejectionReasonCode: 'BROKEN', valuePesewas: 9_502 });
    const raised = await post(accountant, `/goods-receipts/${receipt}/claims`);
    expect(raised.status, JSON.stringify(raised.body)).toBe(201);
    expect(raised.body.lines[0]).toMatchObject({ qtyDeliveredBase: '90.000', qtyAcceptedBase: '60.000', qtyRejectedBase: '30.000', lineValuePesewas: 14_253, acceptedValuePesewas: 9_502, claimedValuePesewas: 4_751 });
    const invoice = await invoiced(order, '3.000', 4_751);
    expect(invoice.matchStatus).toBe('MATCHED');
    const drafted = await post(accountant, `/supplier-claims/${raised.body.id}/credit-note`, { originalInvoiceId: invoice.id, supplierInvoiceNo: 'APF-CN-0703', invoiceDate: today() });
    expect(drafted.status, JSON.stringify(drafted.body)).toBe(201);
    expect(drafted.body.lines[0]).toMatchObject({ qty: '30.000', lineNetPesewas: 4_751 });
    const submitted = await post(accountant, `/supplier-invoices/${drafted.body.id}/submit`);
    expect((await approve(owner, submitted.body.approvalRequestId as string)).status).toBe(200);
    expect((await get(accountant, `/supplier-invoices/${invoice.id}`)).body).toMatchObject({ grossPesewas: 14_253, creditedPesewas: 4_751, outstandingPesewas: 9_502 });
    const balances = await ledger([receipt, invoice.id, drafted.body.id as string]);
    expect([balances['2010'] ?? 0, balances['5140'] ?? 0, balances['2000']]).toEqual([0, 0, -9_502]);
  });

  it('is settled by the invoice that charged only the two good crates, never credited again, and a later invoice for the rejected crate is refused', async () => {
    const order = await ordered('3.000', 4_751);
    const receipt = await received(order, { uom: 'CRATE', qtyReceived: '2.000', qtyRejected: '1.000', rejectionReasonCode: 'BROKEN', valuePesewas: 9_502 });
    const raised = await post(accountant, `/goods-receipts/${receipt}/claims`);
    expect(raised.status).toBe(201);
    const invoice = await invoiced(order, '2.000', 4_751);
    expect(invoice.matchStatus).toBe('MATCHED');
    const credit = await post(accountant, `/supplier-claims/${raised.body.id}/credit-note`, { originalInvoiceId: invoice.id, supplierInvoiceNo: 'APF-CN-0704', invoiceDate: today() });
    expect(credit.status).toBe(422);
    expect(credit.body.error).toMatchObject({ code: 'SUPPLIER_CLAIM_INVALID', details: [{ field: '/originalInvoiceId', code: 'CLAIM_NOT_INVOICED' }] });
    expect(await count('SELECT count(*)::int AS n FROM pur.supplier_invoice WHERE supplier_claim_id = $1', [raised.body.id])).toBe(0);
    const settled = await post(accountant, `/supplier-claims/${raised.body.id}/settle`, { supplierInvoiceId: invoice.id });
    expect(settled.status, JSON.stringify(settled.body)).toBe(200);
    expect(settled.body).toMatchObject({ status: 'SETTLED', settlement: 'INVOICE', settledBy: { id: invoice.id, kind: 'INVOICE' }, creditNote: null });
    expect((await get(accountant, `/supplier-invoices/${invoice.id}`)).body).toMatchObject({ grossPesewas: 9_502, creditedPesewas: 0, outstandingPesewas: 9_502 });
    const balances = await ledger([receipt, invoice.id]);
    expect([balances['2010'] ?? 0, balances['5140'] ?? 0, balances['2000']]).toEqual([0, 0, -9_502]);
    const later = await invoiced(order, '1.000', 4_751, false);
    expect(later.matchStatus).toBe('MISMATCH');
    expect(later.lines[0]!.matchReasons).toEqual(['QTY_EXCEEDS_RECEIVED']);
    expect((await post(accountant, `/supplier-claims/${raised.body.id}/settle`, { supplierInvoiceId: invoice.id })).status).toBe(422);
  });
});

describe('maker and checker on a claim credit note: the receiver, the claim maker and the approver are different people', () => {
  it('refuses the Owner who raised the claim as approver of its credit note, and accepts a second accountant', async () => {
    const order = await ordered('1.000', 4_751);
    const receipt = await received(order, { qtyReceived: '23.000', qtyRejected: '7.000', rejectionReasonCode: 'DIRTY', valuePesewas: 3_642 });
    const raised = await post(owner, `/goods-receipts/${receipt}/claims`);
    expect(raised.status).toBe(201);
    const invoice = await invoiced(order, '1.000', 4_751);
    const drafted = await post(accountant, `/supplier-claims/${raised.body.id}/credit-note`, { originalInvoiceId: invoice.id, supplierInvoiceNo: 'APF-CN-0705', invoiceDate: today() });
    expect(drafted.status).toBe(201);
    const submitted = await post(accountant, `/supplier-invoices/${drafted.body.id}/submit`);
    const byClaimMaker = await approve(owner, submitted.body.approvalRequestId as string);
    expect(byClaimMaker.status).toBe(422);
    expect(byClaimMaker.body.error.code).toBe('INVOICE_MAKER_CANNOT_APPROVE');
    expect((await get(accountant, `/supplier-invoices/${drafted.body.id}`)).body.status).toBe('DRAFT');
    expect((await get(accountant, `/supplier-claims/${raised.body.id}`)).body.status).toBe('OPEN');
    expect((await get(accountant, `/supplier-invoices/${invoice.id}`)).body.creditedPesewas).toBe(0);
    const bySecond = await approve(secondAccountant, submitted.body.approvalRequestId as string);
    expect(bySecond.status, JSON.stringify(bySecond.body)).toBe(200);
    expect((await get(accountant, `/supplier-claims/${raised.body.id}`)).body).toMatchObject({ status: 'SETTLED', settlement: 'CREDIT_NOTE' });

    // The database holds the same rule (pur.supplier_claim_guard): with the claim opened again and its credit note made
    // to read as approved by the claim's maker (triggers off, in a transaction rolled back), settling it is refused.
    const client = await admin().connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL session_replication_role = replica');
      await client.query(
        "UPDATE pur.supplier_claim SET status = 'OPEN', settlement = NULL, settled_by_invoice_id = NULL, posted_at = NULL, posted_by = NULL WHERE id = $1",
        [raised.body.id],
      );
      await client.query('UPDATE pur.supplier_invoice SET posted_by = (SELECT created_by FROM pur.supplier_claim WHERE id = $2) WHERE id = $1', [drafted.body.id, raised.body.id]);
      await client.query('SET LOCAL session_replication_role = origin');
      await expect(
        client.query(
          `UPDATE pur.supplier_claim SET version = version + 1, status = 'SETTLED', settlement = 'CREDIT_NOTE', settled_by_invoice_id = $2, posted_at = updated_at, posted_by = created_by
            WHERE id = $1`,
          [raised.body.id, drafted.body.id],
        ),
      ).rejects.toMatchObject({ code: 'HK010' });
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});

describe('a claim is never keyed by hand, raised only from what was rejected, and refused to the wrong role', () => {
  it('refuses a request that supplies an amount, and writes nothing', async () => {
    const order = await ordered('1.000', 4_751);
    const receipt = await received(order, { qtyReceived: '23.000', qtyRejected: '7.000', rejectionReasonCode: 'CRACKED', valuePesewas: 3_642 });
    for (const body of [{ claimedPesewas: 4_751 }, { lines: [{ claimedValuePesewas: 4_751 }] }, { note: 'Cracked', amountPesewas: 1 }]) {
      const refused = await post(accountant, `/goods-receipts/${receipt}/claims`, body);
      expect(refused.status, JSON.stringify(body)).toBe(400);
      expect(refused.body.error.code).toBe('VALIDATION_FAILED');
    }
    expect(await count('SELECT count(*)::int AS n FROM pur.supplier_claim WHERE goods_receipt_id = $1', [receipt])).toBe(0);
    expect((await post(accountant, `/goods-receipts/${receipt}/claims`)).status).toBe(201);
    const twice = await post(accountant, `/goods-receipts/${receipt}/claims`);
    expect(twice.status).toBe(422);
    expect(twice.body.error.details).toEqual([expect.objectContaining({ code: 'CLAIM_EXISTS' })]);
  });

  it('refuses a receipt with nothing rejected and a draft receipt', async () => {
    const order = await ordered('2.000', 4_751);
    const whole = await received(order, { uom: 'CRATE', qtyReceived: '1.000', valuePesewas: 4_751 });
    const nothing = await post(accountant, `/goods-receipts/${whole}/claims`);
    expect(nothing.status).toBe(422);
    expect(nothing.body.error.details).toEqual([expect.objectContaining({ code: 'NOTHING_REJECTED' })]);
    const draft = await received(order, { qtyReceived: '20.000', qtyRejected: '10.000', rejectionReasonCode: 'CRACKED', valuePesewas: 3_167 }, false);
    const notPosted = await post(accountant, `/goods-receipts/${draft}/claims`);
    expect(notPosted.status).toBe(422);
    expect(notPosted.body.error.details).toEqual([expect.objectContaining({ code: 'RECEIPT_NOT_POSTED' })]);
  });

  it('refuses the storekeeper who received the goods and the cashier every claim operation, with 403, and writes nothing', async () => {
    const order = await ordered('1.000', 4_751);
    const receipt = await received(order, { qtyReceived: '23.000', qtyRejected: '7.000', rejectionReasonCode: 'CRACKED', valuePesewas: 3_642 });
    for (const session of [storekeeper, cashier]) {
      expect((await post(session, `/goods-receipts/${receipt}/claims`)).status).toBe(403);
      expect((await get(session, `/goods-receipts/${receipt}/claims`)).status).toBe(403);
      expect((await get(session, '/supplier-claims')).status).toBe(403);
    }
    expect(await count('SELECT count(*)::int AS n FROM pur.supplier_claim WHERE goods_receipt_id = $1', [receipt])).toBe(0);
    const raised = await post(accountant, `/goods-receipts/${receipt}/claims`);
    for (const session of [storekeeper, cashier]) {
      expect((await get(session, `/supplier-claims/${raised.body.id}`)).status).toBe(403);
      expect((await post(session, `/supplier-claims/${raised.body.id}/settle`, { supplierInvoiceId: randomUUID() })).status).toBe(403);
      expect((await post(session, `/supplier-claims/${raised.body.id}/credit-note`, { originalInvoiceId: randomUUID(), supplierInvoiceNo: 'X-1', invoiceDate: today() })).status).toBe(403);
    }
  });
});

describe('no claim identifier is a key (B09q continued)', () => {
  it('refuses the Owner of another branch a real claim and its receipt, with nothing of the record, and a random id with 404', async () => {
    const order = await ordered('1.000', 4_751);
    const receipt = await received(order, { qtyReceived: '23.000', qtyRejected: '7.000', rejectionReasonCode: 'CRACKED', valuePesewas: 3_642 });
    const raised = await post(accountant, `/goods-receipts/${receipt}/claims`);
    expect(raised.status).toBe(201);
    const tema = await createBranch(database, 'TMA');
    const elsewhere = await enrolAndLogin(api.server, await createUser(database, { name: 'Yaw Boateng', grants: [{ role: 'OWNER', branchId: tema.branchId }] }), () => clock.now());
    for (const [path, random] of [
      [`/supplier-claims/${raised.body.id}`, `/supplier-claims/${randomUUID()}`],
      [`/goods-receipts/${receipt}/claims`, `/goods-receipts/${randomUUID()}/claims`],
    ] as const) {
      const real = await get(elsewhere, path);
      const guessed = await get(elsewhere, random);
      expect([403, 404], path).toContain(real.status);
      expect(guessed.status, path).toBe(404);
      expect(Object.keys(real.body)).toEqual(['error']);
      expect(real.body.error.details ?? []).toEqual([]);
      expect(JSON.stringify(real.body)).not.toContain(raised.body.id);
    }
    expect((await get(elsewhere, '/supplier-claims')).body.data).toEqual([]);
    const settle = await post(elsewhere, `/supplier-claims/${raised.body.id}/settle`, { supplierInvoiceId: randomUUID() });
    expect([403, 404]).toContain(settle.status);
    expect((await get(accountant, `/supplier-claims/${raised.body.id}`)).body.status).toBe('OPEN');
  });
});

describe('the database holds the claim rules itself', () => {
  it('refuses a claim line whose split does not sum to its line, any change to a claim line, and a settlement by the wrong document', async () => {
    const order = await ordered('1.000', 4_751);
    const receipt = await received(order, { qtyReceived: '23.000', qtyRejected: '7.000', rejectionReasonCode: 'CRACKED', valuePesewas: 3_642 });
    const raised = await post(accountant, `/goods-receipts/${receipt}/claims`);
    const line = raised.body.lines[0].id as string;
    await expect(admin().query('UPDATE pur.supplier_claim_line SET claimed_value_pesewas = 1110 WHERE id = $1', [line])).rejects.toMatchObject({ code: 'HK001' });
    await expect(
      admin().query('UPDATE pur.supplier_claim SET version = version + 1, claimed_pesewas = 1110 WHERE id = $1', [raised.body.id]),
    ).rejects.toMatchObject({ code: 'HK004' });
    const draft = await invoiced(order, '1.000', 4_751, false);
    await expect(
      admin().query("UPDATE pur.supplier_claim SET version = version + 1, status = 'SETTLED', settlement = 'INVOICE', settled_by_invoice_id = $2, posted_at = updated_at, posted_by = created_by WHERE id = $1", [raised.body.id, draft.id]),
    ).rejects.toMatchObject({ code: 'HK010' });
    const client = await admin().connect();
    try {
      await client.query('BEGIN');
      await expect(
        client.query(
          `INSERT INTO pur.supplier_claim_line (id, supplier_claim_id, line_no, goods_receipt_line_id, purchase_order_line_id, product_id, rejection_reason_code,
                                                qty_accepted_base, qty_rejected_base, line_value_pesewas, accepted_value_pesewas, claimed_value_pesewas)
           SELECT $2, supplier_claim_id, 2, goods_receipt_line_id, purchase_order_line_id, product_id, rejection_reason_code, 23, 7, 4751, 3642, 1110
             FROM pur.supplier_claim_line WHERE id = $1`,
          [line, randomUUID()],
        ),
      ).rejects.toMatchObject({ code: '23514' });
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
