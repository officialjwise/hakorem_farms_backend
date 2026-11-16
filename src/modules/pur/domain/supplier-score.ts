import { halfUpDivide } from '@hakorem/kernel';

/**
 * Supplier performance scoring (FR-PUR-014, A-173). Pure and exact: every component is a percentage from 0 to 100
 * held as a fraction of two integers, and only the shown text is rounded, half-up, once, to two places.
 *
 * - **Price:** what the supplier was paid on approved invoice lines against the average the farm paid for the same
 *   products in the period (all suppliers): 100 less the percentage over that average, never above 100 for a cheaper
 *   supplier nor below 0.
 * - **Lead time:** the share of the supplier's receipts that arrived on or before the promised day (the order's
 *   expected date, or its date plus the supplier's lead time); a receipt with no promise is left out.
 * - **Quality:** the accepted share of what was received at the gate.
 * - **Rejection:** 100 less the share of accepted goods later sent back to the supplier with a credit note.
 *
 * The score is the weighted mean, divided by the weights as set (settings, 30, 25, 25 and 20 by default), so weights
 * changed one at a time never take it outside 0 to 100. Any component without facts, or all weights zero, gives none.
 */
export interface Percentage {
  readonly numerator: bigint;
  readonly denominator: bigint;
}

export interface ScoreWeights {
  readonly price: bigint;
  readonly leadTime: bigint;
  readonly quality: bigint;
  readonly rejection: bigint;
}

export interface ScoreComponents {
  readonly price: Percentage | null;
  readonly leadTime: Percentage | null;
  readonly quality: Percentage | null;
  readonly rejection: Percentage | null;
}

/** A whole percentage. */
export function percent(value: bigint): Percentage {
  return { numerator: value, denominator: 1n };
}

function share(part: bigint, whole: bigint): Percentage {
  return { numerator: 100n * part, denominator: whole };
}

function clamp(value: Percentage): Percentage {
  if (value.numerator <= 0n) return percent(0n);
  if (value.numerator >= 100n * value.denominator) return percent(100n);
  return value;
}

function hundredLess(value: Percentage): Percentage {
  return clamp({ numerator: 100n * value.denominator - value.numerator, denominator: value.denominator });
}

/** The percentage as the contract shows it: two places, rounded half-up once. */
export function percentText(value: Percentage): string {
  const hundredths = halfUpDivide(value.numerator * 100n, value.denominator);
  return `${hundredths / 100n}.${(hundredths % 100n).toString().padStart(2, '0')}`;
}

export interface PriceFacts {
  /** What the supplier was invoiced for the product, net, on approved invoices in the period. */
  readonly supplierNetPesewas: bigint;
  /** The base quantity those lines carry, in thousandths. */
  readonly supplierQtyThousandths: bigint;
  /** What the farm was invoiced for the product by every supplier in the period, and the quantity. */
  readonly allNetPesewas: bigint;
  readonly allQtyThousandths: bigint;
}

/**
 * The price component: the supplier's net against what the same quantities cost at the farm's average price. The
 * average is kept as the fraction allNet / allQty per product, so the comparison is exact.
 */
export function priceComponent(products: readonly PriceFacts[]): Percentage | null {
  const priced = products.filter((p) => p.supplierQtyThousandths > 0n && p.allQtyThousandths > 0n && p.allNetPesewas > 0n);
  if (priced.length === 0) return null;
  // Over a common denominator D (the product of every allQty): A = sum(supplierQty x allNet x D / allQty), S = supplierNet x D.
  const common = priced.reduce((d, p) => d * p.allQtyThousandths, 1n);
  const atAverage = priced.reduce((sum, p) => sum + (p.supplierQtyThousandths * p.allNetPesewas * common) / p.allQtyThousandths, 0n);
  const paid = priced.reduce((sum, p) => sum + p.supplierNetPesewas * common, 0n);
  const over = paid > atAverage ? paid - atAverage : 0n;
  return hundredLess(share(over, atAverage));
}

/** The percentage over the farm's average price the supplier charged, from 0 to 100 (the contract's priceVariancePercent). */
export function priceVariance(products: readonly PriceFacts[]): Percentage | null {
  const component = priceComponent(products);
  return component === null ? null : hundredLess(component);
}

/** The lead time component: receipts on or before their promised day, over those with a promise. */
export function onTimeComponent(receipts: readonly { readonly receivedOn: string; readonly promisedOn: string | null }[]): Percentage | null {
  const promised = receipts.filter((r) => r.promisedOn !== null);
  if (promised.length === 0) return null;
  return share(BigInt(promised.filter((r) => r.receivedOn <= r.promisedOn!).length), BigInt(promised.length));
}

/** The quality component: accepted over received (accepted plus rejected), in thousandths of the base unit. */
export function qualityComponent(acceptedThousandths: bigint, rejectedThousandths: bigint): Percentage | null {
  const received = acceptedThousandths + rejectedThousandths;
  return received === 0n ? null : share(acceptedThousandths, received);
}

/** The share rejected at the gate (the contract's rejectionPercent). */
export function rejectedAtReceipt(acceptedThousandths: bigint, rejectedThousandths: bigint): Percentage | null {
  const quality = qualityComponent(acceptedThousandths, rejectedThousandths);
  return quality === null ? null : hundredLess(quality);
}

/** The rejection component: 100 less what was sent back over what was accepted, never below 0. */
export function rejectionComponent(returnedThousandths: bigint, acceptedThousandths: bigint): Percentage | null {
  return acceptedThousandths === 0n ? null : hundredLess(share(returnedThousandths, acceptedThousandths));
}

/** The weighted score, or null while a component has no facts or every weight is zero. */
export function combineScore(components: ScoreComponents, weights: ScoreWeights): Percentage | null {
  const parts = [
    [components.price, weights.price],
    [components.leadTime, weights.leadTime],
    [components.quality, weights.quality],
    [components.rejection, weights.rejection],
  ] as const;
  if (parts.some(([component]) => component === null)) return null;
  const totalWeight = parts.reduce((sum, [, weight]) => sum + weight, 0n);
  if (totalWeight === 0n) return null;
  const common = parts.reduce((d, [component]) => d * component!.denominator, 1n);
  const weighted = parts.reduce((sum, [component, weight]) => sum + (weight * component!.numerator * common) / component!.denominator, 0n);
  return { numerator: weighted, denominator: common * totalWeight };
}
