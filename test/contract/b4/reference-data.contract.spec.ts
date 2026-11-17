import { randomUUID } from 'node:crypto';
import { ManualClock } from '@hakorem/kernel';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCatalogue, TAX_CATEGORY } from '../../support/catalogue';
import { contractSchema } from '../../support/contract-schemas';
import { consoleGet, consolePost, createBranch, createUser, enrolAndLogin, relaxRateLimits, SYSTEM_PRINCIPAL, testStartTime, type TestSession } from '../../support/iam';
import { startTestApp, TEST_ORIGIN, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/** The B04d continued 3 operations answer in the shapes of contract/openapi.yaml 1.9.0. */
let database: TestDatabase;
let api: TestApp;
let manager: TestSession;
let branchId: string;
let liveCategoryId: string;
let goatId: string;

function expectShape(schema: string, body: unknown): void {
  const validate = contractSchema(schema);
  expect(validate(body), `${schema}: ${JSON.stringify(validate.errors)}`).toBe(true);
}

const patch = (path: string, body: object) =>
  request(api.server).patch(path).set('Cookie', manager.jar.header()).set('X-CSRF-Token', manager.csrfToken).set('Origin', TEST_ORIGIN).set('Idempotency-Key', randomUUID()).send(body);

beforeAll(async () => {
  database = await createTestDatabase();
  const clock = new ManualClock(testStartTime());
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock });
  ({ branchId } = await createBranch(database));
  const catalogue = await createCatalogue(database);
  liveCategoryId = catalogue.liveCategoryId;
  goatId = randomUUID();
  await database.pool('app').query(
    `INSERT INTO mdm.product (id, sku, name, category_id, stock_policy, tracking, species_id, base_uom, sale_uom, tax_category_id, gl_group, online_mode, status, created_by, updated_by)
     VALUES ($1, 'LIV-0004', 'Goat', $2, 'SERIALISED', 'SERIAL', $3, 'HEAD', 'HEAD', $4, 'LIVE_ANIMALS', 'REQUEST_TO_BUY', 'ACTIVE', $5, $5)`,
    [goatId, catalogue.liveCategoryId, catalogue.goatSpeciesId, TAX_CATEGORY.LIVE_ANIMALS, SYSTEM_PRINCIPAL],
  );
  manager = await enrolAndLogin(api.server, await createUser(database, { name: 'Akosua Boateng', grants: [{ role: 'MANAGER', branchId }] }), () => clock.now());
});

afterAll(async () => {
  await api.close();
  await database.drop();
});

describe('supplier and reference data operations answer in the contract shapes', () => {
  it('the supplier register', async () => {
    const created = await consolePost(api.server, manager, '/v1/suppliers').send({ name: 'Ashanti Feeds Ltd', phone: '0322031447', tin: 'C0098765432', categoryIds: [liveCategoryId] });
    expect(created.status).toBe(201);
    expectShape('Supplier', created.body);
    expectShape('Supplier', (await consoleGet(api.server, manager, `/v1/suppliers/${created.body.id}`)).body);
    expectShape('SupplierPage', (await consoleGet(api.server, manager, '/v1/suppliers')).body);
    const changed = await patch(`/v1/suppliers/${created.body.id}`, { version: created.body.version, status: 'BLOCKED' });
    expectShape('Supplier', changed.body);
    expectShape('Supplier', (await consolePost(api.server, manager, `/v1/suppliers/${created.body.id}/archive`).send({ version: changed.body.version, reason: 'Stopped trading' })).body);
  });

  it('payment methods, reason codes, delivery zones and the delivery quote', async () => {
    const methods = await consoleGet(api.server, manager, '/v1/payment-methods?includeDisabled=true');
    expectShape('PaymentMethodPage', methods.body);
    const cash = methods.body.data.find((row: { code: string }) => row.code === 'CASH');
    const enabled = await patch(`/v1/payment-methods/${cash.id}`, { version: cash.version, isEnabled: true });
    expectShape('PaymentMethod', enabled.body);
    const refused = await patch(`/v1/payment-methods/${cash.id}`, { version: enabled.body.version, channels: [] });
    expect(refused.status).toBe(422);
    expectShape('Error', refused.body);
    expectShape('ReasonCodePage', (await consoleGet(api.server, manager, '/v1/reason-codes?domain=VOID')).body);
    const zone = await consolePost(api.server, manager, '/v1/delivery-zones').send({ branchId, code: 'DODOWA', name: 'Dodowa', areas: ['Dodowa'], feePesewas: 1500, freeOverPesewas: 50000, cutoffTime: '14:00' });
    expect(zone.status).toBe(201);
    expectShape('DeliveryZone', zone.body);
    expectShape('DeliveryZone', (await consoleGet(api.server, manager, `/v1/delivery-zones/${zone.body.id}`)).body);
    expectShape('DeliveryZonePage', (await consoleGet(api.server, manager, '/v1/delivery-zones')).body);
    expectShape('DeliveryZone', (await patch(`/v1/delivery-zones/${zone.body.id}`, { version: zone.body.version, cutoffTime: '13:00' })).body);
    const addressOf = (area: string) => ({ recipientName: 'Ama Serwaa', recipientPhone: '+233244512876', line1: 'Near the market', area, city: area, region: 'Greater Accra' });
    for (const area of ['Dodowa', 'Ho']) {
      const quoted = await request(api.server).post('/v1/shop/delivery/quote').set('Origin', TEST_ORIGIN).send({ address: addressOf(area) });
      expect(quoted.status).toBe(200);
      expectShape('DeliveryQuote', quoted.body);
    }
  });

  it('the price list listings and updates, and archiveProduct', async () => {
    const list = await consolePost(api.server, manager, '/v1/price-lists').send({ code: 'BASE', name: 'Base prices', kind: 'BASE', taxInclusive: true });
    const version = await consolePost(api.server, manager, `/v1/price-lists/${list.body.id}/versions`).send({ validFrom: '2026-12-01T00:00:00Z' });
    await request(api.server)
      .put(`/v1/price-list-versions/${version.body.id}/entries`)
      .set('Cookie', manager.jar.header())
      .set('X-CSRF-Token', manager.csrfToken)
      .set('Origin', TEST_ORIGIN)
      .set('Idempotency-Key', randomUUID())
      .send({ version: 1, entries: [{ productId: goatId, basis: 'PER_HEAD', listPricePesewas: 90_000, floorPricePesewas: 80_000, ceilingPricePesewas: 100_000 }] });
    expectShape('PriceListPage', (await consoleGet(api.server, manager, '/v1/price-lists')).body);
    expectShape('PriceListVersionPage', (await consoleGet(api.server, manager, `/v1/price-lists/${list.body.id}/versions`)).body);
    const entries = await consoleGet(api.server, manager, `/v1/price-list-versions/${version.body.id}/entries`);
    expectShape('PriceListEntryPage', entries.body);
    expect(entries.body.data[0]).toMatchObject({ listPricePesewas: 90000, floorPricePesewas: 80000, ceilingPricePesewas: 100000 });
    const renamed = await patch(`/v1/price-lists/${list.body.id}`, { version: list.body.version, name: 'Base prices 2026' });
    expectShape('PriceList', renamed.body);
    expectShape('PriceList', (await consolePost(api.server, manager, `/v1/price-lists/${list.body.id}/archive`).send({ version: renamed.body.version, reason: 'Replaced' })).body);
    const product = await consoleGet(api.server, manager, `/v1/products/${goatId}`);
    const archived = await consolePost(api.server, manager, `/v1/products/${goatId}/archive`).send({ version: product.body.version, reason: 'No longer sold' });
    expect(archived.status).toBe(200);
    expectShape('Product', archived.body);
  });
});
