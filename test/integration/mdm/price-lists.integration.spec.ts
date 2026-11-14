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

/** FR-MDM-015 and FR-MDM-016 through the API: price lists, versions, entries, maker-checker activation, resolution. */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let branchId: string;
let manager: TestSession;
let managerActor: Actor;
let ownerActor: Actor;
let cashier: TestSession;
let driver: TestSession;
let goatId: string;
let bandId: string;
let gradeId: string;

const actor = (principalId: string, displayName: string, steppedUpAt: Date | null): Actor => ({ principalId, kind: 'USER', displayName, realm: 'STAFF', sessionId: null, steppedUpAt });

function decide(who: Actor, approvalId: string, decision: 'APPROVED' | 'REJECTED', reason: string | null = null) {
  return runWithRequestContext({ correlationId: randomUUID(), ip: '127.0.0.1', userAgent: 'test', actor: who }, () =>
    api.app.get(UnitOfWork).run({ isolation: 'serializable' }, (tx) => api.app.get(Approvals).decide(tx, who, approvalId, decision, reason)),
  );
}

const post = (session: TestSession, path: string, body: object, key: string = randomUUID()) => consolePost(api.server, session, `/v1${path}`, key).send(body);
const put = (session: TestSession, path: string, body: object, key: string = randomUUID()) =>
  request(api.server).put(`/v1${path}`).set('Cookie', session.jar.header()).set('X-CSRF-Token', session.csrfToken).set('Origin', TEST_ORIGIN).set('Idempotency-Key', key).send(body);
const resolve = (session: TestSession, body: object) => post(session, '/pricing/resolve', body);
const goatLine = (fields: object = {}) => ({ lineRef: 'g1', productId: goatId, gradeId, weightKg: '22.400', quantity: '1.000', ...fields });
const entry = (fields: object = {}) => ({ productId: goatId, weightBandId: bandId, gradeId, basis: 'PER_HEAD', listPricePesewas: 90_000, floorPricePesewas: 80_000, ceilingPricePesewas: 100_000, ...fields });

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock });
  const dodowa = await createBranch(database);
  branchId = dodowa.branchId;
  const catalogue = await createCatalogue(database);
  const app = database.pool('app');
  goatId = randomUUID();
  bandId = randomUUID();
  gradeId = randomUUID();
  await app.query(
    `INSERT INTO mdm.product (id, sku, name, category_id, stock_policy, tracking, species_id, base_uom, sale_uom, tax_category_id, gl_group, online_mode, status, created_by, updated_by)
     VALUES ($1, 'LIV-GOAT', 'Goat', $2, 'SERIALISED', 'SERIAL', $3, 'HEAD', 'HEAD', $4, 'LIVE_ANIMALS', 'REQUEST_TO_BUY', 'ACTIVE', $5, $5)`,
    [goatId, catalogue.liveCategoryId, catalogue.goatSpeciesId, TAX_CATEGORY.LIVE_ANIMALS, SYSTEM_PRINCIPAL],
  );
  await app.query("INSERT INTO mdm.weight_band (id, species_id, code, min_kg, max_kg, created_by, updated_by) VALUES ($1, $2, 'GOAT-M', 20, 25, $3, $3)", [bandId, catalogue.goatSpeciesId, SYSTEM_PRINCIPAL]);
  await app.query("INSERT INTO mdm.grade (id, species_id, code, name, created_by, updated_by) VALUES ($1, $2, 'A', 'Grade A', $3, $3)", [gradeId, catalogue.goatSpeciesId, SYSTEM_PRINCIPAL]);
  const managerUser = await createUser(database, { name: 'Akosua Boateng', grants: [{ role: 'MANAGER', branchId }] });
  manager = await enrolAndLogin(api.server, managerUser, () => clock.now());
  managerActor = actor(managerUser.principalId, 'Akosua Boateng', clock.now());
  // The checker holds mdm.price_list.approve, which needs step-up, so an enrolled authenticator.
  const ownerUser = await createUser(database, { name: 'Kwabena Owusu', grants: [{ role: 'OWNER', branchId }] });
  await enrolAndLogin(api.server, ownerUser, () => clock.now());
  ownerActor = actor(ownerUser.principalId, 'Kwabena Owusu', clock.now());
  cashier = await login(api.server, await createUser(database, { name: 'Adwoa Darko', grants: [{ role: 'CASHIER', branchId, locationId: dodowa.shopId }] }));
  driver = await login(api.server, await createUser(database, { name: 'Selorm Agbeko', grants: [{ role: 'DRIVER', branchId }] }));
});

afterAll(async () => {
  await api.close();
  await database.drop();
});

describe('price lists and their activation (FR-MDM-015)', () => {
  let listId: string;
  let versionId: string;
  let approvalId: string;

  it('creates the base list, and refuses a second list in the same slot or with the same code', async () => {
    const created = await post(manager, '/price-lists', { code: 'BASE', name: 'Base prices', kind: 'BASE', taxInclusive: true });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ code: 'BASE', kind: 'BASE', channel: null, customerTier: null, branch: null, taxInclusive: true, currency: 'GHS', activeVersion: null, draftVersionId: null, version: 1 });
    listId = created.body.id;
    const sameSlot = await post(manager, '/price-lists', { code: 'BASE-2', name: 'Another base', kind: 'BASE', taxInclusive: true });
    expect(sameSlot.status).toBe(422);
    expect(sameSlot.body.error).toMatchObject({ code: 'DUPLICATE_VALUE', details: [{ field: '/kind', code: 'TAKEN' }] });
    const sameCode = await post(manager, '/price-lists', { code: 'BASE', name: 'Online', kind: 'CHANNEL', channel: 'ONLINE', taxInclusive: true });
    expect(sameCode.body.error).toMatchObject({ code: 'DUPLICATE_VALUE', details: [{ field: '/code' }] });
  });

  it('answers a replayed create with the stored response and a TIER list without its tier with 400', async () => {
    const key = randomUUID();
    const first = await post(manager, '/price-lists', { code: 'ONLINE', name: 'Online prices', kind: 'CHANNEL', channel: 'ONLINE', taxInclusive: true }, key);
    const replay = await post(manager, '/price-lists', { code: 'ONLINE', name: 'Online prices', kind: 'CHANNEL', channel: 'ONLINE', taxInclusive: true }, key);
    expect([first.status, replay.status, replay.body.id]).toEqual([201, 201, first.body.id]);
    const tier = await post(manager, '/price-lists', { code: 'TIER-X', name: 'Tier', kind: 'TIER', channel: 'WHOLESALE', taxInclusive: true });
    expect(tier.status).toBe(400);
    expect(tier.body.error.details).toEqual([expect.objectContaining({ field: '/customerTierId', code: 'REQUIRED' })]);
  });

  it('refuses the cashier and the driver, who lack mdm.price_list.create (ADR-0035)', async () => {
    for (const session of [cashier, driver]) {
      const refused = await post(session, '/price-lists', { code: 'SHOP', name: 'Shop', kind: 'CHANNEL', channel: 'POS', taxInclusive: true });
      expect(refused.status).toBe(403);
      expect(refused.body.error.code).toBe('FORBIDDEN');
    }
    expect((await consoleGet(api.server, cashier, `/v1/price-lists/${listId}`)).status).toBe(403);
  });

  it('drafts one version at a time', async () => {
    const draft = await post(manager, `/price-lists/${listId}/versions`, { validFrom: clock.now().toISOString(), notes: 'Opening prices' });
    expect(draft.status).toBe(201);
    expect(draft.body).toMatchObject({ priceListId: listId, versionNo: 1, status: 'DRAFT', entryCount: 0, version: 1, createdBy: { displayName: 'Akosua Boateng' }, activatedBy: null });
    versionId = draft.body.id;
    const second = await post(manager, `/price-lists/${listId}/versions`, { validFrom: clock.now().toISOString() });
    expect(second.body.error).toMatchObject({ code: 'INVALID_STATE_TRANSITION', details: [{ code: 'OPEN_VERSION_EXISTS' }] });
    expect((await consoleGet(api.server, manager, `/v1/price-lists/${listId}`)).body.draftVersionId).toBe(versionId);
  });

  it('refuses floor 90,000 above list 80,000, a duplicate entry, a stale version and an unknown product', async () => {
    const invalid = await put(manager, `/price-list-versions/${versionId}/entries`, { version: 1, entries: [entry({ floorPricePesewas: 90_000, listPricePesewas: 80_000 })] });
    expect(invalid.status).toBe(422);
    expect(invalid.body.error).toMatchObject({ code: 'PRICE_ENTRY_INVALID', details: [{ field: '/entries/0/floorPricePesewas', code: 'ABOVE_LIST' }] });
    const duplicate = await put(manager, `/price-list-versions/${versionId}/entries`, { version: 1, entries: [entry(), entry({ listPricePesewas: 95_000 })] });
    expect(duplicate.body.error).toMatchObject({ code: 'PRICE_ENTRY_DUPLICATE', details: [{ field: '/entries/1' }] });
    const stale = await put(manager, `/price-list-versions/${versionId}/entries`, { version: 7, entries: [entry()] });
    expect(stale.status).toBe(409);
    const unknown = await put(manager, `/price-list-versions/${versionId}/entries`, { version: 1, entries: [entry({ productId: randomUUID() })] });
    expect(unknown.body.error).toMatchObject({ code: 'REFERENCE_NOT_FOUND', details: [{ field: '/entries/0/productId' }] });
  });

  it('replaces the entries of the draft and moves its version', async () => {
    const replaced = await put(manager, `/price-list-versions/${versionId}/entries`, { version: 1, entries: [entry(), entry({ gradeId: undefined, listPricePesewas: 85_000, floorPricePesewas: 75_000, ceilingPricePesewas: 95_000 })] });
    expect(replaced.status).toBe(200);
    expect(replaced.body).toMatchObject({ status: 'DRAFT', entryCount: 2, version: 2 });
  });

  it('prices nothing from a draft: the goat is still a quote', async () => {
    const before = await resolve(cashier, { channel: 'POS', branchId, lines: [goatLine()] });
    expect(before.body.lines[0]).toMatchObject({ outcome: 'QUOTE_REQUIRED', quoteRequiredReason: 'NO_RULE' });
  });

  it('submits for approval with 202 ApprovalPending, after which the entries are frozen', async () => {
    const submitted = await post(manager, `/price-list-versions/${versionId}/submit`, {});
    expect(submitted.status).toBe(202);
    expect(submitted.body).toMatchObject({ status: 'PENDING_APPROVAL', kind: 'PRICE_LIST_ACTIVATION', subject: { id: versionId, docType: 'PRICE_LIST_VERSION', number: null } });
    approvalId = submitted.body.approvalRequestId;
    const frozen = await put(manager, `/price-list-versions/${versionId}/entries`, { version: 3, entries: [entry()] });
    expect(frozen.body.error).toMatchObject({ code: 'INVALID_STATE_TRANSITION', details: [{ code: 'PENDING_APPROVAL' }] });
  });

  it('refuses the maker as checker, then activates on the owner\'s approval', async () => {
    await expect(decide(managerActor, approvalId, 'APPROVED')).rejects.toMatchObject({ code: 'MAKER_CANNOT_CHECK' });
    await decide(ownerActor, approvalId, 'APPROVED', 'Checked against the market survey');
    const version = await consoleGet(api.server, manager, `/v1/price-list-versions/${versionId}`);
    expect(version.body).toMatchObject({ status: 'ACTIVE', approvalRequestId: approvalId, activatedBy: { id: ownerActor.principalId, displayName: 'Kwabena Owusu' } });
    const list = await consoleGet(api.server, manager, `/v1/price-lists/${listId}`);
    expect(list.body).toMatchObject({ activeVersion: { id: versionId, versionNo: 1 }, draftVersionId: null });
    const audit = await database.pool('admin').query("SELECT action FROM platform.audit_event WHERE entity_id = $1 ORDER BY recorded_at, id", [versionId]);
    expect(audit.rows.map((row) => row.action)).toEqual(['CREATE', 'UPDATE', 'SUBMIT', 'ACTIVATE']);
    const events = await database.pool('admin').query("SELECT count(*)::int AS n FROM platform.outbox_message WHERE event_type = 'mdm.PriceListVersionActivated' AND subject_id = $1", [versionId]);
    expect(events.rows[0].n).toBe(1);
  });

  it('now resolves the grade A goat at 90,000 and an ungraded one at 85,000', async () => {
    const priced = await resolve(cashier, { channel: 'POS', branchId, lines: [goatLine(), goatLine({ lineRef: 'g2', gradeId: undefined })] });
    expect(priced.status).toBe(200);
    expect(priced.body.lines[0].resolved).toMatchObject({ priceList: { id: listId, code: 'BASE', kind: 'BASE' }, listPricePesewas: 90_000, floorPricePesewas: 80_000, ceilingPricePesewas: 100_000, grade: { id: gradeId, code: 'A' } });
    expect(priced.body.lines[1].resolved).toMatchObject({ listPricePesewas: 85_000, grade: null, weightBand: { code: 'GOAT-M', minKg: '20.000', maxKg: '25.000' } });
  });

  it('starts a backdated version at its approval, ending the earlier one there, so earlier sales keep their price', async () => {
    clock.advanceBy(60_000);
    const approvedAt = clock.now();
    ownerActor = { ...ownerActor, steppedUpAt: approvedAt };
    const draft = await post(manager, `/price-lists/${listId}/versions`, { validFrom: new Date(approvedAt.getTime() - 86_400_000).toISOString(), copyFromVersionId: versionId });
    expect(draft.body.entryCount).toBe(2);
    await put(manager, `/price-list-versions/${draft.body.id}/entries`, { version: 1, entries: [entry({ listPricePesewas: 95_000, ceilingPricePesewas: 105_000 })] });
    const submitted = await post(manager, `/price-list-versions/${draft.body.id}/submit`, {});
    await decide(ownerActor, submitted.body.approvalRequestId, 'APPROVED');
    const next = await consoleGet(api.server, manager, `/v1/price-list-versions/${draft.body.id}`);
    expect(next.body).toMatchObject({ status: 'ACTIVE', validFrom: approvedAt.toISOString() });
    const first = await consoleGet(api.server, manager, `/v1/price-list-versions/${versionId}`);
    expect(first.body).toMatchObject({ status: 'ACTIVE', validTo: approvedAt.toISOString() });
    const earlier = await resolve(cashier, { channel: 'POS', branchId, at: new Date(approvedAt.getTime() - 1).toISOString(), lines: [goatLine()] });
    expect(earlier.body.lines[0].resolved.listPricePesewas).toBe(90_000);
    const now = await resolve(cashier, { channel: 'POS', branchId, lines: [goatLine()] });
    expect(now.body.lines[0].resolved.listPricePesewas).toBe(95_000);
  });

  it('keeps the list priced when a version is rejected', async () => {
    const draft = await post(manager, `/price-lists/${listId}/versions`, { validFrom: clock.now().toISOString(), copyFromVersionId: versionId });
    const submitted = await post(manager, `/price-list-versions/${draft.body.id}/submit`, {});
    await decide(ownerActor, submitted.body.approvalRequestId, 'REJECTED', 'Prices too low for December');
    expect((await consoleGet(api.server, manager, `/v1/price-list-versions/${draft.body.id}`)).body.status).toBe('REJECTED');
    expect((await resolve(cashier, { channel: 'POS', branchId, lines: [goatLine()] })).body.lines[0].resolved.listPricePesewas).toBe(95_000);
  });
});

describe('a branch list comes before the all-branch list in the same slot (ADR-0036)', () => {
  it('prices the goat from the Dodowa base list and falls through to the all-branch base list for what it lacks', async () => {
    const eggsId = randomUUID();
    const catalogue = await database.pool('admin').query<{ id: string }>("SELECT id FROM mdm.category WHERE code = 'EGGS'");
    await database.pool('app').query(
      `INSERT INTO mdm.product (id, sku, name, category_id, stock_policy, tracking, base_uom, sale_uom, tax_category_id, gl_group, online_mode, status, created_by, updated_by)
       VALUES ($1, 'EGG-CRATE-BIG', 'Eggs, big', $2, 'COUNTABLE', 'LOT', 'CRATE', 'CRATE', $3, 'PRODUCE_EGGS', 'LISTED', 'ACTIVE', $4, $4)`,
      [eggsId, catalogue.rows[0]!.id, TAX_CATEGORY.EGGS, SYSTEM_PRINCIPAL],
    );
    const list = await post(manager, '/price-lists', { code: 'BASE-DDW', name: 'Dodowa base prices', kind: 'BASE', branchId, taxInclusive: true });
    expect(list.status).toBe(201);
    expect(list.body.branch).toMatchObject({ id: branchId });
    const draft = await post(manager, `/price-lists/${list.body.id}/versions`, { validFrom: clock.now().toISOString() });
    const eggs = { productId: eggsId, basis: 'PER_UNIT', listPricePesewas: 6_000, floorPricePesewas: 6_000, ceilingPricePesewas: 6_000 };
    await put(manager, `/price-list-versions/${draft.body.id}/entries`, { version: 1, entries: [eggs] });
    const submitted = await post(manager, `/price-list-versions/${draft.body.id}/submit`, {});
    await decide({ ...ownerActor, steppedUpAt: clock.now() }, submitted.body.approvalRequestId, 'APPROVED');
    const eggLine = { lineRef: 'e1', productId: eggsId, quantity: '2.000' };
    const atDodowa = await resolve(cashier, { channel: 'POS', branchId, lines: [eggLine, goatLine()] });
    expect(atDodowa.body.lines.map((line: { resolved: { priceList: { code: string }; listPricePesewas: number } }) => [line.resolved.priceList.code, line.resolved.listPricePesewas])).toEqual([
      ['BASE-DDW', 6_000],
      ['BASE', 95_000],
    ]);
    const kasoa = await createBranch(database, 'KSA');
    const atKasoa = await resolve(cashier, { channel: 'POS', branchId: kasoa.branchId, lines: [eggLine, goatLine()] });
    expect(atKasoa.body.lines[0]).toMatchObject({ outcome: 'QUOTE_REQUIRED', quoteRequiredReason: 'NO_RULE' });
    expect(atKasoa.body.lines[1].resolved).toMatchObject({ priceList: { code: 'BASE' }, listPricePesewas: 95_000 });
  });
});

describe('resolvePrices refusals (FR-MDM-016)', () => {
  it('refuses the driver, who lacks mdm.price.resolve (ADR-0035)', async () => {
    const refused = await resolve(driver, { channel: 'POS', branchId, lines: [goatLine()] });
    expect(refused.status).toBe(403);
  });

  it('refuses a request without the CSRF token', async () => {
    const response = await request(api.server).post('/v1/pricing/resolve').set('Cookie', cashier.jar.header()).set('Origin', TEST_ORIGIN).send({ channel: 'POS', branchId, lines: [goatLine()] });
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('CSRF_TOKEN_INVALID');
  });

  it('answers an id that names no record with 422 REFERENCE_NOT_FOUND, naming every one', async () => {
    const response = await resolve(cashier, {
      channel: 'POS',
      branchId,
      customerId: randomUUID(),
      couponCode: 'XMAS',
      lines: [goatLine({ productId: randomUUID() }), goatLine({ lineRef: 'g2', stockUnitId: randomUUID() })],
    });
    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('REFERENCE_NOT_FOUND');
    expect(response.body.error.details.map((detail: { field: string }) => detail.field)).toEqual(['/customerId', '/couponCode', '/lines/0/productId', '/lines/1/stockUnitId']);
  });

  it('refuses a malformed weight with 400, never rounding it', async () => {
    const response = await resolve(cashier, { channel: 'POS', branchId, lines: [goatLine({ weightKg: '22.4' })] });
    expect(response.status).toBe(400);
  });
});
