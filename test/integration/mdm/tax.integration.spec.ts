import { randomUUID } from 'node:crypto';
import { ManualClock, toBusinessDate } from '@hakorem/kernel';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runWithRequestContext, type Actor } from '../../../src/platform/context/request-context';
import { UnitOfWork } from '../../../src/platform/database/unit-of-work';
import { Approvals } from '../../../src/modules/iam';
import { TAX_CATEGORY } from '../../support/catalogue';
import { consoleGet, consolePost, createBranch, createUser, enrolAndLogin, login, relaxRateLimits, SYSTEM_PRINCIPAL, testStartTime, type TestSession } from '../../support/iam';
import { startTestApp, TEST_ORIGIN, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/** FR-MDM-012 to FR-MDM-014 through the API: levies, the scheme version lifecycle, maker-checker, calculation. */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let today: string;
let accountant: TestSession;
let accountantActor: Actor;
let managerActor: Actor;
let ownerActor: Actor;
let manager: TestSession;
let owner: TestSession;
let cashier: TestSession;
let driver: TestSession;

const LEVY = { VAT: '01900000-0000-7000-8000-000000000501', NHIL: '01900000-0000-7000-8000-000000000502', GETFUND: '01900000-0000-7000-8000-000000000503' } as const;
const OTHER_GOODS = '01900000-0000-7000-8000-000000000207';
const FARM_INPUTS = '01900000-0000-7000-8000-000000000205';
const ALL_CATEGORIES = [...Object.values(TAX_CATEGORY), FARM_INPUTS, OTHER_GOODS];
const STANDARD = new Set<string>([TAX_CATEGORY.PROCESSED_MEAT, TAX_CATEGORY.DELIVERY_SERVICE, OTHER_GOODS]);
const RATES = { VAT: '15', NHIL: '2.5', GETFUND: '2.5' } as const;

const actor = (principalId: string, displayName: string, steppedUpAt: Date | null): Actor => ({ principalId, kind: 'USER', displayName, realm: 'STAFF', sessionId: null, steppedUpAt });

function decide(who: Actor, approvalId: string, decision: 'APPROVED' | 'REJECTED', reason: string | null = null) {
  return runWithRequestContext({ correlationId: randomUUID(), ip: '127.0.0.1', userAgent: 'test', actor: who }, () =>
    api.app.get(UnitOfWork).run({ isolation: 'serializable' }, (tx) => api.app.get(Approvals).decide(tx, who, approvalId, decision, reason)),
  );
}

const post = (session: TestSession, path: string, body: object, key: string = randomUUID()) => consolePost(api.server, session, `/v1${path}`, key).send(body);
const put = (session: TestSession, path: string, body: object, key: string = randomUUID()) =>
  request(api.server).put(`/v1${path}`).set('Cookie', session.jar.header()).set('X-CSRF-Token', session.csrfToken).set('Origin', TEST_ORIGIN).set('Idempotency-Key', key).send(body);
const get = (session: TestSession, path: string) => consoleGet(api.server, session, `/v1${path}`);

/** The seed's matrix (ADR-0020): 15, 2.5 and 2.5 percent on the net for standard categories, zero-rated elsewhere. */
function seededCells(override: (cell: Record<string, unknown>) => Record<string, unknown> = (cell) => cell): Record<string, unknown>[] {
  return ALL_CATEGORIES.flatMap((taxCategoryId) =>
    (['VAT', 'NHIL', 'GETFUND'] as const).map((code, index) => {
      const standard = STANDARD.has(taxCategoryId);
      return override({
        taxCategoryId,
        levyId: LEVY[code],
        treatment: standard ? 'STANDARD' : 'ZERO_RATED',
        ratePercent: standard ? RATES[code] : '0',
        baseKind: 'NET',
        isReclaimable: true,
        calcOrder: index + 1,
      });
    }),
  );
}

const calculate = (session: TestSession, body: object) => post(session, '/tax/calculate', body);
const line = (lineRef: string, taxCategoryId: string, amountPesewas: number) => ({ lineRef, taxCategoryId, amountPesewas });

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  today = toBusinessDate(clock.now());
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock });
  const dodowa = await createBranch(database);
  const branchId = dodowa.branchId;
  const accountantUser = await createUser(database, { name: 'Efua Asante', grants: [{ role: 'ACCOUNTANT', branchId }] });
  accountant = await enrolAndLogin(api.server, accountantUser, () => clock.now());
  accountantActor = actor(accountantUser.principalId, 'Efua Asante', clock.now());
  const managerUser = await createUser(database, { name: 'Akosua Boateng', grants: [{ role: 'MANAGER', branchId }] });
  manager = await enrolAndLogin(api.server, managerUser, () => clock.now());
  managerActor = actor(managerUser.principalId, 'Akosua Boateng', clock.now());
  const ownerUser = await createUser(database, { name: 'Kwabena Owusu', grants: [{ role: 'OWNER', branchId }] });
  owner = await enrolAndLogin(api.server, ownerUser, () => clock.now());
  ownerActor = actor(ownerUser.principalId, 'Kwabena Owusu', clock.now());
  cashier = await login(api.server, await createUser(database, { name: 'Adwoa Darko', grants: [{ role: 'CASHIER', branchId, locationId: dodowa.shopId }] }));
  driver = await login(api.server, await createUser(database, { name: 'Selorm Agbeko', grants: [{ role: 'DRIVER', branchId }] }));
});

afterAll(async () => {
  await api.close();
  await database.drop();
});

describe('tax levies and categories (ADR-0020)', () => {
  it('lists the three seeded levies in print order and the seven categories, to the accountant', async () => {
    const levies = await get(accountant, '/tax/levies');
    expect(levies.status).toBe(200);
    expect(levies.body.data.map((levy: { code: string }) => levy.code)).toEqual(['VAT', 'NHIL', 'GETFUND']);
    expect(levies.body.page).toEqual({ nextCursor: null, limit: 25, hasMore: false });
    const categories = await get(accountant, '/tax/categories');
    expect(categories.body.data).toHaveLength(7);
  });

  it('pages the categories with a cursor', async () => {
    const first = await get(accountant, '/tax/categories?limit=4');
    expect(first.body.data).toHaveLength(4);
    expect(first.body.page.hasMore).toBe(true);
    const second = await get(accountant, `/tax/categories?limit=4&cursor=${encodeURIComponent(first.body.page.nextCursor as string)}`);
    expect(second.body.data).toHaveLength(3);
    expect(second.body.page).toEqual({ nextCursor: null, limit: 4, hasMore: false });
  });

  it('refuses the cashier and the driver, who may not read tax configuration (ADR-0035)', async () => {
    for (const session of [cashier, driver]) {
      const refused = await get(session, '/tax/levies');
      expect(refused.status).toBe(403);
      expect(refused.body.error.code).toBe('FORBIDDEN');
    }
  });

  it('refuses the manager, who may read but not change tax configuration', async () => {
    const refused = await post(manager, '/tax/categories', { code: 'SEEDS', name: 'Seeds' });
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('FORBIDDEN');
  });
});

describe('tax scheme version lifecycle (FR-MDM-012)', () => {
  let versionId: string;
  let approvalId: string;

  it('answers that no scheme is in force before one is approved, rather than taxing at zero', async () => {
    const refused = await calculate(cashier, { taxInclusive: false, taxDate: today, lines: [line('1', TAX_CATEGORY.PROCESSED_MEAT, 10_000)] });
    expect(refused.status).toBe(422);
    expect(refused.body.error).toMatchObject({ code: 'TAX_SCHEME_NOT_IN_FORCE', details: [{ field: '/taxDate' }] });
  });

  it('drafts version 1 and refuses a second open version', async () => {
    const created = await post(accountant, '/tax/scheme-versions', { validFrom: '2026-01-01', sourceNote: 'GRA rates in force from 1 January 2026, confirmed by the owner' });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ versionNo: 1, status: 'DRAFT', validFrom: '2026-01-01', validTo: null, approvalRequestId: null, cells: [], version: 1, createdBy: { displayName: 'Efua Asante' } });
    versionId = created.body.id;
    const second = await post(accountant, '/tax/scheme-versions', { validFrom: '2027-01-01', sourceNote: 'Another' });
    expect(second.status).toBe(422);
    expect(second.body.error).toMatchObject({ code: 'INVALID_STATE_TRANSITION', details: [{ code: 'OPEN_VERSION_EXISTS' }] });
  });

  it('refuses a matrix missing the EGGS/NHIL cell as TAX_MATRIX_INCOMPLETE, naming the gap', async () => {
    const cells = seededCells().filter((cell) => !(cell['taxCategoryId'] === TAX_CATEGORY.EGGS && cell['levyId'] === LEVY.NHIL));
    const refused = await put(accountant, `/tax/scheme-versions/${versionId}/cells`, { version: 1, cells });
    expect(refused.status).toBe(422);
    expect(refused.body.error).toMatchObject({ code: 'TAX_MATRIX_INCOMPLETE', details: [{ field: '/cells', code: 'EGGS/NHIL' }] });
  });

  it('refuses a rate on a zero-rated cell, naming the cell', async () => {
    const cells = seededCells((cell) => (cell['taxCategoryId'] === TAX_CATEGORY.EGGS && cell['levyId'] === LEVY.VAT ? { ...cell, ratePercent: '15' } : cell));
    const refused = await put(accountant, `/tax/scheme-versions/${versionId}/cells`, { version: 1, cells });
    const index = cells.findIndex((cell) => cell['taxCategoryId'] === TAX_CATEGORY.EGGS && cell['levyId'] === LEVY.VAT);
    expect(refused.status).toBe(422);
    expect(refused.body.error).toMatchObject({ code: 'TAX_CELL_INVALID', details: [{ field: `/cells/${index}`, code: 'TAX_RATE_NOT_ALLOWED' }] });
  });

  it('refuses a cell for an unknown category and a replace at a stale version', async () => {
    const unknown = await put(accountant, `/tax/scheme-versions/${versionId}/cells`, { version: 1, cells: [...seededCells(), { ...seededCells()[0]!, taxCategoryId: randomUUID() }] });
    expect(unknown.status).toBe(422);
    expect(unknown.body.error.code).toBe('REFERENCE_NOT_FOUND');
    const stale = await put(accountant, `/tax/scheme-versions/${versionId}/cells`, { version: 7, cells: seededCells() });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('VERSION_CONFLICT');
  });

  it('writes the full matrix: 21 cells, percent printed with two places', async () => {
    const replaced = await put(accountant, `/tax/scheme-versions/${versionId}/cells`, { version: 1, cells: seededCells() });
    expect(replaced.status).toBe(200);
    expect(replaced.body.cells).toHaveLength(21);
    expect(replaced.body.version).toBe(2);
    expect(replaced.body.cells.find((cell: { taxCategory: { code: string }; levy: { code: string } }) => cell.taxCategory.code === 'PROCESSED_MEAT' && cell.levy.code === 'NHIL')).toEqual({
      taxCategory: { id: TAX_CATEGORY.PROCESSED_MEAT, code: 'PROCESSED_MEAT', name: expect.any(String) },
      levy: { id: LEVY.NHIL, code: 'NHIL', name: 'National Health Insurance Levy' },
      treatment: 'STANDARD',
      ratePercent: '2.50',
      baseKind: 'NET',
      baseIncludes: [],
      isReclaimable: true,
      calcOrder: 2,
    });
  });

  it('submits for approval with 202 and freezes the cells', async () => {
    const submitted = await post(accountant, `/tax/scheme-versions/${versionId}/submit`, {});
    expect(submitted.status).toBe(202);
    expect(submitted.body).toMatchObject({ status: 'PENDING_APPROVAL', kind: 'TAX_SCHEME_ACTIVATION', subject: { id: versionId, docType: 'TAX_SCHEME_VERSION', number: null } });
    approvalId = submitted.body.approvalRequestId;
    const frozen = await put(accountant, `/tax/scheme-versions/${versionId}/cells`, { version: 3, cells: seededCells() });
    expect(frozen.status).toBe(422);
    expect(frozen.body.error.code).toBe('INVALID_STATE_TRANSITION');
  });

  it('refuses the accountant and the manager as checkers: neither holds mdm.tax.approve', async () => {
    await expect(decide(accountantActor, approvalId, 'APPROVED')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(decide(managerActor, approvalId, 'APPROVED')).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('activates on the owner’s approval, from the day of approval because 1 January has passed, and publishes the event', async () => {
    await decide(ownerActor, approvalId, 'APPROVED');
    const active = await get(accountant, `/tax/scheme-versions/${versionId}`);
    expect(active.body).toMatchObject({ status: 'ACTIVE', validFrom: today, validTo: null, approvalRequestId: approvalId });
    const { rows } = await database.pool('admin').query("SELECT payload FROM platform.outbox_message WHERE event_type = 'mdm.TaxSchemeVersionActivated' AND subject_id = $1", [versionId]);
    expect(rows).toHaveLength(1);
    const audit = await database.pool('admin').query("SELECT action FROM platform.audit_event WHERE entity_type = 'TaxSchemeVersion' AND entity_id = $1 ORDER BY occurred_at", [versionId]);
    expect(audit.rows.map((row: { action: string }) => row.action)).toEqual(['CREATE', 'UPDATE', 'SUBMIT', 'ACTIVATE']);
  });

  it('lists the versions newest first with no cells', async () => {
    const listed = await get(accountant, '/tax/scheme-versions');
    expect(listed.body.data).toEqual([expect.objectContaining({ id: versionId, status: 'ACTIVE', cells: [] })]);
  });
});

describe('calculateTax with the scheme in force (FR-MDM-013, FR-MDM-014)', () => {
  it('splits the GHS 459.00 beef pack into 382.50, 57.38, 9.56 and 9.56, and leaves a goat zero-rated', async () => {
    const result = await calculate(cashier, { taxInclusive: true, taxDate: today, lines: [line('beef', TAX_CATEGORY.PROCESSED_MEAT, 45_900), line('goat', TAX_CATEGORY.LIVE_ANIMALS, 65_000)] });
    expect(result.status).toBe(200);
    expect(result.body.lines[0]).toEqual({
      lineRef: 'beef',
      netPesewas: 38_250,
      taxPesewas: 7_650,
      grossPesewas: 45_900,
      levies: [
        { levyCode: 'VAT', levyName: 'Value Added Tax', treatment: 'STANDARD', ratePercent: '15.00', basePesewas: 38_250, amountPesewas: 5_738 },
        { levyCode: 'NHIL', levyName: 'National Health Insurance Levy', treatment: 'STANDARD', ratePercent: '2.50', basePesewas: 38_250, amountPesewas: 956 },
        { levyCode: 'GETFUND', levyName: 'GETFund Levy', treatment: 'STANDARD', ratePercent: '2.50', basePesewas: 38_250, amountPesewas: 956 },
      ],
    });
    expect(result.body.lines[1]).toMatchObject({ netPesewas: 65_000, taxPesewas: 0, grossPesewas: 65_000 });
    expect(result.body.lines[1].levies.map((levy: { treatment: string; amountPesewas: number }) => [levy.treatment, levy.amountPesewas])).toEqual([
      ['ZERO_RATED', 0],
      ['ZERO_RATED', 0],
      ['ZERO_RATED', 0],
    ]);
    expect(result.body).toMatchObject({ netPesewas: 103_250, taxPesewas: 7_650, grossPesewas: 110_900, currency: 'GHS', taxInclusive: true });
  });

  it('charges VAT 1,500, NHIL 250 and GETFund 250 on a tax-exclusive net of 10,000', async () => {
    const result = await calculate(cashier, { taxInclusive: false, taxDate: today, lines: [line('1', TAX_CATEGORY.PROCESSED_MEAT, 10_000)] });
    expect(result.body.lines[0].levies.map((levy: { amountPesewas: number }) => levy.amountPesewas)).toEqual([1_500, 250, 250]);
    expect(result.body.grossPesewas).toBe(12_000);
  });

  it('adds the totals from line integers: two nets of 19 carry no NHIL although 2.5 percent of 38 rounds to 1', async () => {
    const result = await calculate(cashier, { taxInclusive: false, taxDate: today, lines: [line('a', TAX_CATEGORY.PROCESSED_MEAT, 19), line('b', TAX_CATEGORY.PROCESSED_MEAT, 19)] });
    expect(result.body).toMatchObject({ netPesewas: 38, taxPesewas: 6, grossPesewas: 44 });
  });

  it('refuses a tax date before the version starts and an unknown category, naming the field', async () => {
    const early = await calculate(cashier, { taxInclusive: false, taxDate: '2025-12-31', lines: [line('1', TAX_CATEGORY.PROCESSED_MEAT, 10_000)] });
    expect(early.body.error.code).toBe('TAX_SCHEME_NOT_IN_FORCE');
    const unknown = await calculate(cashier, { taxInclusive: false, taxDate: today, lines: [line('1', randomUUID(), 10_000)] });
    expect(unknown.status).toBe(422);
    expect(unknown.body.error).toMatchObject({ code: 'REFERENCE_NOT_FOUND', details: [{ field: '/lines/0/taxCategoryId' }] });
  });

  it('refuses the driver, who may not calculate tax', async () => {
    const refused = await calculate(driver, { taxInclusive: false, taxDate: today, lines: [line('1', TAX_CATEGORY.PROCESSED_MEAT, 10_000)] });
    expect(refused.status).toBe(403);
  });

  it('charges nothing on a tax date when the business is not registered', async () => {
    const settingId = randomUUID();
    await database
      .pool('app')
      .query("INSERT INTO platform.setting (id, key, value, value_type, valid_from, description, created_by, updated_by) VALUES ($1, 'tax.registered', 'false', 'BOOLEAN', $2, 'Below the GHS 750,000 threshold', $3, $3)", [
        settingId,
        `${today}T00:00:00Z`,
        SYSTEM_PRINCIPAL,
      ]);
    try {
      const result = await calculate(cashier, { taxInclusive: true, taxDate: today, lines: [line('1', TAX_CATEGORY.PROCESSED_MEAT, 12_000)] });
      expect(result.body.lines[0]).toMatchObject({ netPesewas: 12_000, taxPesewas: 0, grossPesewas: 12_000 });
      expect(result.body.lines[0].levies.map((levy: { ratePercent: string }) => levy.ratePercent)).toEqual(['0.00', '0.00', '0.00']);
    } finally {
      await database.pool('app').query("UPDATE platform.setting SET deleted_at = now(), deleted_by = $2, delete_reason = 'test over', version = version + 1 WHERE id = $1", [settingId, SYSTEM_PRINCIPAL]);
    }
  });
});

describe('a later version, and a levy added after drafting (ADR-0020, ADR-0039)', () => {
  it('activates a compounding version from a later date, ending version 1 the day it starts', async () => {
    const created = await post(accountant, '/tax/scheme-versions', { validFrom: '2030-01-01', sourceNote: 'Compounding test version', copyFromVersionId: (await get(accountant, '/tax/scheme-versions')).body.data[0].id });
    expect(created.body.cells).toHaveLength(21);
    const compounding = seededCells((cell) => {
      if (cell['taxCategoryId'] !== TAX_CATEGORY.PROCESSED_MEAT) return cell;
      const order = { [LEVY.NHIL]: 1, [LEVY.GETFUND]: 2, [LEVY.VAT]: 3 }[cell['levyId'] as string]!;
      return order === 3 ? { ...cell, calcOrder: 3, baseKind: 'NET_PLUS_LEVIES', baseIncludesLevyIds: [LEVY.NHIL, LEVY.GETFUND] } : { ...cell, calcOrder: order };
    });
    expect((await put(accountant, `/tax/scheme-versions/${created.body.id}/cells`, { version: 1, cells: compounding })).status).toBe(200);
    const submitted = await post(accountant, `/tax/scheme-versions/${created.body.id}/submit`, {});
    await decide(ownerActor, submitted.body.approvalRequestId, 'APPROVED');

    const before = await calculate(cashier, { taxInclusive: false, taxDate: '2029-12-31', lines: [line('1', TAX_CATEGORY.PROCESSED_MEAT, 10_000)] });
    expect(before.body.grossPesewas).toBe(12_000);
    const after = await calculate(cashier, { taxInclusive: false, taxDate: '2030-01-01', lines: [line('1', TAX_CATEGORY.PROCESSED_MEAT, 10_000)] });
    expect(after.body.lines[0].levies.map((levy: { levyCode: string; basePesewas: number; amountPesewas: number }) => [levy.levyCode, levy.basePesewas, levy.amountPesewas])).toEqual([
      ['NHIL', 10_000, 250],
      ['GETFUND', 10_000, 250],
      ['VAT', 10_500, 1_575],
    ]);
    expect(after.body.grossPesewas).toBe(12_075);
    const versions = (await get(accountant, '/tax/scheme-versions')).body.data;
    expect(versions.map((version: { versionNo: number; status: string; validTo: string | null }) => [version.versionNo, version.status, version.validTo])).toEqual([
      [2, 'ACTIVE', null],
      [1, 'ACTIVE', '2030-01-01'],
    ]);
  });

  it('refuses to submit a copy that has no cells for a levy created after it was drafted', async () => {
    const draft = await post(accountant, '/tax/scheme-versions', { validFrom: '2031-01-01', sourceNote: 'Draft before the new levy', copyFromVersionId: (await get(accountant, '/tax/scheme-versions')).body.data[0].id });
    const levy = await post(accountant, '/tax/levies', { code: 'COVID', name: 'COVID-19 Health Recovery Levy', sortOrder: 4 });
    expect(levy.status).toBe(201);
    const duplicate = await post(accountant, '/tax/levies', { code: 'COVID', name: 'Again' });
    expect(duplicate.body.error).toMatchObject({ code: 'DUPLICATE_VALUE', details: [{ field: '/code' }] });
    const refused = await post(accountant, `/tax/scheme-versions/${draft.body.id}/submit`, {});
    expect(refused.status).toBe(422);
    expect(refused.body.error.code).toBe('TAX_MATRIX_INCOMPLETE');
    expect(refused.body.error.details).toHaveLength(7);
    expect(refused.body.error.details[0]).toMatchObject({ field: '/cells', code: expect.stringMatching(/\/COVID$/) });
  });

  it('refuses the owner as checker of a version the owner submitted: maker and checker are never one person', async () => {
    const draft = (await get(owner, '/tax/scheme-versions')).body.data.find((version: { status: string }) => version.status === 'DRAFT');
    const covid = (await get(owner, '/tax/levies')).body.data.find((levy: { code: string }) => levy.code === 'COVID').id as string;
    const cells = [...seededCells(), ...ALL_CATEGORIES.map((taxCategoryId) => ({ taxCategoryId, levyId: covid, treatment: 'ZERO_RATED', ratePercent: '0', baseKind: 'NET', isReclaimable: true, calcOrder: 4 }))];
    expect((await put(owner, `/tax/scheme-versions/${draft.id}/cells`, { version: draft.version, cells })).status).toBe(200);
    const submitted = await post(owner, `/tax/scheme-versions/${draft.id}/submit`, {});
    expect(submitted.status).toBe(202);
    await expect(decide(ownerActor, submitted.body.approvalRequestId, 'APPROVED')).rejects.toMatchObject({ code: 'MAKER_CANNOT_CHECK' });
  });
});
