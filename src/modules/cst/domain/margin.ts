import { halfUpDivide, Money } from '@hakorem/kernel';

/** One margin fact as CST's projection holds it: an amount and whether it reduces (a credit note, a return). */
export interface MarginFactInput {
  readonly kind: 'REVENUE' | 'COST';
  readonly isCredit: boolean;
  readonly revenue: bigint;
  readonly cost: bigint;
  /** Signed as BIL publishes it: above zero, the agreed price was below the resolved one. */
  readonly variance: bigint;
}

/** A group's signed totals. */
export interface MarginFigures {
  readonly revenue: bigint;
  readonly cost: bigint;
  readonly margin: bigint;
  readonly variance: bigint;
}

/** What the API answers for a group or the totals: sizes with their signs beside them, and the percent. */
export interface MarginRowFigures {
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

const HUNDREDTHS_OF_A_PERCENT = 10_000n;

/** Sums a group's facts exactly (FR-CST-003): a credit note's line takes revenue back, a return's movement cost. */
export function marginFigures(facts: readonly MarginFactInput[]): MarginFigures {
  let revenue = 0n;
  let cost = 0n;
  let variance = 0n;
  for (const f of facts) {
    const sign = f.isCredit ? -1n : 1n;
    revenue += sign * f.revenue;
    cost += sign * f.cost;
    variance += f.variance;
  }
  return { revenue, cost, margin: revenue - cost, variance };
}

/**
 * `part` over `whole` as a percentage to two places, half-up, for non-negative figures with `part <= whole` and a
 * positive whole: 2,730,000 over 8,840,000 is "30.88".
 */
export function percentOf(part: bigint, whole: bigint): string {
  const hundredths = halfUpDivide(part * HUNDREDTHS_OF_A_PERCENT, whole);
  return `${hundredths / 100n}.${String(hundredths % 100n).padStart(2, '0')}`;
}

const size = (n: bigint): number => Money.ofPesewas(n < 0n ? -n : n).toJsonInteger();

/**
 * A group's answer (FR-CST-003). Margin is over the selling price (the owner, 2026-11-23): gross margin over revenue,
 * 13,600 over 85,000 is 16.00. Each figure is a size with its sign beside it; the percent is the margin's size over
 * revenue, null when there is no positive revenue, when cost is negative, or when the loss is beyond the whole price.
 */
export function marginRow(f: MarginFigures): MarginRowFigures {
  const margin = f.margin < 0n ? -f.margin : f.margin;
  const percent = f.revenue > 0n && f.cost >= 0n && margin <= f.revenue ? percentOf(margin, f.revenue) : null;
  return {
    revenuePesewas: size(f.revenue),
    revenueIsNegative: f.revenue < 0n,
    costPesewas: size(f.cost),
    costIsNegative: f.cost < 0n,
    grossMarginPesewas: size(f.margin),
    marginIsNegative: f.margin < 0n,
    marginPercent: percent,
    priceVariancePesewas: size(f.variance),
    priceVarianceIsNegative: f.variance < 0n,
  };
}
