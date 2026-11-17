import { randomUUID } from 'node:crypto';
import { ManualClock } from '@hakorem/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { contractSchema } from '../../support/contract-schemas';
import { stepUp, type TotpSession } from '../../support/fin';
import { consolePost, createUser, enrolAndLogin, login, relaxRateLimits, testStartTime, type TestSession } from '../../support/iam';
import { startTestApp, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/** createOrder's 202 for a price override, confirmOrder's refusal and issueProforma (B09a continued 2e) answer in the contract shapes. */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let sales: TestSession;
let manager: TestSession;
let cashier: TestSession;
let cabbage: string;
let tema: string;

function expectShape(schema: string, body: unknown): void {
  const validate = contractSchema(schema);
  expect(validate(body), `${schema}: ${JSON.stringify(validate.errors)}`).toBe(true);
}

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock, environment: { AUTH_ACCESS_TTL_SECONDS: '172800' } });
  await runSeedUnits(database.pool('app'), api.app, seedUnits({ SEED_STAFF_PASSWORD: `Seed-${randomUUID()}` }));
  const admin = database.pool('admin');
  const branchId = (await admin.query<{ id: string }>("SELECT id FROM mdm.branch WHERE code = 'DDW'")).rows[0]!.id;
  cabbage = (await admin.query<{ id: string }>("SELECT id FROM mdm.product WHERE sku = 'PRD-CABBAGE-HEAD'")).rows[0]!.id;
  tema = (await admin.query<{ id: string }>("SELECT id FROM mdm.customer WHERE name = 'Tema Cold Store Ltd (SEED)'")).rows[0]!.id;
  sales = await login(api.server, await createUser(database, { name: 'Kojo Antwi', grants: [{ role: 'SALES', branchId }] }));
  cashier = await login(api.server, await createUser(database, { name: 'Adwoa Darko', grants: [{ role: 'CASHIER', branchId }] }));
  manager = await enrolAndLogin(api.server, await createUser(database, { name: 'Ama Owusu', grants: [{ role: 'MANAGER', branchId }] }), () => clock.now());
});

afterAll(async () => {
  await api?.close();
  await database?.drop();
});

describe('B09a continued 2e price override and proforma operations answer in the contract shapes', () => {
  it('an order waiting for its override, its refused confirmation and proforma, the approval, the proforma, and every refusal', async () => {
    const order = (agreed: number | null) => ({
      channel: 'WHOLESALE',
      customerId: tema,
      fulfilmentMode: 'COLLECTION',
      paymentTerms: 'COD',
      lines: [{ productId: cabbage, quantity: '2.000', ...(agreed === null ? {} : { agreedUnitPricePesewas: agreed, varianceReasonCode: 'REGULAR_CUSTOMER' }) }],
    });
    const waiting = await consolePost(api.server, sales, '/v1/orders').send(order(900));
    expect(waiting.status).toBe(202);
    expectShape('ApprovalPending', waiting.body);
    const orderId = waiting.body.subject.id as string;
    const refusals = [
      await consolePost(api.server, sales, `/v1/orders/${orderId}/confirm`).send(),
      await consolePost(api.server, sales, `/v1/orders/${orderId}/proforma`).send(),
      await consolePost(api.server, cashier, `/v1/orders/${orderId}/proforma`).send(),
      await consolePost(api.server, sales, `/v1/orders/${randomUUID()}/proforma`).send(),
    ];
    expect(refusals.map((r) => [r.status, r.body.error.code])).toEqual([
      [422, 'PRICE_OVERRIDE_NEEDS_APPROVAL'],
      [422, 'PRICE_OVERRIDE_NEEDS_APPROVAL'],
      [403, 'FORBIDDEN'],
      [404, 'NOT_FOUND'],
    ]);
    for (const refusal of refusals) expectShape('Error', refusal.body);

    await stepUp(api.server, manager as TotpSession, clock);
    const approved = await consolePost(api.server, manager, `/v1/iam/approvals/${waiting.body.approvalRequestId as string}/approve`).send({ reason: 'Agreed on the phone' });
    expect(approved.status).toBe(200);
    expectShape('ApprovalRequest', approved.body);
    const proforma = await consolePost(api.server, sales, `/v1/orders/${orderId}/proforma`).send();
    expect(proforma.status).toBe(201);
    expectShape('BillingDocument', proforma.body);
    const again = await consolePost(api.server, sales, `/v1/orders/${orderId}/proforma`).send();
    expect([again.status, again.body.error.code]).toEqual([422, 'ORDER_INVALID']);
    expectShape('Error', again.body);

    const plain = await consolePost(api.server, sales, '/v1/orders').send(order(null));
    expect(plain.status).toBe(201);
    expectShape('SalesOrder', plain.body);
  });
});
