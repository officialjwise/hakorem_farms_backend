import { randomUUID } from 'node:crypto';
import { ManualClock, toBusinessDate } from '@hakorem/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { contractSchema } from '../../support/contract-schemas';
import { consoleGet, consolePut, createUser, enrolAndLogin, relaxRateLimits, testStartTime, type TestSession } from '../../support/iam';
import { startTestApp, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/** WHL's ageing and dunning operations and the statement with its ageing summary (B10 continued 2) answer in the shapes of contract/openapi.yaml 2.16.0. */
let database: TestDatabase;
let api: TestApp;
let accountant: TestSession;
let manager: TestSession;
let clock: ManualClock;

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
  const branchId = (await database.pool('admin').query<{ id: string }>("SELECT id FROM mdm.branch WHERE code = 'DDW'")).rows[0]!.id;
  accountant = await enrolAndLogin(api.server, await createUser(database, { name: 'Yaw Agyeman', grants: [{ role: 'ACCOUNTANT', branchId }] }), () => clock.now());
  manager = await enrolAndLogin(api.server, await createUser(database, { name: 'Akosua Boateng', grants: [{ role: 'MANAGER', branchId }] }), () => clock.now());
});

afterAll(async () => {
  await api.close();
  await database.drop();
});

describe('the ageing and dunning operations answer in the contract shapes', () => {
  it('the ageing report as at today and later, the seeded statement, the levels, their replacement, a refusal and the notices', async () => {
    for (const asOf of [toBusinessDate(clock.now()), '2027-12-31']) {
      const report = await consoleGet(api.server, accountant, `/v1/receivables/ageing?asOf=${asOf}`);
      expect(report.status, JSON.stringify(report.body)).toBe(200);
      expectShape('AgeingReport', report.body);
    }
    const statements = await consoleGet(api.server, accountant, '/v1/statements');
    expectShape('CustomerStatementPage', statements.body);
    const statement = await consoleGet(api.server, accountant, `/v1/statements/${statements.body.data[0].id as string}`);
    expectShape('CustomerStatement', statement.body);
    expect(statement.body.ageing).not.toBeNull();
    const levels = await consoleGet(api.server, accountant, '/v1/dunning-policy');
    expectShape('DunningLevelPage', levels.body);
    const replaced = await consolePut(api.server, manager, '/v1/dunning-policy').send({ levels: levels.body.data });
    expect(replaced.status, JSON.stringify(replaced.body)).toBe(200);
    expectShape('DunningLevelPage', replaced.body);
    const refused = await consolePut(api.server, manager, '/v1/dunning-policy').send({ levels: [{ ...levels.body.data[1], level: 2 }] });
    expect([refused.status, refused.body.error.code]).toEqual([422, 'DUNNING_POLICY_INVALID']);
    expectShape('Error', refused.body);
    expectShape('DunningNoticePage', (await consoleGet(api.server, accountant, '/v1/dunning-notices')).body);
  });
});
