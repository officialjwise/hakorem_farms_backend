import { randomUUID } from 'node:crypto';
import { ManualClock, toBusinessDate } from '@hakorem/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { contractSchema } from '../../support/contract-schemas';
import { documentWorker } from '../../support/documents';
import { stepUp, type TotpSession } from '../../support/fin';
import { consoleGet, consolePost, createUser, enrolAndLogin, relaxRateLimits, testStartTime } from '../../support/iam';
import { startTestApp, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/** CST's operations (B12 continued 2) answer in the shapes of contract/openapi.yaml 2.47.0, over the seeded trading day. */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let accountant: TotpSession;
let owner: TotpSession;
let branchId: string;
let today: string;

function expectShape(schema: string, body: unknown): void {
  const validate = contractSchema(schema);
  expect(validate(body), `${schema}: ${JSON.stringify(validate.errors)}`).toBe(true);
}
const get = (path: string) => consoleGet(api.server, accountant, `/v1${path}`);

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock });
  await runSeedUnits(database.pool('app'), api.app, seedUnits({ SEED_STAFF_PASSWORD: `Seed-${randomUUID()}` }, { tradingDay: true }));
  await documentWorker(api, database, clock).settle();
  branchId = (await database.pool('admin').query<{ id: string }>("SELECT id FROM mdm.branch WHERE code = 'DDW'")).rows[0]!.id;
  today = toBusinessDate(clock.now());
  accountant = await enrolAndLogin(api.server, await createUser(database, { name: 'Efua Asante', grants: [{ role: 'ACCOUNTANT', branchId }] }), () => clock.now());
  owner = await enrolAndLogin(api.server, await createUser(database, { name: 'Akua Mensah', grants: [{ role: 'OWNER', branchId }] }), () => clock.now());
});

afterAll(async () => {
  await api.close();
  await database.drop();
});

describe('the CST operations answer in the contract shapes', () => {
  it('margins by every dimension, break-even, losses and a cost object', async () => {
    for (const groupBy of ['PRODUCT', 'PRODUCT_LINE', 'CHANNEL', 'CUSTOMER', 'SALESPERSON', 'BRANCH']) {
      const margins = await get(`/costing/margins?groupBy=${groupBy}&from=2020-01-01&to=${today}`);
      expect(margins.status, JSON.stringify(margins.body)).toBe(200);
      expectShape('MarginReport', margins.body);
    }
    const breakEven = await get(`/costing/break-even?from=2020-01-01&to=${today}`);
    expect(breakEven.status, JSON.stringify(breakEven.body)).toBe(200);
    expectShape('BreakEven', breakEven.body);
    for (const groupBy of ['CAUSE', 'LOCATION', 'HANDLER', 'PRODUCT']) expectShape('LossReport', (await get(`/costing/losses?groupBy=${groupBy}&from=2020-01-01&to=${today}`)).body);
    const unit = (await database.pool('admin').query<{ id: string }>("SELECT object_id AS id FROM cst.cost_object_summary WHERE object_type = 'STOCK_UNIT' ORDER BY object_id LIMIT 1")).rows[0]!.id;
    const cost = await get(`/costing/cost-objects/STOCK_UNIT/${unit}`);
    expect(cost.status, JSON.stringify(cost.body)).toBe(200);
    expectShape('CostObjectSummary', cost.body);
    expectShape('Error', (await get(`/costing/cost-objects/PROCESSING_ORDER/${randomUUID()}`)).body);
    expectShape('Error', (await get(`/costing/margins?groupBy=PRODUCT&from=${today}&to=2099-01-01`)).body);
  });

  it('an allocation run created, listed, read and posted', async () => {
    const created = await consolePost(api.server, accountant, '/v1/costing/overhead-allocations').send({ periodStart: today, periodEnd: today, costElement: 'OVERHEAD', basis: 'HEAD_DAYS', branchId, totalPesewas: 10_001 });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expectShape('OverheadAllocationRun', created.body);
    expectShape('OverheadAllocationRunPage', (await get('/costing/overhead-allocations')).body);
    expectShape('OverheadAllocationRun', (await get(`/costing/overhead-allocations/${created.body.id as string}`)).body);
    await stepUp(api.server, owner, clock);
    const posted = await consolePost(api.server, owner, `/v1/costing/overhead-allocations/${created.body.id as string}/post`).send({});
    expect(posted.status, JSON.stringify(posted.body)).toBe(200);
    expectShape('OverheadAllocationRun', posted.body);
    const again = await consolePost(api.server, owner, `/v1/costing/overhead-allocations/${created.body.id as string}/post`).send({});
    expect(again.status).toBe(422);
    expectShape('Error', again.body);
  });
});
