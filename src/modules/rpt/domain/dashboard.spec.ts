import { describe, expect, it } from 'vitest';
import { addDays, animalsBySpecies, dashboardBranches, dashboardDate, daysBetween, isPending, monthToDate, PENDING_FIGURES, receivablesFigures, seriesPeriod } from './dashboard';
import { salesByChannel, topMovers } from './sales';
import { fillSeries } from './series';

const TODAY = '2026-11-15';

describe('the period of a dashboard time series (business dates in Africa/Accra)', () => {
  it('defaults to the 30 days ending today, both ends counted', () => {
    expect(seriesPeriod({}, TODAY)).toEqual({ ok: true, value: { from: '2026-10-17', to: '2026-11-15' } });
  });

  it('counts 30 days back from the end asked for, and forward from the start asked for, never past today', () => {
    expect(seriesPeriod({ to: '2026-11-10' }, TODAY)).toEqual({ ok: true, value: { from: '2026-10-12', to: '2026-11-10' } });
    expect(seriesPeriod({ from: '2026-10-01' }, TODAY)).toEqual({ ok: true, value: { from: '2026-10-01', to: '2026-10-30' } });
    expect(seriesPeriod({ from: '2026-11-10' }, TODAY)).toEqual({ ok: true, value: { from: '2026-11-10', to: '2026-11-15' } });
  });

  it('answers a single day and exactly 92 days, and refuses 93', () => {
    expect(seriesPeriod({ from: TODAY, to: TODAY }, TODAY)).toEqual({ ok: true, value: { from: TODAY, to: TODAY } });
    expect(seriesPeriod({ from: '2026-08-16', to: TODAY }, TODAY)).toEqual({ ok: true, value: { from: '2026-08-16', to: TODAY } });
    expect(seriesPeriod({ from: '2026-08-15', to: TODAY }, TODAY)).toEqual({ ok: false, error: [{ field: '/to', rule: 'PERIOD_TOO_LONG' }] });
  });

  it('refuses a start after the end, and an end after today', () => {
    expect(seriesPeriod({ from: '2026-11-12', to: '2026-11-11' }, TODAY)).toEqual({ ok: false, error: [{ field: '/from', rule: 'FROM_AFTER_TO' }] });
    expect(seriesPeriod({ from: '2026-11-01', to: '2026-11-16' }, TODAY)).toEqual({ ok: false, error: [{ field: '/to', rule: 'IN_THE_FUTURE' }] });
    expect(seriesPeriod({ from: '2026-11-16' }, TODAY)).toEqual({ ok: false, error: [{ field: '/from', rule: 'IN_THE_FUTURE' }] });
  });

  it('crosses a month and a year end by calendar days', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(daysBetween('2026-11-15', '2026-11-10')).toBe(-5);
  });
});

describe('the dashboard date', () => {
  it('is today unless asked, an earlier day when asked, and never a later one, with the week ending on it', () => {
    expect(dashboardDate(undefined, TODAY)).toEqual({ ok: true, value: { date: TODAY, yesterday: '2026-11-14', series: { from: '2026-11-09', to: TODAY } } });
    expect(dashboardDate('2026-11-14', TODAY)).toEqual({ ok: true, value: { date: '2026-11-14', yesterday: '2026-11-13', series: { from: '2026-11-08', to: '2026-11-14' } } });
    expect(dashboardDate('2026-11-01', TODAY, 'MONTH')).toEqual({ ok: true, value: { date: '2026-11-01', yesterday: '2026-10-31', series: { from: '2026-10-03', to: '2026-11-01' } } });
    expect(dashboardDate('2026-11-16', TODAY)).toEqual({ ok: false, error: [{ field: '/date', rule: 'IN_THE_FUTURE' }] });
  });
});

describe('a series of daily totals in integer pesewas', () => {
  it('lists every day of the period with an exact zero where nothing was received, and the exact total', () => {
    const series = fillSeries({ from: '2026-11-09', to: '2026-11-11' }, [{ date: '2026-11-10', valuePesewas: 1_535_001n, count: 4 }]);
    expect(series.points.map((p) => [p.date, p.valuePesewas.toJsonInteger(), p.count])).toEqual([
      ['2026-11-09', 0, 0],
      ['2026-11-10', 1_535_001, 4],
      ['2026-11-11', 0, 0],
    ]);
    expect(series.total.toJsonInteger()).toBe(1_535_001);
    expect(series.count).toBe(4);
  });

  it('adds two rows of one day exactly, one pesewa included, and ignores a row outside the period', () => {
    const series = fillSeries({ from: '2026-11-10', to: '2026-11-10' }, [
      { date: '2026-11-10', valuePesewas: 390_001n, count: 1 },
      { date: '2026-11-10', valuePesewas: 1n, count: 1 },
      { date: '2026-11-12', valuePesewas: 99n, count: 1 },
    ]);
    expect(series.points.map((p) => p.valuePesewas.toJsonInteger())).toEqual([390_002]);
    expect(series.total.toJsonInteger()).toBe(390_002);
    expect(series.count).toBe(2);
  });

  it('answers a period with no receipt at all as zeros, not as missing days', () => {
    const series = fillSeries({ from: '2026-11-14', to: '2026-11-15' }, []);
    expect(series.points).toHaveLength(2);
    expect(series.total.isZero()).toBe(true);
  });
});

describe('animals on hand by species', () => {
  it('orders species by code, leaves out an empty one, puts a product without a species last and totals the head', () => {
    const result = animalsBySpecies([
      { speciesId: 's', code: 'SHEEP', name: 'Sheep', count: 2 },
      { speciesId: null, code: null, name: null, count: 1 },
      { speciesId: 'g', code: 'GOAT', name: 'Goat', count: 4 },
      { speciesId: 'p', code: 'PIG', name: 'Pig', count: 0 },
    ]);
    expect(result.bySpecies.map((row) => row.code)).toEqual(['GOAT', 'SHEEP', null]);
    expect(result.total).toBe(7);
  });
});

describe('the branches a dashboard read covers', () => {
  it('is the branch asked for, or every branch of a whole-branch grant once, in id order', () => {
    expect(dashboardBranches('b-2', [])).toEqual(['b-2']);
    expect(
      dashboardBranches(undefined, [
        { branchId: 'b-2', locationId: null },
        { branchId: 'b-1', locationId: null },
        { branchId: 'b-2', locationId: null },
        { branchId: 'b-3', locationId: 'shop' },
      ]),
    ).toEqual(['b-1', 'b-2']);
  });
});

describe('the figures without a source yet', () => {
  it('names each with its source module, its reason and the phase that makes it live', () => {
    expect(PENDING_FIGURES.map((f) => [f.figure, f.phase])).toEqual([
      ['alerts', 'B12'],
      ['exceptionsToday', 'B12'],
    ]);
    expect(PENDING_FIGURES.every((f) => f.reason.length > 0 && f.source.length === 3)).toBe(true);
    expect(isPending('cash')).toBe(false);
    expect(isPending('receivablesOutstandingPesewas')).toBe(false);
    expect(isPending('receivablesOverduePesewas')).toBe(false);
    expect(isPending('stockValueAtCostPesewas')).toBe(false);
    for (const figure of ['salesTodayPesewas', 'salesYesterdayPesewas', 'salesMonthToDatePesewas', 'salesByChannel', 'salesSeries', 'topMovers']) expect(isPending(figure), figure).toBe(false);
  });
});

describe('the sales figures from completed orders (FR-RPT-001, CR-013, A-234)', () => {
  it('runs the month to date from the first of the month of the date, both ends counted', () => {
    expect(monthToDate('2026-11-15')).toEqual({ from: '2026-11-01', to: '2026-11-15' });
    expect(monthToDate('2026-11-01')).toEqual({ from: '2026-11-01', to: '2026-11-01' });
    expect(monthToDate('2027-02-28')).toEqual({ from: '2027-02-01', to: '2027-02-28' });
  });

  it('lists every channel in the contract order, a channel with no sale at an exact zero, and adds two rows of one channel', () => {
    expect(salesByChannel([
      { channel: 'WHOLESALE', grossPesewas: 80_430n, count: 1 },
      { channel: 'ONLINE', grossPesewas: 6_000n, count: 1 },
      { channel: 'WHOLESALE', grossPesewas: 3n, count: 2 },
    ])).toEqual([
      { channel: 'POS', amountPesewas: 0, count: 0 },
      { channel: 'ONLINE', amountPesewas: 6_000, count: 1 },
      { channel: 'WHOLESALE', amountPesewas: 80_433, count: 3 },
      { channel: 'QUOTE', amountPesewas: 0, count: 0 },
    ]);
    expect(salesByChannel([]).every((c) => c.amountPesewas === 0 && c.count === 0)).toBe(true);
  });

  it('ranks the five products that took the most by gross, a tie by SKU, and keeps each product and unit apart', () => {
    const row = (sku: string, gross: bigint, qty = '1.000', uom = 'HEAD') => ({ productId: `p-${sku}`, sku, name: sku, uom, qty, grossPesewas: gross });
    const ranked = topMovers([row('LIV-GOAT', 58_500n), row('EGG-CRATE-BIG', 12_000n, '2.000', 'CRATE'), row('A-TIE', 3_000n), row('PRD-CABBAGE-HEAD', 3_000n, '3.000', 'HEAD'), row('MEAT-GOAT-15KG', 6_930n, '3.500', 'KG'), row('PRD-YAM-TUBER', 1n)]);
    expect(ranked.map((m) => [m.product.sku, m.revenuePesewas, m.qty, m.uom])).toEqual([
      ['LIV-GOAT', 58_500, '1.000', 'HEAD'],
      ['EGG-CRATE-BIG', 12_000, '2.000', 'CRATE'],
      ['MEAT-GOAT-15KG', 6_930, '3.500', 'KG'],
      ['A-TIE', 3_000, '1.000', 'HEAD'],
      ['PRD-CABBAGE-HEAD', 3_000, '3.000', 'HEAD'],
    ]);
    expect(ranked[0]!.product).toEqual({ id: 'p-LIV-GOAT', sku: 'LIV-GOAT', name: 'LIV-GOAT' });
    expect(topMovers([])).toEqual([]);
    const twoUnits = topMovers([row('MEAT-BEEF-15KG', 4_000n, '1.000', 'PACK'), row('MEAT-BEEF-15KG', 4_000n, '1.250', 'KG')]);
    expect(twoUnits.map((m) => [m.product.sku, m.uom, m.qty])).toEqual([['MEAT-BEEF-15KG', 'KG', '1.250'], ['MEAT-BEEF-15KG', 'PACK', '1.000']]);
  });

  it('answers the largest sum of pesewas exactly and refuses one beyond it', () => {
    expect(salesByChannel([{ channel: 'POS', grossPesewas: 9_007_199_254_740_991n, count: 1 }])[0]!.amountPesewas).toBe(9_007_199_254_740_991);
    expect(() => salesByChannel([{ channel: 'POS', grossPesewas: 9_007_199_254_740_991n, count: 1 }, { channel: 'POS', grossPesewas: 1n, count: 1 }])).toThrow();
  });
});

describe('the receivables figures (FR-RPT-001, A-200)', () => {
  it('answers the balance of 1200 as outstanding and the documents past due as overdue', () => {
    expect(receivablesFigures(2_063_400n, 545_900n)).toEqual({ outstanding: 2_063_400n, overdue: 545_900n });
  });
  it('never answers overdue above outstanding', () => {
    expect(receivablesFigures(100_000n, 150_000n)).toEqual({ outstanding: 100_000n, overdue: 100_000n });
  });
  it('answers a credit balance as nothing outstanding and nothing overdue', () => {
    expect(receivablesFigures(-5_000n, 0n)).toEqual({ outstanding: 0n, overdue: 0n });
    expect(receivablesFigures(0n, 0n)).toEqual({ outstanding: 0n, overdue: 0n });
  });
});
