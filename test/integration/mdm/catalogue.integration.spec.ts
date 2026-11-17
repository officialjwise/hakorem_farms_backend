import { randomUUID } from 'node:crypto';
import { ManualClock } from '@hakorem/kernel';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Approvals } from '../../../src/modules/iam';
import { runWithRequestContext, type Actor } from '../../../src/platform/context/request-context';
import { UnitOfWork } from '../../../src/platform/database/unit-of-work';
import { TAX_CATEGORY } from '../../support/catalogue';
import { consoleGet, consolePost, createBranch, createUser, enrolAndLogin, login, relaxRateLimits, SYSTEM_PRINCIPAL, testStartTime, type TestSession } from '../../support/iam';
import { sqlStateOf } from '../../support/sql-state';
import { startTestApp, TEST_ORIGIN, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * The catalogue's reference data through the API (FR-MDM-002, FR-MDM-003, FR-MDM-005, FR-MDM-001 updates): every
 * write refuses the wrong role, archiving refuses a record still in use, weight bands never overlap, and a product
 * update keeps its stock-keeping policy.
 */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let manager: TestSession;
let owner: TestSession;
let ownerActor: Actor;
let cashier: TestSession;
let sales: TestSession;
let driver: TestSession;

const post = (session: TestSession, path: string, body: object, key: string = randomUUID()) => consolePost(api.server, session, `/v1${path}`, key).send(body);
const patch = (session: TestSession, path: string, body: object, key: string = randomUUID()) =>
  request(api.server).patch(`/v1${path}`).set('Cookie', session.jar.header()).set('X-CSRF-Token', session.csrfToken).set('Origin', TEST_ORIGIN).set('Idempotency-Key', key).send(body);
const get = (session: TestSession, path: string) => consoleGet(api.server, session, `/v1${path}`);

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock });
  const dodowa = await createBranch(database);
  const branchId = dodowa.branchId;
  manager = await enrolAndLogin(api.server, await createUser(database, { name: 'Akosua Boateng', grants: [{ role: 'MANAGER', branchId }] }), () => clock.now());
  const ownerUser = await createUser(database, { name: 'Kwabena Owusu', grants: [{ role: 'OWNER', branchId }] });
  owner = await enrolAndLogin(api.server, ownerUser, () => clock.now());
  ownerActor = { principalId: ownerUser.principalId, kind: 'USER', displayName: 'Kwabena Owusu', realm: 'STAFF', sessionId: null, steppedUpAt: clock.now() };
  cashier = await login(api.server, await createUser(database, { name: 'Adwoa Darko', grants: [{ role: 'CASHIER', branchId, locationId: dodowa.shopId }] }));
  sales = await login(api.server, await createUser(database, { name: 'Esi Appiah', grants: [{ role: 'SALES', branchId }] }));
  driver = await login(api.server, await createUser(database, { name: 'Selorm Agbeko', grants: [{ role: 'DRIVER', branchId }] }));
});

afterAll(async () => {
  await api.close();
  await database.drop();
});

const category = (code: string, name: string, extra: object = {}) => ({ code, name, productLine: 'MEAT', glGroup: 'MEAT', taxCategoryId: TAX_CATEGORY.PROCESSED_MEAT, ...extra });

describe('wrong roles are refused on every catalogue write (ADR-0035)', () => {
  const someId = randomUUID();
  const writes: ReadonlyArray<readonly [string, 'POST' | 'PATCH', string, object]> = [
    ['createCategory', 'POST', '/categories', category('REFUSED', 'Refused')],
    ['updateCategory', 'PATCH', `/categories/${someId}`, { version: 1, name: 'Refused' }],
    ['archiveCategory', 'POST', `/categories/${someId}/archive`, { version: 1, reason: 'Refused' }],
    ['createSpecies', 'POST', '/species', { code: 'CATTLE', name: 'Cattle', trackingDefault: 'SERIAL' }],
    ['updateSpecies', 'PATCH', `/species/${someId}`, { version: 1, name: 'Refused' }],
    ['createGrade', 'POST', '/grades', { speciesId: someId, code: 'A', name: 'Refused' }],
    ['updateGrade', 'PATCH', `/grades/${someId}`, { version: 1, name: 'Refused' }],
    ['archiveGrade', 'POST', `/grades/${someId}/archive`, { version: 1, reason: 'Refused' }],
    ['createWeightBand', 'POST', '/weight-bands', { speciesId: someId, code: 'X', minKg: '1.000', maxKg: '2.000' }],
    ['updateWeightBand', 'PATCH', `/weight-bands/${someId}`, { version: 1, maxKg: '3.000' }],
    ['archiveWeightBand', 'POST', `/weight-bands/${someId}/archive`, { version: 1, reason: 'Refused' }],
    ['updateProduct', 'PATCH', `/products/${someId}`, { version: 1, name: 'Refused' }],
  ];

  it.each(writes)('%s: the Cashier and Sales are refused with 403 FORBIDDEN before anything is looked up', async (_operationId, method, path, body) => {
    for (const session of [cashier, sales]) {
      const refused = method === 'POST' ? await post(session, path, body) : await patch(session, path, body);
      expect(refused.status).toBe(403);
      expect(refused.body.error.code).toBe('FORBIDDEN');
    }
  });

  it('the Driver cannot read categories, species, grades or bands; the Cashier can', async () => {
    for (const path of ['/categories', '/species', '/grades', '/weight-bands']) {
      expect((await get(driver, path)).status).toBe(403);
      expect((await get(cashier, path)).status).toBe(200);
    }
  });

  it('records each refusal in the audit trail', async () => {
    const { rows } = await database.pool('admin').query<{ n: number }>(
      "SELECT count(*)::int AS n FROM platform.audit_event WHERE action = 'AUTHORISATION_FAILURE' AND metadata->>'permission' LIKE 'mdm.%'",
    );
    expect(rows[0]!.n).toBeGreaterThanOrEqual(writes.length * 2);
  });
});

describe('categories (FR-MDM-002)', () => {
  let meatId = '';
  let beefId = '';
  let beefVersion = 0;
  const products: string[] = [];

  it('creates a tree: Meat, and Beef under it, audited with before and after', async () => {
    const meat = await post(manager, '/categories', category('MEAT', 'Meat', { sortOrder: 20 }));
    expect(meat.status).toBe(201);
    expect(meat.body).toMatchObject({ parentId: null, code: 'MEAT', name: 'Meat', productLine: 'MEAT', glGroup: 'MEAT', taxCategory: { code: 'PROCESSED_MEAT' }, sortOrder: 20, isOnlineVisible: true, productCount: 0, version: 1 });
    meatId = meat.body.id;
    const beef = await post(manager, '/categories', category('BEEF', 'Beef', { parentId: meatId }));
    expect(beef.status).toBe(201);
    beefId = beef.body.id;
    beefVersion = beef.body.version;
    const audit = await database.pool('admin').query<{ before: Buffer | null; after: Buffer }>("SELECT before, after FROM platform.audit_event WHERE entity_type = 'Category' AND entity_id = $1", [beefId]);
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]!.before).toBeNull();
    expect(JSON.parse(audit.rows[0]!.after.toString('utf8'))).toMatchObject({ code: 'BEEF', parentId: meatId });
  });

  it('refuses a duplicate code and a name already used by a sibling, but allows the name under another parent', async () => {
    const sameCode = await post(manager, '/categories', category('BEEF', 'Cattle meat'));
    expect(sameCode.status).toBe(422);
    expect(sameCode.body.error).toMatchObject({ code: 'DUPLICATE_VALUE', details: [{ field: '/code' }] });
    const sameName = await post(manager, '/categories', category('BEEF-2', '  beef ', { parentId: meatId }));
    expect(sameName.body.error).toMatchObject({ code: 'DUPLICATE_VALUE', details: [{ field: '/name' }] });
    expect((await post(manager, '/categories', category('BEEF-ROOT', 'Beef'))).status).toBe(201);
    const unknownParent = await post(manager, '/categories', category('ORPHAN', 'Orphan', { parentId: randomUUID() }));
    expect(unknownParent.body.error).toMatchObject({ code: 'REFERENCE_NOT_FOUND', details: [{ field: '/parentId' }] });
  });

  it('the database refuses a sibling with the same name too', async () => {
    const refused = database
      .pool('app')
      .query("INSERT INTO mdm.category (id, parent_id, code, name, product_line, gl_group, tax_category_id, created_by, updated_by) VALUES ($1, $2, 'BEEF-SQL', 'BEEF', 'MEAT', 'MEAT', $3, $4, $4)", [
        randomUUID(),
        meatId,
        TAX_CATEGORY.PROCESSED_MEAT,
        SYSTEM_PRINCIPAL,
      ]);
    expect(await sqlStateOf(refused)).toBe('23505');
  });

  it('refuses to archive Meat while Beef has three live products, and Beef while it holds them', async () => {
    for (const name of ['Beef, 1 kg', 'Beef, stew', 'Beef, mince']) {
      const created = await post(manager, '/products', { name, categoryId: beefId, stockPolicy: 'CATCH_WEIGHT', baseUom: 'KG', saleUom: 'KG', onlineMode: 'LISTED' });
      expect(created.status).toBe(201);
      products.push(created.body.id);
    }
    const meat = await get(manager, `/categories/${meatId}`);
    const refusedMeat = await post(manager, `/categories/${meatId}/archive`, { version: meat.body.version, reason: 'Restructure' });
    expect(refusedMeat.status).toBe(422);
    expect(refusedMeat.body.error).toMatchObject({ code: 'RECORD_IN_USE', details: [{ field: null, code: 'HAS_LIVE_CHILDREN' }] });
    const beef = await get(manager, `/categories/${beefId}`);
    expect(beef.body.productCount).toBe(3);
    const refusedBeef = await post(manager, `/categories/${beefId}/archive`, { version: beef.body.version, reason: 'Restructure' });
    expect(refusedBeef.body.error).toMatchObject({ code: 'RECORD_IN_USE', details: [{ code: 'HAS_LIVE_PRODUCTS' }] });
  });

  it('archives the emptied Beef once its products move to Meat, and its history stays readable', async () => {
    for (const id of products) {
      const product = await get(manager, `/products/${id}`);
      expect((await patch(manager, `/products/${id}`, { version: product.body.version, categoryId: meatId })).status).toBe(200);
    }
    const stale = await post(manager, `/categories/${beefId}/archive`, { version: beefVersion + 7, reason: 'Merged into Meat' });
    expect(stale.status).toBe(409);
    const archived = await post(manager, `/categories/${beefId}/archive`, { version: beefVersion, reason: 'Merged into Meat' });
    expect(archived.status).toBe(200);
    expect(archived.body).toMatchObject({ id: beefId, productCount: 0, version: beefVersion + 1 });
    expect((await get(manager, `/categories/${beefId}`)).body.code).toBe('BEEF');
    const listed = await get(manager, '/categories?limit=100');
    expect(listed.body.data.map((row: { id: string }) => row.id)).not.toContain(beefId);
    const audit = await database.pool('admin').query<{ after: Buffer }>("SELECT after FROM platform.audit_event WHERE entity_id = $1 AND action = 'ARCHIVE'", [beefId]);
    expect(audit.rows.map((row) => JSON.parse(row.after.toString('utf8')).reason)).toEqual(['Merged into Meat']);
  });

  it('updates with the version it read, refuses a stale version with 409, and replays a repeated key', async () => {
    const meat = await get(manager, `/categories/${meatId}`);
    const key = randomUUID();
    const first = await patch(manager, `/categories/${meatId}`, { version: meat.body.version, name: 'Meat and offal', sortOrder: 5 }, key);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ name: 'Meat and offal', sortOrder: 5, version: meat.body.version + 1 });
    const replay = await patch(manager, `/categories/${meatId}`, { version: meat.body.version, name: 'Meat and offal', sortOrder: 5 }, key);
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(first.body);
    const stale = await patch(manager, `/categories/${meatId}`, { version: meat.body.version, name: 'Meat' });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('VERSION_CONFLICT');
  });
});

describe('units of measure (FR-MDM-003, CR-003)', () => {
  it('lists every unit with its display precision: none for counted units, three for weight and volume', async () => {
    const units = await get(cashier, '/units-of-measure?limit=100');
    expect(units.status).toBe(200);
    const decimals = Object.fromEntries(units.body.data.map((unit: { code: string; displayDecimals: number }) => [unit.code, unit.displayDecimals]));
    expect(decimals).toEqual({ BAG: 0, BUNCH: 0, CRATE: 0, HEAD: 0, KG: 3, LITRE: 3, PACK: 0, TUBER: 0, UNIT: 0 });
  });

  it('pages by code', async () => {
    const first = await get(cashier, '/units-of-measure?limit=4');
    expect(first.body.data.map((unit: { code: string }) => unit.code)).toEqual(['BAG', 'BUNCH', 'CRATE', 'HEAD']);
    const second = await get(cashier, `/units-of-measure?limit=4&cursor=${encodeURIComponent(first.body.page.nextCursor)}`);
    expect(second.body.data.map((unit: { code: string }) => unit.code)).toEqual(['KG', 'LITRE', 'PACK', 'TUBER']);
  });

  it('the database refuses a precision outside 0 to 3', async () => {
    expect(await sqlStateOf(database.pool('admin').query("UPDATE mdm.uom SET display_decimals = 4 WHERE code = 'KG'"))).toBe('23514');
  });
});

describe('species, grades and weight bands (FR-MDM-005)', () => {
  let goatId = '';
  let lowId = '';
  let highId = '';
  let gradeId = '';

  it('creates a species, refuses its code twice, and counts its grades and bands', async () => {
    const goat = await post(manager, '/species', { code: 'GOAT', name: 'Goat', trackingDefault: 'SERIAL' });
    expect(goat.status).toBe(201);
    expect(goat.body).toMatchObject({ code: 'GOAT', trackingDefault: 'SERIAL', gradeCount: 0, weightBandCount: 0, version: 1 });
    goatId = goat.body.id;
    expect((await post(manager, '/species', { code: 'GOAT', name: 'Goats', trackingDefault: 'SERIAL' })).body.error.code).toBe('DUPLICATE_VALUE');
    const renamed = await patch(manager, `/species/${goatId}`, { version: 1, name: 'Goat (West African Dwarf)' });
    expect(renamed.body).toMatchObject({ name: 'Goat (West African Dwarf)', version: 2 });
  });

  it('accepts 10.000 to 20.000 and 20.000 to 30.000 kg, and refuses 19.500 to 25.000 as an overlap', async () => {
    const low = await post(manager, '/weight-bands', { speciesId: goatId, code: 'GOAT-M', minKg: '10.000', maxKg: '20.000' });
    expect(low.status).toBe(201);
    expect(low.body).toMatchObject({ minKg: '10.000', maxKg: '20.000', version: 1 });
    lowId = low.body.id;
    const high = await post(manager, '/weight-bands', { speciesId: goatId, code: 'GOAT-L', minKg: '20.000', maxKg: '30.000' });
    expect(high.status).toBe(201);
    highId = high.body.id;
    const overlap = await post(manager, '/weight-bands', { speciesId: goatId, code: 'GOAT-X', minKg: '19.500', maxKg: '25.000' });
    expect(overlap.status).toBe(422);
    expect(overlap.body.error).toMatchObject({ code: 'WEIGHT_BAND_INVALID', details: [{ field: '/minKg', code: 'OVERLAPS_BAND:GOAT-M' }, { field: '/minKg', code: 'OVERLAPS_BAND:GOAT-L' }] });
  });

  it('the database refuses the overlapping band too', async () => {
    const refused = database
      .pool('app')
      .query("INSERT INTO mdm.weight_band (id, species_id, code, min_kg, max_kg, created_by, updated_by) VALUES ($1, $2, 'GOAT-X', 19.500, 25.000, $3, $3)", [randomUUID(), goatId, SYSTEM_PRINCIPAL]);
    expect(await sqlStateOf(refused)).toBe('23P01');
  });

  it('refuses an empty range and a weight not to three places', async () => {
    const empty = await post(manager, '/weight-bands', { speciesId: goatId, code: 'GOAT-E', minKg: '40.000', maxKg: '40.000' });
    expect(empty.body.error).toMatchObject({ code: 'WEIGHT_BAND_INVALID', details: [{ field: '/maxKg', code: 'NOT_ABOVE_MIN' }] });
    expect((await post(manager, '/weight-bands', { speciesId: goatId, code: 'GOAT-P', minKg: '40.0', maxKg: '50.000' })).status).toBe(400);
  });

  it('creates and lists grades for the species, and the species counts them', async () => {
    const grade = await post(manager, '/grades', { speciesId: goatId, code: 'A', name: 'Grade A, well finished', description: 'Good body condition', sortOrder: 1 });
    expect(grade.status).toBe(201);
    gradeId = grade.body.id;
    expect((await post(manager, '/grades', { speciesId: goatId, code: 'A', name: 'Again' })).body.error.code).toBe('DUPLICATE_VALUE');
    expect((await post(manager, '/grades', { speciesId: randomUUID(), code: 'A', name: 'Nobody' })).body.error).toMatchObject({ code: 'REFERENCE_NOT_FOUND', details: [{ field: '/speciesId' }] });
    const listed = await get(cashier, `/grades?speciesId=${goatId}`);
    expect(listed.body.data).toEqual([expect.objectContaining({ id: gradeId, code: 'A', description: 'Good body condition', sortOrder: 1 })]);
    const bands = await get(cashier, `/weight-bands?speciesId=${goatId}`);
    expect(bands.body.data.map((band: { code: string }) => band.code)).toEqual(['GOAT-M', 'GOAT-L']);
    const species = await get(cashier, '/species');
    expect(species.body.data.find((row: { id: string }) => row.id === goatId)).toMatchObject({ gradeCount: 1, weightBandCount: 2 });
  });

  it('keeps a band and a grade that an active price prices with: no archive, no range move; a free band moves', async () => {
    const goat = await post(manager, '/products', { name: 'Goat', categoryId: (await get(manager, '/categories')).body.data[0].id, stockPolicy: 'SERIALISED', speciesId: goatId, baseUom: 'HEAD', saleUom: 'HEAD', onlineMode: 'REQUEST_TO_BUY' });
    expect(goat.status).toBe(201);
    const list = await post(manager, '/price-lists', { code: 'BASE', name: 'Base prices', kind: 'BASE', taxInclusive: true });
    const version = await post(manager, `/price-lists/${list.body.id}/versions`, { validFrom: clock.now().toISOString() });
    const entries = await request(api.server)
      .put(`/v1/price-list-versions/${version.body.id}/entries`)
      .set('Cookie', manager.jar.header())
      .set('X-CSRF-Token', manager.csrfToken)
      .set('Origin', TEST_ORIGIN)
      .set('Idempotency-Key', randomUUID())
      .send({ version: version.body.version, entries: [{ productId: goat.body.id, gradeId, weightBandId: lowId, basis: 'PER_HEAD', listPricePesewas: 65_000, floorPricePesewas: 40_000, ceilingPricePesewas: 90_000 }] });
    expect(entries.status).toBe(200);
    const submitted = await post(manager, `/price-list-versions/${version.body.id}/submit`, {});
    expect(submitted.status).toBe(202);
    await runWithRequestContext({ correlationId: randomUUID(), ip: '127.0.0.1', userAgent: 'test', actor: ownerActor }, () =>
      api.app.get(UnitOfWork).run({ isolation: 'serializable' }, (tx) => api.app.get(Approvals).decide(tx, ownerActor, submitted.body.approvalRequestId, 'APPROVED', null)),
    );

    const band = await get(manager, `/weight-bands?speciesId=${goatId}`);
    const low = band.body.data.find((row: { id: string }) => row.id === lowId);
    const moved = await patch(manager, `/weight-bands/${lowId}`, { version: low.version, minKg: '9.000' });
    expect(moved.status).toBe(422);
    expect(moved.body.error).toMatchObject({ code: 'RECORD_IN_USE', details: [{ field: '/minKg', code: 'USED_BY_LIVE_PRICES' }] });
    expect((await post(manager, `/weight-bands/${lowId}/archive`, { version: low.version, reason: 'Re-banding' })).body.error.code).toBe('RECORD_IN_USE');
    expect((await post(manager, `/grades/${gradeId}/archive`, { version: 1, reason: 'Re-grading' })).body.error).toMatchObject({ code: 'RECORD_IN_USE', details: [{ code: 'USED_BY_LIVE_PRICES' }] });

    const high = band.body.data.find((row: { id: string }) => row.id === highId);
    const widened = await patch(manager, `/weight-bands/${highId}`, { version: high.version, maxKg: '35.000' });
    expect(widened.status).toBe(200);
    expect(widened.body).toMatchObject({ minKg: '20.000', maxKg: '35.000', version: high.version + 1 });
    const intoLow = await patch(manager, `/weight-bands/${highId}`, { version: high.version + 1, minKg: '19.000' });
    expect(intoLow.body.error).toMatchObject({ code: 'WEIGHT_BAND_INVALID', details: [{ code: 'OVERLAPS_BAND:GOAT-M' }] });
    const archived = await post(manager, `/weight-bands/${highId}/archive`, { version: high.version + 1, reason: 'Re-banding' });
    expect(archived.status).toBe(200);
    expect((await get(cashier, `/weight-bands?speciesId=${goatId}`)).body.data.map((row: { code: string }) => row.code)).toEqual(['GOAT-M']);
  });
});

describe('updateProduct (FR-MDM-001, FR-MDM-004)', () => {
  let productId = '';
  let eggsCategory = '';

  it('changes the name and online mode, publishes mdm.ProductChanged naming the fields, and audits before and after', async () => {
    eggsCategory = (await post(manager, '/categories', { code: 'EGGS', name: 'Eggs', productLine: 'PRODUCE', glGroup: 'PRODUCE_EGGS', taxCategoryId: TAX_CATEGORY.EGGS })).body.id;
    const created = await post(manager, '/products', { name: 'Eggs, big', categoryId: eggsCategory, stockPolicy: 'COUNTABLE', baseUom: 'CRATE', saleUom: 'CRATE', shelfLifeDays: 21, onlineMode: 'HIDDEN' });
    productId = created.body.id;
    const changed = await patch(manager, `/products/${productId}`, { version: 1, name: 'Eggs, big, crate of 30', onlineMode: 'LISTED' });
    expect(changed.status).toBe(200);
    expect(changed.body).toMatchObject({ name: 'Eggs, big, crate of 30', onlineMode: 'LISTED', tracking: 'LOT', stockPolicy: 'COUNTABLE', taxCategory: { code: 'EGGS' }, version: 2 });
    const admin = database.pool('admin');
    const event = await admin.query("SELECT payload FROM platform.outbox_message WHERE event_type = 'mdm.ProductChanged' AND subject_id = $1", [productId]);
    expect(event.rows).toEqual([{ payload: expect.objectContaining({ productId, changedFields: ['name', 'onlineMode'], version: 2, status: 'ACTIVE' }) }]);
    const audit = await admin.query<{ before: Buffer; after: Buffer }>("SELECT before, after FROM platform.audit_event WHERE entity_id = $1 AND action = 'UPDATE'", [productId]);
    expect(audit.rows.map((row) => [JSON.parse(row.before.toString('utf8')).name, JSON.parse(row.after.toString('utf8')).name])).toEqual([['Eggs, big', 'Eggs, big, crate of 30']]);
  });

  it('discontinues and reinstates a product, and never returns it to DRAFT', async () => {
    const discontinued = await patch(manager, `/products/${productId}`, { version: 2, status: 'DISCONTINUED' });
    expect(discontinued.body.status).toBe('DISCONTINUED');
    const draft = await patch(manager, `/products/${productId}`, { version: 3, status: 'DRAFT' });
    expect(draft.status).toBe(422);
    expect(draft.body.error).toMatchObject({ code: 'INVALID_STATE_TRANSITION', details: [{ field: '/status' }] });
    expect((await patch(owner, `/products/${productId}`, { version: 3, status: 'ACTIVE' })).body.status).toBe('ACTIVE');
  });

  it('refuses a change that contradicts the policy, a stale version, and an unknown category', async () => {
    const pack = await patch(manager, `/products/${productId}`, { version: 4, nominalPackKg: '15.000' });
    expect(pack.body.error).toMatchObject({ code: 'STOCK_POLICY_CONFLICT', details: [{ field: '/nominalPackKg', code: 'ONLY_FOR_CATCH_WEIGHT' }] });
    expect((await patch(manager, `/products/${productId}`, { version: 1, name: 'Old' })).status).toBe(409);
    expect((await patch(manager, `/products/${productId}`, { version: 4, categoryId: randomUUID() })).body.error.code).toBe('REFERENCE_NOT_FOUND');
    expect((await patch(manager, `/products/${randomUUID()}`, { version: 1, name: 'Nobody' })).status).toBe(404);
    expect((await patch(manager, `/products/${productId}`, { version: 4, stockPolicy: 'CATCH_WEIGHT' })).status).toBe(400);
    expect((await get(manager, `/products/${productId}`)).body).toMatchObject({ version: 4, stockPolicy: 'COUNTABLE', nominalPackKg: null });
  });

  it('takes no barcode from 2.0.0 (B09q, ADR-0072): a change that sends one is 400, an unknown field', async () => {
    const refused = await patch(manager, `/products/${productId}`, { version: 4, barcode: '6034000123456' });
    expect(refused.status).toBe(400);
    expect(refused.body.error.details).toEqual([expect.objectContaining({ field: '/barcode', code: 'UNKNOWN_FIELD' })]);
    expect((await get(manager, `/products/${productId}`)).body).toMatchObject({ version: 4 });
  });
});
