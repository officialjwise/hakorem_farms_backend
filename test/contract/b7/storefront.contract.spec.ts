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

/**
 * B07 continued 2's responses against the committed contract (FR-SHP-001 to FR-SHP-008, FR-DEL-001): the catalogue,
 * product page and categories expose only public fields; a cart, a checkout and the slot lists match their schemas.
 */
let database: TestDatabase;
let api: TestApp;
let manager: TestSession;
const ids = new Map<string, string>();

function conforms(schema: string, body: unknown): void {
  const validate = contractSchema(schema);
  expect(validate(body), `${schema}: ${JSON.stringify(validate.errors)}`).toBe(true);
}

beforeAll(async () => {
  database = await createTestDatabase();
  const clock = new ManualClock(testStartTime());
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock });
  await runSeedUnits(database.pool('app'), api.app, seedUnits({ SEED_STAFF_PASSWORD: `Seed-${randomUUID()}` }));
  for (const row of (await database.pool('admin').query<{ code: string; id: string }>("SELECT 'product:' || sku AS code, id FROM mdm.product UNION ALL SELECT 'zone:' || code, id FROM mdm.delivery_zone UNION ALL SELECT 'branch:' || code, id FROM mdm.branch")).rows) {
    ids.set(row.code, row.id);
  }
  manager = await enrolAndLogin(api.server, await createUser(database, { name: 'Akosua Boateng', grants: [{ role: 'MANAGER', branchId: ids.get('branch:DDW')! }] }), () => clock.now());
});

afterAll(async () => {
  await api.close();
  await database.drop();
});

describe('the storefront in the contract (FR-SHP-001 to FR-SHP-008)', () => {
  it('exposes only public fields: the catalogue, a product page and the categories', async () => {
    const page = await request(api.server).get('/v1/shop/catalogue?limit=100');
    conforms('CataloguePage', page.body);
    expect(JSON.stringify(page.body)).not.toMatch(/cost|floor|ceiling|onHand|reserved/i);
    conforms('ProductDetail', (await request(api.server).get('/v1/shop/products/beef-15-kg-pack')).body);
    conforms('ProductDetail', (await request(api.server).get('/v1/shop/products/goat')).body);
    conforms('ShopCategoryPage', (await request(api.server).get('/v1/shop/categories')).body);
  });

  it('answers a cart and a checkout in their shapes, and the slot lists in theirs', async () => {
    const created = await request(api.server).post('/v1/shop/carts').set('Origin', TEST_ORIGIN).set('Idempotency-Key', randomUUID());
    conforms('Cart', created.body);
    const cookie = (created.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!;
    const send = (method: 'post' | 'put', path: string, body: object) => request(api.server)[method](`/v1${path}`).set('Origin', TEST_ORIGIN).set('Idempotency-Key', randomUUID()).set('Cookie', cookie).send(body);
    await send('post', `/shop/carts/${created.body.id}/lines`, { productId: ids.get('product:EGG-CRATE-BIG'), quantity: '2.000' });
    const withBeef = await send('post', `/shop/carts/${created.body.id}/lines`, { productId: ids.get('product:MEAT-BEEF-15KG'), quantity: '1.000' });
    conforms('Cart', withBeef.body);
    conforms('Cart', (await send('put', `/shop/carts/${created.body.id}/coupon`, { code: 'WELCOME10' })).body);
    const options = await request(api.server).get(`/v1/shop/delivery/slots?zoneId=${ids.get('zone:DODOWA')}`);
    conforms('SlotOptionPage', options.body);
    const started = await send('post', `/shop/carts/${created.body.id}/checkout`, {
      contactName: 'Ama Serwaa Ofori',
      contactPhone: '+233244512876',
      fulfilmentMode: 'DELIVERY',
      address: { recipientName: 'Ama Serwaa Ofori', recipientPhone: '+233244512876', line1: 'Two houses after the Presby church', area: 'Dodowa', city: 'Dodowa', region: 'Greater Accra' },
      deliverySlotId: options.body.data[0].id,
      paymentTerms: 'PREPAID',
    });
    expect(started.status).toBe(201);
    conforms('Checkout', started.body);
    conforms('Checkout', (await request(api.server).get(`/v1/shop/checkouts/${started.body.id}`).set('Cookie', cookie)).body);
    conforms('DeliverySlotPage', (await consoleGet(api.server, manager, '/v1/delivery-slots')).body);
  });
});
