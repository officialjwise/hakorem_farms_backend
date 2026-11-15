import { randomUUID } from 'node:crypto';
import { ManualClock } from '@hakorem/kernel';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { contractSchema } from '../../support/contract-schemas';
import { consoleGet, createUser, enrolAndLogin, relaxRateLimits, testStartTime, type TestSession } from '../../support/iam';
import { startTestApp, TEST_ORIGIN, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/** The B05x operations answer in the shapes of contract/openapi.yaml 1.21.0, over the seeded farm. */
let database: TestDatabase;
let api: TestApp;
let owner: TestSession;
const ids = new Map<string, string>();
const id = (code: string) => ids.get(code)!;

function expectShape(schema: string, body: unknown): void {
  const validate = contractSchema(schema);
  expect(validate(body), `${schema}: ${JSON.stringify(validate.errors)}`).toBe(true);
}

const get = (path: string) => consoleGet(api.server, owner, `/v1${path}`);

beforeAll(async () => {
  database = await createTestDatabase();
  const clock = new ManualClock(testStartTime());
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock });
  await runSeedUnits(database.pool('app'), api.app, seedUnits({ SEED_STAFF_PASSWORD: `Seed-${randomUUID()}` }));
  for (const row of (
    await database.pool('admin').query<{ code: string; id: string }>(
      `SELECT 'branch:' || code AS code, id FROM mdm.branch
       UNION ALL SELECT 'product:' || sku, id FROM mdm.product
       UNION ALL SELECT 'unit:' || identifier, id FROM inv.stock_unit`,
    )
  ).rows) {
    ids.set(row.code, row.id);
  }
  owner = await enrolAndLogin(api.server, await createUser(database, { name: 'Ama Owusu', grants: [{ role: 'OWNER', branchId: id('branch:DDW') }] }), () => clock.now());
});

afterAll(async () => {
  await api.close();
  await database.drop();
});

describe('B05x operations answer in the contract shapes', () => {
  it('the owner dashboard and the four live tiles', async () => {
    expectShape('OwnerDashboard', (await get('/dashboard/owner')).body);
    expectShape('OwnerDashboard', (await get(`/dashboard/owner?branchId=${id('branch:DDW')}&period=MONTH&date=2026-11-10`)).body);
    expectShape('StockValueTile', (await get('/dashboard/tiles/stock-value')).body);
    expectShape('AnimalsOnHandTile', (await get('/dashboard/tiles/animals-on-hand')).body);
    expectShape('LowStockTile', (await get('/dashboard/tiles/low-stock')).body);
    expectShape('PurchasesSeriesTile', (await get('/dashboard/tiles/purchases?from=2026-11-01&to=2026-11-10')).body);
    const refused = await get('/dashboard/tiles/purchases?from=2026-11-10&to=2026-11-01');
    expect(refused.status).toBe(422);
    expectShape('Error', refused.body);
  });

  it('lot, animal and product labels', async () => {
    expectShape('StockUnitLabel', (await get(`/stock-units/${id('unit:LOT-BEEF-2026-1110')}/label`)).body);
    expectShape('StockUnitLabel', (await get(`/stock-units/${id('unit:G-0143')}/label`)).body);
    expectShape('ProductLabel', (await get(`/products/${id('product:EGG-CRATE-BIG')}/label`)).body);
  });

  it('the scoped branch and location lists, and a refused closing', async () => {
    expectShape('BranchPage', (await get('/branches')).body);
    expectShape('LocationPage', (await get('/locations?includeVirtual=true')).body);
    const ddw = (await get(`/branches/${id('branch:DDW')}`)).body as { version: number };
    const refused = await request(api.server)
      .patch(`/v1/branches/${id('branch:DDW')}`)
      .set('Cookie', owner.jar.header())
      .set('X-CSRF-Token', owner.csrfToken)
      .set('Origin', TEST_ORIGIN)
      .set('Idempotency-Key', randomUUID())
      .send({ version: ddw.version, status: 'CLOSED' });
    expect(refused.status).toBe(422);
    expect(refused.body.error.code).toBe('BRANCH_INVALID');
    expectShape('Error', refused.body);
  });
});
