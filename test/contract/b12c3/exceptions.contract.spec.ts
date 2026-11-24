import { randomUUID } from 'node:crypto';
import { ManualClock, toBusinessDate } from '@hakorem/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ExceptionSweep } from '../../../src/modules/rpt';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { contractSchema } from '../../support/contract-schemas';
import { documentWorker } from '../../support/documents';
import { consoleGet, consolePost, createUser, enrolAndLogin, login, relaxRateLimits, testStartTime, type TestSession } from '../../support/iam';
import { startTestApp, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/** RPT's exception report (B12 continued 3) answers in the shapes of contract/openapi.yaml 2.48.0, over the seeded trading day. */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let owner: TestSession;
let manager: TestSession;
let today: string;

function expectShape(schema: string, body: unknown): void {
  const validate = contractSchema(schema);
  expect(validate(body), `${schema}: ${JSON.stringify(validate.errors)}`).toBe(true);
}

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock });
  await runSeedUnits(database.pool('app'), api.app, seedUnits({ SEED_STAFF_PASSWORD: `Seed-${randomUUID()}` }, { tradingDay: true }));
  await documentWorker(api, database, clock).settle();
  const branchId = (await database.pool('admin').query<{ id: string }>("SELECT id FROM mdm.branch WHERE code = 'DDW'")).rows[0]!.id;
  today = toBusinessDate(clock.now());
  owner = await enrolAndLogin(api.server, await createUser(database, { name: 'Kwabena Owusu', grants: [{ role: 'OWNER', branchId }] }), () => clock.now());
  manager = await enrolAndLogin(api.server, await createUser(database, { name: 'Abena Quaye', grants: [{ role: 'MANAGER', branchId }] }), () => clock.now());
  const cashier = await login(api.server, await createUser(database, { name: 'Adwoa Darko', grants: [{ role: 'CASHIER', branchId }] }));
  expect((await consoleGet(api.server, cashier, `/v1/exceptions?date=${today}`)).status).toBe(403);
  await api.app.get(ExceptionSweep).sweepDay(today);
});

afterAll(async () => {
  await api.close();
  await database.drop();
});

describe('the exception report answers in the contract shapes', () => {
  it('the daily report, a page of items, a review and its refusals', async () => {
    const report = await consoleGet(api.server, owner, `/v1/exceptions/daily-report?date=${today}`);
    expect(report.status, JSON.stringify(report.body)).toBe(200);
    expectShape('DailyExceptionReport', report.body);
    expect(report.body.items.length).toBeGreaterThan(0);
    const page = await consoleGet(api.server, owner, `/v1/exceptions?date=${today}&limit=5`);
    expect(page.status, JSON.stringify(page.body)).toBe(200);
    expectShape('ExceptionItemPage', page.body);
    const item = (report.body.items as { id: string; actor: { id: string } | null }[]).find((i) => i.actor !== null)!;
    const reviewed = await consolePost(api.server, manager, `/v1/exceptions/${item.id}/review`).send({ note: 'Seen with the cashier.' });
    expect(reviewed.status, JSON.stringify(reviewed.body)).toBe(200);
    expectShape('ExceptionItem', reviewed.body);
    const again = await consolePost(api.server, owner, `/v1/exceptions/${item.id}/review`).send({ note: 'Seen again.' });
    expect(again.status).toBe(409);
    expectShape('Error', again.body);
    expectShape('Error', (await consoleGet(api.server, owner, `/v1/exceptions?from=${today}&to=2020-01-01`)).body);
  });
});
