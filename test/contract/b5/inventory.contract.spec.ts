import { randomUUID } from 'node:crypto';
import { ManualClock } from '@hakorem/kernel';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { contractSchema } from '../../support/contract-schemas';
import { consoleGet, consolePost, createUser, enrolAndLogin, relaxRateLimits, testStartTime, type TestSession } from '../../support/iam';
import { startTestApp, TEST_ORIGIN, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/** The B05 continued operations answer in the shapes of contract/openapi.yaml 1.16.0, over the seeded farm. */
let database: TestDatabase;
let api: TestApp;
let manager: TestSession;
const ids = new Map<string, string>();
const id = (code: string) => ids.get(code)!;

function expectShape(schema: string, body: unknown): void {
  const validate = contractSchema(schema);
  expect(validate(body), `${schema}: ${JSON.stringify(validate.errors)}`).toBe(true);
}

const get = (path: string) => consoleGet(api.server, manager, `/v1${path}`);
const post = (path: string, body: object = {}) => consolePost(api.server, manager, `/v1${path}`).send(body);
const patch = (path: string, body: object) =>
  request(api.server).patch(`/v1${path}`).set('Cookie', manager.jar.header()).set('X-CSRF-Token', manager.csrfToken).set('Origin', TEST_ORIGIN).set('Idempotency-Key', randomUUID()).send(body);

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
       UNION ALL SELECT 'supplier:' || name, id FROM mdm.supplier
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

describe('inventory operations answer in the contract shapes', () => {
  it('goods receipts through their life, and their refusals', async () => {
    const created = await post('/goods-receipts', {
      kind: 'PURCHASE',
      supplierId: id('supplier:Kpone Livestock Traders (SEED)'),
      locationId: id('location:PENS'),
      deliveryNoteRef: 'KLT-0458',
      receivedAt: new Date(Date.now() - 3_600_000).toISOString(),
      lines: [{ productId: id('product:LIV-GOAT'), qtyReceived: '2.000', valuePesewas: 120_000, animals: [{ tagNo: 'G-0150', sex: 'MALE', breed: 'West African Dwarf' }, { tagNo: 'G-0151', sex: 'FEMALE', weightKg: '21.400', weightSource: 'SCALE', dateOfBirth: '2025-12-01' }] }],
    });
    expect(created.status).toBe(201);
    expectShape('GoodsReceipt', created.body);
    expectShape('GoodsReceipt', (await patch(`/goods-receipts/${created.body.id}`, { version: created.body.version, notes: 'Two goats from Kpone' })).body);
    expectShape('GoodsReceipt', (await get(`/goods-receipts/${created.body.id}`)).body);
    expectShape('GoodsReceipt', (await post(`/goods-receipts/${created.body.id}/post`)).body);
    expectShape('GoodsReceiptPage', (await get('/goods-receipts')).body);
    expectShape('GoodsReceiptPage', (await get('/goods-receipts?status=POSTED&from=2026-01-01&to=2030-12-31')).body);
    const draft = await post('/goods-receipts', { kind: 'HARVEST', locationId: id('location:SHOP'), receivedAt: new Date(Date.now() - 3_600_000).toISOString(), lines: [{ productId: id('product:PRD-YAM-TUBER'), qtyReceived: '10.000', valuePesewas: 12_000 }] });
    expectShape('GoodsReceipt', (await post(`/goods-receipts/${draft.body.id}/cancel`, { reason: 'Counted twice' })).body);
    const refused = await post(`/goods-receipts/${draft.body.id}/post`);
    expect(refused.status).toBe(422);
    expectShape('Error', refused.body);
    const invalid = await post('/goods-receipts', { kind: 'PURCHASE', locationId: id('location:PENS'), receivedAt: new Date().toISOString(), lines: [] });
    expect(invalid.status).toBe(422);
    expectShape('Error', invalid.body);
  });

  it('stock on hand, a stock unit and its trace', async () => {
    const onHand = await get(`/stock/on-hand?branchId=${id('branch:DDW')}`);
    expect(onHand.status).toBe(200);
    expectShape('StockOnHandPage', onHand.body);
    expectShape('StockOnHandPage', (await get('/stock/on-hand?includeZero=true&limit=2')).body);
    const unit = await get(`/stock-units/${id('unit:LOT-BEEF-2026-1110')}`);
    expect(unit.status).toBe(200);
    expectShape('StockUnit', unit.body);
    expectShape('StockUnit', (await get(`/stock-units/${id('unit:G-0142')}`)).body);
    const trace = await get(`/stock-units/${id('unit:G-0142')}/trace`);
    expect(trace.status).toBe(200);
    expectShape('StockTrace', trace.body);
    const missing = await get(`/stock-units/${randomUUID()}`);
    expect(missing.status).toBe(404);
    expectShape('Error', missing.body);
  });
});
