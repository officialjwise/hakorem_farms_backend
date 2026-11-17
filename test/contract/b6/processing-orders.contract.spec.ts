import { randomUUID } from 'node:crypto';
import { ManualClock } from '@hakorem/kernel';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { contractSchema } from '../../support/contract-schemas';
import { consoleGet, consolePost, consolePut, createUser, enrolAndLogin, relaxRateLimits, testStartTime, type TestSession } from '../../support/iam';
import { startTestApp, TEST_ORIGIN, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/** The B6 processing operations answer in the shapes of contract/openapi.yaml 1.22.0, over the seeded farm. */
let database: TestDatabase;
let api: TestApp;
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
const put = (path: string, body: object) => consolePut(api.server, manager, v1(path)).send(body);
const patch = (path: string, body: object) =>
  request(api.server).patch(v1(path)).set('Cookie', manager.jar.header()).set('X-CSRF-Token', manager.csrfToken).set('Origin', TEST_ORIGIN).set('Idempotency-Key', randomUUID()).send(body);

beforeAll(async () => {
  database = await createTestDatabase();
  const clock = new ManualClock(testStartTime());
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock });
  await runSeedUnits(database.pool('app'), api.app, seedUnits({ SEED_STAFF_PASSWORD: `Seed-${randomUUID()}` }));
  for (const row of (
    await database.pool('admin').query<{ code: string; id: string }>(
      `SELECT 'branch:' || code AS code, id FROM mdm.branch
       UNION ALL SELECT 'location:' || l.code, l.id FROM mdm.location l JOIN mdm.branch b ON b.id = l.branch_id WHERE b.code = 'DDW'
       UNION ALL SELECT 'product:' || sku, id FROM mdm.product
       UNION ALL SELECT 'unit:' || identifier, id FROM inv.stock_unit`,
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

describe('B6 operations answer in the contract shapes', () => {
  it('a processing order through every status, and its refusals', async () => {
    const input = (tag: string) => ({ locationId: id('location:PENS'), outputLocationId: id('location:COLD'), inputs: [{ stockUnitId: id(`unit:${tag}`), weightKg: '28.000', weightSource: 'SCALE' }] });
    const planned = await post('/processing-orders', input('G-0142'));
    expect(planned.status).toBe(201);
    expectShape('ProcessingOrder', planned.body);
    const orderId = planned.body.id as string;
    expectShape('ProcessingOrder', (await patch(`/processing-orders/${orderId}`, { version: planned.body.version, outputLocationId: id('location:COLD') })).body);
    expectShape('ProcessingOrder', (await post(`/processing-orders/${orderId}/costs`, { costKind: 'LABOUR', amountPesewas: 4_000, description: 'Slaughter and dressing, two hands' })).body);
    const started = await post(`/processing-orders/${orderId}/start`);
    expectShape('ProcessingOrder', started.body);
    const recorded = await put(`/processing-orders/${orderId}/outputs`, {
      version: started.body.version,
      outputs: [
        { productId: id('product:MEAT-0007'), outputKind: 'MEAT', weightKg: '13.400', weightSource: 'SCALE', packCount: 1 },
        { productId: id('product:MEAT-0008'), outputKind: 'OFFAL', weightKg: '3.100', weightSource: 'SCALE' },
        { productId: id('product:MEAT-0008'), outputKind: 'WASTE', weightKg: '9.000', weightSource: 'MANUAL' },
      ],
    });
    expectShape('ProcessingOrder', recorded.body);
    const completed = await post(`/processing-orders/${orderId}/complete`);
    expect(completed.status).toBe(200);
    expectShape('ProcessingOrder', completed.body);
    expectShape('ProcessingOrder', (await get(`/processing-orders/${orderId}`)).body);
    expectShape('ProcessingOrderPage', (await get('/processing-orders?status=COMPLETED&limit=5')).body);

    const other = await post('/processing-orders', input('G-0143'));
    const cancelled = await post(`/processing-orders/${other.body.id}/cancel`, { reason: 'Buyer wants the goat live' });
    expectShape('ProcessingOrder', cancelled.body);

    const refused = await post('/processing-orders', input('G-0142'));
    expect(refused.status).toBe(422);
    expectShape('Error', refused.body);
    const again = await post(`/processing-orders/${orderId}/complete`);
    expect(again.status).toBe(422);
    expectShape('Error', again.body);
  });

  it('yield standards, and a refused duplicate', async () => {
    const page = await get('/yield-standards');
    expectShape('YieldStandardPage', page.body);
    const standard = page.body.data[0];
    expectShape('YieldStandard', (await patch(`/yield-standards/${standard.id}`, { version: standard.version, tolerancePercent: '6' })).body);
    const created = await post('/yield-standards', { inputProductId: id('product:LIV-0005'), outputProductId: id('product:MEAT-0008'), expectedPercent: '9.5' });
    expect(created.status).toBe(201);
    expectShape('YieldStandard', created.body);
    const duplicate = await post('/yield-standards', { inputProductId: id('product:LIV-0005'), outputProductId: id('product:MEAT-0008'), expectedPercent: '9.5' });
    expect(duplicate.status).toBe(422);
    expectShape('Error', duplicate.body);
  });
});
