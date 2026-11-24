import { halfUpDivide } from '@hakorem/kernel';

/**
 * The detection rates on the daily exception report (FR-RPT-008): per person a count, a value and, where the report
 * has a denominator for it, a rate beside the same rate for everyone that day. Percentages are to two places, half-up,
 * once; a rate with nothing to divide by is null, never zero.
 */
export interface RateRow {
  readonly actorId: string;
  readonly count: number;
  readonly amountPesewas: bigint;
  readonly ratePercent: string | null;
  readonly comparisonRatePercent: string | null;
}

/** `part` over `whole` as a percentage to two places, half-up; null when the whole is zero or less. */
export function percent(part: bigint, whole: bigint): string | null {
  if (whole <= 0n || part < 0n) return null;
  const hundredths = halfUpDivide(part * 10_000n, whole);
  return `${hundredths / 100n}.${(hundredths % 100n).toString().padStart(2, '0')}`;
}

/** One item a table counts: whose it is, its value, and the share of the person's base it is (for value rates). */
export interface Counted {
  readonly actorId: string;
  readonly amountPesewas: bigint;
}

function grouped(items: readonly Counted[]): Map<string, { count: number; amount: bigint }> {
  const by = new Map<string, { count: number; amount: bigint }>();
  for (const item of items) {
    const row = by.get(item.actorId) ?? { count: 0, amount: 0n };
    row.count += 1;
    row.amount += item.amountPesewas;
    by.set(item.actorId, row);
  }
  return by;
}

/** Each person appears once in a table, so two rows never compare equal. */
const byActor = (a: RateRow, b: RateRow) => (a.actorId < b.actorId ? -1 : 1);

/**
 * A rate by count: each person's items over their own base (a cashier's voids over their completed sales), beside
 * everyone's items over everyone's base. People with a base and no items are listed with a count of 0.
 */
export function countRates(items: readonly Counted[], bases: ReadonlyMap<string, number>): RateRow[] {
  const by = grouped(items);
  const totalItems = BigInt(items.length);
  const totalBase = BigInt([...bases.values()].reduce((sum, n) => sum + n, 0));
  const comparison = percent(totalItems, totalBase);
  const actors = new Set([...by.keys(), ...bases.keys()]);
  return [...actors]
    .map((actorId) => {
      const row = by.get(actorId) ?? { count: 0, amount: 0n };
      return { actorId, count: row.count, amountPesewas: row.amount, ratePercent: percent(BigInt(row.count), BigInt(bases.get(actorId) ?? 0)), comparisonRatePercent: comparison };
    })
    .sort(byActor);
}

/**
 * A rate by value: each person's items' value over their own base in pesewas (a shift's over or short over its
 * expected cash, a driver's shortfall over what they collected), beside everyone's over everyone's.
 */
export function valueRates(items: readonly (Counted & { readonly basePesewas: bigint })[]): RateRow[] {
  const by = new Map<string, { count: number; amount: bigint; base: bigint }>();
  for (const item of items) {
    const row = by.get(item.actorId) ?? { count: 0, amount: 0n, base: 0n };
    row.count += 1;
    row.amount += item.amountPesewas;
    row.base += item.basePesewas;
    by.set(item.actorId, row);
  }
  const amount = items.reduce((sum, i) => sum + i.amountPesewas, 0n);
  const base = items.reduce((sum, i) => sum + i.basePesewas, 0n);
  const comparison = percent(amount, base);
  return [...by.entries()].map(([actorId, row]) => ({ actorId, count: row.count, amountPesewas: row.amount, ratePercent: percent(row.amount, row.base), comparisonRatePercent: comparison })).sort(byActor);
}

/** A table with counts and values only: the report has no fair base for these rates (A-390 (e)). */
export function plainCounts(items: readonly Counted[]): RateRow[] {
  return [...grouped(items).entries()].map(([actorId, row]) => ({ actorId, count: row.count, amountPesewas: row.amount, ratePercent: null, comparisonRatePercent: null })).sort(byActor);
}

/** An approval decision: whose request, who decided it. */
export interface Decision {
  readonly makerId: string;
  readonly checkerId: string;
}

export interface PairRow {
  readonly makerId: string;
  readonly checkerId: string;
  readonly count: number;
  /** The pair's decisions over every decision on the maker's requests that day: the collusion risk R1. */
  readonly frequencyPercent: string;
}

export function approvalPairs(decisions: readonly Decision[]): PairRow[] {
  const pairs = new Map<string, { makerId: string; checkerId: string; count: number }>();
  const byMaker = new Map<string, number>();
  for (const d of decisions) {
    const key = `${d.makerId}|${d.checkerId}`;
    const row = pairs.get(key) ?? { makerId: d.makerId, checkerId: d.checkerId, count: 0 };
    row.count += 1;
    pairs.set(key, row);
    byMaker.set(d.makerId, (byMaker.get(d.makerId) ?? 0) + 1);
  }
  return [...pairs.values()]
    .map((r) => ({ ...r, frequencyPercent: percent(BigInt(r.count), BigInt(byMaker.get(r.makerId)!))! }))
    .sort((a, b) => b.count - a.count || (a.makerId < b.makerId ? -1 : a.makerId > b.makerId ? 1 : a.checkerId < b.checkerId ? -1 : 1));
}
