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

/** The B05 continued to B05 continued 3 operations answer in the shapes of contract/openapi.yaml 1.18.0, over the seeded farm. */
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

  it('movements, a reversal, a transfer and an adjustment through their lives, and their refusals', async () => {
    expectShape('MovementTypePage', (await get('/stock/movement-types?limit=5')).body);
    const movements = await get('/stock/movements?limit=3');
    expectShape('StockMovementPage', movements.body);
    expectShape('StockMovementPage', (await get(`/stock-units/${id('unit:G-0142')}/movements`)).body);
    expectShape('StockMovement', (await get(`/stock/movements/${movements.body.data[0].id as string}`)).body);

    const transfer = await post('/stock-transfers', {
      fromLocationId: id('location:COLD'),
      toLocationId: id('location:SHOP'),
      lines: [{ productId: id('product:MEAT-GOAT-15KG'), stockUnitId: id('unit:LOT-GOAT-0001'), qty: '5.000' }],
    });
    expect(transfer.status).toBe(201);
    expectShape('StockTransfer', transfer.body);
    expectShape('StockTransfer', (await post(`/stock-transfers/${transfer.body.id as string}/dispatch`)).body);
    const received = await post(`/stock-transfers/${transfer.body.id as string}/receive`, { lines: [{ lineId: transfer.body.lines[0].id, qtyReceived: '4.900', varianceReasonCode: 'DAMAGED' }] });
    expect(received.status).toBe(200);
    expectShape('StockTransfer', received.body);
    expectShape('StockTransfer', (await get(`/stock-transfers/${transfer.body.id as string}`)).body);
    expectShape('StockTransferPage', (await get('/stock-transfers?status=RECEIVED')).body);
    const unbalanced = await post(`/stock-transfers/${transfer.body.id as string}/receive`, { lines: [] });
    expect(unbalanced.status).toBe(422);
    expectShape('Error', unbalanced.body);
    const draft = await post('/stock-transfers', { fromLocationId: id('location:COLD'), toLocationId: id('location:SHOP'), lines: [{ productId: id('product:MEAT-GOAT-15KG'), stockUnitId: id('unit:LOT-GOAT-0001'), qty: '1.000' }] });
    expectShape('StockTransfer', (await post(`/stock-transfers/${draft.body.id as string}/cancel`, { reason: 'Van not available' })).body);

    const small = await post('/stock-adjustments', {
      locationId: id('location:SHOP'),
      reasonCode: 'DAMAGED',
      note: 'Two tubers crushed',
      lines: [{ productId: id('product:PRD-YAM-TUBER'), direction: 'LOSS', qty: '2.000' }],
    });
    expect(small.status).toBe(201);
    expectShape('StockAdjustment', small.body);
    const posted = await post(`/stock-adjustments/${small.body.id as string}/submit`);
    expect(posted.status).toBe(200);
    expectShape('StockAdjustment', posted.body);
    const large = await post('/stock-adjustments', {
      locationId: id('location:COLD'),
      reasonCode: 'COLD_CHAIN_FAILURE',
      note: 'Freezer failed overnight',
      lines: [{ productId: id('product:MEAT-BEEF-15KG'), stockUnitId: id('unit:LOT-BEEF-2026-1110'), direction: 'LOSS', qty: '10.000', weightKg: '10.000' }],
    });
    const pending = await post(`/stock-adjustments/${large.body.id as string}/submit`);
    expect(pending.status).toBe(202);
    expectShape('ApprovalPending', pending.body);
    expectShape('StockAdjustment', (await get(`/stock-adjustments/${large.body.id as string}`)).body);
    expectShape('StockAdjustmentPage', (await get('/stock-adjustments')).body);
    const invalid = await post('/stock-adjustments', { locationId: id('location:SHOP'), reasonCode: 'REGULAR_CUSTOMER', lines: [] });
    expect(invalid.status).toBe(422);
    expectShape('Error', invalid.body);

    const reversed = await post(`/stock/movements/${posted.body.lines[0].movementId as string}/reverse`, { reasonCode: 'COUNT_ERROR', note: 'The tubers were fine' });
    expect(reversed.status).toBe(201);
    expectShape('StockMovement', reversed.body);
    const twice = await post(`/stock/movements/${posted.body.lines[0].movementId as string}/reverse`, { reasonCode: 'COUNT_ERROR', note: 'Again' });
    expect(twice.status).toBe(422);
    expectShape('Error', twice.body);
  });

  it('a stock take through its life, its variance report and its refusals', async () => {
    const created = await post('/stock-takes', { locationId: id('location:SHOP'), scope: 'CYCLE', productIds: [id('product:PRD-CABBAGE-HEAD')] });
    expect(created.status).toBe(201);
    expectShape('StockTake', created.body);
    const takeId = created.body.id as string;
    expectShape('StockTake', (await post(`/stock-takes/${takeId}/start`)).body);
    const blind = await get(`/stock-takes/${takeId}/lines`);
    expectShape('StockTakeLinePage', blind.body);
    const lineId = blind.body.data[0].id as string;
    const counted = await consolePut(api.server, manager, `/v1/stock-takes/${takeId}/counts`).send({ counts: [{ lineId, countedQty: '24.000' }] });
    expect(counted.status).toBe(200);
    expectShape('StockTake', counted.body);
    expectShape('StockTake', (await post(`/stock-takes/${takeId}/review`)).body);
    expectShape('StockTakeLinePage', (await get(`/stock-takes/${takeId}/lines`)).body);
    const early = await post(`/stock-takes/${takeId}/submit`);
    expect(early.status).toBe(422);
    expectShape('Error', early.body);
    await consolePut(api.server, manager, `/v1/stock-takes/${takeId}/counts`).send({ counts: [{ lineId, countedQty: '24.000', isRecount: true }] });
    const posted = await post(`/stock-takes/${takeId}/submit`);
    expect(posted.status).toBe(200);
    expectShape('StockTake', posted.body);
    expectShape('StockTake', (await get(`/stock-takes/${takeId}`)).body);
    expectShape('StockTakePage', (await get('/stock-takes?status=POSTED')).body);
    const other = await post('/stock-takes', { locationId: id('location:SHOP'), scope: 'FULL' });
    expectShape('StockTake', (await post(`/stock-takes/${other.body.id as string}/cancel`, { reason: 'Planned for the wrong day' })).body);
    const refused = await post('/stock-takes', { locationId: id('location:SHOP'), scope: 'CYCLE' });
    expect(refused.status).toBe(422);
    expectShape('Error', refused.body);
  });
});
