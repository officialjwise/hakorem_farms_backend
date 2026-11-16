import { randomUUID } from 'node:crypto';
import { ManualClock, toBusinessDate } from '@hakorem/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { contractSchema } from '../../support/contract-schemas';
import { stepUp, type TotpSession } from '../../support/fin';
import { consoleGet, consolePatch, consolePost, createUser, enrolAndLogin, login, relaxRateLimits, testStartTime, type TestSession } from '../../support/iam';
import { issueInvoice } from '../../support/pay';
import { startTestApp, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/** The refund against a credit note and the cheque's bank payout (B09a continued 1d) answer in the shapes of contract/openapi.yaml, refusals included. */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let owner: TotpSession;
let manager: TotpSession;
let accountant: TotpSession;
let cashier: TestSession;
let accountantId: string;
let branchId: string;
let tema: string;
let goat: string;
let gcb: string;
const methods = new Map<string, string>();

function expectShape(schema: string, body: unknown): void {
  const validate = contractSchema(schema);
  expect(validate(body), `${schema}: ${JSON.stringify(validate.errors)}`).toBe(true);
}

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock, environment: { AUTH_ACCESS_TTL_SECONDS: '43200' } });
  await runSeedUnits(database.pool('app'), api.app, seedUnits({ SEED_STAFF_PASSWORD: `Seed-${randomUUID()}` }));
  const admin = database.pool('admin');
  branchId = (await admin.query<{ id: string }>("SELECT id FROM mdm.branch WHERE code = 'DDW'")).rows[0]!.id;
  tema = (await admin.query<{ id: string }>('SELECT id FROM mdm.customer WHERE name = $1', ['Tema Cold Store Ltd (SEED)'])).rows[0]!.id;
  goat = (await admin.query<{ id: string }>("SELECT id FROM mdm.product WHERE sku = 'LIV-GOAT'")).rows[0]!.id;
  gcb = (await admin.query<{ id: string }>("SELECT id FROM fin.bank_account WHERE name = 'GCB current account (SEED)'")).rows[0]!.id;
  for (const row of (await admin.query<{ code: string; id: string }>('SELECT code, id FROM mdm.payment_method')).rows) methods.set(row.code, row.id);
  owner = await enrolAndLogin(api.server, await createUser(database, { name: 'Kwabena Owusu', grants: [{ role: 'OWNER', branchId }] }), () => clock.now());
  manager = await enrolAndLogin(api.server, await createUser(database, { name: 'Akosua Boateng', grants: [{ role: 'MANAGER', branchId }] }), () => clock.now());
  const accountantUser = await createUser(database, { name: 'Yaw Agyeman', grants: [{ role: 'ACCOUNTANT', branchId }] });
  accountantId = accountantUser.principalId;
  accountant = await enrolAndLogin(api.server, accountantUser, () => clock.now());
  cashier = await login(api.server, await createUser(database, { name: 'Adwoa Darko', grants: [{ role: 'CASHIER', branchId }] }));
  for (const code of ['CHEQUE']) {
    const { rows } = await admin.query<{ version: number }>('SELECT version FROM mdm.payment_method WHERE code = $1', [code]);
    expect((await consolePatch(api.server, owner, `/v1/payment-methods/${methods.get(code)!}`).send({ version: rows[0]!.version, isEnabled: true })).status).toBe(200);
  }
});

afterAll(async () => {
  await api?.close();
  await database?.drop();
});

describe('B09a continued 1d operations answer in the contract shapes', () => {
  it('a paid invoice credited beyond its outstanding, a refund against the credit note through a bank payout, and the refusals', async () => {
    const actor = { principalId: accountantId, kind: 'USER' as const, displayName: 'Yaw Agyeman', realm: 'STAFF' as const, sessionId: null, steppedUpAt: null };
    const invoice = await issueInvoice(api, actor, clock, { branchId, customerId: tema, productId: goat }, 40_000n);
    const body = { id: randomUUID(), paymentMethodId: methods.get('CHEQUE')!, amountPesewas: 40_000, customerId: tema, bankAccountId: gcb, externalReference: '004513', receivedAt: clock.now().toISOString(), allocations: [{ billingDocumentId: invoice.id, amountPesewas: 40_000 }] };
    expect((await consolePost(api.server, cashier, '/v1/payments').send(body)).status).toBe(201);
    expect((await consolePost(api.server, accountant, `/v1/payments/${body.id}/clear-cheque`).send({ clearedOn: toBusinessDate(clock.now()) })).status).toBe(200);
    const original = await consoleGet(api.server, accountant, `/v1/billing-documents/${invoice.id}`);
    const asked = await consolePost(api.server, accountant, `/v1/billing-documents/${invoice.id}/credit-notes`).send({ reasonCode: 'QUALITY_COMPLAINT', note: 'One goat returned', lines: [{ lineId: original.body.lines[0].id, amountPesewas: 10_000 }] });
    expect(asked.status).toBe(202);
    await stepUp(api.server, manager, clock);
    expect((await consolePost(api.server, manager, `/v1/iam/approvals/${asked.body.approvalRequestId as string}/approve`).send({ reason: 'Seen the goat' })).status).toBe(200);
    const note = await consoleGet(api.server, accountant, `/v1/billing-documents/${asked.body.subject.id as string}`);
    expect(note.body.settlement).toMatchObject({ refundedPesewas: 0, refundablePesewas: 10_000 });
    expectShape('BillingDocument', note.body);
    const credited = await consoleGet(api.server, accountant, `/v1/billing-documents/${invoice.id}`);
    expect(credited.body.settlement).toMatchObject({ outstandingPesewas: 0, refundablePesewas: 10_000 });
    expectShape('BillingDocument', credited.body);
    expectShape('BillingDocumentPage', (await consoleGet(api.server, accountant, '/v1/billing-documents?limit=5')).body);

    const refund = await consolePost(api.server, cashier, '/v1/refunds').send({ originalPaymentId: body.id, amountPesewas: 10_000, destination: 'ORIGINAL_METHOD', reasonCode: 'QUALITY_COMPLAINT', note: 'One goat returned', creditNoteId: note.body.id });
    expect(refund.status).toBe(202);
    expectShape('ApprovalPending', refund.body);
    const over = await consolePost(api.server, cashier, '/v1/refunds').send({ originalPaymentId: body.id, amountPesewas: 1, destination: 'ORIGINAL_METHOD', reasonCode: 'QUALITY_COMPLAINT', note: 'More', creditNoteId: note.body.id });
    expect([over.status, over.body.error.code]).toEqual([422, 'REFUND_EXCEEDS_CREDIT_NOTE']);
    expectShape('Error', over.body);
    await stepUp(api.server, accountant, clock);
    const byNoteMaker = await consolePost(api.server, accountant, `/v1/iam/approvals/${refund.body.approvalRequestId as string}/approve`).send({ reason: 'Mine' });
    expect([byNoteMaker.status, byNoteMaker.body.error.code]).toEqual([422, 'MAKER_CANNOT_CHECK']);
    expectShape('Error', byNoteMaker.body);
    await stepUp(api.server, owner, clock);
    expect((await consolePost(api.server, owner, `/v1/iam/approvals/${refund.body.approvalRequestId as string}/approve`).send({ reason: 'Agreed' })).status).toBe(200);
    const read = await consoleGet(api.server, cashier, `/v1/refunds/${refund.body.subject.id as string}`);
    expect(read.body).toMatchObject({ status: 'APPROVED', creditNote: { id: note.body.id, docType: 'CREDIT_NOTE', number: note.body.documentNo } });
    expectShape('Refund', read.body);
    await stepUp(api.server, accountant, clock);
    const paid = await consolePost(api.server, accountant, `/v1/refunds/${refund.body.subject.id as string}/mark-paid`).send({ paidAt: clock.now().toISOString(), externalReference: 'GCB-TRF-90013' });
    expect(paid.status).toBe(200);
    expectShape('Refund', paid.body);
    expectShape('RefundPage', (await consoleGet(api.server, cashier, '/v1/refunds?limit=5')).body);
  });
});
