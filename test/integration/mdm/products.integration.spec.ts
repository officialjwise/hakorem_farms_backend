import { randomUUID } from 'node:crypto';
import { ManualClock } from '@hakorem/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCatalogue, TAX_CATEGORY, type TestCatalogue } from '../../support/catalogue';
import { consoleGet, consolePost, createBranch, createUser, enrolAndLogin, login, relaxRateLimits, testStartTime, type TestSession } from '../../support/iam';
import { startTestApp, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let catalogue: TestCatalogue;
let manager: TestSession;
let managerId: string;
let cashier: TestSession;

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock });
  const dodowa = await createBranch(database);
  catalogue = await createCatalogue(database);
  const managerUser = await createUser(database, { name: 'Kwabena Owusu', grants: [{ role: 'MANAGER', branchId: dodowa.branchId }] });
  managerId = managerUser.principalId;
  manager = await enrolAndLogin(api.server, managerUser, () => clock.now());
  cashier = await login(api.server, await createUser(database, { name: 'Adwoa Darko', grants: [{ role: 'CASHIER', branchId: dodowa.branchId, locationId: dodowa.shopId }] }));
});

afterAll(async () => {
  await api.close();
  await database.drop();
});

function goat(overrides: object = {}) {
  return {
    sku: 'LIV-GOAT',
    name: 'Goat',
    categoryId: catalogue.liveCategoryId,
    stockPolicy: 'SERIALISED',
    speciesId: catalogue.goatSpeciesId,
    baseUom: 'HEAD',
    saleUom: 'HEAD',
    description: 'Individually tagged and weighed. Priced by size and weight.',
    onlineMode: 'REQUEST_TO_BUY',
    seo: { slug: 'goat', title: 'Goat | HaKorem Farms' },
    ...overrides,
  };
}

const create = (body: object, key: string = randomUUID(), session: TestSession = manager) => consolePost(api.server, session, '/v1/products', key).send(body);

describe('createProduct (FR-MDM-001)', () => {
  it('creates a serialised goat with its derived tracking, ledger group and tax category, and answers 201', async () => {
    const response = await create(goat());
    expect(response.status).toBe(201);
    expect(response.body).toEqual({
      id: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/),
      sku: 'LIV-GOAT',
      name: 'Goat',
      category: { id: catalogue.liveCategoryId, code: 'LIVE', name: 'Live animals' },
      stockPolicy: 'SERIALISED',
      tracking: 'SERIAL',
      species: { id: catalogue.goatSpeciesId, code: 'GOAT', name: 'Goat' },
      baseUom: 'HEAD',
      saleUom: 'HEAD',
      nominalPackKg: null,
      weightTolerancePercent: '10.00',
      taxCategory: { id: TAX_CATEGORY.LIVE_ANIMALS, code: 'LIVE_ANIMALS', name: 'Live animals' },
      glGroup: 'LIVE_ANIMALS',
      shelfLifeDays: null,
      storageTempClass: null,
      withdrawalDays: null,
      barcode: null,
      description: 'Individually tagged and weighed. Priced by size and weight.',
      onlineMode: 'REQUEST_TO_BUY',
      seo: { slug: 'goat', title: 'Goat | HaKorem Farms', description: null },
      isPurchasable: true,
      isSellable: true,
      status: 'ACTIVE',
      images: [],
      version: 1,
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });
  });

  it('stores a catch-weight pack size and tolerance exactly, as decimal strings', async () => {
    const response = await create({
      sku: 'MEAT-GOAT-5KG',
      name: 'Goat meat, 5 kg pack',
      categoryId: catalogue.meatCategoryId,
      stockPolicy: 'CATCH_WEIGHT',
      baseUom: 'KG',
      saleUom: 'PACK',
      nominalPackKg: '5.000',
      weightTolerancePercent: '7.25',
      shelfLifeDays: 30,
      storageTempClass: 'FROZEN',
      onlineMode: 'LISTED',
      seo: { slug: 'goat-meat-5-kg-pack' },
    });
    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ tracking: 'LOT', nominalPackKg: '5.000', weightTolerancePercent: '7.25', glGroup: 'MEAT', taxCategory: { code: 'PROCESSED_MEAT' } });
    const { rows } = await database.pool('admin').query<{ kg: string; pct: string }>(
      'SELECT nominal_pack_kg::text AS kg, weight_tolerance_percent::text AS pct FROM mdm.product WHERE id = $1',
      [response.body.id],
    );
    expect(rows[0]).toEqual({ kg: '5.000', pct: '7.2500' });
  });

  it('writes the audit event and the domain event in the same transaction as the product', async () => {
    const response = await create(goat({ sku: 'LIV-SHEEP', name: 'Sheep', seo: { slug: 'sheep' } }));
    const id = response.body.id as string;
    const admin = database.pool('admin');
    const audit = await admin.query<{ action: string; actor_id: string; after: Buffer }>(
      "SELECT action, actor_id, \"after\" FROM platform.audit_event WHERE entity_type = 'Product' AND entity_id = $1",
      [id],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({ action: 'CREATE', actor_id: managerId });
    expect(JSON.parse(audit.rows[0]!.after.toString('utf8'))).toMatchObject({ sku: 'LIV-SHEEP', stockPolicy: 'SERIALISED' });
    const event = await admin.query<{ event_type: string; actor_id: string; payload: { sku: string } }>(
      'SELECT event_type, actor_id, payload FROM platform.outbox_message WHERE subject_id = $1',
      [id],
    );
    expect(event.rows).toEqual([{ event_type: 'mdm.ProductCreated', actor_id: managerId, payload: expect.objectContaining({ productId: id, sku: 'LIV-SHEEP' }) }]);
  });

  it('returns the stored response for a retry with the same key, and creates nothing more', async () => {
    const key = randomUUID();
    const body = goat({ sku: 'LIV-PIG', name: 'Baby pig', seo: { slug: 'baby-pig' } });
    const first = await create(body, key);
    const retry = await create(body, key);
    expect(retry.status).toBe(201);
    expect(retry.body).toEqual(first.body);
    const { rows } = await database.pool('admin').query("SELECT 1 FROM mdm.product WHERE sku = 'LIV-PIG'");
    expect(rows).toHaveLength(1);
  });

  it('creates one product from two concurrent identical requests with one key', async () => {
    const key = randomUUID();
    const body = goat({ sku: 'LIV-RABBIT', name: 'Rabbit', seo: { slug: 'rabbit' } });
    const [a, b] = await Promise.all([create(body, key), create(body, key)]);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(b.body.id).toBe(a.body.id);
    const { rows } = await database.pool('admin').query("SELECT 1 FROM mdm.product WHERE sku = 'LIV-RABBIT'");
    expect(rows).toHaveLength(1);
  });

  it('refuses the same key with a different body, with 409', async () => {
    const key = randomUUID();
    await create(goat({ sku: 'LIV-DUCK', name: 'Duck', seo: { slug: 'duck' } }), key);
    const changed = await create(goat({ sku: 'LIV-DUCK', name: 'Muscovy duck', seo: { slug: 'duck' } }), key);
    expect(changed.status).toBe(409);
    expect(changed.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('refuses a SKU or storefront slug another product uses, naming each field', async () => {
    const response = await create(goat());
    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('DUPLICATE_VALUE');
    expect(response.body.error.details.map((d: { field: string }) => d.field)).toEqual(['/sku', '/seo/slug']);
  });

  it('refuses references that do not exist and fields that contradict the stock policy, with 422 and the fields named', async () => {
    const unknown = await create(goat({ sku: 'LIV-COW', categoryId: randomUUID(), seo: { slug: 'cow' } }));
    expect(unknown.status).toBe(422);
    expect(unknown.body.error).toMatchObject({ code: 'REFERENCE_NOT_FOUND', details: [{ field: '/categoryId', code: 'UNKNOWN' }] });
    const conflict = await create(goat({ sku: 'LIV-COW', onlineMode: 'LISTED', seo: { slug: 'cow' } }));
    expect(conflict.status).toBe(422);
    expect(conflict.body.error).toMatchObject({ code: 'STOCK_POLICY_CONFLICT', details: [{ field: '/onlineMode', code: 'LIVE_ANIMALS_ARE_REQUEST_TO_BUY' }] });
  });

  it('refuses unknown fields and malformed decimals at the boundary with 400, listing every field', async () => {
    const response = await create(goat({ sku: 'LIV-COW', priceGhs: 1200, nominalPackKg: '15.5', seo: { slug: 'cow' } }));
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_FAILED');
    const fields = response.body.error.details.map((d: { field: string; code: string }) => `${d.field}:${d.code}`);
    expect(fields).toEqual(expect.arrayContaining(['/priceGhs:UNKNOWN_FIELD', '/nominalPackKg:INVALID_FORMAT']));
  });

  it('refuses a cashier, who may read the catalogue but not add to it, and creates nothing', async () => {
    const response = await create(goat({ sku: 'LIV-TURKEY', name: 'Turkey', seo: { slug: 'turkey' } }), randomUUID(), cashier);
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('FORBIDDEN');
    expect((await database.pool('admin').query("SELECT 1 FROM mdm.product WHERE sku = 'LIV-TURKEY'")).rowCount).toBe(0);
    expect((await database.pool('admin').query("SELECT 1 FROM platform.idempotency_key WHERE scope LIKE '%createProduct' AND principal_id <> $1", [managerId])).rowCount).toBe(0);
  });
});

describe('getProduct and listProducts', () => {
  it('reads a product by id, and answers 404 for an id that names none', async () => {
    const created = await create({ sku: 'PRD-EGGS-BIG', name: 'Eggs, big, crate of 30', categoryId: catalogue.eggsCategoryId, stockPolicy: 'COUNTABLE', baseUom: 'CRATE', saleUom: 'CRATE', shelfLifeDays: 21, onlineMode: 'LISTED' });
    const read = await consoleGet(api.server, cashier, `/v1/products/${created.body.id}`);
    expect(read.status).toBe(200);
    expect(read.body).toEqual(created.body);
    const missing = await consoleGet(api.server, cashier, `/v1/products/${randomUUID()}`);
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('NOT_FOUND');
    const malformed = await consoleGet(api.server, cashier, '/v1/products/not-a-uuid');
    expect(malformed.status).toBe(400);
  });

  it('lists newest first, filters by policy and by the start of a word, and pages with a cursor', async () => {
    const all = await consoleGet(api.server, cashier, '/v1/products');
    expect(all.status).toBe(200);
    const ids = all.body.data.map((p: { id: string }) => p.id);
    expect(ids).toEqual([...ids].sort().reverse());

    const meat = await consoleGet(api.server, cashier, '/v1/products?stockPolicy=CATCH_WEIGHT');
    expect(meat.body.data.map((p: { sku: string }) => p.sku)).toEqual(['MEAT-GOAT-5KG']);
    const search = await consoleGet(api.server, cashier, '/v1/products?q=meat');
    expect(search.body.data.map((p: { sku: string }) => p.sku)).toEqual(['MEAT-GOAT-5KG']);
    const percent = await consoleGet(api.server, cashier, `/v1/products?q=${encodeURIComponent('5%')}`);
    expect(percent.body.data).toEqual([]);

    const first = await consoleGet(api.server, cashier, '/v1/products?limit=2');
    expect(first.body.data).toHaveLength(2);
    expect(first.body.page.hasMore).toBe(true);
    const next = await consoleGet(api.server, cashier, `/v1/products?limit=2&cursor=${encodeURIComponent(first.body.page.nextCursor)}`);
    expect(next.body.data[0].id < first.body.data[1].id).toBe(true);
    // A cursor is bound to its filters.
    const rebound = await consoleGet(api.server, cashier, `/v1/products?limit=2&stockPolicy=SERIALISED&cursor=${encodeURIComponent(first.body.page.nextCursor)}`);
    expect(rebound.status).toBe(400);
  });
});
