import { randomUUID } from 'node:crypto';
import { ManualClock } from '@hakorem/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCatalogue, TAX_CATEGORY, type TestCatalogue } from '../../support/catalogue';
import { consoleGet, consolePatch, consolePost, createBranch, createUser, enrolAndLogin, login, relaxRateLimits, testStartTime, type TestSession } from '../../support/iam';
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
const update = (id: string, body: object, key: string = randomUUID()) => consolePatch(api.server, manager, `/v1/products/${id}`, key).send(body);
const productCount = async () => Number((await database.pool('admin').query<{ n: string }>('SELECT count(*) AS n FROM mdm.product')).rows[0]!.n);

describe('createProduct (FR-MDM-001)', () => {
  it('creates a serialised goat with its derived tracking, ledger group and tax category, the SKU the server gives it, and no barcode', async () => {
    const response = await create(goat());
    expect(response.status).toBe(201);
    expect(response.body).toEqual({
      id: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/),
      sku: 'LIV-0001',
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

  it('stores a catch-weight pack size and tolerance exactly, as decimal strings, under its own prefix', async () => {
    const response = await create({
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
    expect(response.body).toMatchObject({ sku: 'MEAT-0001', tracking: 'LOT', nominalPackKg: '5.000', weightTolerancePercent: '7.25', glGroup: 'MEAT', taxCategory: { code: 'PROCESSED_MEAT' } });
    const { rows } = await database.pool('admin').query<{ kg: string; pct: string }>(
      'SELECT nominal_pack_kg::text AS kg, weight_tolerance_percent::text AS pct FROM mdm.product WHERE id = $1',
      [response.body.id],
    );
    expect(rows[0]).toEqual({ kg: '5.000', pct: '7.2500' });
  });

  it('writes the audit event and the domain event in the same transaction as the product, with its SKU', async () => {
    const response = await create(goat({ name: 'Sheep', seo: { slug: 'sheep' } }));
    expect(response.body.sku).toBe('LIV-0002');
    const id = response.body.id as string;
    const admin = database.pool('admin');
    const audit = await admin.query<{ action: string; actor_id: string; after: Buffer }>(
      "SELECT action, actor_id, \"after\" FROM platform.audit_event WHERE entity_type = 'Product' AND entity_id = $1",
      [id],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({ action: 'CREATE', actor_id: managerId });
    expect(JSON.parse(audit.rows[0]!.after.toString('utf8'))).toMatchObject({ sku: 'LIV-0002', stockPolicy: 'SERIALISED' });
    const event = await admin.query<{ event_type: string; actor_id: string; payload: { sku: string } }>(
      'SELECT event_type, actor_id, payload FROM platform.outbox_message WHERE subject_id = $1',
      [id],
    );
    expect(event.rows).toEqual([{ event_type: 'mdm.ProductCreated', actor_id: managerId, payload: expect.objectContaining({ productId: id, sku: 'LIV-0002' }) }]);
  });

  it('returns the stored response for a retry with the same key, and creates nothing more nor takes another SKU', async () => {
    const key = randomUUID();
    const body = goat({ name: 'Baby pig', seo: { slug: 'baby-pig' } });
    const first = await create(body, key);
    const retry = await create(body, key);
    expect(retry.status).toBe(201);
    expect(retry.body).toEqual(first.body);
    expect(first.body.sku).toBe('LIV-0003');
    const { rows } = await database.pool('admin').query("SELECT 1 FROM mdm.product WHERE name = 'Baby pig'");
    expect(rows).toHaveLength(1);
  });

  it('creates one product from two concurrent identical requests with one key', async () => {
    const key = randomUUID();
    const body = goat({ name: 'Rabbit', seo: { slug: 'rabbit' } });
    const [a, b] = await Promise.all([create(body, key), create(body, key)]);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(b.body.id).toBe(a.body.id);
    const { rows } = await database.pool('admin').query("SELECT 1 FROM mdm.product WHERE name = 'Rabbit'");
    expect(rows).toHaveLength(1);
  });

  it('refuses the same key with a different body, with 409', async () => {
    const key = randomUUID();
    await create(goat({ name: 'Duck', seo: { slug: 'duck' } }), key);
    const changed = await create(goat({ name: 'Muscovy duck', seo: { slug: 'duck' } }), key);
    expect(changed.status).toBe(409);
    expect(changed.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('refuses a storefront slug another product uses, naming the field', async () => {
    const response = await create(goat());
    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('DUPLICATE_VALUE');
    expect(response.body.error.details.map((d: { field: string }) => d.field)).toEqual(['/seo/slug']);
  });

  it('refuses every concurrent duplicate slug with 422 DUPLICATE_VALUE, never a 500, when the race reaches the unique index', async () => {
    // The pre-check sees committed rows only; eight concurrent creates of one new slug pass it together, and all but one
    // meet uq_product_seo_slug inside drizzle's insert, whose error wraps the pg error (constraint and code) as its cause.
    const body = goat({ name: 'Piglet', seo: { slug: 'piglet' } });
    const responses = await Promise.all(Array.from({ length: 8 }, () => create(body, randomUUID())));
    expect(responses.map((r) => r.status).sort()).toEqual([201, 422, 422, 422, 422, 422, 422, 422]);
    for (const refused of responses.filter((r) => r.status === 422)) {
      expect(refused.body.error.code).toBe('DUPLICATE_VALUE');
      expect(refused.body.error.details.map((d: { field: string }) => d.field)).toEqual(['/seo/slug']);
    }
    const { rows } = await database.pool('admin').query("SELECT 1 FROM mdm.product WHERE seo_slug = 'piglet'");
    expect(rows).toHaveLength(1);
  });

  it('refuses references that do not exist and fields that contradict the stock policy, with 422 and the fields named', async () => {
    const unknown = await create(goat({ categoryId: randomUUID(), seo: { slug: 'cow' } }));
    expect(unknown.status).toBe(422);
    expect(unknown.body.error).toMatchObject({ code: 'REFERENCE_NOT_FOUND', details: [{ field: '/categoryId', code: 'UNKNOWN' }] });
    const conflict = await create(goat({ onlineMode: 'LISTED', seo: { slug: 'cow' } }));
    expect(conflict.status).toBe(422);
    expect(conflict.body.error).toMatchObject({ code: 'STOCK_POLICY_CONFLICT', details: [{ field: '/onlineMode', code: 'LIVE_ANIMALS_ARE_REQUEST_TO_BUY' }] });
  });

  it('refuses unknown fields and malformed decimals at the boundary with 400, listing every field', async () => {
    const response = await create(goat({ priceGhs: 1200, nominalPackKg: '15.5', seo: { slug: 'cow' } }));
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_FAILED');
    const fields = response.body.error.details.map((d: { field: string; code: string }) => `${d.field}:${d.code}`);
    expect(fields).toEqual(expect.arrayContaining(['/priceGhs:UNKNOWN_FIELD', '/nominalPackKg:INVALID_FORMAT']));
  });

  it('refuses a cashier, who may read the catalogue but not add to it, and creates nothing', async () => {
    const response = await create(goat({ name: 'Turkey', seo: { slug: 'turkey' } }), randomUUID(), cashier);
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('FORBIDDEN');
    expect((await database.pool('admin').query("SELECT 1 FROM mdm.product WHERE name = 'Turkey'")).rowCount).toBe(0);
    expect((await database.pool('admin').query("SELECT 1 FROM platform.idempotency_key WHERE scope LIKE '%createProduct' AND principal_id <> $1", [managerId])).rowCount).toBe(0);
  });
});

describe('the SKU is generated by the server, unique, never reused and never edited (B09q, ADR-0072)', () => {
  it('refuses a create that carries a SKU, whatever its value, with 422 FIELD_SERVER_ASSIGNED, and creates nothing', async () => {
    const before = await productCount();
    for (const sku of ['LIV-0099', 'EGG-0001', '', null]) {
      const refused = await create(goat({ sku, name: 'Turkey', seo: { slug: 'turkey' } }));
      expect(refused.status, String(sku)).toBe(422);
      expect(refused.body.error).toMatchObject({ code: 'FIELD_SERVER_ASSIGNED', details: [{ field: '/sku', code: 'SERVER_ASSIGNED' }] });
    }
    expect(await productCount()).toBe(before);
  });

  it('refuses an update that carries a SKU, even its own, with 422, and changes nothing', async () => {
    const created = await create(goat({ name: 'Guinea fowl', seo: { slug: 'guinea-fowl' } }));
    for (const sku of ['LIV-0999', created.body.sku as string]) {
      const refused = await update(created.body.id, { version: 1, sku, name: 'Guinea fowl, renamed' });
      expect(refused.status, sku).toBe(422);
      expect(refused.body.error).toMatchObject({ code: 'FIELD_SERVER_ASSIGNED', details: [{ field: '/sku', code: 'SERVER_ASSIGNED' }] });
    }
    const read = await consoleGet(api.server, manager, `/v1/products/${created.body.id}`);
    expect(read.body).toMatchObject({ sku: created.body.sku, name: 'Guinea fowl', version: 1 });
  });

  it('gives eight concurrent creates of one category eight different SKUs, one after another', async () => {
    const responses = await Promise.all(Array.from({ length: 8 }, (_, i) => create({ name: `Eggs, tray ${i + 1}`, categoryId: catalogue.eggsCategoryId, stockPolicy: 'COUNTABLE', baseUom: 'CRATE', saleUom: 'CRATE', onlineMode: 'LISTED' })));
    expect(responses.map((r) => r.status)).toEqual(Array(8).fill(201));
    expect(responses.map((r) => r.body.sku as string).sort()).toEqual(['EGG-0001', 'EGG-0002', 'EGG-0003', 'EGG-0004', 'EGG-0005', 'EGG-0006', 'EGG-0007', 'EGG-0008']);
  });

  it("keeps a product's SKU when it moves to another category, and never gives an archived product's SKU again", async () => {
    const created = await create({ name: 'Duck eggs, crate', categoryId: catalogue.eggsCategoryId, stockPolicy: 'COUNTABLE', baseUom: 'CRATE', saleUom: 'CRATE', onlineMode: 'LISTED' });
    expect(created.body.sku).toBe('EGG-0009');
    const moved = await update(created.body.id, { version: 1, categoryId: catalogue.meatCategoryId });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect(moved.body).toMatchObject({ sku: 'EGG-0009', category: { id: catalogue.meatCategoryId } });
    const archived = await consolePost(api.server, manager, `/v1/products/${created.body.id}/archive`).send({ version: 2, reason: 'Entered by mistake' });
    expect(archived.status, JSON.stringify(archived.body)).toBe(200);
    const next = await create({ name: 'Duck eggs, crate of 30', categoryId: catalogue.eggsCategoryId, stockPolicy: 'COUNTABLE', baseUom: 'CRATE', saleUom: 'CRATE', onlineMode: 'LISTED' });
    expect(next.body.sku).toBe('EGG-0010');
  });

  it("takes its prefix from the category: one given at creation, one derived from the code, and a changed one for later products only", async () => {
    const tubers = await consolePost(api.server, manager, '/v1/categories').send({ code: 'TUBERS', name: 'Tubers', productLine: 'PRODUCE', glGroup: 'PRODUCE_EGGS', taxCategoryId: TAX_CATEGORY.RAW_PRODUCE, skuPrefix: 'TUB' });
    expect(tubers.status, JSON.stringify(tubers.body)).toBe(201);
    expect(tubers.body.skuPrefix).toBe('TUB');
    const greens = await consolePost(api.server, manager, '/v1/categories').send({ code: 'GREENS', name: 'Leafy greens', productLine: 'PRODUCE', glGroup: 'PRODUCE_EGGS', taxCategoryId: TAX_CATEGORY.RAW_PRODUCE });
    expect(greens.body.skuPrefix).toBe('GRE');
    const tuber = (name: string, categoryId: string) => create({ name, categoryId, stockPolicy: 'COUNTABLE', baseUom: 'TUBER', saleUom: 'TUBER', onlineMode: 'LISTED' });
    const yam = await tuber('Yam, per tuber', tubers.body.id);
    expect(yam.body.sku).toBe('TUB-0001');
    expect((await tuber('Kontomire, bunch', greens.body.id)).body.sku).toBe('GRE-0001');
    const renamed = await consolePatch(api.server, manager, `/v1/categories/${tubers.body.id}`).send({ version: tubers.body.version, skuPrefix: 'YAM' });
    expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);
    expect((await tuber('Water yam, per tuber', tubers.body.id)).body.sku).toBe('YAM-0001');
    expect((await consoleGet(api.server, manager, `/v1/products/${yam.body.id}`)).body.sku).toBe('TUB-0001');
    const bad = await consolePost(api.server, manager, '/v1/categories').send({ code: 'ROOTS', name: 'Roots', productLine: 'PRODUCE', glGroup: 'PRODUCE_EGGS', taxCategoryId: TAX_CATEGORY.RAW_PRODUCE, skuPrefix: 'roots1' });
    expect(bad.status).toBe(400);
  });
});

describe('no product barcode and no barcode lookup (B09q, ADR-0072)', () => {
  it('refuses a barcode on create and on update as an unknown field, with 400', async () => {
    const created = await create(goat({ barcode: '6034000120051', name: 'Turkey', seo: { slug: 'turkey' } }));
    expect(created.status).toBe(400);
    expect(created.body.error.details).toEqual(expect.arrayContaining([expect.objectContaining({ field: '/barcode', code: 'UNKNOWN_FIELD' })]));
    const product = await create(goat({ name: 'Turkey', seo: { slug: 'turkey' } }));
    const changed = await update(product.body.id, { version: 1, barcode: '6034000120051' });
    expect(changed.status).toBe(400);
    expect(product.body).not.toHaveProperty('barcode');
  });

  it('refuses a barcode lookup on listProducts with 400, rather than answering a scanner with the whole catalogue', async () => {
    const lookup = await consoleGet(api.server, cashier, '/v1/products?barcode=6034000120051');
    expect(lookup.status).toBe(400);
    expect(lookup.body.error.code).toBe('VALIDATION_FAILED');
    expect(lookup.body.error.details).toEqual([expect.objectContaining({ field: '/barcode' })]);
  });
});

describe('getProduct and listProducts', () => {
  it('reads a product by id, and answers 404 for an id that names none', async () => {
    const created = await create({ name: 'Eggs, big, crate of 30', categoryId: catalogue.eggsCategoryId, stockPolicy: 'COUNTABLE', baseUom: 'CRATE', saleUom: 'CRATE', shelfLifeDays: 21, onlineMode: 'LISTED' });
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
    expect(meat.body.data.map((p: { sku: string }) => p.sku)).toEqual(['MEAT-0001']);
    const search = await consoleGet(api.server, cashier, '/v1/products?q=meat');
    expect(search.body.data.map((p: { sku: string }) => p.sku)).toEqual(['MEAT-0001']);
    const bySku = await consoleGet(api.server, cashier, '/v1/products?q=meat-00');
    expect(bySku.body.data.map((p: { sku: string }) => p.sku)).toEqual(['MEAT-0001']);
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
