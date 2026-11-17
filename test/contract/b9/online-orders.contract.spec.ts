import { randomUUID } from 'node:crypto';
import { ManualClock } from '@hakorem/kernel';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { contractSchema } from '../../support/contract-schemas';
import { PAYSTACK_MTN_TEST_PHONE, paystackEnvironment, startFakePaystack, type FakePaystack } from '../../support/fake-paystack';
import { consoleGet, consolePost, createUser, login, relaxRateLimits, SYSTEM_PRINCIPAL, testStartTime, type TestSession } from '../../support/iam';
import { startTestApp, TEST_ORIGIN, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/** placeOrder, trackOrder, listMyOrders and getMyOrder (B09a continued 2f) answer in the contract shapes. */
let database: TestDatabase;
let api: TestApp;
let fake: FakePaystack;
let customer: TestSession;
let sales: TestSession;
let eggs: string;
let tema: string;

function expectShape(schema: string, body: unknown): void {
  const validate = contractSchema(schema);
  expect(validate(body), `${schema}: ${JSON.stringify(validate.errors)}`).toBe(true);
}

beforeAll(async () => {
  database = await createTestDatabase();
  const clock = new ManualClock(testStartTime());
  await relaxRateLimits(database);
  for (const key of ['rate_limit.public.per_address_1m', 'rate_limit.checkout.per_address_10m']) {
    await database.pool('app').query(
      `INSERT INTO platform.setting (id, key, value, value_type, valid_from, description, created_by, updated_by)
       VALUES ($1, $2, '100000', 'INTEGER', now() - interval '1 day', 'Raised for a test file', $3, $3)`,
      [randomUUID(), key, SYSTEM_PRINCIPAL],
    );
  }
  fake = await startFakePaystack(() => clock.now());
  api = await startTestApp(database, { clock, environment: { ...paystackEnvironment(fake), AUTH_ACCESS_TTL_SECONDS: '172800' } });
  await runSeedUnits(database.pool('app'), api.app, seedUnits({ SEED_STAFF_PASSWORD: `Seed-${randomUUID()}` }));
  const admin = database.pool('admin');
  const branchId = (await admin.query<{ id: string }>("SELECT id FROM mdm.branch WHERE code = 'DDW'")).rows[0]!.id;
  eggs = (await admin.query<{ id: string }>("SELECT id FROM mdm.product WHERE sku = 'EGG-0003'")).rows[0]!.id;
  tema = (await admin.query<{ id: string }>("SELECT id FROM mdm.customer WHERE name = 'Tema Cold Store Ltd (SEED)'")).rows[0]!.id;
  sales = await login(api.server, await createUser(database, { name: 'Kojo Antwi', grants: [{ role: 'SALES', branchId }] }));
  const user = await createUser(database, { name: 'Esi Asante', realm: 'CUSTOMER' });
  await admin.query('UPDATE mdm.customer SET principal_id = $1, version = version + 1 WHERE id = $2', [user.principalId, tema]);
  customer = await login(api.server, user);
});

afterAll(async () => {
  await api?.close();
  await fake?.close();
  await database?.drop();
});

describe('B09a continued 2f online order operations answer in the contract shapes', () => {
  it('a placed order, its tracking, a customer’s list and order, and the refusals', async () => {
    const created = await request(api.server).post('/v1/shop/carts').set('Origin', TEST_ORIGIN).set('Idempotency-Key', randomUUID());
    const cookie = (created.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('__Host-hk_guest='))!.split(';')[0]!;
    const guestWrite = (path: string, body: object) => request(api.server).post(`/v1${path}`).set('Origin', TEST_ORIGIN).set('Idempotency-Key', randomUUID()).set('Cookie', cookie).send(body);
    expect((await guestWrite(`/shop/carts/${created.body.id as string}/lines`, { productId: eggs, quantity: '2.000' })).status).toBe(200);
    const started = await guestWrite(`/shop/carts/${created.body.id as string}/checkout`, { contactName: 'Ama Serwaa Ofori', contactPhone: '+233244512876', fulfilmentMode: 'COLLECTION', paymentTerms: 'PREPAID' });
    const refused = await guestWrite(`/shop/checkouts/${started.body.id as string}/place`, { paymentMethod: 'CARD' });
    expect(refused.status).toBe(422);
    expectShape('Error', refused.body);
    const placed = await guestWrite(`/shop/checkouts/${started.body.id as string}/place`, { paymentMethod: 'MOBILE_MONEY', payerPhone: PAYSTACK_MTN_TEST_PHONE, network: 'MTN' });
    expect(placed.status).toBe(201);
    expectShape('PlaceOrderResult', placed.body);
    const closed = await guestWrite(`/shop/checkouts/${started.body.id as string}/place`, { paymentMethod: 'MOBILE_MONEY', payerPhone: PAYSTACK_MTN_TEST_PHONE, network: 'MTN' });
    expect(closed.status).toBe(409);
    expectShape('Error', closed.body);

    const tracked = await request(api.server).get(`/v1/shop/orders/track/${placed.body.trackingToken as string}`);
    expect(tracked.status).toBe(200);
    expectShape('OrderTracking', tracked.body);
    const unknown = await request(api.server).get('/v1/shop/orders/track/trk_nothing');
    expect(unknown.status).toBe(404);
    expectShape('Error', unknown.body);

    const entered = await consolePost(api.server, sales, '/v1/orders').send({ channel: 'ONLINE', customerId: tema, fulfilmentMode: 'COLLECTION', paymentTerms: 'COD', lines: [{ productId: eggs, quantity: '1.000' }] });
    expect(entered.status).toBe(201);
    const listed = await consoleGet(api.server, customer, '/v1/me/orders');
    expect(listed.status).toBe(200);
    expectShape('CustomerOrderSummaryPage', listed.body);
    const mine = await consoleGet(api.server, customer, `/v1/me/orders/${entered.body.id as string}`);
    expect(mine.status).toBe(200);
    expectShape('CustomerOrder', mine.body);
    const theirs = await consoleGet(api.server, customer, `/v1/me/orders/${placed.body.orderId as string}`);
    expect(theirs.status).toBe(404);
    expectShape('Error', theirs.body);
  });
});
