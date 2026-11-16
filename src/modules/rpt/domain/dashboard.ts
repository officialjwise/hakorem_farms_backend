import { err, ok, type Result } from '@hakorem/kernel';

/** The longest period a time series answers, in days, both ends counted: a quarter. */
export const MAX_SERIES_DAYS = 92;
/** The days a series covers when no period is asked for, ending today: a month. */
export const DEFAULT_SERIES_DAYS = 30;
/** The days the owner dashboard's purchases and sales series cover, ending on its date: a week or a month (CR-013). */
export const DASHBOARD_PERIOD_DAYS = { WEEK: 7, MONTH: 30 } as const;
export type DashboardPeriod = keyof typeof DASHBOARD_PERIOD_DAYS;

const MS_PER_DAY = 86_400_000;

/**
 * A dashboard figure whose source module is not built yet (owner, 2026-11-15): the figure stays null in
 * `getOwnerDashboard` exactly while it is listed, with why and the phase that makes it live. A 200 with a zero for a
 * figure nothing records yet would be a placeholder; a null with its reason is the truth.
 */
export interface PendingFigure {
  /** The `OwnerDashboard` property that is null. */
  readonly figure: string;
  /** The module whose records the figure will come from. */
  readonly source: string;
  readonly reason: string;
  /** The build phase whose gate makes the figure live. */
  readonly phase: string;
}

const SALES = 'Sales are completed orders; the order core that records them on every channel is built in B9a, and counter sales reach it from B9b.';

/**
 * Every figure of the owner dashboard that has no source today, in the order of the `OwnerDashboard` schema. B8, B9a,
 * B9b and B12 each remove their own entries, and set the figure, with no contract change. B08 continued 1c made `cash`
 * live, from the ledger's published `fin.pub_cash_balance` (A-196).
 */
export const PENDING_FIGURES: readonly PendingFigure[] = [
  { figure: 'salesTodayPesewas', source: 'ord', reason: SALES, phase: 'B9a' },
  { figure: 'salesYesterdayPesewas', source: 'ord', reason: SALES, phase: 'B9a' },
  { figure: 'salesMonthToDatePesewas', source: 'ord', reason: SALES, phase: 'B9a' },
  { figure: 'salesByChannel', source: 'ord', reason: SALES, phase: 'B9a' },
  { figure: 'salesSeries', source: 'ord', reason: SALES, phase: 'B9a' },
  {
    figure: 'receivablesOutstandingPesewas',
    source: 'fin',
    reason: 'Receivables are the balance of ledger account 1200 from issued invoices; the ledger and billing are built in B8.',
    phase: 'B8',
  },
  {
    figure: 'receivablesOverduePesewas',
    source: 'bil',
    reason: 'Overdue receivables are invoices past their due date; billing is built in B8.',
    phase: 'B8',
  },
  { figure: 'topMovers', source: 'ord', reason: 'Top movers rank the products sold today by revenue, from completed orders built in B9a.', phase: 'B9a' },
  {
    figure: 'alerts',
    source: 'rpt',
    reason: 'The alert feed gathers stock exceptions, approvals and the daily exception report, which are composed in B12.',
    phase: 'B12',
  },
  { figure: 'exceptionsToday', source: 'rpt', reason: 'The count of exception items comes from the daily exception report, built in B12.', phase: 'B12' },
];

/** Whether a figure has a source yet. */
export function isPending(figure: string): boolean {
  return PENDING_FIGURES.some((pending) => pending.figure === figure);
}

/** A rule a requested period breaks. */
export interface PeriodRule {
  readonly field: string;
  readonly rule: 'FROM_AFTER_TO' | 'PERIOD_TOO_LONG' | 'IN_THE_FUTURE';
}

export interface Period {
  readonly from: string;
  readonly to: string;
}

/** The calendar date `days` after `date` (`YYYY-MM-DD`); Africa/Accra keeps no daylight saving, so days are 24 hours. */
export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * MS_PER_DAY).toISOString().slice(0, 10);
}

/** Days from one calendar date to another; negative when `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / MS_PER_DAY);
}

/**
 * The period a time series covers, as business dates in Africa/Accra, both ends included. Missing ends default to
 * the 30 days ending today, or the 30 days ending `to` or starting `from`. A period may not end after today, start
 * after it ends, or cover more than 92 days.
 */
export function seriesPeriod(input: { readonly from?: string | undefined; readonly to?: string | undefined }, today: string): Result<Period, PeriodRule[]> {
  const to = input.to ?? (input.from === undefined ? today : minDate(addDays(input.from, DEFAULT_SERIES_DAYS - 1), today));
  const from = input.from ?? addDays(to, -(DEFAULT_SERIES_DAYS - 1));
  const rules: PeriodRule[] = [];
  if (daysBetween(today, from) > 0) return err([{ field: '/from', rule: 'IN_THE_FUTURE' }]);
  if (daysBetween(today, to) > 0) rules.push({ field: '/to', rule: 'IN_THE_FUTURE' });
  if (daysBetween(from, to) < 0) rules.push({ field: '/from', rule: 'FROM_AFTER_TO' });
  else if (daysBetween(from, to) + 1 > MAX_SERIES_DAYS) rules.push({ field: '/to', rule: 'PERIOD_TOO_LONG' });
  return rules.length > 0 ? err(rules) : ok({ from, to });
}

function minDate(a: string, b: string): string {
  return daysBetween(a, b) < 0 ? b : a;
}

/**
 * The dashboard's business date (today unless one is asked for, never after today), the day before it, and the week
 * or month its series cover, ending on it.
 */
export function dashboardDate(
  asked: string | undefined,
  today: string,
  period: DashboardPeriod = 'WEEK',
): Result<{ readonly date: string; readonly yesterday: string; readonly series: Period }, PeriodRule[]> {
  const date = asked ?? today;
  if (daysBetween(today, date) > 0) return err([{ field: '/date', rule: 'IN_THE_FUTURE' }]);
  return ok({ date, yesterday: addDays(date, -1), series: { from: addDays(date, -(DASHBOARD_PERIOD_DAYS[period] - 1)), to: date } });
}

/** One day of a series as the store sums it. */
export interface DayTotal {
  readonly date: string;
  readonly valuePesewas: bigint;
  readonly count: number;
}

/** Every business date of the period, in order, both ends included. */
export function periodDates(period: Period): string[] {
  const dates: string[] = [];
  for (let date = period.from; daysBetween(date, period.to) >= 0; date = addDays(date, 1)) dates.push(date);
  return dates;
}

/** The count of each day of the store's rows (two rows of one day add up), and the count of the period's days. */
export function countByDate(period: Period, days: readonly DayTotal[]): { readonly byDate: Map<string, number>; readonly total: number } {
  const dates = new Set(periodDates(period));
  const byDate = new Map<string, number>();
  for (const day of days) {
    if (dates.has(day.date)) byDate.set(day.date, (byDate.get(day.date) ?? 0) + day.count);
  }
  return { byDate, total: [...byDate.values()].reduce((sum, count) => sum + count, 0) };
}

/** Serialised live stock units standing on hand, counted per species. */
export interface SpeciesCount {
  readonly speciesId: string | null;
  readonly code: string | null;
  readonly name: string | null;
  readonly count: number;
}

/** The species in code order (a product without a species last), and the total head. */
export function animalsBySpecies(rows: readonly SpeciesCount[]): { readonly total: number; readonly bySpecies: SpeciesCount[] } {
  const bySpecies = [...rows].filter((row) => row.count > 0).sort((a, b) => (a.code ?? '￿').localeCompare(b.code ?? '￿'));
  return { total: bySpecies.reduce((sum, row) => sum + row.count, 0), bySpecies };
}

/**
 * The branches a dashboard read covers: the one asked for, or every branch where the reader holds the permission for
 * the whole branch. A grant limited to one location shows a location's stock, not a branch's dashboard, so it adds
 * no branch (A-149).
 */
export function dashboardBranches(asked: string | undefined, grants: ReadonlyArray<{ readonly branchId: string; readonly locationId: string | null }>): string[] {
  if (asked !== undefined) return [asked];
  return [...new Set(grants.filter((grant) => grant.locationId === null).map((grant) => grant.branchId))].sort();
}
