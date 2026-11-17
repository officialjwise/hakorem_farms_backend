import { randomUUID } from 'node:crypto';
import { ManualClock } from '@hakorem/kernel';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runWithRequestContext, type Actor } from '../../../src/platform/context/request-context';
import { UnitOfWork } from '../../../src/platform/database/unit-of-work';
import { Approvals } from '../../../src/modules/iam';
import { createCatalogue, TAX_CATEGORY } from '../../support/catalogue';
import { consoleGet, consolePost, createBranch, createUser, enrolAndLogin, login, relaxRateLimits, SYSTEM_PRINCIPAL, testStartTime, type TestSession } from '../../support/iam';
import { startTestApp, TEST_ORIGIN, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * CR-009, previewPriceListVersion: a draft compared with the version in force by the engine's own identity
 * (product, grade, band, quantity break), in cursor pages, with counts over the whole comparison. Read only.
 */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let branchId: string;
let manager: TestSession;
let ownerActor: Actor;
let sales: TestSession;
let salesElsewhere: TestSession;
let wrongRoles: Array<[string, TestSession]>;
let goatId: string;
let eggsId: string;
let gradeId: string;
let bandM: string;
let bandL: string;
let listId: string;
let firstId: string;
let draftId: string;

const actor = (principalId: string, displayName: string, steppedUpAt: Date | null): Actor => ({ principalId, kind: 'USER', displayName, realm: 'STAFF', sessionId: null, steppedUpAt });
const post = (session: TestSession, path: string, body: object) => consolePost(api.server, session, `/v1${path}`).send(body);
const put = (session: TestSession, path: string, body: object) =>
  request(api.server).put(`/v1${path}`).set('Cookie', session.jar.header()).set('X-CSRF-Token', session.csrfToken).set('Origin', TEST_ORIGIN).set('Idempotency-Key', randomUUID()).send(body);
const preview = (session: TestSession, id: string, query = '') => consoleGet(api.server, session, `/v1/price-list-versions/${id}/preview${query}`);

async function approve(versionId: string): Promise<void> {
  const submitted = await post(manager, `/price-list-versions/${versionId}/submit`, {});
  expect(submitted.status).toBe(202);
  const checker = { ...ownerActor, steppedUpAt: clock.now() };
  await runWithRequestContext({ correlationId: randomUUID(), ip: '127.0.0.1', userAgent: 'test', actor: checker }, () =>
    api.app.get(UnitOfWork).run({ isolation: 'serializable' }, (tx) => api.app.get(Approvals).decide(tx, checker, submitted.body.approvalRequestId, 'APPROVED', 'Checked')),
  );
}

// Prices in pesewas: GHS 900.00 is 90_000.
const goatAM = { productId: '', gradeId: '', weightBandId: '', basis: 'PER_HEAD', listPricePesewas: 90_000, floorPricePesewas: 80_000, ceilingPricePesewas: 100_000 };
const goatL = () => ({ productId: goatId, weightBandId: bandL, basis: 'PER_HEAD', listPricePesewas: 140_000, floorPricePesewas: 120_000, ceilingPricePesewas: 195_000 });
const eggs = () => ({ productId: eggsId, basis: 'PER_UNIT', listPricePesewas: 6_000, floorPricePesewas: 6_000, ceilingPricePesewas: 6_000 });

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock });
  const dodowa = await createBranch(database);
  branchId = dodowa.branchId;
  const kasoa = await createBranch(database, 'KSA');
  const catalogue = await createCatalogue(database);
  const app = database.pool('app');
  [goatId, eggsId, gradeId, bandM, bandL] = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  await app.query(
    `INSERT INTO mdm.product (id, sku, name, category_id, stock_policy, tracking, species_id, base_uom, sale_uom, tax_category_id, gl_group, online_mode, status, created_by, updated_by)
     VALUES ($1, 'LIV-0004', 'Goat', $2, 'SERIALISED', 'SERIAL', $3, 'HEAD', 'HEAD', $4, 'LIVE_ANIMALS', 'REQUEST_TO_BUY', 'ACTIVE', $5, $5)`,
    [goatId, catalogue.liveCategoryId, catalogue.goatSpeciesId, TAX_CATEGORY.LIVE_ANIMALS, SYSTEM_PRINCIPAL],
  );
  const eggCategory = await database.pool('admin').query<{ id: string }>("SELECT id FROM mdm.category WHERE code = 'EGGS'");
  await app.query(
    `INSERT INTO mdm.product (id, sku, name, category_id, stock_policy, tracking, base_uom, sale_uom, tax_category_id, gl_group, online_mode, status, created_by, updated_by)
     VALUES ($1, 'EGG-0003', 'Eggs, big, crate of 30', $2, 'COUNTABLE', 'LOT', 'CRATE', 'CRATE', $3, 'PRODUCE_EGGS', 'LISTED', 'ACTIVE', $4, $4)`,
    [eggsId, eggCategory.rows[0]!.id, TAX_CATEGORY.EGGS, SYSTEM_PRINCIPAL],
  );
  await app.query(
    `INSERT INTO mdm.weight_band (id, species_id, code, min_kg, max_kg, created_by, updated_by)
     VALUES ($1, $3, 'GOAT-M', 20, 25, $4, $4), ($2, $3, 'GOAT-L', 25, 45, $4, $4)`,
    [bandM, bandL, catalogue.goatSpeciesId, SYSTEM_PRINCIPAL],
  );
  await app.query("INSERT INTO mdm.grade (id, species_id, code, name, created_by, updated_by) VALUES ($1, $2, 'A', 'Grade A', $3, $3)", [gradeId, catalogue.goatSpeciesId, SYSTEM_PRINCIPAL]);
  Object.assign(goatAM, { productId: goatId, gradeId, weightBandId: bandM });

  const managerUser = await createUser(database, { name: 'Akosua Boateng', grants: [{ role: 'MANAGER', branchId }] });
  manager = await enrolAndLogin(api.server, managerUser, () => clock.now());
  const ownerUser = await createUser(database, { name: 'Kwabena Owusu', grants: [{ role: 'OWNER', branchId }] });
  await enrolAndLogin(api.server, ownerUser, () => clock.now());
  ownerActor = actor(ownerUser.principalId, 'Kwabena Owusu', clock.now());
  sales = await login(api.server, await createUser(database, { name: 'Esi Appiah', grants: [{ role: 'SALES', branchId }] }));
  salesElsewhere = await login(api.server, await createUser(database, { name: 'Yaw Asante', grants: [{ role: 'SALES', branchId: kasoa.branchId }] }));
  wrongRoles = [
    ['cashier', await login(api.server, await createUser(database, { name: 'Adwoa Darko', grants: [{ role: 'CASHIER', branchId, locationId: dodowa.shopId }] }))],
    ['storekeeper', await login(api.server, await createUser(database, { name: 'Kofi Mensah', grants: [{ role: 'STOREKEEPER', branchId }] }))],
    ['farm hand', await login(api.server, await createUser(database, { name: 'Abdul-Rahman Iddrisu', grants: [{ role: 'FARM_HAND', branchId, locationId: dodowa.pensId }] }))],
    ['driver', await login(api.server, await createUser(database, { name: 'Selorm Agbeko', grants: [{ role: 'DRIVER', branchId }] }))],
    ['investor', await login(api.server, await createUser(database, { name: 'Investor reader', grants: [{ role: 'INVESTOR', branchId }] }))],
  ];

  const list = await post(manager, '/price-lists', { code: 'BASE', name: 'Base prices', kind: 'BASE', taxInclusive: true });
  listId = list.body.id;
  const first = await post(manager, `/price-lists/${listId}/versions`, { validFrom: clock.now().toISOString(), notes: 'Opening prices' });
  firstId = first.body.id;
  const replaced = await put(manager, `/price-list-versions/${firstId}/entries`, { version: 1, entries: [goatAM, goatL(), eggs()] });
  expect(replaced.status).toBe(200);
});

afterAll(async () => {
  await api.close();
  await database.drop();
});

describe('a version with nothing in force (CR-009)', () => {
  it('answers every line ADDED, compared with no version, at the version\'s start', async () => {
    const answer = await preview(manager, firstId);
    expect(answer.status).toBe(200);
    expect(answer.body.comparedWith).toBeNull();
    expect(answer.body.comparedAt).toBe(clock.now().toISOString());
    expect(answer.body.counts).toEqual({ added: 3, changed: 0, removed: 0, unchanged: 0 });
    expect(answer.body.data.map((line: { kind: string; current: unknown }) => [line.kind, line.current])).toEqual([
      ['ADDED', null],
      ['ADDED', null],
      ['ADDED', null],
    ]);
    expect(answer.body.page).toEqual({ nextCursor: null, limit: 25, hasMore: false });
  });
});

describe('a draft against the version in force, one line of each kind (CR-009)', () => {
  const kinds = (body: { data: Array<{ kind: string; current: { product: { sku: string } } | null; proposed: { product: { sku: string } } | null }> }) =>
    body.data.map((line) => [line.kind, (line.proposed ?? line.current)!.product.sku]);

  beforeAll(async () => {
    await approve(firstId);
    clock.advanceBy(60_000);
    const startsAt = new Date(clock.now().getTime() + 86_400_000);
    const draft = await post(manager, `/price-lists/${listId}/versions`, { validFrom: startsAt.toISOString(), copyFromVersionId: firstId, notes: 'Christmas season goat prices' });
    draftId = draft.body.id;
    // Goat grade A 20-25 kg rises to 95,000; the 25-45 kg goat stays; the eggs are dropped; a break from 10 head is added.
    const entries = [{ ...goatAM, listPricePesewas: 95_000, ceilingPricePesewas: 105_000 }, goatL(), { ...goatAM, minQty: '10.000', listPricePesewas: 85_000 }];
    expect((await put(manager, `/price-list-versions/${draftId}/entries`, { version: 1, entries })).status).toBe(200);
  });

  it('pairs the lines by product, grade, band and quantity break, with the counts and the version compared', async () => {
    const answer = await preview(manager, draftId);
    expect(answer.status).toBe(200);
    const draft = await consoleGet(api.server, manager, `/v1/price-list-versions/${draftId}`);
    const first = await consoleGet(api.server, manager, `/v1/price-list-versions/${firstId}`);
    expect(answer.body.comparedWith).toEqual({ id: firstId, versionNo: 1, validFrom: first.body.validFrom, validTo: null });
    expect(answer.body.comparedAt).toBe(draft.body.validFrom);
    expect(answer.body.counts).toEqual({ added: 1, changed: 1, removed: 1, unchanged: 1 });
    expect(answer.body.data).toHaveLength(4);
    const byKind = Object.fromEntries(answer.body.data.map((line: { kind: string }) => [line.kind, line]));
    expect(byKind.CHANGED.current).toMatchObject({ product: { id: goatId, sku: 'LIV-0004' }, grade: { id: gradeId, code: 'A' }, weightBand: { code: 'GOAT-M' }, listPricePesewas: 90_000, ceilingPricePesewas: 100_000, minQty: '0.000', currency: 'GHS' });
    expect(byKind.CHANGED.proposed).toMatchObject({ grade: { code: 'A' }, weightBand: { code: 'GOAT-M' }, listPricePesewas: 95_000, floorPricePesewas: 80_000, ceilingPricePesewas: 105_000, minQty: '0.000' });
    expect(byKind.CHANGED.proposed.id).not.toBe(byKind.CHANGED.current.id);
    expect(byKind.ADDED).toMatchObject({ current: null, proposed: { weightBand: { code: 'GOAT-M' }, minQty: '10.000', listPricePesewas: 85_000 } });
    expect(byKind.UNCHANGED).toMatchObject({ current: { weightBand: { code: 'GOAT-L' }, listPricePesewas: 140_000 }, proposed: { weightBand: { code: 'GOAT-L' }, listPricePesewas: 140_000 } });
    expect(byKind.REMOVED).toMatchObject({ current: { product: { sku: 'EGG-0003' }, basis: 'PER_UNIT', listPricePesewas: 6_000 }, proposed: null });
  });

  it('answers cursor pages that add up to the whole comparison, with the same counts on every page', async () => {
    const whole = kinds((await preview(manager, draftId)).body);
    const first = await preview(manager, draftId, '?limit=3');
    expect(first.body.page).toMatchObject({ limit: 3, hasMore: true });
    const second = await preview(manager, draftId, `?limit=3&cursor=${encodeURIComponent(first.body.page.nextCursor)}`);
    expect(second.body.page).toEqual({ nextCursor: null, limit: 3, hasMore: false });
    expect([...kinds(first.body), ...kinds(second.body)]).toEqual(whole);
    expect(second.body.counts).toEqual(first.body.counts);
  });

  it('refuses a cursor once the draft changed, rather than mix two comparisons', async () => {
    const first = await preview(manager, draftId, '?limit=1');
    const draft = await consoleGet(api.server, manager, `/v1/price-list-versions/${draftId}`);
    const entries = [{ ...goatAM, listPricePesewas: 95_000, ceilingPricePesewas: 105_000 }, goatL(), { ...goatAM, minQty: '10.000', listPricePesewas: 85_000 }];
    expect((await put(manager, `/price-list-versions/${draftId}/entries`, { version: draft.body.version, entries })).status).toBe(200);
    const stale = await preview(manager, draftId, `?limit=1&cursor=${encodeURIComponent(first.body.page.nextCursor)}`);
    expect(stale.status).toBe(400);
    expect(stale.body.error.details).toEqual([expect.objectContaining({ field: '/cursor', code: 'INVALID_CURSOR' })]);
  });

  it('previews the version while it waits for approval, and writes nothing', async () => {
    const before = await database.pool('admin').query('SELECT count(*)::int AS n FROM platform.audit_event');
    const submitted = await post(manager, `/price-list-versions/${draftId}/submit`, {});
    expect(submitted.status).toBe(202);
    const afterSubmit = await database.pool('admin').query('SELECT count(*)::int AS n FROM platform.audit_event');
    const answer = await preview(sales, draftId);
    expect(answer.status).toBe(200);
    expect(answer.body.counts).toEqual({ added: 1, changed: 1, removed: 1, unchanged: 1 });
    const after = await database.pool('admin').query('SELECT count(*)::int AS n FROM platform.audit_event');
    expect(after.rows[0].n).toBe(afterSubmit.rows[0].n);
    expect(afterSubmit.rows[0].n).toBeGreaterThan(before.rows[0].n);
  });

  it('refuses to preview a version already in force with 422 INVALID_STATE_TRANSITION', async () => {
    const answer = await preview(manager, firstId);
    expect(answer.status).toBe(422);
    expect(answer.body.error).toMatchObject({ code: 'INVALID_STATE_TRANSITION', details: [{ code: 'ACTIVE' }] });
  });
});

describe('who may preview (ADR-0035)', () => {
  it('refuses every role without mdm.price_list.read with 403', async () => {
    for (const [who, session] of wrongRoles) {
      const answer = await preview(session, draftId);
      expect([who, answer.status, answer.body.error?.code]).toEqual([who, 403, 'FORBIDDEN']);
    }
  });

  it('refuses a reader granted only at another branch: the version is the first branch\'s', async () => {
    const answer = await preview(salesElsewhere, draftId);
    expect(answer.status).toBe(403);
  });

  it('answers 404 for a version that does not exist and 400 for a forged cursor', async () => {
    expect((await preview(manager, randomUUID())).status).toBe(404);
    const forged = await preview(manager, draftId, '?cursor=eyJpZCI6IjAxOWE3YyJ9.bad');
    expect(forged.status).toBe(400);
  });
});
