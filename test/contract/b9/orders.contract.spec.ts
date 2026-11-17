import { randomUUID } from 'node:crypto';
import { ManualClock } from '@hakorem/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { contractSchema } from '../../support/contract-schemas';
import { consoleGet, consolePost, createUser, login, relaxRateLimits, testStartTime, type TestSession } from '../../support/iam';
import { startTestApp, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/** The order record's operations (B09a continued 2b) answer in the shapes of contract/openapi.yaml, refusals included. */
let database: TestDatabase;
let api: TestApp;
let sales: TestSession;
let storekeeper: TestSession;
let tema: string;
let eggs: string;
let cabbage: string;

function expectShape(schema: string, body: unknown): void {
  const validate = contractSchema(schema);
  expect(validate(body), `${schema}: ${JSON.stringify(validate.errors)}`).toBe(true);
}

beforeAll(async () => {
  database = await createTestDatabase();
  const clock = new ManualClock(testStartTime());
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock });
  await runSeedUnits(database.pool('app'), api.app, seedUnits({ SEED_STAFF_PASSWORD: `Seed-${randomUUID()}` }));
  const admin = database.pool('admin');
  const branchId = (await admin.query<{ id: string }>("SELECT id FROM mdm.branch WHERE code = 'DDW'")).rows[0]!.id;
  tema = (await admin.query<{ id: string }>('SELECT id FROM mdm.customer WHERE name = $1', ['Tema Cold Store Ltd (SEED)'])).rows[0]!.id;
  eggs = (await admin.query<{ id: string }>("SELECT id FROM mdm.product WHERE sku = 'EGG-CRATE-BIG'")).rows[0]!.id;
  cabbage = (await admin.query<{ id: string }>("SELECT id FROM mdm.product WHERE sku = 'PRD-CABBAGE-HEAD'")).rows[0]!.id;
  sales = await login(api.server, await createUser(database, { name: 'Kojo Antwi', grants: [{ role: 'SALES', branchId }] }));
  storekeeper = await login(api.server, await createUser(database, { name: 'Yaw Asante', grants: [{ role: 'STOREKEEPER', branchId }] }));
});

afterAll(async () => {
  await api?.close();
  await database?.drop();
});

describe('B09a continued 2b order operations answer in the contract shapes', () => {
  it('an order entered, confirmed, read, listed and its history, and every refusal', async () => {
    const body = { channel: 'WHOLESALE', customerId: tema, fulfilmentMode: 'COLLECTION', paymentTerms: 'COD', lines: [{ productId: eggs, quantity: '2.000' }, { productId: cabbage, quantity: '3.000', agreedUnitPricePesewas: 1_100, varianceReasonCode: 'BULK_PURCHASE' }] };
    const created = await consolePost(api.server, sales, '/v1/orders').send(body);
    expect(created.status).toBe(201);
    expectShape('SalesOrder', created.body);
    const confirmed = await consolePost(api.server, sales, `/v1/orders/${created.body.id as string}/confirm`).send();
    expect(confirmed.status).toBe(200);
    expectShape('SalesOrder', confirmed.body);
    expectShape('SalesOrder', (await consoleGet(api.server, sales, `/v1/orders/${created.body.id as string}`)).body);
    expectShape('SalesOrderPage', (await consoleGet(api.server, sales, '/v1/orders?limit=5')).body);
    expectShape('OrderStatusChangePage', (await consoleGet(api.server, sales, `/v1/orders/${created.body.id as string}/history`)).body);

    const refusals = [
      await consolePost(api.server, sales, '/v1/orders').send({ ...body, fulfilmentMode: 'DELIVERY' }),
      await consolePost(api.server, sales, '/v1/orders').send({ ...body, lines: [{ productId: cabbage, quantity: '2.000', agreedUnitPricePesewas: 700, varianceReasonCode: 'BULK_PURCHASE' }] }),
      await consolePost(api.server, sales, `/v1/orders/${created.body.id as string}/confirm`).send(),
      await consolePost(api.server, storekeeper, '/v1/orders').send(body),
      await consoleGet(api.server, sales, `/v1/orders/${randomUUID()}`),
      await consolePost(api.server, sales, '/v1/orders').send({ ...body, lines: [{ productId: eggs, quantity: '2' }] }),
    ];
    expect(refusals.map((r) => [r.status, r.body.error.code])).toEqual([
      [422, 'ORDER_INVALID'],
      [422, 'PRICE_OVERRIDE_NEEDS_APPROVAL'],
      [422, 'INVALID_STATE_TRANSITION'],
      [403, 'FORBIDDEN'],
      [404, 'NOT_FOUND'],
      [400, 'VALIDATION_FAILED'],
    ]);
    for (const refusal of refusals) expectShape('Error', refusal.body);

    const placed = await consolePost(api.server, sales, '/v1/orders').send({ ...body, lines: [{ productId: cabbage, quantity: '99.000' }] });
    const short = await consolePost(api.server, sales, `/v1/orders/${placed.body.id as string}/confirm`).send();
    expect([short.status, short.body.error.code]).toEqual([422, 'STOCK_UNAVAILABLE']);
    expectShape('Error', short.body);
  });
});
