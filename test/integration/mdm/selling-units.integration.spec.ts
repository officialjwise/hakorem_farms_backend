import { randomUUID } from 'node:crypto';
import { ManualClock } from '@hakorem/kernel';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Approvals } from '../../../src/modules/iam';
import { runWithRequestContext, type Actor } from '../../../src/platform/context/request-context';
import { UnitOfWork } from '../../../src/platform/database/unit-of-work';
import { createCatalogue, TAX_CATEGORY } from '../../support/catalogue';
import { consoleGet, consolePost, createBranch, createUser, enrolAndLogin, login, relaxRateLimits, SYSTEM_PRINCIPAL, testStartTime, type TestSession } from '../../support/iam';
import { SQLSTATE, sqlStateOf } from '../../support/sql-state';
import { startTestApp, TEST_ORIGIN, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * B09e, the owner's decisions 1 and 6 (2026-11-17), through the API: a crate and a single egg each carry their own price
 * on the price list, never one derived from the other, while stock stays in eggs; a quantity break is counted in the
 * selling unit (10 crates) and stored in eggs (300). Every write refuses the wrong role.
 */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let branchId: string;
let manager: TestSession;
let cashier: TestSession;
let ownerActor: Actor;
let eggsId: string;
let versionId: string;

const actor = (principalId: string, displayName: string, steppedUpAt: Date | null): Actor => ({ principalId, kind: 'USER', displayName, realm: 'STAFF', sessionId: null, steppedUpAt });
const post = (session: TestSession, path: string, body: object, key: string = randomUUID()) => consolePost(api.server, session, `/v1${path}`, key).send(body);
const put = (session: TestSession, path: string, body: object) =>
  request(api.server).put(`/v1${path}`).set('Cookie', session.jar.header()).set('X-CSRF-Token', session.csrfToken).set('Origin', TEST_ORIGIN).set('Idempotency-Key', randomUUID()).send(body);
const resolve = (lines: object[]) => post(cashier, '/pricing/resolve', { channel: 'POS', branchId, lines });
const egg = (fields: object = {}) => ({ productId: eggsId, basis: 'PER_UNIT', listPricePesewas: 200, floorPricePesewas: 200, ceilingPricePesewas: 220, ...fields });
const crate = (fields: object = {}) => egg({ uom: 'CRATE', listPricePesewas: 5_500, floorPricePesewas: 5_000, ceilingPricePesewas: 6_000, ...fields });

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock });
  const dodowa = await createBranch(database);
  branchId = dodowa.branchId;
  const catalogue = await createCatalogue(database);
  const app = database.pool('app');
  eggsId = randomUUID();
  // Eggs held one by one (base unit UNIT) and sold by the crate of 30 (SEED-like test data).
  await app.query(
    `INSERT INTO mdm.product (id, sku, name, category_id, stock_policy, tracking, base_uom, sale_uom, tax_category_id, gl_group, online_mode, status, created_by, updated_by)
     VALUES ($1, 'EGG-0009', 'Eggs, test', $2, 'COUNTABLE', 'NONE', 'UNIT', 'CRATE', $3, 'PRODUCE_EGGS', 'HIDDEN', 'ACTIVE', $4, $4)`,
    [eggsId, catalogue.eggsCategoryId, TAX_CATEGORY.EGGS, SYSTEM_PRINCIPAL],
  );
  await app.query(
    "INSERT INTO mdm.product_uom_conversion (id, product_id, from_uom, to_uom, numerator, denominator, created_by, updated_by) VALUES ($1, $2, 'CRATE', 'UNIT', 30, 1, $3, $3)",
    [randomUUID(), eggsId, SYSTEM_PRINCIPAL],
  );
  const managerUser = await createUser(database, { name: 'Akosua Boateng', grants: [{ role: 'MANAGER', branchId }] });
  manager = await enrolAndLogin(api.server, managerUser, () => clock.now());
  const ownerUser = await createUser(database, { name: 'Kwabena Owusu', grants: [{ role: 'OWNER', branchId }] });
  await enrolAndLogin(api.server, ownerUser, () => clock.now());
  ownerActor = actor(ownerUser.principalId, 'Kwabena Owusu', clock.now());
  cashier = await login(api.server, await createUser(database, { name: 'Adwoa Darko', grants: [{ role: 'CASHIER', branchId, locationId: dodowa.shopId }] }));
  const list = await post(manager, '/price-lists', { code: 'BASE', name: 'Base prices', kind: 'BASE', taxInclusive: true });
  versionId = (await post(manager, `/price-lists/${list.body.id}/versions`, { validFrom: clock.now().toISOString() })).body.id;
});

afterAll(async () => {
  await api.close();
  await database.drop();
});

describe('entries per selling unit (decisions 1 and 6)', () => {
  it('refuses the cashier, who lacks mdm.price_list.update, and writes nothing (ADR-0035)', async () => {
    const refused = await put(cashier, `/price-list-versions/${versionId}/entries`, { version: 1, entries: [crate()] });
    expect(refused.status).toBe(403);
    expect((await database.pool('app').query('SELECT count(*)::int AS n FROM mdm.price_list_entry WHERE version_id = $1', [versionId])).rows[0].n).toBe(0);
  });

  it('refuses a unit the product is not sold by, and a unit on a per-kilogram price', async () => {
    const refused = await put(manager, `/price-list-versions/${versionId}/entries`, { version: 1, entries: [crate({ uom: 'BAG' }), crate({ basis: 'PER_KG' })] });
    expect(refused.status).toBe(422);
    expect(refused.body.error).toMatchObject({
      code: 'PRICE_ENTRY_INVALID',
      details: [
        { field: '/entries/0/uom', code: 'NO_CONVERSION' },
        { field: '/entries/1/uom', code: 'NOT_PER_KG' },
      ],
    });
  });

  it('keeps a crate at 5,500, 10 crates at 5,250 and a single egg at 200 side by side, the break counted in crates and stored in eggs', async () => {
    const replaced = await put(manager, `/price-list-versions/${versionId}/entries`, {
      version: 1,
      entries: [crate(), crate({ minQty: '10.000', listPricePesewas: 5_250 }), egg()],
    });
    expect(replaced.status).toBe(200);
    const listed = await consoleGet(api.server, manager, `/v1/price-list-versions/${versionId}/entries`);
    const rows = (listed.body.data as { uom: string; minQty: string; minQtyBase: string; listPricePesewas: number; id: string }[]).map((e) => [e.uom, e.minQty, e.minQtyBase, e.listPricePesewas]);
    expect(rows).toEqual(
      expect.arrayContaining([
        ['CRATE', '0.000', '0.000', 5_500],
        ['CRATE', '10.000', '300.000', 5_250],
        ['UNIT', '0.000', '0.000', 200],
      ]),
    );
    expect(rows).toHaveLength(3);
    const stored = await database.pool('app').query<{ uom: string | null; min_qty: string; min_qty_uom: string | null }>(
      'SELECT uom, min_qty::text, min_qty_uom::text FROM mdm.price_list_entry WHERE version_id = $1 ORDER BY uom NULLS FIRST, min_qty',
      [versionId],
    );
    expect(stored.rows).toEqual([
      { uom: null, min_qty: '0.000', min_qty_uom: null },
      { uom: 'CRATE', min_qty: '0.000', min_qty_uom: '0.000' },
      { uom: 'CRATE', min_qty: '300.000', min_qty_uom: '10.000' },
    ]);
  });

  it('refuses in the database an entry in a unit the product does not convert from, and allows a crate and a single egg at one break', async () => {
    const app = database.pool('app');
    const insert = (uom: string | null, minUom: string | null) =>
      app.query(
        `INSERT INTO mdm.price_list_entry (id, version_id, product_id, basis, list_price_pesewas, floor_price_pesewas, ceiling_price_pesewas, min_qty, uom, min_qty_uom, created_by, updated_by)
         VALUES ($1, $2, $3, 'PER_UNIT', 100, 100, 100, 5, $4, $5, $6, $6)`,
        [randomUUID(), versionId, eggsId, uom, minUom, SYSTEM_PRINCIPAL],
      );
    expect(await sqlStateOf(insert('BAG', '1.000'))).toBe('HK010');
    expect(await sqlStateOf(insert('CRATE', null))).toBe(SQLSTATE.checkViolation);
    await insert(null, null);
    await insert('CRATE', '0.167');
    expect(await sqlStateOf(insert('CRATE', '0.167'))).toBe(SQLSTATE.uniqueViolation);
    await app.query('SELECT mdm.clear_draft_price_list_entries($1)', [versionId]);
  });
});

describe('the engine resolves the price of the unit sold (decision 1)', () => {
  beforeAll(async () => {
    const replaced = await put(manager, `/price-list-versions/${versionId}/entries`, { version: 2, entries: [crate(), crate({ minQty: '10.000', listPricePesewas: 5_250 }), egg()] });
    expect(replaced.status).toBe(200);
    const submitted = await post(manager, `/price-list-versions/${versionId}/submit`, {});
    await runWithRequestContext({ correlationId: randomUUID(), ip: '127.0.0.1', userAgent: 'test', actor: ownerActor }, () =>
      api.app.get(UnitOfWork).run({ isolation: 'serializable' }, (tx) => api.app.get(Approvals).decide(tx, ownerActor, submitted.body.approvalRequestId, 'APPROVED', null)),
    );
  });

  it('prices one crate at 5,500 per crate and one egg at 200 per egg, each naming its unit', async () => {
    const priced = await resolve([
      { lineRef: 'crate', productId: eggsId, uom: 'CRATE', quantity: '1.000' },
      { lineRef: 'egg', productId: eggsId, quantity: '1.000' },
      { lineRef: 'egg-named', productId: eggsId, uom: 'UNIT', quantity: '1.000' },
    ]);
    expect(priced.status).toBe(200);
    expect(priced.body.lines.map((l: { resolved: { uom: string; listPricePesewas: number } }) => [l.resolved.uom, l.resolved.listPricePesewas])).toEqual([
      ['CRATE', 5_500],
      ['UNIT', 200],
      ['UNIT', 200],
    ]);
  });

  it('takes the break at 10 crates (300 eggs) and not at 9, and never applies a crate break to 300 single eggs', async () => {
    const priced = await resolve([
      { lineRef: 'ten', productId: eggsId, uom: 'CRATE', quantity: '10.000' },
      { lineRef: 'nine', productId: eggsId, uom: 'CRATE', quantity: '9.000' },
      { lineRef: 'singles', productId: eggsId, quantity: '300.000' },
    ]);
    expect(priced.body.lines.map((l: { resolved: { listPricePesewas: number } }) => l.resolved.listPricePesewas)).toEqual([5_250, 5_500, 200]);
  });

  it('refuses a line in a unit the product is not sold by with 422, naming the field', async () => {
    const refused = await resolve([{ lineRef: 'bag', productId: eggsId, uom: 'BAG', quantity: '1.000' }]);
    expect(refused.status).toBe(422);
    expect(refused.body.error).toMatchObject({ code: 'REFERENCE_NOT_FOUND', details: [{ field: '/lines/0/uom' }] });
  });
});
