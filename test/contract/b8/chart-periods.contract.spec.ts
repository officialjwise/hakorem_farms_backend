import { randomUUID } from 'node:crypto';
import { ManualClock } from '@hakorem/kernel';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { totpAt } from '../../../src/modules/iam/domain/totp';
import { contractSchema } from '../../support/contract-schemas';
import { consoleGet, consolePost, createBranch, createUser, enrolAndLogin, relaxRateLimits, testStartTime, type TestSession } from '../../support/iam';
import { startTestApp, TEST_ORIGIN, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/** The B08 continued operations answer in the shapes of contract/openapi.yaml 1.34.0. */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
type TotpSession = TestSession & { readonly secret: Buffer };
let owner: TotpSession;
let accountant: TotpSession;

const post = (session: TestSession, path: string, body: object = {}) => consolePost(api.server, session, `/v1${path}`).send(body);
const get = (session: TestSession, path: string) => consoleGet(api.server, session, `/v1${path}`);

function expectShape(schema: string, body: unknown): void {
  const validate = contractSchema(schema);
  expect(validate(body), `${schema}: ${JSON.stringify(validate.errors)}`).toBe(true);
}

async function stepUp(session: TotpSession): Promise<void> {
  clock.advanceBy(30_000);
  expect((await post(session, '/auth/step-up', { code: totpAt(session.secret, Math.floor(clock.now().getTime() / 1000)) })).status).toBe(200);
}

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock });
  const branchId = (await createBranch(database)).branchId;
  owner = await enrolAndLogin(api.server, await createUser(database, { name: 'Kwabena Owusu', grants: [{ role: 'OWNER', branchId }] }), () => clock.now());
  accountant = await enrolAndLogin(api.server, await createUser(database, { name: 'Efua Asante', grants: [{ role: 'ACCOUNTANT', branchId }] }), () => clock.now());
});

afterAll(async () => {
  await api.close();
  await database.drop();
});

describe('B08 continued operations answer in the contract shapes', () => {
  it('the chart: a page, a new account, a renamed one and a refusal', async () => {
    const page = await get(accountant, '/finance/accounts?limit=5');
    expectShape('AccountPage', page.body);
    const created = await post(accountant, '/finance/accounts', { code: '6110', name: 'Generator fuel', type: 'EXPENSE', isPostable: true, cashFlowCategory: 'OPERATING' });
    expect(created.status).toBe(201);
    expectShape('Account', created.body);
    const renamed = await request(api.server)
      .patch(`/v1/finance/accounts/${created.body.id as string}`)
      .set('Cookie', accountant.jar.header())
      .set('X-CSRF-Token', accountant.csrfToken)
      .set('Origin', TEST_ORIGIN)
      .set('Idempotency-Key', randomUUID())
      .send({ version: 1, name: 'Generator fuel and servicing' });
    expect(renamed.status).toBe(200);
    expectShape('Account', renamed.body);
    const refused = await post(accountant, '/finance/accounts', { code: '2150', name: 'Wrong class', type: 'ASSET', isPostable: true });
    expect(refused.status).toBe(422);
    expectShape('Error', refused.body);
  });

  it('the periods: a page, a lock, a close and a reopen waiting on its checker', async () => {
    const page = await get(accountant, '/finance/periods?fiscalYear=2026&limit=12');
    expectShape('AccountingPeriodPage', page.body);
    const [january, february] = [...(page.body.data as { id: string; periodNo: number }[])].sort((a, b) => a.periodNo - b.periodNo);
    const locked = await post(accountant, `/finance/periods/${january!.id}/lock`);
    expect(locked.status).toBe(200);
    expectShape('AccountingPeriod', locked.body);
    await stepUp(accountant);
    const closed = await post(accountant, `/finance/periods/${january!.id}/close`);
    expect(closed.status).toBe(200);
    expectShape('AccountingPeriod', closed.body);
    expect((await post(accountant, `/finance/periods/${february!.id}/lock`)).status).toBe(200);
    await stepUp(owner);
    const asked = await post(owner, `/finance/periods/${february!.id}/reopen`, { reason: 'A late supplier invoice' });
    expect(asked.status).toBe(202);
    expectShape('ApprovalPending', asked.body);
  });
});
