import { randomUUID } from 'node:crypto';
import { ManualClock } from '@hakorem/kernel';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { contractSchema } from '../../support/contract-schemas';
import { consoleGet, consolePost, createUser, enrolAndLogin, login, relaxRateLimits, testStartTime, type TestSession } from '../../support/iam';
import { startTestApp, TEST_ORIGIN, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/** B11 continued: a dispatch, the delivery it makes, the driver's view and the proof with its cash, in the shapes of 2.27.0. */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
const sessions = new Map<string, TestSession>();
const ids = new Map<string, string>();
const id = (name: string) => ids.get(name)!;
const post = (who: string, path: string, body: object) => consolePost(api.server, sessions.get(who)!, `/v1${path}`).send(body);
const get = (who: string, path: string) => consoleGet(api.server, sessions.get(who)!, `/v1${path}`);

function expectShape(schema: string, body: unknown): void {
  const validate = contractSchema(schema);
  expect(validate(body), `${schema}: ${JSON.stringify(validate.errors)}`).toBe(true);
}

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  await relaxRateLimits(database);
  for (const key of ['rate_limit.public.per_address_1m', 'rate_limit.checkout.per_address_10m']) {
    await database.pool('app').query(
      `INSERT INTO platform.setting (id, key, value, value_type, valid_from, description, created_by, updated_by)
       VALUES ($1, $2, '100000', 'INTEGER', now() - interval '1 day', 'Raised for a test file', '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001')`,
      [randomUUID(), key],
    );
  }
  api = await startTestApp(database, { clock, environment: { AUTH_ACCESS_TTL_SECONDS: '43200' } });
  await runSeedUnits(database.pool('app'), api.app, seedUnits({ SEED_STAFF_PASSWORD: `Seed-${randomUUID()}` }));
  const admin = database.pool('admin');
  const branchId = (await admin.query<{ id: string }>("SELECT id FROM mdm.branch WHERE code = 'DDW'")).rows[0]!.id;
  ids.set('eggs', (await admin.query<{ id: string }>("SELECT id FROM mdm.product WHERE sku = 'EGG-0003'")).rows[0]!.id);
  ids.set('lot', (await admin.query<{ id: string }>("SELECT u.id FROM inv.stock_unit u JOIN mdm.product p ON p.id = u.product_id WHERE p.sku = 'EGG-0003' AND u.tracking = 'LOT'")).rows[0]!.id);
  for (const code of ['SHOP', 'VAN1']) ids.set(code, (await admin.query<{ id: string }>('SELECT id FROM mdm.location WHERE branch_id = $1 AND code = $2', [branchId, code])).rows[0]!.id);
  sessions.set('storekeeper', await login(api.server, await createUser(database, { name: 'Yaw Boateng', grants: [{ role: 'STOREKEEPER', branchId }] })));
  const driver = await createUser(database, { name: 'Kwabena Asare', grants: [{ role: 'DRIVER', branchId }] });
  ids.set('driver', driver.principalId);
  sessions.set('driver', await login(api.server, driver));
  sessions.set('manager', await enrolAndLogin(api.server, await createUser(database, { name: 'Abena Owusu', grants: [{ role: 'MANAGER', branchId }] }), () => clock.now()));
});

afterAll(async () => {
  await api?.close();
  await database?.drop();
});

describe('dispatch, the delivery and the proof of delivery (2.27.0)', () => {
  it('answers dispatchFulfilment, listDeliveries, getDelivery, getMyDelivery, recordProofOfDelivery and the order in their contract shapes', async () => {
    const cart = await request(api.server).post('/v1/shop/carts').set('Origin', TEST_ORIGIN).set('Idempotency-Key', randomUUID());
    const cookie = (cart.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('__Host-hk_guest='))!.split(';')[0]!;
    const guest = (path: string, body: object) => request(api.server).post(`/v1${path}`).set('Origin', TEST_ORIGIN).set('Idempotency-Key', randomUUID()).set('Cookie', cookie).send(body);
    expect((await guest(`/shop/carts/${cart.body.id as string}/lines`, { productId: id('eggs'), quantity: '1.000' })).status).toBe(200);
    const address = { recipientName: 'Ama Serwaa Ofori', recipientPhone: '0244512876', line1: 'Two houses after the Presby church', area: 'Dodowa', city: 'Dodowa', region: 'Greater Accra' };
    const started = await guest(`/shop/carts/${cart.body.id as string}/checkout`, { contactName: 'Kofi Boateng', contactPhone: '0201234567', fulfilmentMode: 'DELIVERY', address, paymentTerms: 'COD' });
    const placed = await guest(`/shop/checkouts/${started.body.id as string}/place`, { paymentMethod: 'COD' });
    expect(placed.status, JSON.stringify(placed.body)).toBe(201);
    const orderId = placed.body.orderId as string;
    const made = await post('storekeeper', `/orders/${orderId}/fulfilments`, { pickLocationId: id('SHOP') });
    const lineId = (await get('manager', `/orders/${orderId}`)).body.lines[0].id as string;
    expect((await post('storekeeper', `/fulfilments/${made.body.id as string}/picks`, { picks: [{ id: randomUUID(), orderLineId: lineId, stockUnitId: id('lot'), qty: '1.000' }] })).status).toBe(200);
    expect((await post('storekeeper', `/fulfilments/${made.body.id as string}/pack`, { packageCount: 1 })).status).toBe(200);

    const sent = await post('manager', `/fulfilments/${made.body.id as string}/dispatch`, { driverId: id('driver'), vehicleLocationId: id('VAN1') });
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    expectShape('Fulfilment', sent.body);
    const order = await get('manager', `/orders/${orderId}`);
    expectShape('SalesOrder', order.body);
    const page = await get('manager', `/deliveries?orderId=${orderId}`);
    expectShape('DeliveryPage', page.body);
    const deliveryId = page.body.data[0].id as string;
    expectShape('Delivery', (await get('manager', `/deliveries/${deliveryId}`)).body);
    const mine = await get('driver', `/driver/deliveries/${deliveryId}`);
    expectShape('Delivery', mine.body);
    const photo = await consolePost(api.server, sessions.get('driver')!, '/v1/files').field('purpose', 'PROOF_OF_DELIVERY').attach('file', Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(1_020, 7)]), 'door.jpg');
    expect(photo.status).toBe(201);
    const refused = await post('driver', `/driver/deliveries/${deliveryId}/proof`, { id: randomUUID(), recipientName: 'Ama Serwaa Ofori', codCollectedPesewas: 0, capturedAt: clock.now().toISOString() });
    expect(refused.status).toBe(422);
    expectShape('Error', refused.body);
    const done = await post('driver', `/driver/deliveries/${deliveryId}/proof`, { id: randomUUID(), recipientName: 'Ama Serwaa Ofori', photoFileId: photo.body.id, codCollectedPesewas: mine.body.codDuePesewas, capturedAt: clock.now().toISOString() });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expectShape('Delivery', done.body);
    expectShape('SalesOrder', (await get('manager', `/orders/${orderId}`)).body);
  });
});
