import { randomUUID } from 'node:crypto';
import { ManualClock } from '@hakorem/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { totpAt } from '../../../src/modules/iam/domain/totp';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { consoleGet, consolePost, consolePut, createUser, enrolAndLogin, login, relaxRateLimits, testStartTime, type TestSession } from '../../support/iam';
import { sqlStateOf, SQLSTATE } from '../../support/sql-state';
import { startTestApp, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * Stock takes and cycle counts over the seeded farm (FR-INV-013, FR-INV-014, ADR-0017, ADR-0035, threat model "a
 * count used to hide a shortage"): every write refuses the wrong role and the wrong location; the expected figure is
 * frozen at start and hidden from everyone until counting closes; every difference is recounted; a variance posts a
 * STOCKTAKE_GAIN or STOCKTAKE_LOSS at its pool value; a variance value at or above 50,000 pesewas waits for a
 * different person; two counts of one location never share a product, in the application and in the database.
 */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let manager: TestSession & { readonly secret: Buffer };
let owner: TestSession & { readonly secret: Buffer };
let accountant: TestSession;
let coldStorekeeper: TestSession;
let shopStorekeeper: TestSession;
let penStorekeeper: TestSession;
let cashier: TestSession;
let sales: TestSession;
let driver: TestSession;
let farmHand: TestSession;
const ids = new Map<string, string>();

const id = (code: string) => ids.get(code)!;
const post = (session: TestSession, path: string, body: object = {}, key: string = randomUUID()) => consolePost(api.server, session, `/v1${path}`, key).send(body);
const put = (session: TestSession, path: string, body: object, key: string = randomUUID()) => consolePut(api.server, session, `/v1${path}`, key).send(body);
const get = (session: TestSession, path: string) => consoleGet(api.server, session, `/v1${path}`);
const admin = () => database.pool('admin');

async function stepUp(session: TestSession & { readonly secret: Buffer }): Promise<void> {
  clock.advanceBy(30_000);
  const response = await post(session, '/auth/step-up', { code: totpAt(session.secret, Math.floor(clock.now().getTime() / 1000)) });
  expect(response.status).toBe(200);
}

async function onHand(location: string, unit: string | null, sku: string): Promise<string> {
  const { rows } = await admin().query<{ qty: string }>(
    `SELECT COALESCE(sum(b.on_hand_qty), 0)::numeric(14,3)::text AS qty FROM inv.stock_balance b
      WHERE b.location_id = $1 AND b.product_id = $2 AND b.stock_unit_id IS NOT DISTINCT FROM $3`,
    [id(`location:${location}`), id(`product:${sku}`), unit === null ? null : id(`unit:${unit}`)],
  );
  return rows[0]!.qty;
}

const cycle = (location: string, ...skus: string[]) => ({ locationId: id(`location:${location}`), scope: 'CYCLE', productIds: skus.map((sku) => id(`product:${sku}`)) });

/** Plans and starts a take as the session, and answers its lines. */
async function started(session: TestSession, body: object): Promise<{ takeId: string; lines: Array<Record<string, unknown>> }> {
  const created = await post(session, '/stock-takes', body);
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const takeId = created.body.id as string;
  const start = await post(session, `/stock-takes/${takeId}/start`);
  expect(start.status, JSON.stringify(start.body)).toBe(200);
  return { takeId, lines: (await get(session, `/stock-takes/${takeId}/lines`)).body.data };
}

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock });
  await runSeedUnits(database.pool('app'), api.app, seedUnits({ SEED_STAFF_PASSWORD: `Seed-${randomUUID()}` }));
  for (const row of (
    await admin().query<{ code: string; id: string }>(
      `SELECT 'branch:' || code AS code, id FROM mdm.branch
       UNION ALL SELECT 'location:' || l.code, l.id FROM mdm.location l JOIN mdm.branch b ON b.id = l.branch_id WHERE b.code = 'DDW'
       UNION ALL SELECT 'product:' || sku, id FROM mdm.product
       UNION ALL SELECT 'unit:' || identifier, id FROM inv.stock_unit`,
    )
  ).rows) {
    ids.set(row.code, row.id);
  }
  const branchId = id('branch:DDW');
  manager = await enrolAndLogin(api.server, await createUser(database, { name: 'Akosua Boateng', grants: [{ role: 'MANAGER', branchId }] }), () => clock.now());
  owner = await enrolAndLogin(api.server, await createUser(database, { name: 'Nana Ama Korsah', grants: [{ role: 'OWNER', branchId }] }), () => clock.now());
  accountant = await enrolAndLogin(api.server, await createUser(database, { name: 'Yaw Agyeman', grants: [{ role: 'ACCOUNTANT', branchId }] }), () => clock.now());
  coldStorekeeper = await login(api.server, await createUser(database, { name: 'Kofi Mensah', grants: [{ role: 'STOREKEEPER', branchId, locationId: id('location:COLD') }] }));
  shopStorekeeper = await login(api.server, await createUser(database, { name: 'Efua Quaye', grants: [{ role: 'STOREKEEPER', branchId, locationId: id('location:SHOP') }] }));
  penStorekeeper = await login(api.server, await createUser(database, { name: 'Kwabena Owusu', grants: [{ role: 'STOREKEEPER', branchId, locationId: id('location:PENS') }] }));
  cashier = await login(api.server, await createUser(database, { name: 'Adwoa Darko', grants: [{ role: 'CASHIER', branchId, locationId: id('location:SHOP') }] }));
  sales = await login(api.server, await createUser(database, { name: 'Esi Appiah', grants: [{ role: 'SALES', branchId }] }));
  driver = await login(api.server, await createUser(database, { name: 'Selorm Agbeko', grants: [{ role: 'DRIVER', branchId }] }));
  farmHand = await login(api.server, await createUser(database, { name: 'Abdul-Rahman Iddrisu', grants: [{ role: 'FARM_HAND', branchId, locationId: id('location:PENS') }] }));
});

afterAll(async () => {
  await api.close();
  await database.drop();
});

describe('wrong roles are refused on every stock take write (ADR-0035)', () => {
  let takeId: string;
  let lineId: string;
  beforeAll(async () => {
    const take = await started(shopStorekeeper, cycle('SHOP', 'PRD-0002'));
    takeId = take.takeId;
    lineId = take.lines[0]!['id'] as string;
  });

  const writes = (): ReadonlyArray<readonly [string, 'post' | 'put', string, object]> => [
    ['createStockTake', 'post', '/stock-takes', cycle('SHOP', 'PRD-0002')],
    ['startStockTake', 'post', `/stock-takes/${takeId}/start`, {}],
    ['recordStockTakeCounts', 'put', `/stock-takes/${takeId}/counts`, { counts: [{ lineId, countedQty: '25.000' }] }],
    ['closeStockTakeCounting', 'post', `/stock-takes/${takeId}/review`, {}],
    ['submitStockTake', 'post', `/stock-takes/${takeId}/submit`, {}],
    ['cancelStockTake', 'post', `/stock-takes/${takeId}/cancel`, { reason: 'Refused' }],
  ];

  it('the Accountant, Cashier, Sales, Driver and Farm hand are refused with 403 FORBIDDEN on all six writes, each refusal audited, and nothing changes', async () => {
    const count = async () => (await admin().query<{ n: number }>("SELECT count(*)::int AS n FROM platform.audit_event WHERE action = 'AUTHORISATION_FAILURE'")).rows[0]!.n;
    const takes = async () => (await admin().query<{ n: number; v: number }>('SELECT count(*)::int AS n, sum(version)::int AS v FROM inv.stock_take')).rows[0]!;
    const before = await count();
    const state = await takes();
    for (const [op, method, path, body] of writes()) {
      for (const [role, session] of Object.entries({ accountant, cashier, sales, driver, farmHand })) {
        const response = method === 'put' ? await put(session, path, body) : await post(session, path, body);
        expect(response.status, `${op} as ${role}`).toBe(403);
        expect(response.body.error.code).toBe('FORBIDDEN');
      }
    }
    expect((await count()) - before).toBe(30);
    expect(await takes()).toEqual(state);
  });

  it('a storekeeper counts but never posts variances; a storekeeper at the cold room cannot plan, count or cancel at the shop', async () => {
    expect((await post(shopStorekeeper, `/stock-takes/${takeId}/submit`)).status).toBe(403);
    expect((await post(coldStorekeeper, '/stock-takes', cycle('SHOP', 'PRD-0005'))).status).toBe(403);
    expect((await put(coldStorekeeper, `/stock-takes/${takeId}/counts`, { counts: [{ lineId, countedQty: '25.000' }] })).status).toBe(403);
    expect((await post(coldStorekeeper, `/stock-takes/${takeId}/cancel`, { reason: 'Not mine' })).status).toBe(403);
    expect((await get(coldStorekeeper, `/stock-takes/${takeId}`)).status).toBe(403);
    expect((await get(cashier, '/stock-takes')).status).toBe(403);
  });

  it('the take is cancelled with a reason, then frozen: it cannot start again, and the database refuses a change', async () => {
    const cancelled = await post(shopStorekeeper, `/stock-takes/${takeId}/cancel`, { reason: 'Counted with the wrong sheet' });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.status).toBe('CANCELLED');
    expect((await post(shopStorekeeper, `/stock-takes/${takeId}/start`)).body.error.code).toBe('INVALID_STATE_TRANSITION');
    expect(await sqlStateOf(admin().query("UPDATE inv.stock_take SET scope = 'FULL', version = version + 1 WHERE id = $1", [takeId]))).toBe(SQLSTATE.documentFrozen);
  });
});

describe('a blind count posts its variances (FR-INV-013)', () => {
  let takeId: string;
  let lineId: string;

  it('freezes 30 crates of eggs (900, A-261) as expected at start, and nobody reads it, nor any variance, while counting', async () => {
    const take = await started(shopStorekeeper, cycle('SHOP', 'EGG-0003'));
    takeId = take.takeId;
    expect(take.lines).toHaveLength(1);
    lineId = take.lines[0]!['id'] as string;
    for (const session of [shopStorekeeper, manager, owner]) {
      const line = (await get(session, `/stock-takes/${takeId}/lines`)).body.data[0];
      expect(line).toMatchObject({ expectedQty: null, countedQty: null, varianceQty: null, varianceValuePesewas: null, varianceDirection: null, needsRecount: false });
    }
    const { rows } = await admin().query<{ expected_qty: string }>('SELECT expected_qty FROM inv.stock_take_line WHERE id = $1', [lineId]);
    expect(rows[0]!.expected_qty).toBe('900.000');
  });

  it('refuses to close counting with a line uncounted, and a recount while counting', async () => {
    const closed = await post(shopStorekeeper, `/stock-takes/${takeId}/review`);
    expect(closed.status).toBe(422);
    expect(closed.body.error.code).toBe('STOCK_TAKE_NOT_COUNTED');
    const recount = await put(shopStorekeeper, `/stock-takes/${takeId}/counts`, { counts: [{ lineId, countedQty: '870.000', isRecount: true }] });
    expect(recount.status).toBe(422);
    expect(recount.body.error.details[0].code).toBe('RECOUNT_IN_REVIEW_ONLY');
  });

  it('a counted 29 crates (870), corrected to 870 again, then counting closes: expected 900, variance -30 eggs (a crate) valued 3,500, and a recount is asked for', async () => {
    expect((await put(shopStorekeeper, `/stock-takes/${takeId}/counts`, { counts: [{ lineId, countedQty: '28.000' }] })).status).toBe(200);
    const counted = await put(shopStorekeeper, `/stock-takes/${takeId}/counts`, { counts: [{ lineId, countedQty: '870.000' }] });
    expect(counted.body).toMatchObject({ status: 'COUNTING', lineCount: 1, countedLineCount: 1, countedBy: { displayName: 'Efua Quaye' }, gainValuePesewas: null });
    const review = await post(shopStorekeeper, `/stock-takes/${takeId}/review`);
    expect(review.status).toBe(200);
    expect(review.body).toMatchObject({ status: 'REVIEW', gainValuePesewas: 0, lossValuePesewas: 3_500 });
    const line = (await get(manager, `/stock-takes/${takeId}/lines`)).body.data[0];
    expect(line).toMatchObject({ expectedQty: '900.000', countedQty: '870.000', recountQty: null, varianceQty: '-30.000', varianceValuePesewas: 3_500, varianceDirection: 'LOSS', needsRecount: true, uom: 'UNIT' });
  });

  it('refuses to submit before the recount; the recount confirms 870 and the manager posts one STOCKTAKE_LOSS of 3,500', async () => {
    const early = await post(manager, `/stock-takes/${takeId}/submit`);
    expect(early.status).toBe(422);
    expect(early.body.error.details[0].code).toBe('RECOUNT_REQUIRED');
    expect((await put(shopStorekeeper, `/stock-takes/${takeId}/counts`, { counts: [{ lineId, countedQty: '870.000' }] })).body.error.details[0].code).toBe('COUNTING_CLOSED');
    expect((await put(shopStorekeeper, `/stock-takes/${takeId}/counts`, { counts: [{ lineId, countedQty: '870.000', isRecount: true }] })).status).toBe(200);
    const twice = await put(shopStorekeeper, `/stock-takes/${takeId}/counts`, { counts: [{ lineId, countedQty: '900.000', isRecount: true }] });
    expect(twice.body.error.details[0].code).toBe('RECOUNT_NOT_NEEDED');
    const posted = await post(manager, `/stock-takes/${takeId}/submit`);
    expect(posted.status, JSON.stringify(posted.body)).toBe(200);
    expect(posted.body).toMatchObject({ status: 'POSTED', lossValuePesewas: 3_500, postedBy: { displayName: 'Akosua Boateng' } });
    const { rows } = await admin().query<{ movement_type: string; qty_base: string; value_pesewas: string; reason_code: string }>(
      'SELECT movement_type, qty_base, value_pesewas, reason_code FROM inv.stock_movement WHERE source_document_id = $1',
      [takeId],
    );
    expect(rows).toEqual([{ movement_type: 'STOCKTAKE_LOSS', qty_base: '30.000', value_pesewas: '3500', reason_code: 'COUNT_ERROR' }]);
    expect(await onHand('SHOP', 'EGG-BIG-2026-1110', 'EGG-0003')).toBe('870.000');
    expect((await post(manager, `/stock-takes/${takeId}/cancel`, { reason: 'Too late' })).body.error.code).toBe('INVALID_STATE_TRANSITION');
    expect(await sqlStateOf(admin().query('UPDATE inv.stock_take_line SET counted_qty = 30 WHERE id = $1', [lineId]))).toBe(SQLSTATE.documentFrozen);
  });

  it('a movement during counting does not change the frozen figure: 2 yams lost meanwhile and 38 counted is a variance of -2 against 40', async () => {
    const take = await started(shopStorekeeper, cycle('SHOP', 'PRD-0005'));
    const adjusted = await post(shopStorekeeper, '/stock-adjustments', {
      locationId: id('location:SHOP'),
      reasonCode: 'DAMAGED',
      note: 'Two tubers rotted',
      lines: [{ productId: id('product:PRD-0005'), direction: 'LOSS', qty: '2.000' }],
    });
    expect((await post(shopStorekeeper, `/stock-adjustments/${adjusted.body.id as string}/submit`)).status).toBe(200);
    const yamLine = take.lines[0]!['id'] as string;
    await put(shopStorekeeper, `/stock-takes/${take.takeId}/counts`, { counts: [{ lineId: yamLine, countedQty: '38.000' }] });
    await post(shopStorekeeper, `/stock-takes/${take.takeId}/review`);
    const line = (await get(manager, `/stock-takes/${take.takeId}/lines`)).body.data[0];
    expect(line).toMatchObject({ expectedQty: '40.000', varianceQty: '-2.000', varianceDirection: 'LOSS' });
    // 48,000 for 40 tubers less 2 issued at 1,200: 45,600 for 38; two more at average are 2,400.
    expect(line.varianceValuePesewas).toBe(2_400);
    expect((await post(shopStorekeeper, `/stock-takes/${take.takeId}/cancel`, { reason: 'Recount tomorrow after the delivery' })).status).toBe(200);
  });
});

describe('a large variance waits for a different person (FR-INV-013, ADR-0017)', () => {
  let takeId: string;
  it('beef counted 40.000 kg of 45.000: a loss of 5 kg valued 60,000 answers 202 and stock is unchanged', async () => {
    const take = await started(coldStorekeeper, cycle('COLD', 'MEAT-0005'));
    takeId = take.takeId;
    const lineId = take.lines[0]!['id'] as string;
    await put(coldStorekeeper, `/stock-takes/${takeId}/counts`, { counts: [{ lineId, countedQty: '40.000', countedWeightKg: '40.000' }] });
    await post(coldStorekeeper, `/stock-takes/${takeId}/review`);
    await put(coldStorekeeper, `/stock-takes/${takeId}/counts`, { counts: [{ lineId, countedQty: '40.000', isRecount: true }] });
    const submitted = await post(manager, `/stock-takes/${takeId}/submit`);
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(202);
    expect(submitted.body).toMatchObject({ status: 'PENDING_APPROVAL', kind: 'STOCK_WRITE_OFF', subject: { id: takeId, docType: 'STOCK_TAKE' } });
    expect(await onHand('COLD', 'LOT-BEEF-2026-1110', 'MEAT-0005')).toBe('45.000');
    expect((await get(manager, `/stock-takes/${takeId}`)).body).toMatchObject({ status: 'PENDING_APPROVAL', lossValuePesewas: 60_000, approvalRequestId: submitted.body.approvalRequestId });
    expect((await post(manager, `/stock-takes/${takeId}/cancel`, { reason: 'Withdraw' })).body.error.code).toBe('INVALID_STATE_TRANSITION');

    await stepUp(manager);
    const self = await post(manager, `/iam/approvals/${submitted.body.approvalRequestId as string}/approve`, { reason: 'My own' });
    expect(self.body.error.code).toBe('MAKER_CANNOT_CHECK');
    await stepUp(owner);
    const approved = await post(owner, `/iam/approvals/${submitted.body.approvalRequestId as string}/approve`, { reason: 'Saw the trimmed carcass' });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect((await get(manager, `/stock-takes/${takeId}`)).body).toMatchObject({ status: 'POSTED', postedBy: { displayName: 'Nana Ama Korsah' } });
    expect(await onHand('COLD', 'LOT-BEEF-2026-1110', 'MEAT-0005')).toBe('40.000');
    const { rows } = await admin().query<{ movement_type: string; value_pesewas: string }>('SELECT movement_type, value_pesewas FROM inv.stock_movement WHERE source_document_id = $1', [takeId]);
    expect(rows).toEqual([{ movement_type: 'STOCKTAKE_LOSS', value_pesewas: '60000' }]);
  });

  it('the database refuses a take posted at or above its threshold without an approval; a rejected take closes with nothing moved', async () => {
    const take = await started(coldStorekeeper, cycle('COLD', 'MEAT-0007'));
    const lineId = take.lines[0]!['id'] as string;
    await put(coldStorekeeper, `/stock-takes/${take.takeId}/counts`, { counts: [{ lineId, countedQty: '25.000' }] });
    await post(coldStorekeeper, `/stock-takes/${take.takeId}/review`);
    await put(coldStorekeeper, `/stock-takes/${take.takeId}/counts`, { counts: [{ lineId, countedQty: '25.000', isRecount: true }] });
    // 5 kg of 30 worth 390,000 is 65,000: at or above 50,000, never posted without a different person's approval.
    const unapproved = admin().query(
      "UPDATE inv.stock_take SET status = 'POSTED', posted_at = now(), posted_by = created_by, approval_threshold_pesewas = 50000, version = version + 1 WHERE id = $1",
      [take.takeId],
    );
    expect(await sqlStateOf(unapproved)).toBe(SQLSTATE.checkViolation);
    const submitted = await post(manager, `/stock-takes/${take.takeId}/submit`);
    expect(submitted.status).toBe(202);
    await stepUp(owner);
    expect((await post(owner, `/iam/approvals/${submitted.body.approvalRequestId as string}/reject`, { reason: 'Count the lot again' })).status).toBe(200);
    expect((await get(manager, `/stock-takes/${take.takeId}`)).body.status).toBe('CANCELLED');
    expect(await onHand('COLD', 'LOT-GOAT-0001', 'MEAT-0007')).toBe('30.000');
    expect((await admin().query('SELECT count(*)::int AS n FROM inv.stock_movement WHERE source_document_id = $1', [take.takeId])).rows[0]!.n).toBe(0);
  });
});

describe('cycle counts never overlap (FR-INV-014)', () => {
  it('"Cold room, beef" runs while "Pens, broilers" runs; a second cold room count including beef, and a full one, are refused', async () => {
    const coldBeef = await started(coldStorekeeper, cycle('COLD', 'MEAT-0005'));
    const pens = await started(penStorekeeper, cycle('PENS', 'LIV-0001'));
    expect(pens.lines).toHaveLength(1);
    const overlapping = await post(coldStorekeeper, '/stock-takes', cycle('COLD', 'MEAT-0007', 'MEAT-0005'));
    expect(overlapping.status).toBe(422);
    expect(overlapping.body.error).toMatchObject({ code: 'STOCK_TAKE_INVALID', details: [{ code: 'SCOPE_OVERLAP' }] });
    expect((await post(coldStorekeeper, '/stock-takes', { locationId: id('location:COLD'), scope: 'FULL' })).body.error.details[0].code).toBe('SCOPE_OVERLAP');
    expect((await post(coldStorekeeper, '/stock-takes', cycle('COLD', 'MEAT-0007'))).status).toBe(201);
    for (const take of [coldBeef, pens]) await post(manager, `/stock-takes/${take.takeId}/cancel`, { reason: 'Test over' });
  });

  it('the database refuses to start a take whose scope overlaps one counting, whoever writes (ck_stock_take_overlap)', async () => {
    const first = await started(coldStorekeeper, cycle('COLD', 'MEAT-0005'));
    const second = (await admin().query<{ id: string }>("SELECT id FROM inv.stock_take WHERE status = 'DRAFT' AND location_id = $1", [id('location:COLD')])).rows[0]!.id;
    await admin().query('INSERT INTO inv.stock_take_product (stock_take_id, product_id) VALUES ($1, $2)', [second, id('product:MEAT-0005')]);
    const forced = await admin().query("UPDATE inv.stock_take SET status = 'COUNTING', snapshot_at = now(), version = version + 1 WHERE id = $1", [second]).catch((e: unknown) => e);
    expect((forced as { code?: string; constraint?: string }).code).toBe('HK010');
    expect((forced as { constraint?: string }).constraint).toBe('ck_stock_take_overlap');
    const api422 = await post(coldStorekeeper, `/stock-takes/${second}/start`);
    expect(api422.body.error.details[0].code).toBe('SCOPE_OVERLAP');
    await post(manager, `/stock-takes/${first.takeId}/cancel`, { reason: 'Test over' });
    await post(manager, `/stock-takes/${second}/cancel`, { reason: 'Test over' });
  });

  it('animals are not counted here; a full count of the pens leaves them out and counts the broiler lot', async () => {
    const goats = await post(penStorekeeper, '/stock-takes', cycle('PENS', 'LIV-0004'));
    expect(goats.body.error.details[0].code).toBe('ANIMAL_NOT_COUNTED');
    const full = await started(penStorekeeper, { locationId: id('location:PENS'), scope: 'FULL' });
    expect(full.lines.map((l) => (l['product'] as { sku: string }).sku)).toEqual(['LIV-0001']);
    expect((await post(penStorekeeper, '/stock-takes', { locationId: id('location:TRANSIT'), scope: 'FULL' })).status).toBe(403);
    expect((await post(manager, '/stock-takes', { locationId: id('location:TRANSIT'), scope: 'FULL' })).body.error.details[0].code).toBe('NOT_A_STOCK_LOCATION');
    const listed = await get(manager, `/stock-takes?status=COUNTING&locationId=${id('location:PENS')}`);
    expect(listed.body.data.map((t: { id: string }) => t.id)).toEqual([full.takeId]);
    expect((await get(penStorekeeper, '/stock-takes')).body.data.every((t: { location: { code: string } }) => t.location.code === 'PENS')).toBe(true);
  });
});
