import { randomUUID } from 'node:crypto';
import { ManualClock } from '@hakorem/kernel';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { totpAt } from '../../../src/modules/iam/domain/totp';
import { contractSchema } from '../../support/contract-schemas';
import { consoleGet, consolePost, createBranch, createUser, enrolAndLogin, relaxRateLimits, testStartTime, type TestSession } from '../../support/iam';
import { startTestApp, TEST_ORIGIN, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/** The B08 continued 1b2 operations answer in the shapes of contract/openapi.yaml. */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
type TotpSession = TestSession & { readonly secret: Buffer };
let owner: TotpSession;

function expectShape(schema: string, body: unknown): void {
  const validate = contractSchema(schema);
  expect(validate(body), `${schema}: ${JSON.stringify(validate.errors)}`).toBe(true);
}

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock });
  const branchId = (await createBranch(database)).branchId;
  owner = await enrolAndLogin(api.server, await createUser(database, { name: 'Kwabena Owusu', grants: [{ role: 'OWNER', branchId }] }), () => clock.now());
});

afterAll(async () => {
  await api.close();
  await database.drop();
});

describe('B08 continued 1b2 operations answer in the contract shapes', () => {
  it('a bank account added, listed, renamed and refused, and a wallet with a branch', async () => {
    clock.advanceBy(30_000);
    expect((await consolePost(api.server, owner, '/v1/auth/step-up').send({ code: totpAt(owner.secret, Math.floor(clock.now().getTime() / 1000)) })).status).toBe(200);
    const created = await consolePost(api.server, owner, '/v1/finance/bank-accounts').send({ kind: 'BANK', name: 'Fidelity savings', institution: 'Fidelity Bank', accountNo: '2040016620' });
    expect(created.status).toBe(201);
    expectShape('BankAccount', created.body);
    const branch = (await database.pool('admin').query<{ id: string }>('SELECT id FROM mdm.branch LIMIT 1')).rows[0]!.id;
    const wallet = await consolePost(api.server, owner, '/v1/finance/bank-accounts').send({ kind: 'MOBILE_MONEY', name: 'Telecel Cash wallet', institution: 'Telecel Cash', accountNo: '0204002284', branchId: branch });
    expect(wallet.status).toBe(201);
    expectShape('BankAccount', wallet.body);
    expect(wallet.body.branch).not.toBeNull();
    const page = await consoleGet(api.server, owner, '/v1/finance/bank-accounts?limit=1');
    expectShape('BankAccountPage', page.body);
    const renamed = await request(api.server)
      .patch(`/v1/finance/bank-accounts/${created.body.id as string}`)
      .set('Cookie', owner.jar.header())
      .set('X-CSRF-Token', owner.csrfToken)
      .set('Origin', TEST_ORIGIN)
      .set('Idempotency-Key', randomUUID())
      .send({ version: 1, isActive: false });
    expect(renamed.status).toBe(200);
    expectShape('BankAccount', renamed.body);
    const refused = await consolePost(api.server, owner, '/v1/finance/bank-accounts').send({ kind: 'BANK', name: 'Too short', institution: 'GCB Bank', accountNo: '12345' });
    expect(refused.status).toBe(422);
    expectShape('Error', refused.body);
  });
});
