import { randomUUID } from 'node:crypto';
import { ManualClock, toBusinessDate } from '@hakorem/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { totpAt } from '../../../src/modules/iam/domain/totp';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { contractSchema } from '../../support/contract-schemas';
import { consoleGet, consolePost, createUser, enrolAndLogin, relaxRateLimits, testStartTime, type TestSession } from '../../support/iam';
import { startTestApp, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/** The B7 purchase-to-pay operations answer in the shapes of contract/openapi.yaml 1.28.0, over the seeded farm. */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let manager: TestSession & { readonly secret: Buffer };
let accountant: TestSession & { readonly secret: Buffer };
const ids = new Map<string, string>();
const v1 = (path: string) => `/v1${path}`;
const post = (session: TestSession, path: string, body: object = {}) => consolePost(api.server, session, v1(path)).send(body);

function expectShape(schema: string, body: unknown): void {
  const validate = contractSchema(schema);
  expect(validate(body), `${schema}: ${JSON.stringify(validate.errors)}`).toBe(true);
}

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock });
  await runSeedUnits(database.pool('app'), api.app, seedUnits({ SEED_STAFF_PASSWORD: `Seed-${randomUUID()}` }));
  for (const row of (
    await database.pool('admin').query<{ code: string; id: string }>(
      `SELECT 'branch:' || code AS code, id FROM mdm.branch
       UNION ALL SELECT 'location:' || l.code, l.id FROM mdm.location l JOIN mdm.branch b ON b.id = l.branch_id WHERE b.code = 'DDW'
       UNION ALL SELECT 'product:' || sku, id FROM mdm.product
       UNION ALL SELECT 'supplier:' || name, id FROM mdm.supplier
       UNION ALL SELECT 'tax:' || code, id FROM mdm.tax_category`,
    )
  ).rows) {
    ids.set(row.code, row.id);
  }
  const branchId = ids.get('branch:DDW')!;
  manager = await enrolAndLogin(api.server, await createUser(database, { name: 'Akosua Boateng', grants: [{ role: 'MANAGER', branchId }] }), () => clock.now());
  accountant = await enrolAndLogin(api.server, await createUser(database, { name: 'Yaw Agyeman', grants: [{ role: 'ACCOUNTANT', branchId }] }), () => clock.now());
});

afterAll(async () => {
  await api.close();
  await database.drop();
});

describe('B7 operations answer in the contract shapes', () => {
  it('lists the seeded feed order by the bag and the seeded transport invoice, counted by hand', async () => {
    const orders = await consoleGet(api.server, manager, v1('/purchase-orders'));
    expectShape('PurchaseOrderPage', orders.body);
    expect(orders.body.data).toHaveLength(1);
    expect(orders.body.data[0]).toMatchObject({ status: 'SENT', grossPesewas: 180_000, lines: [{ uom: 'BAG', qtyOrdered: '4.000', baseUom: 'KG', qtyOrderedBase: '200.000', qtyOutstanding: '200.000' }] });
    const invoices = await consoleGet(api.server, accountant, v1('/supplier-invoices'));
    expectShape('SupplierInvoicePage', invoices.body);
    expect(invoices.body.data.map((i: { supplierInvoiceNo: string; status: string; matchStatus: string; grossPesewas: number }) => [i.supplierInvoiceNo, i.status, i.matchStatus, i.grossPesewas])).toEqual([
      ['KLT-T-0457', 'APPROVED', 'NOT_REQUIRED', 15_000],
    ]);
    expectShape('SupplierInvoice', (await consoleGet(api.server, accountant, v1(`/supplier-invoices/${invoices.body.data[0].id}`))).body);
  });

  it('an order, its 202 above the limit, an invoice, its match and a payment match their schemas', async () => {
    const today = toBusinessDate(clock.now());
    const order = await post(manager, '/purchase-orders', {
      supplierId: ids.get('supplier:Awutu Poultry Farm (SEED)'),
      deliverToLocationId: ids.get('location:PENS'),
      orderDate: today,
      lines: [{ productId: ids.get('product:LIV-BROILER'), qtyOrdered: '50.000', unitPricePesewas: 5_000 }],
    });
    expect(order.status).toBe(201);
    expectShape('PurchaseOrder', order.body);
    const pending = await post(manager, `/purchase-orders/${order.body.id}/submit`);
    expect(pending.status).toBe(202);
    expectShape('ApprovalPending', pending.body);
    const invoice = await post(accountant, '/supplier-invoices', {
      kind: 'INVOICE',
      supplierId: ids.get('supplier:Kpone Livestock Traders (SEED)'),
      supplierInvoiceNo: 'KLT-T-0458',
      invoiceDate: today,
      branchId: ids.get('branch:DDW'),
      lines: [{ description: 'Transport of sheep from Kpone', qty: '1.000', unitPricePesewas: 12_000, taxCategoryId: ids.get('tax:LIVE_ANIMALS') }],
    });
    expect(invoice.status).toBe(201);
    expectShape('SupplierInvoice', invoice.body);
    const matched = await post(accountant, `/supplier-invoices/${invoice.body.id}/match`);
    expectShape('SupplierInvoice', matched.body);
    expectShape('SupplierInvoice', (await post(accountant, `/supplier-invoices/${invoice.body.id}/approve`)).body);
    const payment = await post(accountant, '/supplier-payments', {
      supplierId: ids.get('supplier:Kpone Livestock Traders (SEED)'),
      method: 'CASH',
      allocations: [{ supplierInvoiceId: invoice.body.id, amountPesewas: 12_000 }],
    });
    expect(payment.status).toBe(201);
    expectShape('SupplierPayment', payment.body);
    const submitted = await post(accountant, `/supplier-payments/${payment.body.id}/submit`);
    expect(submitted.status).toBe(202);
    expectShape('ApprovalPending', submitted.body);
    clock.advanceBy(30_000);
    expect((await post(manager, '/auth/step-up', { code: totpAt(manager.secret, Math.floor(clock.now().getTime() / 1000)) })).status).toBe(200);
    expect((await post(manager, `/iam/approvals/${submitted.body.approvalRequestId}/approve`, { reason: 'Matches the transport note' })).status).toBe(200);
    const paid = await post(accountant, `/supplier-payments/${payment.body.id}/mark-paid`, { paidAt: clock.now().toISOString(), externalReference: 'CASH-8812' });
    expectShape('SupplierPayment', paid.body);
    expectShape('SupplierPaymentPage', (await consoleGet(api.server, accountant, v1('/supplier-payments'))).body);
  });

  it('refuses an unmatched invoice for payment in the error envelope with THREE_WAY_MATCH_FAILED', async () => {
    const invoice = await post(accountant, '/supplier-invoices', {
      kind: 'INVOICE',
      supplierId: ids.get('supplier:Awutu Poultry Farm (SEED)'),
      supplierInvoiceNo: 'APF-9001',
      invoiceDate: toBusinessDate(clock.now()),
      branchId: ids.get('branch:DDW'),
      lines: [{ productId: ids.get('product:LIV-BROILER'), description: 'Broilers with no order', qty: '5.000', unitPricePesewas: 5_500, taxCategoryId: ids.get('tax:LIVE_ANIMALS') }],
    });
    await post(accountant, `/supplier-invoices/${invoice.body.id}/match`);
    const refused = await post(accountant, `/supplier-invoices/${invoice.body.id}/approve`);
    expect(refused.status).toBe(422);
    expectShape('Error', refused.body);
    expect(refused.body.error).toMatchObject({ code: 'THREE_WAY_MATCH_FAILED', details: [{ field: '/lines/0', code: 'NO_ORDER_LINE' }] });
  });
});
