import { randomUUID } from 'node:crypto';
import { ManualClock } from '@hakorem/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { contractSchema } from '../../support/contract-schemas';
import { paystackEnvironment, startFakePaystack, type FakePaystack } from '../../support/fake-paystack';
import { stepUp, type TotpSession } from '../../support/fin';
import { consoleGet, consolePost, createUser, enrolAndLogin, login, relaxRateLimits, testStartTime, type TestSession } from '../../support/iam';
import { approveAndDeliver, deliverWebhook, initiateCharge, issueInvoice, referenceFor, runRefundDispatch } from '../../support/pay';
import { startTestApp, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/** The B09a continued operations answer in the shapes of contract/openapi.yaml, refusals included. */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let fake: FakePaystack;
let owner: TotpSession;
let manager: TotpSession;
let cashier: TestSession;
let accountantId: string;
let branchId: string;
let tema: string;
let goat: string;

function expectShape(schema: string, body: unknown): void {
  const validate = contractSchema(schema);
  expect(validate(body), `${schema}: ${JSON.stringify(validate.errors)}`).toBe(true);
}

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  fake = await startFakePaystack(() => clock.now());
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock, environment: { ...paystackEnvironment(fake), AUTH_ACCESS_TTL_SECONDS: '43200' } });
  await runSeedUnits(database.pool('app'), api.app, seedUnits({ SEED_STAFF_PASSWORD: `Seed-${randomUUID()}` }));
  const admin = database.pool('admin');
  branchId = (await admin.query<{ id: string }>("SELECT id FROM mdm.branch WHERE code = 'DDW'")).rows[0]!.id;
  tema = (await admin.query<{ id: string }>('SELECT id FROM mdm.customer WHERE name = $1', ['Tema Cold Store Ltd (SEED)'])).rows[0]!.id;
  goat = (await admin.query<{ id: string }>("SELECT id FROM mdm.product WHERE sku = 'LIV-GOAT'")).rows[0]!.id;
  owner = await enrolAndLogin(api.server, await createUser(database, { name: 'Kwabena Owusu', grants: [{ role: 'OWNER', branchId }] }), () => clock.now());
  manager = await enrolAndLogin(api.server, await createUser(database, { name: 'Akosua Boateng', grants: [{ role: 'MANAGER', branchId }] }), () => clock.now());
  cashier = await login(api.server, await createUser(database, { name: 'Adwoa Darko', grants: [{ role: 'CASHIER', branchId }] }));
  accountantId = (await createUser(database, { name: 'Yaw Agyeman', grants: [{ role: 'ACCOUNTANT', branchId }] })).principalId;
});

afterAll(async () => {
  await api?.close();
  await fake?.close();
  await database?.drop();
});

describe('B09a continued operations answer in the contract shapes', () => {
  it('a mobile money payment pending, cleared, allocated and unallocated, read and listed, and the webhook acknowledged', async () => {
    const started = await initiateCharge(api.server, cashier, { amountPesewas: 30_000, customerId: tema });
    expect(started.status).toBe(201);
    expectShape('Payment', started.body);
    clock.advanceBy(1_000);
    const t = fake.approve(referenceFor(started.body.id as string));
    const hook = await deliverWebhook(api.server, fake.webhook(t));
    expect(hook.status).toBe(200);
    expectShape('WebhookAck', hook.body);
    const forged = await deliverWebhook(api.server, { body: '{"event":"charge.success"}', signature: 'f'.repeat(128) });
    expect(forged.status).toBe(401);
    expectShape('Error', forged.body);
    const invoice = await issueInvoice(api, { principalId: accountantId, kind: 'USER', displayName: 'Yaw Agyeman', realm: 'STAFF', sessionId: null, steppedUpAt: null }, clock, { branchId, customerId: tema, productId: goat }, 20_000n);
    const allocated = await consolePost(api.server, owner, `/v1/payments/${started.body.id as string}/allocate`).send({ allocations: [{ billingDocumentId: invoice.id, amountPesewas: 20_000 }] });
    expect(allocated.status).toBe(200);
    expectShape('Payment', allocated.body);
    const off = await consolePost(api.server, owner, `/v1/payments/${started.body.id as string}/unallocate`).send({ allocationId: allocated.body.allocations[0].id, reason: 'Wrong invoice' });
    expect(off.status).toBe(200);
    expectShape('Payment', off.body);
    const refused = await consolePost(api.server, owner, `/v1/payments/${started.body.id as string}/allocate`).send({ allocations: [{ billingDocumentId: invoice.id, amountPesewas: 30_001 }] });
    expect(refused.status).toBe(422);
    expectShape('Error', refused.body);
    expectShape('Payment', (await consoleGet(api.server, cashier, `/v1/payments/${started.body.id as string}`)).body);
    expectShape('Payment', (await consolePost(api.server, cashier, `/v1/payments/${started.body.id as string}/check-status`).send({})).body);
    expectShape('PaymentPage', (await consoleGet(api.server, cashier, '/v1/payments?limit=5')).body);
    expectShape('PaymentPage', (await consoleGet(api.server, cashier, '/v1/payments/unmatched')).body);
  });

  it('a refund asked for (202), approved, paid by the provider, read and listed, and its refusals', async () => {
    const started = await initiateCharge(api.server, cashier, { amountPesewas: 12_000, customerId: tema });
    clock.advanceBy(1_000);
    await approveAndDeliver(api.server, fake, referenceFor(started.body.id as string));
    const asked = await consolePost(api.server, cashier, '/v1/refunds').send({ originalPaymentId: started.body.id, amountPesewas: 12_000, destination: 'ORIGINAL_METHOD', reasonCode: 'WRONG_ITEM', note: 'Wrong cut' });
    expect(asked.status).toBe(202);
    expectShape('ApprovalPending', asked.body);
    const tooMuch = await consolePost(api.server, cashier, '/v1/refunds').send({ originalPaymentId: started.body.id, amountPesewas: 1, destination: 'ORIGINAL_METHOD', reasonCode: 'WRONG_ITEM', note: 'More' });
    expect(tooMuch.status).toBe(422);
    expectShape('Error', tooMuch.body);
    await stepUp(api.server, manager, clock);
    expect((await consolePost(api.server, manager, `/v1/iam/approvals/${asked.body.approvalRequestId as string}/approve`).send({ reason: 'Checked' })).status).toBe(200);
    fake.refundBehaviour = 'processed';
    await runRefundDispatch(api);
    const refund = await consoleGet(api.server, cashier, `/v1/refunds/${asked.body.subject.id as string}`);
    expect(refund.body.status).toBe('PAID');
    expectShape('Refund', refund.body);
    expectShape('RefundPage', (await consoleGet(api.server, cashier, '/v1/refunds?limit=5')).body);
    const retry = await consolePost(api.server, cashier, `/v1/refunds/${asked.body.subject.id as string}/retry`).send({});
    expect(retry.status).toBe(422);
    expectShape('Error', retry.body);
    await stepUp(api.server, owner, clock);
    const paid = await consolePost(api.server, owner, `/v1/refunds/${asked.body.subject.id as string}/mark-paid`).send({ paidAt: clock.now().toISOString(), externalReference: 'MTN-REV-1' });
    expect(paid.status).toBe(422);
    expectShape('Error', paid.body);
  });

  it('a provider that cannot be reached answers 503 in the error shape', async () => {
    fake.available = false;
    const down = await initiateCharge(api.server, cashier, { amountPesewas: 1_000 });
    fake.available = true;
    expect(down.status).toBe(503);
    expectShape('Error', down.body);
  });
});
