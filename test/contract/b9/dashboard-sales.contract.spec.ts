import { randomUUID } from 'node:crypto';
import { ManualClock, toBusinessDate } from '@hakorem/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays } from '../../../src/modules/rpt/domain/dashboard';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { contractSchema } from '../../support/contract-schemas';
import { consoleGet, createUser, enrolAndLogin, login, relaxRateLimits, testStartTime, type TestSession } from '../../support/iam';
import { startTestApp, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * The owner dashboard with its sales figures and the tiles getSalesTodayTile and getSalesSeries answer in the shapes
 * of contract/openapi.yaml 1.52.0, over the seeded farm with its trading day (B09a continued 2g), refusals included.
 */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let owner: TestSession;
let cashier: TestSession;

function expectShape(schema: string, body: unknown): void {
  const validate = contractSchema(schema);
  expect(validate(body), `${schema}: ${JSON.stringify(validate.errors)}`).toBe(true);
}

const get = (session: TestSession, path: string) => consoleGet(api.server, session, `/v1${path}`);

beforeAll(async () => {
  database = await createTestDatabase();
  const start = testStartTime();
  clock = new ManualClock(start.getUTCHours() >= 22 ? new Date(`${addDays(toBusinessDate(start), 1)}T00:05:00Z`) : start);
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock });
  await runSeedUnits(database.pool('app'), api.app, seedUnits({ SEED_STAFF_PASSWORD: `Seed-${randomUUID()}` }, { tradingDay: true }));
  const branchId = (await database.pool('admin').query<{ id: string }>("SELECT id FROM mdm.branch WHERE code = 'DDW'")).rows[0]!.id;
  owner = await enrolAndLogin(api.server, await createUser(database, { name: 'Ama Owusu', grants: [{ role: 'OWNER', branchId }] }), () => clock.now());
  cashier = await login(api.server, await createUser(database, { name: 'Adwoa Darko', grants: [{ role: 'CASHIER', branchId }] }));
});

afterAll(async () => {
  await api?.close();
  await database?.drop();
});

describe('the sales figures answer in the contract shapes', () => {
  it('the owner dashboard with every sales figure live, a week and a month', async () => {
    const week = await get(owner, '/dashboard/owner');
    expectShape('OwnerDashboard', week.body);
    expect(week.body.salesTodayPesewas).toBeGreaterThan(0);
    expect(week.body.topMovers.length).toBeGreaterThan(0);
    expectShape('OwnerDashboard', (await get(owner, '/dashboard/owner?period=MONTH')).body);
  });

  it('getSalesTodayTile and getSalesSeries, and their refusals', async () => {
    const today = toBusinessDate(clock.now());
    expectShape('SalesTodayTile', (await get(owner, '/dashboard/tiles/sales-today')).body);
    expectShape('SalesTodayTile', (await get(owner, `/dashboard/tiles/sales-today?date=${addDays(today, -1)}`)).body);
    expectShape('SalesSeriesTile', (await get(owner, '/dashboard/tiles/sales')).body);
    expectShape('SalesSeriesTile', (await get(owner, `/dashboard/tiles/sales?from=${today}&to=${today}`)).body);
    const future = await get(owner, `/dashboard/tiles/sales-today?date=${addDays(today, 1)}`);
    expect(future.status).toBe(422);
    expectShape('Error', future.body);
    const reversed = await get(owner, `/dashboard/tiles/sales?from=${today}&to=${addDays(today, -1)}`);
    expect(reversed.status).toBe(422);
    expectShape('Error', reversed.body);
    const refused = await get(cashier, '/dashboard/tiles/sales');
    expect(refused.status).toBe(403);
    expectShape('Error', refused.body);
  });
});
