import { randomUUID } from 'node:crypto';
import { ManualClock, toBusinessDate } from '@hakorem/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { totpAt } from '../../../src/modules/iam/domain/totp';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { contractSchema } from '../../support/contract-schemas';
import { consoleGet, consolePost, createUser, enrolAndLogin, login, relaxRateLimits, testStartTime, type TestSession } from '../../support/iam';
import { startTestApp, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/** The claim operations (B09e continued 3, ADR-0076) answer in the shapes of contract/openapi.yaml 2.4.0. */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
type TotpSession = TestSession & { readonly secret: Buffer };
let owner: TotpSession;
let accountant: TotpSession;
let storekeeper: TestSession;
const ids = new Map<string, string>();
const id = (code: string) => ids.get(code)!;
const post = (session: TestSession, path: string, body: object = {}) => consolePost(api.server, session, `/v1${path}`).send(body);
const get = (session: TestSession, path: string) => consoleGet(api.server, session, `/v1${path}`);
const today = () => toBusinessDate(clock.now());

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
       UNION ALL SELECT 'tax:' || sku, tax_category_id FROM mdm.product
       UNION ALL SELECT 'supplier:' || name, id FROM mdm.supplier`,
    )
  ).rows) {
    ids.set(row.code, row.id);
  }
  const branchId = id('branch:DDW');
  owner = await enrolAndLogin(api.server, await createUser(database, { name: 'Kwabena Owusu', grants: [{ role: 'OWNER', branchId }] }), () => clock.now());
  accountant = await enrolAndLogin(api.server, await createUser(database, { name: 'Yaw Agyeman', grants: [{ role: 'ACCOUNTANT', branchId }] }), () => clock.now());
  storekeeper = await login(api.server, await createUser(database, { name: 'Kofi Mensah', grants: [{ role: 'STOREKEEPER', branchId, locationId: id('location:SHOP') }] }));
});

afterAll(async () => {
  await api.close();
  await database.drop();
});

describe('the claim operations answer in the contract shapes', () => {
  it('a raised claim, its receipt list, the supplier list, its credit note, the approved settlement and a refusal', async () => {
    const supplierId = id('supplier:Awutu Poultry Farm (SEED)');
    const order = await post(storekeeper, '/purchase-orders', {
      supplierId,
      deliverToLocationId: id('location:SHOP'),
      orderDate: today(),
      lines: [{ productId: id('product:EGG-0003'), uom: 'CRATE', qtyOrdered: '1.000', unitPricePesewas: 4_751 }],
    });
    expect(order.status).toBe(201);
    expect((await post(storekeeper, `/purchase-orders/${order.body.id}/submit`)).status).toBe(200);
    expect((await post(owner, `/purchase-orders/${order.body.id}/send`, { channels: ['WHATSAPP'] })).status).toBe(200);
    const line = order.body.lines[0].id as string;
    const receipt = await post(storekeeper, '/goods-receipts', {
      kind: 'PURCHASE',
      supplierId,
      locationId: id('location:SHOP'),
      purchaseOrderId: order.body.id,
      receivedAt: new Date(clock.now().getTime() - 60_000).toISOString(),
      lines: [{ productId: id('product:EGG-0003'), purchaseOrderLineId: line, qtyReceived: '23.000', qtyRejected: '7.000', rejectionReasonCode: 'CRACKED', valuePesewas: 3_642, batchNo: 'EGG-CLAIM-0001', expiresOn: toBusinessDate(new Date(clock.now().getTime() + 14 * 86_400_000)) }],
    });
    expect((await post(storekeeper, `/goods-receipts/${receipt.body.id}/post`)).status).toBe(200);

    const raised = await post(accountant, `/goods-receipts/${receipt.body.id}/claims`, { note: 'Seven cracked' });
    expect(raised.status).toBe(201);
    expectShape('SupplierClaim', raised.body);
    const byReceipt = await get(accountant, `/goods-receipts/${receipt.body.id}/claims`);
    expectShape('SupplierClaimPage', byReceipt.body);
    const open = await get(owner, `/supplier-claims?status=OPEN&supplierId=${supplierId}`);
    expectShape('SupplierClaimPage', open.body);

    const invoice = await post(accountant, '/supplier-invoices', {
      kind: 'INVOICE',
      supplierId,
      supplierInvoiceNo: 'APF-INV-C001',
      invoiceDate: today(),
      purchaseOrderId: order.body.id,
      lines: [{ description: 'Big eggs, crate of 30', purchaseOrderLineId: line, qty: '1.000', unitPricePesewas: 4_751, taxCategoryId: id('tax:EGG-0003') }],
    });
    expect((await post(accountant, `/supplier-invoices/${invoice.body.id}/match`)).status).toBe(200);
    expect((await post(owner, `/supplier-invoices/${invoice.body.id}/approve`)).status).toBe(200);
    const refused = await post(accountant, `/supplier-claims/${raised.body.id}/settle`, { supplierInvoiceId: invoice.body.id });
    expect(refused.status).toBe(422);
    expectShape('Error', refused.body);
    const credit = await post(accountant, `/supplier-claims/${raised.body.id}/credit-note`, { originalInvoiceId: invoice.body.id, supplierInvoiceNo: 'APF-CN-C001', invoiceDate: today() });
    expect(credit.status).toBe(201);
    expectShape('SupplierInvoice', credit.body);
    const submitted = await post(accountant, `/supplier-invoices/${credit.body.id}/submit`);
    clock.advanceBy(30_000);
    expect((await post(owner, '/auth/step-up', { code: totpAt(owner.secret, Math.floor(clock.now().getTime() / 1000)) })).status).toBe(200);
    expect((await post(owner, `/iam/approvals/${submitted.body.approvalRequestId}/approve`, { reason: 'Checked' })).status).toBe(200);
    const settled = await get(owner, `/supplier-claims/${raised.body.id}`);
    expectShape('SupplierClaim', settled.body);
    expect(settled.body.status).toBe('SETTLED');
    expectShape('SupplierInvoice', (await get(accountant, `/supplier-invoices/${invoice.body.id}`)).body);
  });
});
