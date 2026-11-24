import { randomUUID } from 'node:crypto';
import { ManualClock, toBusinessDate } from '@hakorem/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CostingProjections } from '../../../src/modules/cst';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { documentWorker } from '../../support/documents';
import { runAsSystem } from '../../../src/platform/context/request-context';
import { consoleGet, createUser, enrolAndLogin, relaxRateLimits, testStartTime, type TestSession } from '../../support/iam';
import { startTestApp, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * Margins, break-even and the projections' tie to the ledger (FR-CST-003 to FR-CST-006, FR-CST-008) over the seeded
 * farm and its trading day: every sale, receipt, credit note and debit note posted through the services, the margin
 * projection kept by CST's asynchronous consumer as the outbox delivers, and every figure compared with the ledger's
 * own accounts and with a rebuild from the published views.
 */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let manager: TestSession;
let today: string;
const admin = () => database.pool('admin');
const get = (who: TestSession, path: string) => consoleGet(api.server, who, `/v1${path}`);
const projections = () => api.app.get(CostingProjections);
const SCHEDULER = { principalId: '01900000-0000-7000-8000-000000000004', displayName: 'Scheduler' };
/** The nightly comparison as the worker runs it: as the Scheduler. */
const compare = (whole: { from: string; to: string }) => runAsSystem(SCHEDULER, randomUUID(), () => projections().compareWithLedger(whole));
const range = () => `from=2020-01-01&to=${today}`;
const DIMENSIONS = ['PRODUCT', 'PRODUCT_LINE', 'CHANNEL', 'CUSTOMER', 'SALESPERSON', 'BRANCH'] as const;

interface Row {
  readonly group: { readonly id: string | null; readonly label: string };
  readonly revenuePesewas: number;
  readonly revenueIsNegative: boolean;
  readonly costPesewas: number;
  readonly costIsNegative: boolean;
  readonly grossMarginPesewas: number;
  readonly marginIsNegative: boolean;
  readonly marginPercent: string | null;
  readonly priceVariancePesewas: number;
  readonly priceVarianceIsNegative: boolean;
}
const signed = (size: number, negative: boolean) => (negative ? -size : size);
const sums = (rows: readonly Row[]) => ({
  revenue: rows.reduce((s, r) => s + signed(r.revenuePesewas, r.revenueIsNegative), 0),
  cost: rows.reduce((s, r) => s + signed(r.costPesewas, r.costIsNegative), 0),
  margin: rows.reduce((s, r) => s + signed(r.grossMarginPesewas, r.marginIsNegative), 0),
});

async function marginFacts(): Promise<unknown[]> {
  const { rows } = await admin().query('SELECT * FROM cst.margin_fact ORDER BY fact_ref');
  return rows.map((r) => ({ ...r, refreshed_at: null }));
}

/** The ledger's figures FR-CST-004 names, straight from FIN's tables. */
async function ledger(): Promise<{ revenue: number; cost: number; variance: number }> {
  const { rows } = await admin().query<{ code: string; net: string }>(
    `SELECT a.code, sum(CASE l.side WHEN 'D' THEN l.amount_pesewas ELSE -l.amount_pesewas END)::text AS net
       FROM fin.journal_line l JOIN fin.account a ON a.id = l.account_id GROUP BY a.code`,
  );
  const net = (codes: string[]) => rows.filter((r) => codes.includes(r.code)).reduce((s, r) => s + Number(r.net), 0);
  return { revenue: -net(['4000', '4010', '4020', '4030']) - net(['4200', '4210', '4220']), cost: net(['5000', '5010', '5020', '5030']), variance: net(['4210']) };
}

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock });
  await runSeedUnits(database.pool('app'), api.app, seedUnits({ SEED_STAFF_PASSWORD: `Seed-${randomUUID()}` }, { tradingDay: true }));
  await documentWorker(api, database, clock).settle();
  today = toBusinessDate(clock.now());
  const branchId = (await admin().query<{ id: string }>("SELECT id FROM mdm.branch WHERE code = 'DDW'")).rows[0]!.id;
  manager = await enrolAndLogin(api.server, await createUser(database, { name: 'Kwame Asare', grants: [{ role: 'MANAGER', branchId }] }), () => clock.now());
});

afterAll(async () => {
  await api?.close();
  await database?.drop();
});

describe('margin by dimension (FR-CST-003)', () => {
  it('kept by the consumer as the outbox delivered, exactly as a rebuild from the published views gives it', async () => {
    const consumed = await marginFacts();
    expect(consumed.length).toBeGreaterThan(0);
    await projections().rebuild();
    expect(await marginFacts()).toEqual(consumed);
  });

  it('adds up by every dimension to the same totals, which tie to the ledger', async () => {
    const book = await ledger();
    for (const groupBy of DIMENSIONS) {
      const response = await get(manager, `/costing/margins?groupBy=${groupBy}&${range()}&limit=100`);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body.page.hasMore).toBe(false);
      const totals = response.body.totals as Row;
      expect(sums(response.body.data as Row[]), groupBy).toEqual({ revenue: signed(totals.revenuePesewas, totals.revenueIsNegative), cost: signed(totals.costPesewas, totals.costIsNegative), margin: signed(totals.grossMarginPesewas, totals.marginIsNegative) });
      // Negotiated and overridden prices (4210) are shown, not hidden: the same signed figure as the ledger's.
      expect({ revenue: signed(totals.revenuePesewas, totals.revenueIsNegative), cost: signed(totals.costPesewas, totals.costIsNegative), variance: signed(totals.priceVariancePesewas, totals.priceVarianceIsNegative) }).toEqual(book);
    }
  });

  it('works each margin over the selling price, never over cost', async () => {
    const response = await get(manager, `/costing/margins?groupBy=PRODUCT&${range()}&limit=100`);
    for (const row of response.body.data as Row[]) {
      if (row.revenueIsNegative || row.costIsNegative || row.revenuePesewas === 0 || row.grossMarginPesewas > row.revenuePesewas) continue;
      const hundredths = Math.floor((2 * row.grossMarginPesewas * 10_000 + row.revenuePesewas) / (2 * row.revenuePesewas));
      expect(row.marginPercent, row.group.label).toBe(`${Math.floor(hundredths / 100)}.${String(hundredths % 100).padStart(2, '0')}`);
    }
  });

  it('refuses a range that ends after today', async () => {
    const tomorrow = toBusinessDate(new Date(clock.now().getTime() + 86_400_000));
    const response = await get(manager, `/costing/margins?groupBy=PRODUCT&from=${today}&to=${tomorrow}`);
    expect([response.status, response.body.error.code]).toEqual([422, 'REPORT_PERIOD_INVALID']);
  });
});

describe('the margin projection ties to the ledger (FR-CST-004)', () => {
  it('matches the ledger, reports one drift when a projection row is deleted, and the rebuild restores equality', async () => {
    const whole = { from: '2020-01-01', to: today };
    expect((await compare(whole)).drifted).toBe(false);
    await admin().query("DELETE FROM cst.margin_fact WHERE fact_ref = (SELECT fact_ref FROM cst.margin_fact WHERE fact_kind = 'COST' ORDER BY fact_ref LIMIT 1)");
    const before = (await admin().query<{ n: string }>("SELECT count(*)::text AS n FROM platform.outbox_message WHERE event_type = 'cst.ProjectionDriftDetected'")).rows[0]!.n;
    const drift = await compare(whole);
    expect(drift.drifted).toBe(true);
    expect(drift.revenue.projected).toBe(drift.revenue.ledger);
    expect(drift.costOfSales.projected).toBeLessThan(drift.costOfSales.ledger);
    const after = (await admin().query<{ n: string }>("SELECT count(*)::text AS n FROM platform.outbox_message WHERE event_type = 'cst.ProjectionDriftDetected'")).rows[0]!.n;
    expect(Number(after) - Number(before)).toBe(1);
    await projections().rebuild();
    expect((await compare(whole)).drifted).toBe(false);
  });
});

describe('break-even and contribution (FR-CST-005, FR-CST-006)', () => {
  it('ties each line to the margins by product line and the contributions to the total margin', async () => {
    const margins = await get(manager, `/costing/margins?groupBy=PRODUCT_LINE&${range()}&limit=100`);
    const breakEven = await get(manager, `/costing/break-even?${range()}`);
    expect(breakEven.status, JSON.stringify(breakEven.body)).toBe(200);
    const byLine = new Map((margins.body.data as Row[]).map((r) => [r.group.id ?? r.group.label, r] as const));
    expect(breakEven.body.lines.length).toBe(margins.body.data.length);
    let contribution = 0;
    for (const line of breakEven.body.lines as { productLine: string; revenuePesewas: number; variableCostPesewas: number; contributionPesewas: number; contributionIsNegative: boolean; fixedCostPesewas: number }[]) {
      const row = (margins.body.data as Row[]).find((r) => r.revenuePesewas === line.revenuePesewas && r.costPesewas === line.variableCostPesewas);
      expect(row, line.productLine).toBeDefined();
      contribution += signed(line.contributionPesewas, line.contributionIsNegative);
    }
    expect(byLine.size).toBe(breakEven.body.lines.length);
    expect(contribution).toBe(signed(margins.body.totals.grossMarginPesewas, margins.body.totals.marginIsNegative));
    expect((breakEven.body.lines as { fixedCostPesewas: number }[]).reduce((s, l) => s + l.fixedCostPesewas, 0)).toBe(breakEven.body.fixedCostPesewas);
    expect(breakEven.body.explanation).toContain('Break-even');
  });
});

describe('costing projection rebuild (FR-CST-008)', () => {
  it('drops and rebuilds the projections on the seeded data to identical figures for 12 sample cost objects', async () => {
    // Every stock unit the farm holds, and its pens and stores, up to twelve.
    const { rows: sample } = await admin().query<{ type: string; id: string }>(
      `(SELECT 'STOCK_UNIT' AS type, object_id AS id FROM cst.cost_object_summary WHERE object_type = 'STOCK_UNIT')
       UNION ALL (SELECT 'PEN', l.id FROM mdm.location l WHERE NOT l.is_virtual AND l.kind IN ('PEN', 'STORE', 'COLD_ROOM'))
       ORDER BY 1 DESC, 2 LIMIT 12`,
    );
    expect(sample).toHaveLength(12);
    const read = async () => Promise.all(sample.map(async (s) => ({ ...(await get(manager, `/costing/cost-objects/${s.type}/${s.id}`)).body, refreshedAt: null })));
    const before = await read();
    expect(before.every((b) => b.totalPesewas !== undefined)).toBe(true);
    await admin().query('DELETE FROM cst.cost_object_summary');
    await admin().query('DELETE FROM cst.margin_fact');
    await admin().query('DELETE FROM cst.loss_fact');
    await projections().rebuild();
    expect(await read()).toEqual(before);
  });
});
