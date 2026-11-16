import { Money, type Quantity, Weight, type Rate } from '@hakorem/kernel';

export type PriceBasis = 'PER_HEAD' | 'PER_KG' | 'PER_UNIT';

const THOUSANDTHS_PER_UNIT = 1_000n;

export interface LineToEstimate {
  readonly basis: PriceBasis;
  /** The resolved list price: per head, per unit, or per kilogram. */
  readonly unitPrice: Money;
  /** Whole units of the product's sale unit: crates, heads, packs. */
  readonly quantity: Quantity;
  /** For a catch-weight product: its nominal pack weight and the tolerance the weighed total may rise by. */
  readonly catchWeight: { readonly nominalPack: Weight; readonly tolerance: Rate } | null;
}

export interface LineEstimate {
  /** Packs times the nominal pack weight; null for a line not sold by weight. */
  readonly estimatedWeight: Weight | null;
  /** The line anchor, rounded half-up once: price times quantity, or price per kilogram times the estimated weight. */
  readonly estimated: Money;
  /** The most the line can come to without asking the customer: the estimate plus its tolerance (ADR-0021). */
  readonly maximum: Money;
}

/** A storefront quantity is whole units of the sale unit, above zero (A-178). */
export function wholeUnits(quantity: Quantity): boolean {
  return quantity.thousandths > 0n && quantity.thousandths % THOUSANDTHS_PER_UNIT === 0n;
}

/**
 * A cart or checkout line's estimate (FR-SHP-003, FR-SHP-007, ADR-0021). A catch-weight line is priced on its
 * estimated weight, packs times the nominal pack weight, `half_up(price per kg x kg)` once; its maximum is the estimate
 * plus `half_up(estimate x tolerance)`, which is the one half-up of the estimate times one plus the tolerance. Any
 * other line is `half_up(price x quantity)`, and its maximum is its estimate.
 */
export function estimateLine(line: LineToEstimate): LineEstimate {
  if (line.catchWeight === null) {
    const estimated = line.unitPrice.timesQuantity(line.quantity);
    return { estimatedWeight: null, estimated, maximum: estimated };
  }
  const weight = Weight.ofGrams((line.catchWeight.nominalPack.grams * line.quantity.thousandths) / THOUSANDTHS_PER_UNIT);
  const estimated = line.unitPrice.timesWeight(weight);
  return { estimatedWeight: weight, estimated, maximum: estimated.plus(estimated.timesRate(line.catchWeight.tolerance)) };
}

/** The zone's exact fee (FR-SHP-008), waived only when the goods come to more than the zone's threshold. */
export function deliveryFee(zone: { readonly feePesewas: bigint; readonly freeOverPesewas: bigint | null }, goods: Money): Money {
  if (zone.freeOverPesewas !== null && goods.pesewas > zone.freeOverPesewas) return Money.zero();
  return Money.ofPesewas(zone.feePesewas);
}

export interface PricedLine {
  readonly estimated: Money;
  readonly maximum: Money;
  readonly discount: Money;
}

/** A checkout's totals: sums of the line integers, less the discounts, plus the fee. Nothing is rounded here. */
export function checkoutTotals(lines: readonly PricedLine[], fee: Money): { readonly goods: Money; readonly discount: Money; readonly estimated: Money; readonly maximum: Money } {
  const goods = Money.sum(lines.map((line) => line.estimated));
  const discount = Money.sum(lines.map((line) => line.discount));
  const maximum = Money.sum(lines.map((line) => line.maximum));
  return { goods, discount, estimated: goods.minus(discount).plus(fee), maximum: maximum.minus(discount).plus(fee) };
}

/**
 * How a line's quantity is spread over the balances it may be promised from, in their order (oldest first): as much
 * as each holds until the line is covered. Null when together they hold too little, so the checkout reserves nothing.
 */
export function allocateReservation(requested: Quantity, rows: readonly { readonly availableQty: Quantity }[]): { readonly index: number; readonly qty: Quantity }[] | null {
  const pieces: { index: number; qty: Quantity }[] = [];
  let left = requested;
  for (const [index, row] of rows.entries()) {
    if (left.isZero()) break;
    const take = row.availableQty.compareTo(left) >= 0 ? left : row.availableQty;
    pieces.push({ index, qty: take });
    left = left.minus(take);
  }
  return left.isZero() ? pieces : null;
}
