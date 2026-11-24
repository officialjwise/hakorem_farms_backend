import { allocate, halfUpDivide, Money } from '@hakorem/kernel';
import { percentOf } from './margin';

/** A product line's figures for a period (FR-CST-005): net revenue, cost of sales, units sold and its fixed cost. */
export interface BreakEvenInput {
  readonly revenue: bigint;
  readonly variableCost: bigint;
  /** Units sold in thousandths of the products' units (heads, crates, kilograms), as the margin facts count them. */
  readonly unitsThousandths: bigint;
  readonly fixedCost: bigint;
}

export interface BreakEvenFigures {
  readonly contribution: bigint;
  /** Contribution's size over revenue; null when there is no revenue or it is beyond the whole price. */
  readonly contributionMarginPercent: string | null;
  readonly averagePrice: bigint | null;
  readonly variableCostPerUnit: bigint | null;
  readonly contributionPerUnit: bigint | null;
  /** Null when there is no break-even: nothing sold, or a contribution per unit of nothing or less. */
  readonly breakEvenUnits: bigint | null;
  readonly breakEvenRevenue: bigint | null;
  /** How much of break-even revenue the line's revenue reached, capped at 100. */
  readonly coveredPercent: string | null;
}

const THOUSANDTHS = 1_000n;

const perUnit = (amount: bigint, unitsThousandths: bigint): bigint => (amount < 0n ? -halfUpDivide(-amount * THOUSANDTHS, unitsThousandths) : halfUpDivide(amount * THOUSANDTHS, unitsThousandths));

/**
 * Break-even for a line (FR-CST-005, FR-CST-006): the average net price and the variable cost per unit, each half-up
 * once from the period's totals; contribution per unit their difference; break-even units the fixed cost over it,
 * rounded up to a whole unit; break-even revenue those units at the average price. Fixed 600,000 at 85,000 a head with
 * 71,400 variable is 13,600 a head, 44.12 heads rounded up to 45, and 3,825,000.
 */
export function breakEvenLine(input: BreakEvenInput): BreakEvenFigures {
  const contribution = input.revenue - input.variableCost;
  const magnitude = contribution < 0n ? -contribution : contribution;
  const contributionMarginPercent = input.revenue > 0n && magnitude <= input.revenue ? percentOf(magnitude, input.revenue) : null;
  if (input.unitsThousandths <= 0n) {
    return { contribution, contributionMarginPercent, averagePrice: null, variableCostPerUnit: null, contributionPerUnit: null, breakEvenUnits: null, breakEvenRevenue: null, coveredPercent: null };
  }
  const averagePrice = perUnit(input.revenue, input.unitsThousandths);
  const variableCostPerUnit = perUnit(input.variableCost, input.unitsThousandths);
  const contributionPerUnit = averagePrice - variableCostPerUnit;
  if (contributionPerUnit <= 0n) {
    return { contribution, contributionMarginPercent, averagePrice, variableCostPerUnit, contributionPerUnit, breakEvenUnits: null, breakEvenRevenue: null, coveredPercent: null };
  }
  const breakEvenUnits = (input.fixedCost + contributionPerUnit - 1n) / contributionPerUnit;
  const breakEvenRevenue = breakEvenUnits * averagePrice;
  // A positive break-even revenue means a positive average price, so revenue is positive here.
  const coveredPercent = breakEvenRevenue <= 0n || input.revenue >= breakEvenRevenue ? '100.00' : percentOf(input.revenue, breakEvenRevenue);
  return { contribution, contributionMarginPercent, averagePrice, variableCostPerUnit, contributionPerUnit, breakEvenUnits, breakEvenRevenue, coveredPercent };
}

/**
 * The period's fixed costs (its operating expenses) assigned to the lines in proportion to their revenue through
 * `allocate`, keyed in the order given; equally when no line has revenue (A-388). The parts sum to the total exactly.
 */
export function assignFixedCosts<K>(total: bigint, lines: readonly { readonly key: K; readonly revenue: bigint }[]): { readonly key: K; readonly fixedCost: bigint }[] {
  if (lines.length === 0) return [];
  const weights = lines.map((l) => (l.revenue > 0n ? l.revenue : 0n));
  const equal = weights.every((w) => w === 0n);
  // The weights are non-negative with one positive and the keys distinct, so the kernel cannot refuse.
  const parts = allocate(
    Money.ofPesewas(total),
    lines.map((_, i) => ({ key: BigInt(i), weight: equal ? 1n : weights[i]! })),
  ) as { readonly ok: true; readonly value: Money[] };
  return lines.map((l, i) => ({ key: l.key, fixedCost: parts.value[i]!.pesewas }));
}

/**
 * Each line's share of the total contribution, in hundredths of a percent allocated over 100.00 by `allocate`, so the
 * shares sum to 100.00 exactly; null for every line when any contribution or the total is not positive.
 */
export function contributionShares(contributions: readonly bigint[]): (string | null)[] {
  const total = contributions.reduce((s, c) => s + c, 0n);
  if (total <= 0n || contributions.some((c) => c < 0n)) return contributions.map(() => null);
  const parts = allocate(
    Money.ofPesewas(10_000n),
    contributions.map((c, i) => ({ key: BigInt(i), weight: c })),
  ) as { readonly ok: true; readonly value: Money[] };
  return parts.value.map((p) => `${p.pesewas / 100n}.${String(p.pesewas % 100n).padStart(2, '0')}`);
}
