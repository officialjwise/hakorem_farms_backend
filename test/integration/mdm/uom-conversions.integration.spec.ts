import { randomUUID } from 'node:crypto';
import { ManualClock, Quantity } from '@hakorem/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MasterDataRefs } from '../../../src/modules/mdm';
import { UnitOfWork } from '../../../src/platform/database/unit-of-work';
import { createCatalogue, type TestCatalogue } from '../../support/catalogue';
import { consoleGet, consolePost, createBranch, createUser, enrolAndLogin, login, relaxRateLimits, SYSTEM_PRINCIPAL, testStartTime, type RoleCode, type TestSession } from '../../support/iam';
import { SQLSTATE, sqlStateOf } from '../../support/sql-state';
import { startTestApp, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * A product's alternative units (FR-MDM-003, CR-011, A-157, A-163): an exact numerator and denominator to the base unit,
 * refused by the database when it is not exact, listed in the contract, managed by the Owner and the Manager only, and
 * read by other modules through MasterDataRefs. Farm terms: a 50 kg bag of feed, a crate of 30 eggs.
 */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let catalogue: TestCatalogue;
let manager: TestSession;
let owner: TestSession;
const refusedRoles = new Map<RoleCode, TestSession>();
let feedId = '';
let eggsId = '';
let goatMeatId = '';
let goatId = '';
let yamId = '';

const post = (session: TestSession, path: string, body: object, key: string = randomUUID()) => consolePost(api.server, session, `/v1${path}`, key).send(body);
const get = (session: TestSession, path: string) => consoleGet(api.server, session, `/v1${path}`);

async function product(body: object): Promise<string> {
  const created = await post(manager, '/products', { onlineMode: 'HIDDEN', ...body });
  expect(created.status).toBe(201);
  return created.body.id as string;
}

function toBase(productId: string, uom: string, quantity: string): Promise<string> {
  return api.app.get(UnitOfWork).run({ isolation: 'read committed' }, async (tx) => {
    const result = await api.app.get(MasterDataRefs).toBaseIn(tx, productId, uom, Quantity.parse(quantity));
    return result.ok ? result.value.toDecimalString() : result.error;
  });
}

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock });
  catalogue = await createCatalogue(database);
  const dodowa = await createBranch(database);
  const branchId = dodowa.branchId;
  manager = await enrolAndLogin(api.server, await createUser(database, { name: 'Akosua Boateng', grants: [{ role: 'MANAGER', branchId }] }), () => clock.now());
  owner = await enrolAndLogin(api.server, await createUser(database, { name: 'Kwabena Owusu', grants: [{ role: 'OWNER', branchId }] }), () => clock.now());
  const people: ReadonlyArray<readonly [RoleCode, string]> = [
    ['ACCOUNTANT', 'Efua Mensah'],
    ['STOREKEEPER', 'Yaw Asante'],
    ['CASHIER', 'Adwoa Darko'],
    ['SALES', 'Esi Appiah'],
    ['FARM_HAND', 'Kofi Tetteh'],
    ['DRIVER', 'Selorm Agbeko'],
    ['INVESTOR', 'Nana Ama Ofori'],
  ];
  for (const [role, name] of people) {
    const user = await createUser(database, { name, grants: [{ role, branchId }] });
    refusedRoles.set(role, role === 'ACCOUNTANT' ? await enrolAndLogin(api.server, user, () => clock.now()) : await login(api.server, user));
  }
  feedId = await product({ sku: 'FEED-BRL-GROWER', name: 'Broiler grower pellets, per kg', categoryId: catalogue.eggsCategoryId, stockPolicy: 'COUNTABLE', baseUom: 'KG', saleUom: 'KG' });
  eggsId = await product({ sku: 'EGG-LOCAL-UNIT', name: 'Eggs, local, each', categoryId: catalogue.eggsCategoryId, stockPolicy: 'COUNTABLE', baseUom: 'UNIT', saleUom: 'CRATE' });
  goatMeatId = await product({ sku: 'MEAT-GOAT-15KG', name: 'Goat meat, 15 kg pack', categoryId: catalogue.meatCategoryId, stockPolicy: 'CATCH_WEIGHT', baseUom: 'KG', saleUom: 'PACK', nominalPackKg: '15.000' });
  goatId = await product({ sku: 'LIV-GOAT', name: 'Goat', categoryId: catalogue.liveCategoryId, stockPolicy: 'SERIALISED', speciesId: catalogue.goatSpeciesId, baseUom: 'HEAD', saleUom: 'HEAD' });
  yamId = await product({ sku: 'PRD-YAM-TUBER', name: 'Yam, per tuber', categoryId: catalogue.eggsCategoryId, stockPolicy: 'COUNTABLE', baseUom: 'TUBER', saleUom: 'TUBER' });
});

afterAll(async () => {
  await api.close();
  await database.drop();
});

describe('wrong roles are refused on every conversion write (ADR-0035)', () => {
  it('createUomConversion and archiveUomConversion refuse every role but the Owner and the Manager with 403', async () => {
    for (const [role, session] of refusedRoles) {
      const create = await post(session, '/uom-conversions', { productId: feedId, fromUom: 'BAG', numerator: 50, denominator: 1 });
      expect([role, create.status, create.body.error?.code]).toEqual([role, 403, 'FORBIDDEN']);
      const archive = await post(session, `/uom-conversions/${randomUUID()}/archive`, { version: 1, reason: 'Refused' });
      expect([role, archive.status, archive.body.error?.code]).toEqual([role, 403, 'FORBIDDEN']);
    }
    const { rows } = await database.pool('admin').query<{ n: number }>("SELECT count(*)::int AS n FROM mdm.product_uom_conversion");
    expect(rows[0]!.n).toBe(0);
  });

  it('every staff role that reads products lists conversions; the Investor does not', async () => {
    for (const [role, session] of refusedRoles) {
      expect([role, (await get(session, '/uom-conversions')).status]).toEqual([role, role === 'INVESTOR' ? 403 : 200]);
    }
  });
});

describe('making a conversion (FR-MDM-003)', () => {
  let bagId = '';

  it('makes a 50 kg bag of feed, exact, audited, and published as a product change', async () => {
    const made = await post(manager, '/uom-conversions', { productId: feedId, fromUom: 'BAG', numerator: 50, denominator: 1 });
    expect(made.status).toBe(201);
    expect(made.body).toEqual({
      id: expect.any(String),
      product: { id: feedId, sku: 'FEED-BRL-GROWER', name: 'Broiler grower pellets, per kg' },
      fromUom: 'BAG',
      toUom: 'KG',
      numerator: 50,
      denominator: 1,
      factor: '50.000',
      version: 1,
      createdAt: expect.any(String),
      archivedAt: null,
      archiveReason: null,
    });
    bagId = made.body.id;
    const admin = database.pool('admin');
    const audit = await admin.query<{ before: Buffer | null; after: Buffer }>("SELECT before, after FROM platform.audit_event WHERE entity_type = 'UomConversion' AND entity_id = $1", [bagId]);
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]!.before).toBeNull();
    expect(JSON.parse(audit.rows[0]!.after.toString('utf8'))).toMatchObject({ productId: feedId, fromUom: 'BAG', toUom: 'KG', numerator: 50, denominator: 1 });
    const events = await admin.query("SELECT payload FROM platform.outbox_message WHERE event_type = 'mdm.ProductChanged' AND subject_id = $1", [feedId]);
    expect(events.rows).toEqual([{ payload: expect.objectContaining({ productId: feedId, changedFields: ['uomConversions'] }) }]);
  });

  it('answers a replay with the stored conversion and makes nothing new', async () => {
    const key = randomUUID();
    const first = await post(owner, '/uom-conversions', { productId: eggsId, fromUom: 'CRATE', numerator: 30, denominator: 1 }, key);
    expect(first.status).toBe(201);
    const again = await post(owner, '/uom-conversions', { productId: eggsId, fromUom: 'CRATE', numerator: 30, denominator: 1 }, key);
    expect(again.status).toBe(201);
    expect(again.body.id).toBe(first.body.id);
    const { rows } = await database.pool('admin').query<{ n: number }>('SELECT count(*)::int AS n FROM mdm.product_uom_conversion WHERE product_id = $1', [eggsId]);
    expect(rows[0]!.n).toBe(1);
  });

  it('keeps the factor in lowest terms: a 125 g pack of pellets, sent as 250/2000 kg, is stored as 1/8, 0.125', async () => {
    const bunch = await post(manager, '/uom-conversions', { productId: feedId, fromUom: 'PACK', numerator: 250, denominator: 2000 });
    expect(bunch.status).toBe(201);
    expect(bunch.body).toMatchObject({ numerator: 1, denominator: 8, factor: '0.125' });
  });

  it('refuses a factor of a third, which has no exact value to three places', async () => {
    for (const [numerator, denominator] of [
      [1, 3],
      [3_333_333, 10_000_000],
    ] as const) {
      const refused = await post(manager, '/uom-conversions', { productId: yamId, fromUom: 'BAG', numerator, denominator });
      expect(refused.status).toBe(422);
      expect(refused.body.error).toMatchObject({ code: 'UOM_CONVERSION_INVALID', details: [{ field: '/denominator', code: 'INEXACT_FACTOR' }] });
    }
  });

  it('refuses a pack-to-kilogram factor on catch-weight meat, and any conversion of a goat', async () => {
    const pack = await post(manager, '/uom-conversions', { productId: goatMeatId, fromUom: 'PACK', numerator: 15, denominator: 1 });
    expect(pack.status).toBe(422);
    expect(pack.body.error).toMatchObject({ code: 'UOM_CONVERSION_INVALID', details: [{ field: '/productId', code: 'NOT_COUNTABLE' }] });
    const goat = await post(manager, '/uom-conversions', { productId: goatId, fromUom: 'UNIT', numerator: 1, denominator: 1 });
    expect(goat.body.error).toMatchObject({ code: 'UOM_CONVERSION_INVALID', details: [{ field: '/productId', code: 'NOT_COUNTABLE' }] });
  });

  it('refuses the base unit itself, a weighed unit, a second live conversion of one unit, and unknown records', async () => {
    const base = await post(manager, '/uom-conversions', { productId: feedId, fromUom: 'KG', numerator: 1, denominator: 1 });
    expect(base.body.error).toMatchObject({ code: 'UOM_CONVERSION_INVALID', details: [{ field: '/fromUom', code: 'BASE_UNIT' }] });
    const weighed = await post(manager, '/uom-conversions', { productId: yamId, fromUom: 'KG', numerator: 1, denominator: 1 });
    expect(weighed.body.error).toMatchObject({ code: 'UOM_CONVERSION_INVALID', details: [{ field: '/fromUom', code: 'NOT_COUNTED' }] });
    const second = await post(manager, '/uom-conversions', { productId: feedId, fromUom: 'BAG', numerator: 25, denominator: 1 });
    expect(second.status).toBe(422);
    expect(second.body.error).toMatchObject({ code: 'DUPLICATE_VALUE', details: [{ field: '/fromUom', code: 'TAKEN' }] });
    const noUnit = await post(manager, '/uom-conversions', { productId: feedId, fromUom: 'BARREL', numerator: 1, denominator: 1 });
    expect(noUnit.body.error).toMatchObject({ code: 'REFERENCE_NOT_FOUND', details: [{ field: '/fromUom' }] });
    const noProduct = await post(manager, '/uom-conversions', { productId: randomUUID(), fromUom: 'BAG', numerator: 1, denominator: 1 });
    expect(noProduct.body.error).toMatchObject({ code: 'REFERENCE_NOT_FOUND', details: [{ field: '/productId' }] });
  });

  it('refuses a factor that is zero, negative or not a whole number at the boundary', async () => {
    for (const body of [
      { numerator: 0, denominator: 1 },
      { numerator: 50, denominator: -1 },
      { numerator: 0.5, denominator: 1 },
      { numerator: '50', denominator: 1 },
    ]) {
      const refused = await post(manager, '/uom-conversions', { productId: yamId, fromUom: 'BAG', ...body });
      expect(refused.status).toBe(400);
      expect(refused.body.error.code).toBe('VALIDATION_FAILED');
    }
  });

  it('lists live conversions of one product in the order they were made, with cursor pages', async () => {
    const listed = await get(manager, `/uom-conversions?productId=${feedId}&limit=1`);
    expect(listed.status).toBe(200);
    expect(listed.body.data.map((row: { fromUom: string }) => row.fromUom)).toEqual(['BAG']);
    expect(listed.body.page).toMatchObject({ limit: 1, hasMore: true });
    const next = await get(manager, `/uom-conversions?productId=${feedId}&limit=1&cursor=${encodeURIComponent(listed.body.page.nextCursor)}`);
    expect(next.body.data.map((row: { fromUom: string }) => row.fromUom)).toEqual(['PACK']);
    expect(next.body.page.hasMore).toBe(false);
    const all = await get(manager, '/uom-conversions');
    expect(all.body.data.map((row: { product: { sku: string }; fromUom: string }) => `${row.product.sku}:${row.fromUom}`)).toEqual([
      'FEED-BRL-GROWER:BAG',
      'EGG-LOCAL-UNIT:CRATE',
      'FEED-BRL-GROWER:PACK',
    ]);
  });

  it('archives a conversion with its version and reason, then takes a new factor for the unit; the old one stays readable', async () => {
    const stale = await post(manager, `/uom-conversions/${bagId}/archive`, { version: 7, reason: 'Supplier now packs 25 kg bags' });
    expect(stale.status).toBe(409);
    const archived = await post(manager, `/uom-conversions/${bagId}/archive`, { version: 1, reason: 'Supplier now packs 25 kg bags' });
    expect(archived.status).toBe(200);
    expect(archived.body).toMatchObject({ id: bagId, version: 2, archivedAt: expect.any(String), archiveReason: 'Supplier now packs 25 kg bags' });
    const twice = await post(manager, `/uom-conversions/${bagId}/archive`, { version: 2, reason: 'Again' });
    expect(twice.status).toBe(404);
    const missing = await post(manager, `/uom-conversions/${randomUUID()}/archive`, { version: 1, reason: 'No such conversion' });
    expect(missing.status).toBe(404);
    const replaced = await post(manager, '/uom-conversions', { productId: feedId, fromUom: 'BAG', numerator: 25, denominator: 1 });
    expect(replaced.status).toBe(201);
    const live = await get(manager, `/uom-conversions?productId=${feedId}`);
    expect(live.body.data.map((row: { fromUom: string; factor: string }) => `${row.fromUom}:${row.factor}`)).toEqual(['PACK:0.125', 'BAG:25.000']);
    const withArchived = await get(manager, `/uom-conversions?productId=${feedId}&includeArchived=true`);
    expect(withArchived.body.data.map((row: { fromUom: string; factor: string; archivedAt: string | null }) => `${row.fromUom}:${row.factor}:${row.archivedAt === null ? 'live' : 'archived'}`)).toEqual([
      'BAG:50.000:archived',
      'PACK:0.125:live',
      'BAG:25.000:live',
    ]);
    const audit = await database.pool('admin').query("SELECT action FROM platform.audit_event WHERE entity_type = 'UomConversion' AND entity_id = $1 ORDER BY recorded_at", [bagId]);
    expect(audit.rows.map((row: { action: string }) => row.action)).toEqual(['CREATE', 'ARCHIVE']);
  });
});

describe('other modules convert through MasterDataRefs', () => {
  it('converts 3 crates of 30 to 90 eggs and 4 bags of 25 kg to 100 kg, and passes the base unit through', async () => {
    expect(await toBase(eggsId, 'CRATE', '3.000')).toBe('90.000');
    expect(await toBase(feedId, 'BAG', '4.000')).toBe('100.000');
    expect(await toBase(feedId, 'KG', '12.345')).toBe('12.345');
  });

  it('refuses a quantity that would need a fourth decimal place, and a unit with no live conversion', async () => {
    expect(await toBase(feedId, 'PACK', '0.001')).toBe('INEXACT_QUANTITY');
    expect(await toBase(feedId, 'CRATE', '1.000')).toBe('NO_CONVERSION');
    expect(await toBase(goatMeatId, 'PACK', '2.000')).toBe('NO_CONVERSION');
    expect(await toBase(randomUUID(), 'KG', '1.000')).toBe('NO_PRODUCT');
  });
});

describe('the database holds the rules, whoever writes (migration 0090)', () => {
  const insert = (productId: string, fromUom: string, toUom: string, numerator: number, denominator: number) =>
    database
      .pool('app')
      .query('INSERT INTO mdm.product_uom_conversion (id, product_id, from_uom, to_uom, numerator, denominator, created_by, updated_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $7)', [
        randomUUID(),
        productId,
        fromUom,
        toUom,
        numerator,
        denominator,
        SYSTEM_PRINCIPAL,
      ]);

  it('refuses an inexact factor, and one not in lowest terms', async () => {
    expect(await sqlStateOf(insert(yamId, 'BAG', 'TUBER', 1, 3))).toBe(SQLSTATE.checkViolation);
    expect(await sqlStateOf(insert(yamId, 'BAG', 'TUBER', 3_333_333, 10_000_000))).toBe(SQLSTATE.checkViolation);
    expect(await sqlStateOf(insert(yamId, 'BAG', 'TUBER', 60, 2))).toBe(SQLSTATE.checkViolation);
    expect(await sqlStateOf(insert(yamId, 'BAG', 'TUBER', 0, 1))).toBe(SQLSTATE.checkViolation);
  });

  it('refuses a catch-weight product, a unit other than the base unit as the target, and a weighed alternative unit', async () => {
    expect(await sqlStateOf(insert(goatMeatId, 'PACK', 'KG', 15, 1))).toBe('HK010');
    expect(await sqlStateOf(insert(goatId, 'UNIT', 'HEAD', 1, 1))).toBe('HK010');
    expect(await sqlStateOf(insert(yamId, 'BAG', 'KG', 20, 1))).toBe('HK010');
    expect(await sqlStateOf(insert(yamId, 'KG', 'TUBER', 2, 1))).toBe('HK010');
  });

  it('refuses a second live conversion of one unit', async () => {
    expect(await sqlStateOf(insert(eggsId, 'CRATE', 'UNIT', 12, 1))).toBe(SQLSTATE.uniqueViolation);
  });

  it('never changes a conversion: its factor and units are fixed, and an archived one is final', async () => {
    const app = database.pool('app');
    expect(await sqlStateOf(app.query('UPDATE mdm.product_uom_conversion SET numerator = 60 WHERE product_id = $1', [eggsId]))).toBe(SQLSTATE.documentFrozen);
    expect(await sqlStateOf(app.query("UPDATE mdm.product_uom_conversion SET delete_reason = 'Rewritten' WHERE deleted_at IS NOT NULL"))).toBe(SQLSTATE.documentFrozen);
    expect(await sqlStateOf(app.query('DELETE FROM mdm.product_uom_conversion'))).toBe(SQLSTATE.insufficientPrivilege);
  });
});
