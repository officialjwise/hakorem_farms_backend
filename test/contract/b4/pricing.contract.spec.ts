import { randomUUID } from 'node:crypto';
import { ManualClock } from '@hakorem/kernel';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCatalogue, TAX_CATEGORY } from '../../support/catalogue';
import { contractSchema } from '../../support/contract-schemas';
import { consoleGet, consolePost, createBranch, createUser, enrolAndLogin, relaxRateLimits, SYSTEM_PRINCIPAL, testStartTime, type TestSession } from '../../support/iam';
import { startTestApp, TEST_ORIGIN, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/** The B4 operations answer in the shapes of contract/openapi.yaml 1.3.0. */
let database: TestDatabase;
let api: TestApp;
let manager: TestSession;
let branchId: string;
let goatId: string;

function expectShape(schema: string, body: unknown): void {
  const validate = contractSchema(schema);
  expect(validate(body), `${schema}: ${JSON.stringify(validate.errors)}`).toBe(true);
}

beforeAll(async () => {
  database = await createTestDatabase();
  const clock = new ManualClock(testStartTime());
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock });
  ({ branchId } = await createBranch(database));
  const catalogue = await createCatalogue(database);
  goatId = randomUUID();
  await database.pool('app').query(
    `INSERT INTO mdm.product (id, sku, name, category_id, stock_policy, tracking, species_id, base_uom, sale_uom, tax_category_id, gl_group, online_mode, status, created_by, updated_by)
     VALUES ($1, 'LIV-GOAT', 'Goat', $2, 'SERIALISED', 'SERIAL', $3, 'HEAD', 'HEAD', $4, 'LIVE_ANIMALS', 'REQUEST_TO_BUY', 'ACTIVE', $5, $5)`,
    [goatId, catalogue.liveCategoryId, catalogue.goatSpeciesId, TAX_CATEGORY.LIVE_ANIMALS, SYSTEM_PRINCIPAL],
  );
  manager = await enrolAndLogin(api.server, await createUser(database, { name: 'Akosua Boateng', grants: [{ role: 'MANAGER', branchId }] }), () => clock.now());
});

afterAll(async () => {
  await api.close();
  await database.drop();
});

describe('pricing operations answer in the contract shapes', () => {
  it('createPriceList, getPriceList, createPriceListVersion, replacePriceListEntries, getPriceListVersion and submitPriceListVersion', async () => {
    const list = await consolePost(api.server, manager, '/v1/price-lists').send({ code: 'BASE', name: 'Base prices', kind: 'BASE', taxInclusive: true });
    expect(list.status).toBe(201);
    expectShape('PriceList', list.body);
    expectShape('PriceList', (await consoleGet(api.server, manager, `/v1/price-lists/${list.body.id}`)).body);
    const version = await consolePost(api.server, manager, `/v1/price-lists/${list.body.id}/versions`).send({ validFrom: '2026-12-01T00:00:00Z', notes: 'December' });
    expect(version.status).toBe(201);
    expectShape('PriceListVersion', version.body);
    const replaced = await request(api.server)
      .put(`/v1/price-list-versions/${version.body.id}/entries`)
      .set('Cookie', manager.jar.header())
      .set('X-CSRF-Token', manager.csrfToken)
      .set('Origin', TEST_ORIGIN)
      .set('Idempotency-Key', randomUUID())
      .send({ version: 1, entries: [{ productId: goatId, basis: 'PER_HEAD', listPricePesewas: 90_000, floorPricePesewas: 80_000, ceilingPricePesewas: 100_000 }] });
    expect(replaced.status).toBe(200);
    expectShape('PriceListVersion', replaced.body);
    expectShape('PriceListVersion', (await consoleGet(api.server, manager, `/v1/price-list-versions/${version.body.id}`)).body);
    const submitted = await consolePost(api.server, manager, `/v1/price-list-versions/${version.body.id}/submit`).send({});
    expect(submitted.status).toBe(202);
    expectShape('ApprovalPending', submitted.body);
  });

  it('resolvePrices returns PriceResolveResult, and a refusal the error envelope', async () => {
    const resolved = await consolePost(api.server, manager, '/v1/pricing/resolve').send({ channel: 'POS', branchId, lines: [{ lineRef: '1', productId: goatId, quantity: '1.000' }] });
    expect(resolved.status).toBe(200);
    expectShape('PriceResolveResult', resolved.body);
    expect(resolved.body.lines[0].outcome).toBe('QUOTE_REQUIRED');
    const refused = await consolePost(api.server, manager, '/v1/pricing/resolve').send({ channel: 'POS', branchId, lines: [{ lineRef: '1', productId: randomUUID(), quantity: '1.000' }] });
    expect(refused.status).toBe(422);
    expectShape('Error', refused.body);
  });
});
