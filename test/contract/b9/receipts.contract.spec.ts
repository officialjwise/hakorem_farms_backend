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

/** The B09a continued 1b operations answer in the shapes of contract/openapi.yaml, refusals included. */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let owner: TotpSession;
let manager: TotpSession;
let accountant: TotpSession;
let cashier: TestSession;
let customer: TestSession;
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
  const buyer = await createUser(database, { name: 'Esi Asante', realm: 'CUSTOMER' });
  await admin.query('UPDATE mdm.customer SET principal_id = $1, version = version + 1 WHERE id = $2', [buyer.principalId, tema]);
  customer = await login(api.server, buyer);
  for (const code of ['CHEQUE', 'STORE_CREDIT']) {
    const { rows } = await admin.query<{ version: number }>('SELECT version FROM mdm.payment_method WHERE code = $1', [code]);
    expect((await consolePatch(api.server, owner, `/v1/payment-methods/${methods.get(code)!}`).send({ version: rows[0]!.version, isEnabled: true })).status).toBe(200);
  }
});

afterAll(async () => {
  await api?.close();
  await database?.drop();
});

describe('B09a continued 1b operations answer in the contract shapes', () => {
  it('a cheque recorded, cleared and reversed; store credit refunded, read and redeemed; the open items; and the refusals', async () => {
    const invoice = await issueInvoice(api, { principalId: accountantId, kind: 'USER', displayName: 'Yaw Agyeman', realm: 'STAFF', sessionId: null, steppedUpAt: null }, clock, { branchId, customerId: tema, productId: goat }, 40_000n);
    const body = { id: randomUUID(), paymentMethodId: methods.get('CHEQUE')!, amountPesewas: 50_000, customerId: tema, bankAccountId: gcb, externalReference: '004512', chequeDueOn: toBusinessDate(clock.now()), receivedAt: clock.now().toISOString(), allocations: [{ billingDocumentId: invoice.id, amountPesewas: 40_000 }] };
    const recorded = await consolePost(api.server, cashier, '/v1/payments').send(body);
    expect(recorded.status).toBe(201);
    expectShape('Payment', recorded.body);
    const cleared = await consolePost(api.server, accountant, `/v1/payments/${body.id}/clear-cheque`).send({ clearedOn: toBusinessDate(clock.now()) });
    expect(cleared.status).toBe(200);
    expectShape('Payment', cleared.body);
    const open = await consoleGet(api.server, accountant, '/v1/receivables/open-items?limit=5');
    expect(open.status).toBe(200);
    expectShape('OpenItemPage', open.body);

    const refund = await consolePost(api.server, cashier, '/v1/refunds').send({ originalPaymentId: body.id, amountPesewas: 10_000, destination: 'STORE_CREDIT', reasonCode: 'OVERCHARGED', note: 'Charged for a crate not taken' });
    expect(refund.status).toBe(202);
    await stepUp(api.server, owner, clock);
    expect((await consolePost(api.server, owner, `/v1/iam/approvals/${refund.body.approvalRequestId as string}/approve`).send({ reason: 'Agreed' })).status).toBe(200);
    const credit = await consoleGet(api.server, cashier, `/v1/customers/${tema}/store-credit`);
    expect(credit.status).toBe(200);
    expectShape('StoreCredit', credit.body);
    const mine = await consoleGet(api.server, customer, '/v1/me/store-credit');
    expect(mine.status).toBe(200);
    expectShape('StoreCredit', mine.body);
    const redeemed = await consolePost(api.server, cashier, '/v1/payments').send({ id: randomUUID(), paymentMethodId: methods.get('STORE_CREDIT')!, amountPesewas: 10_000, customerId: tema, receivedAt: clock.now().toISOString() });
    expect(redeemed.status).toBe(201);
    expectShape('Payment', redeemed.body);
    const over = await consolePost(api.server, cashier, '/v1/payments').send({ id: randomUUID(), paymentMethodId: methods.get('STORE_CREDIT')!, amountPesewas: 1, customerId: tema, receivedAt: clock.now().toISOString() });
    expect(over.status).toBe(422);
    expectShape('Error', over.body);

    const reversal = await consolePost(api.server, manager, `/v1/payments/${redeemed.body.id as string}/reverse`).send({ reasonCode: 'RECORDED_IN_ERROR', note: 'Redeemed on the wrong account' });
    expect(reversal.status).toBe(202);
    expectShape('ApprovalPending', reversal.body);
    const refused = await consolePost(api.server, manager, `/v1/payments/${body.id}/reverse`).send({ reasonCode: 'OVERCHARGED' });
    expect(refused.status).toBe(422);
    expectShape('Error', refused.body);
    const momo = await consolePost(api.server, cashier, '/v1/payments').send({ id: randomUUID(), paymentMethodId: methods.get('MOMO')!, amountPesewas: 1_000, receivedAt: clock.now().toISOString() });
    expect(momo.status).toBe(422);
    expectShape('Error', momo.body);
    const forbidden = await consoleGet(api.server, cashier, '/v1/receivables/open-items');
    expect(forbidden.status).toBe(403);
    expectShape('Error', forbidden.body);
  });
});
