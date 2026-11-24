import { randomUUID } from 'node:crypto';
import { ManualClock, toBusinessDate } from '@hakorem/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CostingProjections } from '../../../src/modules/cst';
import { documentWorker, type DocumentWorker } from '../../support/documents';
import { stepUp, type TotpSession } from '../../support/fin';
import { consoleGet, consolePost, createBranch, createUser, enrolAndLogin, login, relaxRateLimits, SYSTEM_PRINCIPAL, testStartTime, type TestSession } from '../../support/iam';
import { createStockFixture, move, pool, receive, stockDocument, stockUnit, type StockFixture } from '../../support/inventory';
import { sqlStateOf as sqlState } from '../../support/sql-state';
import { startTestApp, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * CST against the real engine (FR-CST-001, FR-CST-002, FR-CST-007, ADR-0018, ADR-0102): the stock is written in SQL as
 * any script could (the inventory fixture), the projections rebuilt from the published views, and the allocation run
 * through the API by the Accountant, posted by the Manager with step-up through INV and the ledger.
 */
let database: TestDatabase;
let api: TestApp;
let fx: StockFixture;
let clock: ManualClock;
let worker: DocumentWorker;
let accountant: TotpSession;
let owner: TotpSession;
let manager: TotpSession;
let cashier: TestSession;
let pen3: string;
const admin = () => database.pool('admin');
const get = (who: TestSession, path: string) => consoleGet(api.server, who, `/v1${path}`);
const post = (who: TestSession, path: string, body: object = {}, key: string = randomUUID()) => consolePost(api.server, who, `/v1${path}`, key).send(body);
const rebuild = () => api.app.get(CostingProjections).rebuild();
/** Noon UTC (noon in Accra) on the business day `offset` days from the clock's. */
const noonOn = (offset: number) => new Date(Date.parse(`${toBusinessDate(clock.now())}T12:00:00Z`) + offset * 86_400_000);
const dayOf = (offset: number) => toBusinessDate(noonOn(offset));

async function goat(tag: string, location: string, value: number, occurredAt: Date): Promise<string> {
  const unit = await stockUnit(fx, { productId: fx.goat, tracking: 'SERIAL', identifier: tag });
  await move(fx, { type: 'RECEIPT_PURCHASE', productId: fx.goat, from: fx.virtual.SUPPLIER, to: location, qty: '1.000', value, unitId: unit, occurredAt });
  return unit;
}

async function capitalise(unit: string, location: string, value: number, element: string): Promise<void> {
  await move(fx, { type: 'COST_CAPITALISE', productId: fx.goat, from: fx.virtual.CONSUMPTION, to: location, qty: '0.000', value, unitId: unit, costElement: element });
}

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  await relaxRateLimits(database);
  fx = await createStockFixture(database);
  api = await startTestApp(database, { clock });
  worker = documentWorker(api, database, clock);
  pen3 = randomUUID();
  await fx.app.query(
    `INSERT INTO mdm.location (id, branch_id, code, name, kind, is_virtual, is_sellable, allows_negative, created_by, updated_by)
     VALUES ($1, $2, 'PEN-3', 'Goat pen 3', 'PEN', false, false, false, $3, $3)`,
    [pen3, fx.branchId, SYSTEM_PRINCIPAL],
  );
  accountant = await enrolAndLogin(api.server, await createUser(database, { name: 'Efua Asante', grants: [{ role: 'ACCOUNTANT', branchId: fx.branchId }] }), () => clock.now());
  owner = await enrolAndLogin(api.server, await createUser(database, { name: 'Akua Mensah', grants: [{ role: 'OWNER', branchId: fx.branchId }] }), () => clock.now());
  manager = await enrolAndLogin(api.server, await createUser(database, { name: 'Kwame Asare', grants: [{ role: 'MANAGER', branchId: fx.branchId }] }), () => clock.now());
  cashier = await login(api.server, await createUser(database, { name: 'Ama Darko', grants: [{ role: 'CASHIER', branchId: fx.branchId }] }));
});

afterAll(async () => {
  await api?.close();
  await database?.drop();
});

describe('cost object view by element (FR-CST-001)', () => {
  let g0142: string;

  it('splits G-0142 into purchase 60,000, feed 8,400 and veterinary 3,000, which sum to 71,400, its cost pool', async () => {
    g0142 = await goat('G-0142', fx.pens, 60_000, noonOn(-20));
    await capitalise(g0142, fx.pens, 8_400, 'FEED');
    await capitalise(g0142, fx.pens, 3_000, 'VETERINARY');
    await rebuild();
    const view = await get(manager, `/costing/cost-objects/STOCK_UNIT/${g0142}`);
    expect(view.status, JSON.stringify(view.body)).toBe(200);
    expect(view.body).toMatchObject({ objectType: 'STOCK_UNIT', objectId: g0142, label: 'LIV-0004 G-0142', branchId: fx.branchId, totalPesewas: 71_400, currency: 'GHS' });
    expect(view.body.byElement).toEqual([
      { costElement: 'PURCHASE', valuePesewas: 60_000 },
      { costElement: 'FEED', valuePesewas: 8_400 },
      { costElement: 'VETERINARY', valuePesewas: 3_000 },
    ]);
    expect((await pool(fx, fx.goat, g0142))!.value).toBe('71400');
  });

  it('shows a pen as the animals standing in it now', async () => {
    const view = await get(accountant, `/costing/cost-objects/PEN/${fx.pens}`);
    expect(view.status).toBe(200);
    expect(view.body).toMatchObject({ objectType: 'PEN', label: 'PEN-2 location', totalPesewas: 71_400 });
  });

  it('shows a processing order as its input cost 71,400 by element plus direct 5,000 under processing', async () => {
    const order = await stockDocument(fx, 'PROCESSING_ORDER');
    const input = await goat('G-0143', fx.pens, 60_000, noonOn(-20));
    await capitalise(input, fx.pens, 8_400, 'FEED');
    await capitalise(input, fx.pens, 3_000, 'VETERINARY');
    await move(fx, { type: 'PROCESS_CONSUME', productId: fx.goat, from: fx.pens, to: fx.virtual.PROCESSING, qty: '1.000', unitId: input, documentId: order });
    const lot = await stockUnit(fx, { productId: fx.beef, tracking: 'LOT', identifier: 'MEAT-0143' });
    await move(fx, { type: 'PROCESS_OUTPUT', productId: fx.beef, from: fx.virtual.PROCESSING, to: fx.coldRoom, qty: '16.000', value: 76_400, unitId: lot, costElement: 'PROCESSING', documentId: order });
    await rebuild();
    const view = await get(manager, `/costing/cost-objects/PROCESSING_ORDER/${order}`);
    expect(view.status, JSON.stringify(view.body)).toBe(200);
    expect(view.body.byElement).toEqual([
      { costElement: 'PURCHASE', valuePesewas: 60_000 },
      { costElement: 'FEED', valuePesewas: 8_400 },
      { costElement: 'VETERINARY', valuePesewas: 3_000 },
      { costElement: 'PROCESSING', valuePesewas: 5_000 },
    ]);
    expect(view.body.totalPesewas).toBe(76_400);
    const output = await get(manager, `/costing/cost-objects/STOCK_UNIT/${lot}`);
    expect(output.body.byElement).toEqual([{ costElement: 'PROCESSING', valuePesewas: 76_400 }]);
  });

  it('rebuilds to identical figures, and a cost object of another branch answers as one that does not exist', async () => {
    const before = (await admin().query('SELECT * FROM cst.cost_object_summary ORDER BY object_type, object_id')).rows.map((r) => ({ ...r, refreshed_at: null }));
    await rebuild();
    const after = (await admin().query('SELECT * FROM cst.cost_object_summary ORDER BY object_type, object_id')).rows.map((r) => ({ ...r, refreshed_at: null }));
    expect(after).toEqual(before);
    const { branchId: elsewhere } = await createBranch(database, 'KPN');
    const stranger = await enrolAndLogin(api.server, await createUser(database, { name: 'Yaw Boateng', grants: [{ role: 'MANAGER', branchId: elsewhere }] }), () => clock.now());
    const theirs = await get(stranger, `/costing/cost-objects/STOCK_UNIT/${g0142}`);
    const madeUp = await get(stranger, `/costing/cost-objects/STOCK_UNIT/${randomUUID()}`);
    expect([theirs.status, madeUp.status]).toEqual([404, 404]);
    expect(theirs.body.error.code).toBe(madeUp.body.error.code);
  });

  it('refuses the Cashier every costing read', async () => {
    expect((await get(cashier, `/costing/cost-objects/STOCK_UNIT/${g0142}`)).status).toBe(403);
    expect((await get(cashier, `/costing/margins?groupBy=PRODUCT&from=${dayOf(-30)}&to=${dayOf(0)}`)).status).toBe(403);
    expect((await get(cashier, `/costing/break-even?from=${dayOf(-30)}&to=${dayOf(0)}`)).status).toBe(403);
    expect((await get(cashier, `/costing/losses?groupBy=CAUSE&from=${dayOf(-30)}&to=${dayOf(0)}`)).status).toBe(403);
    expect((await get(cashier, '/costing/overhead-allocations')).status).toBe(403);
  });
});

describe('labour and overhead allocation (FR-CST-002)', () => {
  let runId: string;
  const units: Record<string, string> = {};
  const period = () => ({ periodStart: dayOf(-12), periodEnd: dayOf(-3), costElement: 'LABOUR', basis: 'HEAD_DAYS', scopeLocationId: pen3, totalPesewas: 30_001 });

  it('spreads 30,001 over head-days of 10, 10 and 5 as 12,001, 12,000 and 6,000, a draft that posts nothing', async () => {
    units['G-0201'] = await goat('G-0201', pen3, 50_000, noonOn(-13));
    units['G-0202'] = await goat('G-0202', pen3, 50_000, noonOn(-13));
    units['G-0203'] = await goat('G-0203', pen3, 50_000, noonOn(-7));
    const created = await post(accountant, '/costing/overhead-allocations', period());
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    runId = created.body.id;
    expect(created.body).toMatchObject({ status: 'DRAFT', totalPesewas: 30_001, branchId: fx.branchId, scopeLocation: { id: pen3, code: 'PEN-3' }, createdBy: { displayName: 'Efua Asante' }, postedBy: null });
    expect(created.body.lines.map((l: { stockUnit: { identifier: string }; weight: number; amountPesewas: number; treatment: string; movementId: string | null }) => [l.stockUnit.identifier, l.weight, l.amountPesewas, l.treatment, l.movementId])).toEqual([
      ['G-0201', 10, 12_001, 'CAPITALISED', null],
      ['G-0202', 10, 12_000, 'CAPITALISED', null],
      ['G-0203', 5, 6_000, 'CAPITALISED', null],
    ]);
    expect((await pool(fx, fx.goat, units['G-0201']))!.value).toBe('50000');
  });

  it('refuses the Accountant the post, the Cashier the run, and the maker their own post', async () => {
    expect((await post(accountant, `/costing/overhead-allocations/${runId}/post`)).status).toBe(403);
    expect((await post(cashier, '/costing/overhead-allocations', period())).status).toBe(403);
    expect((await get(cashier, `/costing/overhead-allocations/${runId}`)).status).toBe(403);
    const own = await post(owner, '/costing/overhead-allocations', { ...period(), basis: 'EQUAL', costElement: 'OVERHEAD', totalPesewas: 9_001 });
    expect(own.status, JSON.stringify(own.body)).toBe(201);
    expect(own.body.lines.map((l: { amountPesewas: number }) => l.amountPesewas)).toEqual([3_001, 3_000, 3_000]);
    await stepUp(api.server, owner, clock);
    const refused = await post(owner, `/costing/overhead-allocations/${own.body.id}/post`);
    expect([refused.status, refused.body.error.code]).toEqual([422, 'MAKER_CANNOT_CHECK']);
  });

  it('refuses a period after today, a basis it cannot weigh and a scope that is not a pen', async () => {
    const late = await post(accountant, '/costing/overhead-allocations', { ...period(), periodEnd: dayOf(1) });
    const weight = await post(accountant, '/costing/overhead-allocations', { ...period(), basis: 'WEIGHT_GAIN' });
    const virtual = await post(accountant, '/costing/overhead-allocations', { ...period(), scopeLocationId: fx.virtual.CONSUMPTION });
    const empty = await post(accountant, '/costing/overhead-allocations', { ...period(), scopeLocationId: fx.store });
    expect([late, weight, virtual, empty].map((r) => [r.status, r.body.error?.details?.[0]?.code])).toEqual([
      [422, 'PERIOD_INVALID'],
      [422, 'BASIS_NOT_SUPPORTED'],
      [422, 'SCOPE_NOT_A_PEN'],
      [422, 'NO_ANIMALS_IN_SCOPE'],
    ]);
  });

  it('is posted by the Manager with step-up as value-only movements onto each animal, Dr inventory, Cr 5220, and once only', async () => {
    const before = (await admin().query<{ n: string }>("SELECT count(*)::text AS n FROM fin.journal_entry WHERE event_code = 'inv.OverheadAbsorbed'")).rows[0]!.n;
    await stepUp(api.server, manager, clock);
    const posted = await post(manager, `/costing/overhead-allocations/${runId}/post`);
    expect(posted.status, JSON.stringify(api.logLines().filter((l) => 'err' in l || 'error' in l).slice(-2))).toBe(200);
    expect(posted.body).toMatchObject({ status: 'POSTED', postedBy: { displayName: 'Kwame Asare' } });
    expect(posted.body.lines.every((l: { movementId: string | null }) => l.movementId !== null)).toBe(true);
    expect((await pool(fx, fx.goat, units['G-0201']))!.value).toBe('62001');
    expect((await pool(fx, fx.goat, units['G-0202']))!.value).toBe('62000');
    expect((await pool(fx, fx.goat, units['G-0203']))!.value).toBe('56000');
    const { rows: movements } = await admin().query<{ type: string; element: string; value: string }>(
      "SELECT movement_type AS type, cost_element AS element, value_pesewas::text AS value FROM inv.stock_movement WHERE source_document_id = $1 ORDER BY value_pesewas DESC",
      [runId],
    );
    expect(movements).toEqual([
      { type: 'OVERHEAD_CAPITALISE', element: 'LABOUR', value: '12001' },
      { type: 'OVERHEAD_CAPITALISE', element: 'LABOUR', value: '12000' },
      { type: 'OVERHEAD_CAPITALISE', element: 'LABOUR', value: '6000' },
    ]);
    const { rows: ledger } = await admin().query<{ code: string; side: string; amount: string }>(
      `SELECT a.code, l.side, sum(l.amount_pesewas)::text AS amount
         FROM fin.journal_line l JOIN fin.account a ON a.id = l.account_id JOIN fin.journal_entry e ON e.id = l.journal_entry_id
        WHERE e.event_code = 'inv.OverheadAbsorbed' AND e.source_document_id = $1 GROUP BY a.code, l.side ORDER BY l.side DESC`,
      [runId],
    );
    expect(ledger.map((r) => [r.side, r.amount])).toEqual([
      ['D', '30001'],
      ['C', '30001'],
    ]);
    expect(ledger.find((r) => r.side === 'C')!.code).toBe('5220');
    expect(Number((await admin().query<{ n: string }>("SELECT count(*)::text AS n FROM fin.journal_entry WHERE event_code = 'inv.OverheadAbsorbed'")).rows[0]!.n) - Number(before)).toBe(3);

    const { rows: published } = await admin().query<{ payload: Record<string, unknown> }>("SELECT payload FROM platform.outbox_message WHERE event_type = 'cst.OverheadAllocated' AND subject_id = $1", [runId]);
    expect(published.map((p) => [p.payload['totalPesewas'], p.payload['capitalisedPesewas'], p.payload['expensedPesewas'], p.payload['abuseCases']])).toEqual([[30_001, 30_001, 0, [72]]]);
    expect(published[0]!.payload['makerId']).not.toBe(published[0]!.payload['checkerId']);

    await worker.settle();
    const cost = await get(manager, `/costing/cost-objects/STOCK_UNIT/${units['G-0201']}`);
    expect(cost.body.byElement).toEqual([
      { costElement: 'PURCHASE', valuePesewas: 50_000 },
      { costElement: 'LABOUR', valuePesewas: 12_001 },
    ]);

    const again = await post(manager, `/costing/overhead-allocations/${runId}/post`);
    expect([again.status, again.body.error?.details?.[0]?.code]).toEqual([422, 'ALREADY_POSTED']);
    const twin = await post(accountant, '/costing/overhead-allocations', period());
    const twinPosted = await post(manager, `/costing/overhead-allocations/${twin.body.id}/post`);
    expect([twinPosted.status, twinPosted.body.error?.details?.[0]?.code]).toEqual([422, 'PERIOD_ALREADY_POSTED']);
    const listed = await get(manager, '/costing/overhead-allocations?limit=2');
    expect(listed.status).toBe(200);
    expect(listed.body.data).toHaveLength(2);
    expect(listed.body.page.hasMore).toBe(true);
    const next = await get(manager, `/costing/overhead-allocations?limit=2&cursor=${encodeURIComponent(listed.body.page.nextCursor)}`);
    expect(next.body.data.map((r: { id: string }) => r.id)).toContain(runId);
  });

  it('is refused by the database: lines that do not sum, a posted run changed, and a run posted by its maker', async () => {
    const run = await post(accountant, '/costing/overhead-allocations', { ...period(), costElement: 'OVERHEAD', totalPesewas: 1_000 });
    const id = run.body.id as string;
    const migrator = database.pool('app');
    expect(await sqlState(migrator.query("UPDATE cst.overhead_allocation_line SET amount_pesewas = amount_pesewas + 1 WHERE run_id = $1", [id]))).toBe('HK004');
    const client = await migrator.connect();
    try {
      await client.query('BEGIN');
      await client.query("INSERT INTO cst.overhead_allocation_line (run_id, stock_unit_id, weight, amount_pesewas, treatment) VALUES ($1, $2, 1, 1, 'EXPENSED')", [id, units['G-0142'] ?? (await goat('G-0299', pen3, 1, noonOn(-1)))]);
      expect(await sqlState(client.query('COMMIT'))).toBe('HK010');
    } finally {
      client.release();
    }
    expect(await sqlState(migrator.query("UPDATE cst.overhead_allocation_run SET total_pesewas = 2, version = version + 1 WHERE id = $1", [runId]))).toBe('HK004');
    expect(await sqlState(migrator.query("UPDATE cst.overhead_allocation_run SET status = 'POSTED', posted_at = now(), posted_by = created_by, version = version + 1 WHERE id = $1", [id]))).toBe('23514');
    expect(await sqlState(migrator.query('DELETE FROM cst.overhead_allocation_run WHERE id = $1', [id]))).not.toBeUndefined();
  });
});

describe('losses as their own figure (FR-CST-007)', () => {
  it('shows the doe written off at 62,500 under mortality and an expired lot of 8,000 under wastage, none of it in cost of sales', async () => {
    const doe = await goat('G-0310', fx.pens, 62_500, noonOn(-2));
    await move(fx, { type: 'MORTALITY', productId: fx.goat, from: fx.pens, to: fx.virtual.LOSS, qty: '1.000', unitId: doe, reason: 'HEAT_STRESS', occurredAt: noonOn(-1) });
    const lot = await stockUnit(fx, { productId: fx.eggLots, tracking: 'LOT', identifier: 'EGG-0310' });
    await receive(fx, fx.eggLots, fx.store, '30.000', 8_000, lot);
    await move(fx, { type: 'ADJUST_LOSS', productId: fx.eggLots, from: fx.store, to: fx.virtual.LOSS, qty: '30.000', unitId: lot, reason: 'EXPIRED', occurredAt: noonOn(-1) });
    await rebuild();
    const losses = await get(manager, `/costing/losses?groupBy=CAUSE&from=${dayOf(-1)}&to=${dayOf(-1)}`);
    expect(losses.status, JSON.stringify(losses.body)).toBe(200);
    expect(losses.body.data.map((r: { group: { label: string }; lossGroup: string; events: number; valuePesewas: number }) => [r.group.label, r.lossGroup, r.events, r.valuePesewas])).toEqual([
      ['Mortality', 'MORTALITY', 1, 62_500],
      ['Wastage and expiry', 'WASTAGE', 1, 8_000],
    ]);
    expect(losses.body.totalPesewas).toBe(70_500);
    const byLocation = await get(manager, `/costing/losses?groupBy=LOCATION&from=${dayOf(-1)}&to=${dayOf(-1)}`);
    expect(byLocation.body.data.map((r: { group: { id: string }; qty: string }) => [r.group.id, r.qty])).toEqual([
      [fx.pens, '1.000'],
      [fx.store, '30.000'],
    ]);
    const margins = await get(manager, `/costing/margins?groupBy=PRODUCT&from=${dayOf(-1)}&to=${dayOf(-1)}`);
    expect(margins.body.totals).toMatchObject({ revenuePesewas: 0, costPesewas: 0 });
  });
});
