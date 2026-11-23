import { err, Money, ok, Quantity, Weight, type Rate, type Result } from '@hakorem/kernel';

export type PickBasis = 'PER_HEAD' | 'PER_KG' | 'PER_UNIT';
export type PickWeightSource = 'SCALE' | 'MANUAL' | 'ESTIMATE';
export type ToleranceState = 'BELOW' | 'WITHIN' | 'ABOVE';

export interface PickedPiece {
  readonly qty: Quantity;
  readonly weight: Weight | null;
}

export interface PickedTotal {
  /** The line's weighed kilograms; null on a line not priced by weight. */
  readonly weight: Weight | null;
  readonly qty: Quantity;
  readonly total: Money;
}

/**
 * The final line total on the weighed quantity (FR-ORD-009, ADR-0021, ADR-0001): a line priced by the kilogram is
 * `half_up(price per kg x the sum of its packs' kilograms)`, once over the whole line, never pack by pack; any other line
 * is `half_up(price x the quantity picked)`.
 */
export function pickedLineTotal(unitPricePesewas: bigint, basis: PickBasis, picks: readonly PickedPiece[]): PickedTotal {
  const qty = Quantity.sum(picks.map((p) => p.qty));
  const price = Money.ofPesewas(unitPricePesewas);
  if (basis !== 'PER_KG') return { weight: null, qty, total: price.timesQuantity(qty) };
  if (picks.some((p) => p.weight === null)) throw new Error('a catch-weight pick needs its weight');
  const weight = Weight.sum(picks.map((p) => p.weight!));
  return { weight, qty, total: price.timesWeight(weight) };
}

export interface CatchWeightEstimate {
  /** Packs times the nominal pack weight, as the order took it. */
  readonly weight: Weight;
  readonly tolerance: Rate;
  readonly estimatedTotal: Money;
}

export interface ToleranceLimits {
  /** The least weight allowed without a prompt, rounded up to a whole gram. */
  readonly minimum: Weight;
  /** The most weight allowed without the customer's consent, rounded down to a whole gram. */
  readonly maximum: Weight;
  /** The most the line can come to without consent: the estimate plus `half_up(estimate x tolerance)`, as checkout showed. */
  readonly maximumTotal: Money;
}

/** FR-ORD-010: the estimate plus or minus its tolerance, each limit kept inside the exact figure. */
export function toleranceLimits(e: CatchWeightEstimate): ToleranceLimits {
  const { numerator: n, denominator: d } = e.tolerance;
  const low = e.weight.grams * (d - n);
  return {
    minimum: Weight.ofGrams(low / d + (low % d === 0n ? 0n : 1n)),
    maximum: Weight.ofGrams((e.weight.grams * (d + n)) / d),
    maximumTotal: e.estimatedTotal.plus(e.estimatedTotal.timesRate(e.tolerance)),
  };
}

/**
 * FR-ORD-010: a weighed line is ABOVE its tolerance when its weight passes the estimate plus the tolerance, or its total
 * passes the most the customer was shown (a weight at the limit can round a pesewa over it); BELOW when its weight is
 * under the estimate less the tolerance; otherwise WITHIN. The comparisons are exact, in grams over the rate's denominator.
 */
export function judgeWeighed(e: CatchWeightEstimate, weighed: Weight, total: Money): ToleranceState {
  const { numerator: n, denominator: d } = e.tolerance;
  const scaled = weighed.grams * d;
  if (scaled > e.weight.grams * (d + n) || total.compareTo(toleranceLimits(e).maximumTotal) > 0) return 'ABOVE';
  if (scaled < e.weight.grams * (d - n)) return 'BELOW';
  return 'WITHIN';
}

/** A line's picks against what its pick list asks: never more (CR-054); less only with the customer's agreement. */
export function judgePickedQuantity(toPick: Quantity, picked: Quantity): 'COMPLETE' | 'SHORT' | 'OVER' {
  const order = picked.compareTo(toPick);
  return order === 0 ? 'COMPLETE' : order < 0 ? 'SHORT' : 'OVER';
}

/** A line's weight source is its least trusted pack's: SCALE only when every pack was weighed on the scale. */
export function pickWeightSource(sources: readonly PickWeightSource[]): PickWeightSource | null {
  if (sources.length === 0) return null;
  if (sources.includes('ESTIMATE')) return 'ESTIMATE';
  return sources.every((s) => s === 'SCALE') ? 'SCALE' : 'MANUAL';
}

export interface LineToPack {
  readonly lineNo: number;
  readonly catchWeight: boolean;
  readonly toPick: Quantity;
  readonly picked: Quantity;
  /** The smaller quantity the customer agreed to (a SHORT_PICK consent accepted), or null. */
  readonly agreedShort: Quantity | null;
  /** A catch-weight line's state at its weighed total; null on any other line. */
  readonly tolerance: ToleranceState | null;
  /** The customer accepted the higher total of this line (a HIGHER_TOTAL consent accepted at or above it). */
  readonly consentedAbove: boolean;
}

export type PackRefusal = 'NOTHING_PICKED' | 'SHORT_PICK_NOT_AGREED' | 'TOLERANCE_EXCEEDED';

/**
 * Whether a pick list may be packed (FR-ORD-011, FR-ORD-010, CR-054). A line sold by the unit or the head is packed at
 * exactly its quantity to pick, or at exactly the smaller quantity the customer agreed to. A catch-weight line needs at
 * least one pack weighed; above its tolerance only with the customer's consent; below it, it goes at the lower total.
 */
export function readyToPack(lines: readonly LineToPack[]): Result<null, { readonly lineNo: number; readonly rule: PackRefusal }[]> {
  if (lines.length === 0) return err([{ lineNo: 0, rule: 'NOTHING_PICKED' }]);
  const refused: { lineNo: number; rule: PackRefusal }[] = [];
  for (const line of lines) {
    if (line.catchWeight) {
      if (line.picked.isZero()) refused.push({ lineNo: line.lineNo, rule: 'NOTHING_PICKED' });
      else if (line.tolerance === 'ABOVE' && !line.consentedAbove) refused.push({ lineNo: line.lineNo, rule: 'TOLERANCE_EXCEEDED' });
      continue;
    }
    if (judgePickedQuantity(line.agreedShort ?? line.toPick, line.picked) !== 'COMPLETE') refused.push({ lineNo: line.lineNo, rule: 'SHORT_PICK_NOT_AGREED' });
  }
  return refused.length === 0 ? ok(null) : err(refused);
}
