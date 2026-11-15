import { randomUUID } from 'node:crypto';
import { ManualClock } from '@hakorem/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { contractSchema } from '../../support/contract-schemas';
import { consoleGet, consolePost, createUser, enrolAndLogin, relaxRateLimits, testStartTime, type TestSession } from '../../support/iam';
import { startTestApp, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/** The B06 continued livestock operations answer in the shapes of contract/openapi.yaml 1.24.0, over the seeded farm. */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let manager: TestSession;
const ids = new Map<string, string>();
const id = (code: string) => ids.get(code)!;

function expectShape(schema: string, body: unknown): void {
  const validate = contractSchema(schema);
  expect(validate(body), `${schema}: ${JSON.stringify(validate.errors)}`).toBe(true);
}

const v1 = (path: string) => `/v1${path}`;
const get = (path: string) => consoleGet(api.server, manager, v1(path));
const post = (path: string, body: object = {}) => consolePost(api.server, manager, v1(path)).send(body);
const hourAgo = () => new Date(clock.now().getTime() - 3_600_000).toISOString();

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock });
  await runSeedUnits(database.pool('app'), api.app, seedUnits({ SEED_STAFF_PASSWORD: `Seed-${randomUUID()}` }));
  for (const row of (
    await database.pool('admin').query<{ code: string; id: string }>(
      `SELECT 'branch:' || code AS code, id FROM mdm.branch UNION ALL SELECT 'unit:' || identifier, id FROM inv.stock_unit`,
    )
  ).rows) {
    ids.set(row.code, row.id);
  }
  manager = await enrolAndLogin(api.server, await createUser(database, { name: 'Akosua Boateng', grants: [{ role: 'MANAGER', branchId: id('branch:DDW') }] }), () => clock.now());
});

afterAll(async () => {
  await api.close();
  await database.drop();
});

describe('B06 continued operations answer in the contract shapes', () => {
  it('the register, weights, a health check, a mortality report and the empty feed lists', async () => {
    expectShape('AnimalPage', (await get('/animals')).body);
    expectShape('Animal', (await get(`/animals/${id('unit:G-0142')}`)).body);
    const weighed = await post('/weight-records', { records: [{ id: randomUUID(), stockUnitId: id('unit:G-0142'), weightKg: '24.350', weightSource: 'SCALE', measuredAt: hourAgo() }] });
    expect(weighed.status).toBe(200);
    expectShape('WeightRecordBatchResult', weighed.body);
    expectShape('WeightRecordPage', (await get('/weight-records')).body);
    const checked = await post('/health-events', { kind: 'CHECK', stockUnitId: id('unit:G-0144'), costPesewas: 2_500, administeredBy: 'Dr Kofi Ampofo (SEED)', occurredAt: hourAgo() });
    expect(checked.status).toBe(201);
    expectShape('HealthEvent', checked.body);
    expectShape('HealthEvent', (await get(`/health-events/${checked.body.id as string}`)).body);
    expectShape('HealthEventPage', (await get('/health-events')).body);
    const reported = await post('/mortality-records', { kind: 'DEATH', stockUnitId: id('unit:G-0145'), reasonCode: 'INJURY', foundAt: hourAgo() });
    expect(reported.status).toBe(201);
    expectShape('MortalityRecord', reported.body);
    expectShape('MortalityRecordPage', (await get('/mortality-records')).body);
    const submitted = await post(`/mortality-records/${reported.body.id as string}/submit`);
    expect(submitted.status).toBe(422);
    expectShape('Error', submitted.body);
    expectShape('RationPage', (await get('/rations')).body);
    expectShape('FeedConsumptionPage', (await get('/feed-consumption')).body);
  });
});
