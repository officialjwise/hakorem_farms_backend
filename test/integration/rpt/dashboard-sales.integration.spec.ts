import { randomUUID } from 'node:crypto';
import { ManualClock, Quantity, toBusinessDate } from '@hakorem/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LedgerReconciliation } from '../../../src/modules/fin';
import { addDays } from '../../../src/modules/rpt/domain/dashboard';
import { PgDashboardStore } from '../../../src/modules/rpt/infrastructure/pg-dashboard-store';
import { runAsSystem } from '../../../src/platform/context/request-context';
import type { Transaction } from '../../../src/platform/database/unit-of-work';
import { SEED_HAND_COUNT } from '../../../src/seed/farm-inv';
import { SEED_TRADING_DAY } from '../../../src/seed/farm-ord';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedCalendar } from '../../../src/seed/seed-calendar';
import { seedUnits } from '../../../src/seed/seed-units';
import { stepUp, type TotpSession } from '../../support/fin';
import { consoleGet, consolePost, createUser, enrolAndLogin, login, relaxRateLimits, SYSTEM_PRINCIPAL, testStartTime, type RoleCode, type TestSession } from '../../support/iam';
import { startTestApp, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * The B09a continued 2g gate (FR-RPT-001, CR-013, A-149, A-234): the owner dashboard's sales figures, top movers and
 * sales series, and the tiles getSalesTodayTile and getSalesSeries, answer to the pesewa from completed orders on the
 * seeded trading day, read through ORD's published views as the reporting role reads them. A VOIDED order is not a
 * sale; a completed return leaves the figures as they were. The trading day, posted through SalePosting by the seeded
 * cashier, keeps the B5 hand count (less exactly what it sold), the trial balance at 0 and the cost pools tied to
 * the ledger. Every wrong role is refused.
 */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let TODAY: string;
const sessions = new Map<string, TestSession>();
const ids = new Map<string, string>();
const id = (code: string) => ids.get(code)!;
const as = (who: string) => sessions.get(who)!;
const get = (who: string, path: string) => consoleGet(api.server, as(who), `/v1${path}`);
const post = (who: string, path: string, body: object = {}) => consolePost(api.server, as(who), `/v1${path}`, randomUUID()).send(body);
const decide = (who: string, approvalId: string) => post(who, `/iam/approvals/${approvalId}/approve`, { reason: 'Seen at the counter' });
const admin = () => database.pool('admin');

// The seeded trading day, priced by the engine at list (src/seed/farm-ord.ts): goat 58,500, two crates of eggs 12,000,
// three cabbages 3,000 and 3.500 kg of goat meat 6,930 on one wholesale receipt of 80,430; one crate collected and paid
// on collection, 6,000; four yams on a wholesale receipt, 8,000.
const WHOLESALE_ONE = 80_430;
const ONLINE = 6_000;
const YAMS = 8_000;
const DAY_TOTAL = WHOLESALE_ONE + ONLINE + YAMS;
// The cost the day issued, by hand: the goat's own pool 60,000; three crates from 105,000 for 30, 7,000 for two and
// 3,500 for the third; three cabbages at 500; 3.500 kg of 390,000 for 30 kg at 13,000 a kg, 45,500; four yams at 1,200.
const COST_ISSUED = 60_000 + 7_000 + 3_500 + 1_500 + 45_500 + 4_800;

beforeAll(async () => {
  database = await createTestDatabase();
  // A run that starts in the last hours of an Accra day starts just after the next midnight instead, so the seeded day,
  // the void (allowed only on the sale's own business day) and the day after are the days the test names.
  const start = testStartTime();
  clock = new ManualClock(start.getUTCHours() >= 22 ? new Date(`${addDays(toBusinessDate(start), 1)}T00:05:00Z`) : start);
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock });
  await runSeedUnits(database.pool('app'), api.app, seedUnits({ SEED_STAFF_PASSWORD: `Seed-${randomUUID()}` }, { tradingDay: true }));
  TODAY = seedCalendar(clock.now()).today;
  for (const row of (
    await admin().query<{ code: string; id: string }>(
      `SELECT 'branch:' || code AS code, id FROM mdm.branch
       UNION ALL SELECT 'product:' || sku, id FROM mdm.product
       UNION ALL SELECT 'location:' || l.code, l.id FROM mdm.location l JOIN mdm.branch b ON b.id = l.branch_id WHERE b.code = 'DDW'`,
    )
  ).rows) {
    ids.set(row.code, row.id);
  }
  const branchId = id('branch:DDW');
  const now = () => clock.now();
  for (const [who, name, role] of [['owner', 'Ama Owusu', 'OWNER'], ['manager', 'Kojo Addo', 'MANAGER'], ['accountant', 'Abena Ofori', 'ACCOUNTANT']] as const) {
    const user = await createUser(database, { name, grants: [{ role, branchId }] });
    ids.set(`user:${who}`, user.principalId);
    sessions.set(who, await enrolAndLogin(api.server, user, now));
  }
  sessions.set('testOwner', await enrolAndLogin(api.server, await createUser(database, { name: 'Kwabena Asare', grants: [{ role: 'OWNER', branchId: id('branch:TST') }] }), now));
  for (const role of ['STOREKEEPER', 'CASHIER', 'SALES', 'DRIVER', 'FARM_HAND'] as const satisfies readonly RoleCode[]) {
    const user = await createUser(database, { name: `Kwame ${role.toLowerCase()}`, grants: [{ role, branchId }] });
    ids.set(`user:${role}`, user.principalId);
    sessions.set(role, await login(api.server, user));
  }
});

afterAll(async () => {
  await api?.close();
  await database?.drop();
});

/** The seeded sale whose lines include the product, by SKU. */
async function saleWith(sku: string): Promise<{ id: string; lineId: string }> {
  const { rows } = await admin().query<{ id: string; line_id: string }>(
    'SELECT o.id, l.id AS line_id FROM ord.sales_order o JOIN ord.sales_order_line l ON l.sales_order_id = o.id WHERE l.product_id = $1 ORDER BY o.placed_at LIMIT 1',
    [id(`product:${sku}`)],
  );
  return { id: rows[0]!.id, lineId: rows[0]!.line_id };
}

const SERIES_OF_TODAY = (total: number, orders: number) => ({ date: TODAY, salesPesewas: total, orderCount: orders });

describe('the seeded trading day keeps the books and the hand count true (hakorem-seed, B5, B8)', () => {
  it('posted three sales through SalePosting, each completed, numbered and paid in full by the seeded cashier', async () => {
    const { rows } = await admin().query<{ channel: string; status: string; total: string; order_no: string; cashier: string }>(
      `SELECT o.channel, o.status, o.final_total_pesewas::text AS total, o.order_no, p.display_name AS cashier
         FROM ord.sales_order o JOIN iam.principal p ON p.id = o.created_by ORDER BY o.order_no`,
    );
    expect(rows.map((r) => [r.channel, r.status, Number(r.total), r.cashier])).toEqual([
      ['WHOLESALE', 'COMPLETED', WHOLESALE_ONE, 'Adwoa Darko'],
      ['ONLINE', 'COMPLETED', ONLINE, 'Adwoa Darko'],
      ['WHOLESALE', 'COMPLETED', YAMS, 'Adwoa Darko'],
    ]);
    expect(rows.every((r) => /^SO-\d{4}-DDW-\d{6}$/.test(r.order_no))).toBe(true);
    const unpaid = await admin().query("SELECT 1 FROM bil.pub_document WHERE kind = 'RECEIPT' AND order_document_id IS NOT NULL AND outstanding_pesewas > 0");
    expect(unpaid.rowCount).toBe(0);
  });

  it('changes nothing on a second run of the seed with its trading day', async () => {
    const records = await runSeedUnits(database.pool('app'), api.app, seedUnits({ SEED_STAFF_PASSWORD: `Seed-${randomUUID()}` }, { tradingDay: true }));
    expect(records).toBe(0);
    expect((await admin().query('SELECT 1 FROM ord.sales_order')).rowCount).toBe(3);
  });

  it('leaves on hand exactly the B5 hand count less what the day sold, at every Dodowa location, the movement ledger agreeing', async () => {
    const expected = new Map<string, Quantity>(SEED_HAND_COUNT.lines.map((l) => [`${l.location}:${l.sku}`, Quantity.parse(l.onHand)]));
    for (const sold of SEED_TRADING_DAY.sold) expected.set(`${sold.location}:${sold.sku}`, expected.get(`${sold.location}:${sold.sku}`)!.minus(Quantity.parse(sold.qty)));
    const balances = await admin().query<{ code: string; sku: string; qty: string }>(
      `SELECT l.code, p.sku, sum(b.on_hand_qty)::numeric(14,3)::text AS qty FROM inv.stock_balance b
         JOIN mdm.location l ON l.id = b.location_id JOIN mdm.product p ON p.id = b.product_id
        WHERE l.branch_id = $1 AND NOT l.is_virtual GROUP BY l.code, p.sku HAVING sum(b.on_hand_qty) <> 0`,
      [id('branch:DDW')],
    );
    const ledger = await admin().query<{ code: string; sku: string; qty: string }>(
      `WITH signed AS (SELECT to_location_id AS location_id, product_id, qty_base AS qty FROM inv.stock_movement
                       UNION ALL SELECT from_location_id, product_id, -qty_base FROM inv.stock_movement)
       SELECT l.code, p.sku, sum(s.qty)::numeric(14,3)::text AS qty FROM signed s JOIN mdm.location l ON l.id = s.location_id JOIN mdm.product p ON p.id = s.product_id
        WHERE l.branch_id = $1 AND NOT l.is_virtual GROUP BY l.code, p.sku HAVING sum(s.qty) <> 0`,
      [id('branch:DDW')],
    );
    const want = Object.fromEntries([...expected].map(([k, q]) => [k, q.toDecimalString()]));
    expect(Object.fromEntries(balances.rows.map((r) => [`${r.code}:${r.sku}`, r.qty]))).toEqual(want);
    expect(Object.fromEntries(ledger.rows.map((r) => [`${r.code}:${r.sku}`, r.qty]))).toEqual(want);
  });

  it('issued 122,300 at cost, so stock stands at 1,667,201, and the dashboard values it so', async () => {
    const issued = await admin().query<{ v: string }>("SELECT sum(value_pesewas)::text AS v FROM inv.stock_movement WHERE movement_type = 'SALE_ISSUE'");
    expect(Number(issued.rows[0]!.v)).toBe(COST_ISSUED);
    expect(COST_ISSUED).toBe(122_300);
    const body = (await get('owner', '/dashboard/owner')).body;
    expect(body.stockValueAtCostPesewas).toBe(SEED_HAND_COUNT.totalValueAtCostPesewas - COST_ISSUED);
    expect(body.stockValueAtCostPesewas).toBe(1_667_201);
  });

  it('sums the trial balance to exactly zero with no break, cost of sales at the cost issued, the day\'s cash in till T1', async () => {
    const totals = await admin().query<{ signed: string }>("SELECT sum(CASE side WHEN 'D' THEN amount_pesewas ELSE -amount_pesewas END)::text AS signed FROM fin.journal_line");
    expect(totals.rows[0]!.signed).toBe('0');
    const report = await runAsSystem({ principalId: SYSTEM_PRINCIPAL, displayName: 'Scheduler' }, randomUUID(), () =>
      api.app.get(LedgerReconciliation).run({ principalId: SYSTEM_PRINCIPAL, kind: 'SYSTEM', displayName: 'Scheduler', realm: null, sessionId: null, steppedUpAt: null }),
    );
    expect([report.signedSumPesewas, report.unbalancedEntries, report.sources.flatMap((s) => s.breaks)]).toEqual([0n, [], []]);
    const cost = await admin().query<{ booked: string }>(
      "SELECT sum(CASE l.side WHEN 'D' THEN l.amount_pesewas ELSE -l.amount_pesewas END)::text AS booked FROM fin.journal_line l JOIN fin.account a ON a.id = l.account_id WHERE a.code LIKE '50__'",
    );
    expect(Number(cost.rows[0]!.booked)).toBe(COST_ISSUED);
    const body = (await get('owner', '/dashboard/owner')).body;
    expect(body.cash).toEqual({ tillsPesewas: DAY_TOTAL, safePesewas: 0, driversPesewas: 0, bankPesewas: 0, mobileMoneyPesewas: 0, totalPesewas: DAY_TOTAL, negativeFigures: [] });
    // The B08 continued 2 documents are unchanged: every sale was paid in full at the counter.
    expect([body.receivablesOutstandingPesewas, body.receivablesOverduePesewas]).toEqual([109_389, 0]);
  });
});

describe('the owner dashboard answers its sales figures exactly from completed orders (FR-RPT-001, CR-013)', () => {
  it('answers today, yesterday, the month to date, the channels, the top movers and the week, none of them pending', async () => {
    const response = await get('owner', '/dashboard/owner');
    expect(response.status).toBe(200);
    const body = response.body;
    expect(body.date).toBe(TODAY);
    expect([body.salesTodayPesewas, body.salesYesterdayPesewas, body.salesMonthToDatePesewas]).toEqual([DAY_TOTAL, 0, DAY_TOTAL]);
    expect(body.salesByChannel).toEqual([
      { channel: 'POS', amountPesewas: 0, count: 0 },
      { channel: 'ONLINE', amountPesewas: ONLINE, count: 1 },
      { channel: 'WHOLESALE', amountPesewas: WHOLESALE_ONE + YAMS, count: 2 },
      { channel: 'QUOTE', amountPesewas: 0, count: 0 },
    ]);
    expect(body.topMovers.map((m: { product: { sku: string }; qty: string; uom: string; revenuePesewas: number }) => [m.product.sku, m.qty, m.uom, m.revenuePesewas])).toEqual([
      ['LIV-GOAT', '1.000', 'HEAD', 58_500],
      ['EGG-CRATE-BIG', '3.000', 'CRATE', 18_000],
      ['PRD-YAM-TUBER', '4.000', 'TUBER', YAMS],
      ['MEAT-GOAT-15KG', '3.500', 'KG', 6_930],
      ['PRD-CABBAGE-HEAD', '3.000', 'UNIT', 3_000],
    ]);
    expect(body.topMovers[0].product).toEqual({ id: id('product:LIV-GOAT'), sku: 'LIV-GOAT', name: expect.any(String) });
    expect(body.salesSeries).toMatchObject({ from: addDays(TODAY, -6), to: TODAY, totalPesewas: DAY_TOTAL, orderCount: 3 });
    expect(body.salesSeries.points).toHaveLength(7);
    expect(body.salesSeries.points.at(-1)).toEqual(SERIES_OF_TODAY(DAY_TOTAL, 3));
    expect(body.salesSeries.points.slice(0, 6).every((p: { salesPesewas: number; orderCount: number }) => p.salesPesewas === 0 && p.orderCount === 0)).toBe(true);
    expect(body.pendingFigures.map((f: { figure: string }) => f.figure)).toEqual(['alerts', 'exceptionsToday']);
    expect(body.salesByChannel.reduce((sum: number, c: { amountPesewas: number }) => sum + c.amountPesewas, 0)).toBe(body.salesTodayPesewas);
  });

  it('answers the same figures in the tiles: getSalesTodayTile and getSalesSeries', async () => {
    const today = await get('manager', '/dashboard/tiles/sales-today');
    expect(today.status).toBe(200);
    expect(today.body).toEqual({ branchIds: [id('branch:DDW')], date: TODAY, salesPesewas: DAY_TOTAL, orderCount: 3, currency: 'GHS', asOf: clock.now().toISOString() });
    const series = await get('accountant', '/dashboard/tiles/sales');
    expect(series.status).toBe(200);
    expect(series.body.sales).toMatchObject({ from: addDays(TODAY, -29), to: TODAY, totalPesewas: DAY_TOTAL, orderCount: 3 });
    expect(series.body.sales.points).toHaveLength(30);
    expect(series.body.sales.points.at(-1)).toEqual(SERIES_OF_TODAY(DAY_TOTAL, 3));
    const day = await get('owner', `/dashboard/tiles/sales?from=${TODAY}&to=${TODAY}`);
    expect(day.body.sales).toEqual({ from: TODAY, to: TODAY, points: [SERIES_OF_TODAY(DAY_TOTAL, 3)], totalPesewas: DAY_TOTAL, orderCount: 3 });
    const before = await get('owner', `/dashboard/tiles/sales-today?date=${addDays(TODAY, -1)}`);
    expect([before.body.salesPesewas, before.body.orderCount]).toEqual([0, 0]);
  });

  it('answers a branch with no sale with exact zeros', async () => {
    const tile = await get('testOwner', '/dashboard/tiles/sales-today');
    expect(tile.body).toMatchObject({ branchIds: [id('branch:TST')], salesPesewas: 0, orderCount: 0 });
    const dashboard = (await get('testOwner', '/dashboard/owner')).body;
    expect([dashboard.salesTodayPesewas, dashboard.salesMonthToDatePesewas, dashboard.topMovers, dashboard.salesSeries.totalPesewas]).toEqual([0, 0, [], 0]);
  });

  it('refuses a date after today, and a period too long or reversed, with REPORT_PERIOD_INVALID', async () => {
    const tomorrow = addDays(TODAY, 1);
    for (const path of [`/dashboard/tiles/sales-today?date=${tomorrow}`, `/dashboard/tiles/sales?from=${addDays(TODAY, -92)}&to=${TODAY}`, `/dashboard/tiles/sales?from=${TODAY}&to=${addDays(TODAY, -1)}`]) {
      const response = await get('owner', path);
      expect(response.status, path).toBe(422);
      expect(response.body.error.code).toBe('REPORT_PERIOD_INVALID');
    }
    expect((await get('owner', '/dashboard/tiles/sales-today?period=WEEK')).status).toBe(400);
  });
});

describe('the dashboard and the sales tiles refuse the wrong role (ADR-0035)', () => {
  it('refuses the owner dashboard to all but the Owner, and the sales tiles to the Storekeeper, Cashier, Sales, Driver and Farm hand', async () => {
    for (const who of ['manager', 'accountant', 'STOREKEEPER', 'CASHIER', 'SALES', 'DRIVER', 'FARM_HAND']) {
      expect((await get(who, '/dashboard/owner')).status, who).toBe(403);
    }
    for (const who of ['STOREKEEPER', 'CASHIER', 'SALES', 'DRIVER', 'FARM_HAND']) {
      expect((await get(who, '/dashboard/tiles/sales-today')).status, who).toBe(403);
      expect((await get(who, '/dashboard/tiles/sales')).status, who).toBe(403);
    }
    for (const who of ['owner', 'manager', 'accountant']) expect((await get(who, '/dashboard/tiles/sales-today')).status, who).toBe(200);
  });

  it('refuses a branch outside the grants', async () => {
    expect((await get('manager', `/dashboard/tiles/sales-today?branchId=${id('branch:TST')}`)).status).toBe(403);
    expect((await get('testOwner', `/dashboard/tiles/sales?branchId=${id('branch:DDW')}`)).status).toBe(403);
  });
});

describe('a VOIDED order is not a sale, and a completed return leaves the figures as they were (A-234)', () => {
  it('takes the voided yam sale out of every figure once the Owner approves the void', async () => {
    const yams = await saleWith('PRD-YAM-TUBER');
    const asked = await post('CASHIER', `/orders/${yams.id}/void`, { reasonCode: 'CUSTOMER_CHANGED_MIND', note: 'Took the yams back before leaving' });
    expect(asked.status, JSON.stringify(asked.body)).toBe(202);
    // Still a sale while the void waits.
    expect((await get('owner', '/dashboard/tiles/sales-today')).body.salesPesewas).toBe(DAY_TOTAL);
    await stepUp(api.server, as('owner') as TotpSession, clock);
    const approved = await decide('owner', asked.body.approvalRequestId as string);
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    const body = (await get('owner', '/dashboard/owner')).body;
    expect([body.salesTodayPesewas, body.salesMonthToDatePesewas, body.salesSeries.totalPesewas, body.salesSeries.orderCount]).toEqual([DAY_TOTAL - YAMS, DAY_TOTAL - YAMS, DAY_TOTAL - YAMS, 2]);
    expect(body.salesByChannel.find((c: { channel: string }) => c.channel === 'WHOLESALE')).toEqual({ channel: 'WHOLESALE', amountPesewas: WHOLESALE_ONE, count: 1 });
    expect(body.topMovers.map((m: { product: { sku: string } }) => m.product.sku)).toEqual(['LIV-GOAT', 'EGG-CRATE-BIG', 'MEAT-GOAT-15KG', 'PRD-CABBAGE-HEAD']);
    expect((await get('manager', '/dashboard/tiles/sales-today')).body).toMatchObject({ salesPesewas: DAY_TOTAL - YAMS, orderCount: 2 });
  });

  it('keeps a sale at its gross when one of its cabbages comes back on a completed return', async () => {
    const sale = await saleWith('PRD-CABBAGE-HEAD');
    const created = await post('CASHIER', '/returns', {
      orderId: sale.id,
      kind: 'RETURN',
      reasonCode: 'RETURN_UNWANTED',
      refundDestination: 'ORIGINAL_METHOD',
      lines: [{ orderLineId: sale.lineId, qty: '1.000', disposition: 'RESTOCK' }],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const submitted = await post('CASHIER', `/returns/${created.body.id}/submit`);
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(202);
    await stepUp(api.server, as('owner') as TotpSession, clock);
    const approved = await decide('owner', submitted.body.approvalRequestId as string);
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect((await admin().query<{ status: string }>('SELECT status FROM ord.order_return WHERE id = $1', [created.body.id])).rows[0]!.status).toBe('COMPLETED');
    const body = (await get('owner', '/dashboard/owner')).body;
    expect([body.salesTodayPesewas, body.salesSeries.orderCount]).toEqual([DAY_TOTAL - YAMS, 2]);
    expect(body.topMovers.find((m: { product: { sku: string } }) => m.product.sku === 'PRD-CABBAGE-HEAD')).toMatchObject({ qty: '3.000', revenuePesewas: 3_000 });
  });

  it('moves the day to yesterday when the clock passes midnight in Accra, the series and the month to date following', async () => {
    clock.set(new Date(`${addDays(TODAY, 1)}T08:00:00Z`));
    // A new day, a new sign-in: the Owner who reads it signs in on the new day's clock.
    sessions.set('owner', await enrolAndLogin(api.server, await createUser(database, { name: 'Ama Owusu', grants: [{ role: 'OWNER', branchId: id('branch:DDW') }] }), () => clock.now()));
    const kept = DAY_TOTAL - YAMS;
    const body = (await get('owner', '/dashboard/owner')).body;
    const sameMonth = addDays(TODAY, 1).slice(0, 7) === TODAY.slice(0, 7);
    expect([body.date, body.salesTodayPesewas, body.salesYesterdayPesewas, body.salesMonthToDatePesewas]).toEqual([addDays(TODAY, 1), 0, kept, sameMonth ? kept : 0]);
    expect(body.topMovers).toEqual([]);
    expect(body.salesSeries.points.slice(-2)).toEqual([SERIES_OF_TODAY(kept, 2), { date: addDays(TODAY, 1), salesPesewas: 0, orderCount: 0 }]);
    expect((await get('owner', `/dashboard/owner?date=${TODAY}`)).body.salesTodayPesewas).toBe(kept);
    // The tiles take today from the application clock too.
    expect((await get('owner', '/dashboard/tiles/sales-today')).body).toMatchObject({ date: addDays(TODAY, 1), salesPesewas: 0, orderCount: 0 });
    expect((await get('owner', '/dashboard/tiles/sales')).body.sales.points.slice(-2)).toEqual([SERIES_OF_TODAY(kept, 2), { date: addDays(TODAY, 1), salesPesewas: 0, orderCount: 0 }]);
  });
});

describe('the sales figures are read through ORD\'s published views only (ADR-0011, ADR-0023)', () => {
  it('answers them on a connection as the reporting role, which cannot read the order tables', async () => {
    const client = await database.pool('report').connect();
    try {
      const tx = client as unknown as Transaction;
      const store = new PgDashboardStore();
      const branchIds = [id('branch:DDW')];
      const kept = BigInt(DAY_TOTAL - YAMS);
      expect(await store.salesByDay(tx, branchIds, { from: TODAY, to: TODAY })).toEqual([{ date: TODAY, valuePesewas: kept, count: 2 }]);
      expect((await store.salesByChannel(tx, branchIds, TODAY)).sort((a, b) => a.channel.localeCompare(b.channel))).toEqual([
        { channel: 'ONLINE', grossPesewas: 6_000n, count: 1 },
        { channel: 'WHOLESALE', grossPesewas: 80_430n, count: 1 },
      ]);
      expect((await store.productSales(tx, branchIds, TODAY)).map((r) => r.sku).sort()).toEqual(['EGG-CRATE-BIG', 'LIV-GOAT', 'MEAT-GOAT-15KG', 'PRD-CABBAGE-HEAD']);
      await expect(client.query('SELECT 1 FROM ord.sales_order LIMIT 1')).rejects.toMatchObject({ code: '42501' });
      await expect(client.query('SELECT 1 FROM ord.sales_order_line LIMIT 1')).rejects.toMatchObject({ code: '42501' });
    } finally {
      client.release();
    }
  });
});
