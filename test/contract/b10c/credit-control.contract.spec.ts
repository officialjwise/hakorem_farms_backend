import { randomUUID } from 'node:crypto';
import { ManualClock } from '@hakorem/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { contractSchema } from '../../support/contract-schemas';
import { consoleGet, consolePost, createUser, enrolAndLogin, login, relaxRateLimits, testStartTime, type TestSession } from '../../support/iam';
import { startTestApp, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/** WHL's business account and credit control operations (B10 continued) answer in the shapes of contract/openapi.yaml 2.13.0. */
let database: TestDatabase;
let api: TestApp;
let sales: TestSession;
let manager: TestSession;
const ids = new Map<string, string>();

function expectShape(schema: string, body: unknown): void {
  const validate = contractSchema(schema);
  expect(validate(body), `${schema}: ${JSON.stringify(validate.errors)}`).toBe(true);
}

beforeAll(async () => {
  database = await createTestDatabase();
  const clock = new ManualClock(testStartTime());
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock });
  await runSeedUnits(database.pool('app'), api.app, seedUnits({ SEED_STAFF_PASSWORD: `Seed-${randomUUID()}` }));
  const admin = database.pool('admin');
  const branchId = (await admin.query<{ id: string }>("SELECT id FROM mdm.branch WHERE code = 'DDW'")).rows[0]!.id;
  ids.set('yam', (await admin.query<{ id: string }>("SELECT id FROM mdm.product WHERE sku = 'PRD-0005'")).rows[0]!.id);
  ids.set('madina', (await admin.query<{ id: string }>("SELECT id FROM mdm.customer WHERE name = 'Madina Market Traders (SEED)'")).rows[0]!.id);
  ids.set('tema', (await admin.query<{ id: string }>("SELECT id FROM mdm.customer WHERE name = 'Tema Cold Store Ltd (SEED)'")).rows[0]!.id);
  sales = await login(api.server, await createUser(database, { name: 'Esi Appiah', grants: [{ role: 'SALES', branchId }] }));
  manager = await enrolAndLogin(api.server, await createUser(database, { name: 'Akosua Boateng', grants: [{ role: 'MANAGER', branchId }] }), () => clock.now());
});

afterAll(async () => {
  await api.close();
  await database.drop();
});

describe('the credit control operations answer in the contract shapes', () => {
  it('an account and its page, an order\'s credit check, the refusal, the override asked, the release asked and the overrides page', async () => {
    expectShape('BusinessAccountPage', (await consoleGet(api.server, sales, '/v1/business-accounts')).body);
    expectShape('BusinessAccount', (await consoleGet(api.server, sales, `/v1/business-accounts/${ids.get('tema')!}`)).body);
    const order = await consolePost(api.server, sales, '/v1/orders').send({ channel: 'WHOLESALE', customerId: ids.get('madina')!, fulfilmentMode: 'COLLECTION', paymentTerms: 'CREDIT', lines: [{ productId: ids.get('yam')!, quantity: '2.000' }] });
    expect(order.status, JSON.stringify(order.body)).toBe(201);
    const check = await consoleGet(api.server, sales, `/v1/orders/${order.body.id as string}/credit-check`);
    expectShape('OrderCreditCheck', check.body);
    expect(check.body.outcome).toBe('ON_HOLD');
    const refused = await consolePost(api.server, sales, `/v1/orders/${order.body.id as string}/confirm`).send();
    expect([refused.status, refused.body.error.code]).toEqual([422, 'ACCOUNT_ON_HOLD']);
    expectShape('Error', refused.body);
    const asked = await consolePost(api.server, sales, `/v1/orders/${order.body.id as string}/credit-override`).send({ reason: 'Funeral order, paid Friday' });
    expect(asked.status, JSON.stringify(asked.body)).toBe(202);
    expectShape('CreditOverridePending', asked.body);
    const release = await consolePost(api.server, manager, `/v1/business-accounts/${ids.get('madina')!}/release`).send({ reason: 'Cheque replaced' });
    expect(release.status, JSON.stringify(release.body)).toBe(202);
    expectShape('ApprovalPending', release.body);
    expectShape('CreditOverridePage', (await consoleGet(api.server, sales, '/v1/credit-overrides')).body);
  });
});
