import { randomUUID } from 'node:crypto';
import { ManualClock } from '@hakorem/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { contractSchema } from '../../support/contract-schemas';
import type { TotpSession } from '../../support/fin';
import { consoleGet, consolePost, createUser, enrolAndLogin, relaxRateLimits, testStartTime } from '../../support/iam';
import { startTestApp, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/** The B08 continued 2 operations answer in the shapes of contract/openapi.yaml, over the seeded trading day's documents. */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let owner: TotpSession;
let accountant: TotpSession;
let branchId: string;
let invoiceId: string;

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
  branchId = (await database.pool('admin').query<{ id: string }>("SELECT id FROM mdm.branch WHERE code = 'DDW'")).rows[0]!.id;
  invoiceId = (await database.pool('admin').query<{ id: string }>("SELECT id FROM bil.billing_document WHERE kind = 'INVOICE'")).rows[0]!.id;
  owner = await enrolAndLogin(api.server, await createUser(database, { name: 'Kwabena Owusu', grants: [{ role: 'OWNER', branchId }] }), () => clock.now());
  accountant = await enrolAndLogin(api.server, await createUser(database, { name: 'Efua Asante', grants: [{ role: 'ACCOUNTANT', branchId }] }), () => clock.now());
});

afterAll(async () => {
  await api.close();
  await database.drop();
});

describe('B08 continued 2 operations answer in the contract shapes', () => {
  it('billing documents: the list, one document, a credit note waiting for approval, a debit note and a refusal', async () => {
    const page = await consoleGet(api.server, accountant, '/v1/billing-documents?limit=10');
    expect(page.status).toBe(200);
    expectShape('BillingDocumentPage', page.body);
    expect(page.body.data.map((d: { kind: string }) => d.kind).sort()).toEqual(['CREDIT_NOTE', 'DEBIT_NOTE', 'INVOICE', 'PROFORMA', 'RECEIPT']);
    const invoice = await consoleGet(api.server, accountant, `/v1/billing-documents/${invoiceId}`);
    expectShape('BillingDocument', invoice.body);
    const credit = await consolePost(api.server, accountant, `/v1/billing-documents/${invoiceId}/credit-notes`).send({ reasonCode: 'OVERCHARGED', note: 'Delivery charged twice', lines: [{ lineId: invoice.body.lines[2].id, amountPesewas: 500 }] });
    expect(credit.status, JSON.stringify(credit.body)).toBe(202);
    expectShape('ApprovalPending', credit.body);
    const otherGoods = (await database.pool('admin').query<{ id: string }>("SELECT id FROM mdm.tax_category WHERE code = 'OTHER_GOODS'")).rows[0]!.id;
    const debit = await consolePost(api.server, accountant, `/v1/billing-documents/${invoiceId}/debit-notes`).send({ reasonCode: 'CHARGE_OMITTED', note: 'Crates', lines: [{ description: 'Returnable crates', amountPesewas: 1_200, taxCategoryId: otherGoods }] });
    expect(debit.status, JSON.stringify(debit.body)).toBe(201);
    expectShape('BillingDocument', debit.body);
    const refused = await consolePost(api.server, accountant, `/v1/billing-documents/${invoiceId}/debit-notes`).send({ reasonCode: 'OVERCHARGED', lines: [{ description: 'x', amountPesewas: 1, taxCategoryId: otherGoods }] });
    expect([refused.status, refused.body.error.code]).toEqual([422, 'BILLING_DOCUMENT_INVALID']);
    expectShape('Error', refused.body);
  });

  it('the receivables tile and the owner dashboard with its receivables live', async () => {
    const tile = await consoleGet(api.server, owner, `/v1/dashboard/tiles/receivables?branchId=${branchId}`);
    expect(tile.status).toBe(200);
    expectShape('ReceivablesTile', tile.body);
    const dashboard = await consoleGet(api.server, owner, `/v1/dashboard/owner?branchId=${branchId}`);
    expect(dashboard.status).toBe(200);
    expectShape('OwnerDashboard', dashboard.body);
    expect(dashboard.body.receivablesOutstandingPesewas).toBe(tile.body.outstandingPesewas);
  });
});
