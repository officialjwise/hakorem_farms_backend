import { randomUUID } from 'node:crypto';
import { ManualClock, toBusinessDate } from '@hakorem/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { totpAt } from '../../../src/modules/iam/domain/totp';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { SEED_TRANSPORT_INVOICE } from '../../../src/seed/farm-pur';
import { seedUnits } from '../../../src/seed/seed-units';
import { contractSchema } from '../../support/contract-schemas';
import { consoleGet, consolePost, createUser, enrolAndLogin, relaxRateLimits, testStartTime, type TestSession } from '../../support/iam';
import { startTestApp, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/** The B07 continued 1b operations answer in the shapes of contract/openapi.yaml 1.30.0. */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
type TotpSession = TestSession & { readonly secret: Buffer };
let manager: TotpSession;
let accountant: TotpSession;
let owner: TotpSession;
const ids = new Map<string, string>();
const post = (session: TestSession, path: string, body: object = {}) => consolePost(api.server, session, `/v1${path}`).send(body);
const get = (session: TestSession, path: string) => consoleGet(api.server, session, `/v1${path}`);

function expectShape(schema: string, body: unknown): void {
  const validate = contractSchema(schema);
  expect(validate(body), `${schema}: ${JSON.stringify(validate.errors)}`).toBe(true);
}

async function approve(checker: TotpSession, approvalRequestId: string) {
  clock.advanceBy(30_000);
  expect((await post(checker, '/auth/step-up', { code: totpAt(checker.secret, Math.floor(clock.now().getTime() / 1000)) })).status).toBe(200);
  return post(checker, `/iam/approvals/${approvalRequestId}/approve`, { reason: 'Checked' });
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
       UNION ALL SELECT 'supplier:' || name, id FROM mdm.supplier
       UNION ALL SELECT 'tax:' || code, id FROM mdm.tax_category
       UNION ALL SELECT 'invoice:' || supplier_invoice_no, id FROM pur.supplier_invoice`,
    )
  ).rows) {
    ids.set(row.code, row.id);
  }
  const branchId = ids.get('branch:DDW')!;
  manager = await enrolAndLogin(api.server, await createUser(database, { name: 'Akosua Boateng', grants: [{ role: 'MANAGER', branchId }] }), () => clock.now());
  accountant = await enrolAndLogin(api.server, await createUser(database, { name: 'Yaw Agyeman', grants: [{ role: 'ACCOUNTANT', branchId }] }), () => clock.now());
  owner = await enrolAndLogin(api.server, await createUser(database, { name: 'Kwabena Owusu', grants: [{ role: 'OWNER', branchId }] }), () => clock.now());
});

afterAll(async () => {
  await api.close();
  await database.drop();
});

describe('B07 continued 1b operations answer in the contract shapes', () => {
  it('a credit note and its submission, the credited invoice, a paid payment remittance and the scores page', async () => {
    const kpone = ids.get(`supplier:${SEED_TRANSPORT_INVOICE.supplier}`)!;
    const invoice = ids.get(`invoice:${SEED_TRANSPORT_INVOICE.supplierInvoiceNo}`)!;
    const credit = await post(accountant, '/supplier-invoices', {
      kind: 'CREDIT_NOTE',
      supplierId: kpone,
      supplierInvoiceNo: 'KLT-CN-0032',
      invoiceDate: toBusinessDate(clock.now()),
      originalInvoiceId: invoice,
      lines: [{ description: 'Transport refund, the second trip', qty: '1.000', unitPricePesewas: 1_500, taxCategoryId: ids.get(`tax:${SEED_TRANSPORT_INVOICE.taxCategory}`)! }],
    });
    expect(credit.status).toBe(201);
    expectShape('SupplierInvoice', credit.body);
    const submitted = await post(accountant, `/supplier-invoices/${credit.body.id}/submit`);
    expect(submitted.status).toBe(202);
    expectShape('ApprovalPending', submitted.body);
    expect((await approve(owner, submitted.body.approvalRequestId)).status).toBe(200);
    const credited = await get(accountant, `/supplier-invoices/${invoice}`);
    expectShape('SupplierInvoice', credited.body);
    expect(credited.body).toMatchObject({ grossPesewas: 15_000, creditedPesewas: 3_000, outstandingPesewas: 12_000 });

    const payment = await post(accountant, '/supplier-payments', { supplierId: kpone, method: 'CASH', allocations: [{ supplierInvoiceId: invoice, amountPesewas: 12_000 }] });
    const pending = await post(accountant, `/supplier-payments/${payment.body.id}/submit`);
    expect((await approve(manager, pending.body.approvalRequestId)).status).toBe(200);
    expect((await post(accountant, `/supplier-payments/${payment.body.id}/mark-paid`, { paidAt: clock.now().toISOString(), externalReference: 'CASH-KLT-0457' })).status).toBe(200);
    const remittance = await get(accountant, `/supplier-payments/${payment.body.id}/remittance`);
    expect(remittance.status).toBe(200);
    expectShape('SupplierRemittance', remittance.body);

    const scores = await get(manager, `/supplier-scores?periodStart=${toBusinessDate(clock.now()).slice(0, 7)}-01`);
    expect(scores.status).toBe(200);
    expectShape('SupplierScorePage', scores.body);
    expect(scores.body.data.length).toBeGreaterThan(0);
  });
});
