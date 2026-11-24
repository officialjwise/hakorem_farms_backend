import { halfUpDivide, Money, Quantity } from '@hakorem/kernel';

export const QUOTE_STATUSES = ['DRAFT', 'PENDING_APPROVAL', 'ISSUED', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'CONVERTED', 'CANCELLED'] as const;
export type QuoteStatus = (typeof QUOTE_STATUSES)[number];
export const VERSION_STATUSES = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'ISSUED', 'SUPERSEDED', 'ACCEPTED'] as const;
export type VersionStatus = (typeof VERSION_STATUSES)[number];
export type PriceBasis = 'PER_HEAD' | 'PER_KG' | 'PER_UNIT';

/**
 * The margin floor's default (FR-QUO-005, seed 10 percent), in basis points of the selling price (the owner, 2026-11-23:
 * margin is over the price). Until B10 continued 6 the same number was read over cost; a stored value now reads stricter
 * (A-342).
 */
export const DEFAULT_MARGIN_FLOOR_BASIS_POINTS = 1_000;
const BASIS_POINTS = 10_000n;
const PERCENT_HUNDREDTHS = 10_000n;

/** A signed ratio as a percentage to two places, half away from zero (the magnitude half-up once, ADR-0001). */
function percentOf(numerator: bigint, denominator: bigint): string {
  const hundredths = halfUpDivide((numerator < 0n ? -numerator : numerator) * PERCENT_HUNDREDTHS, denominator);
  const whole = hundredths / 100n;
  const cents = String(hundredths % 100n).padStart(2, '0');
  return `${numerator < 0n && hundredths > 0n ? '-' : ''}${whole}.${cents}`;
}

/** A quote line extended once at its anchor, half-up (ADR-0001): the quoted unit price times the quantity in its unit. */
export function lineNet(unitPricePesewas: bigint, qty: Quantity): bigint {
  return Money.ofPesewas(unitPricePesewas).timesQuantity(qty).pesewas;
}

/** A line's estimated cost: its unit cost times its quantity, half-up once; unknown stays unknown. */
export function lineCost(unitCostPesewas: bigint | null, qty: Quantity): bigint | null {
  return unitCostPesewas === null ? null : Money.ofPesewas(unitCostPesewas).timesQuantity(qty).pesewas;
}

/**
 * Markup over cost (the owner, 2026-11-23: anything worked over cost is markup and is named markup): (net less cost)
 * over cost, as a percentage to two places, rounded half away from zero; null when the cost is unknown or nil. It may be
 * negative (sold below cost) or above 100. This is the figure B10 to B10 continued 5 called "margin".
 */
export function markupPercent(netPesewas: bigint, costPesewas: bigint | null): string | null {
  if (costPesewas === null || costPesewas === 0n) return null;
  return percentOf(netPesewas - costPesewas, costPesewas);
}

/**
 * Margin over the selling price (the owner, 2026-11-23, FR-QUO-003): (price less cost) over price, as a percentage to
 * two places, rounded half away from zero; null when the cost is unknown or there is no price. Never above 100 (a nil
 * cost is 100.00); negative when sold below cost.
 */
export function marginPercent(pricePesewas: bigint, costPesewas: bigint | null): string | null {
  if (costPesewas === null || pricePesewas === 0n) return null;
  return percentOf(pricePesewas - costPesewas, pricePesewas);
}

/**
 * Whether a price is below the margin floor over that price (FR-QUO-005, the owner, 2026-11-23), compared exactly in
 * integers, never on the rounded percentage: (price - cost) * 10,000 < floor * price. An unknown cost cannot be shown to
 * clear the floor, so it is below (A-309 (c)); a nil cost clears any floor short of 100 percent.
 */
export function judgeMargin(pricePesewas: bigint, costPesewas: bigint | null, floorBasisPoints: number): boolean {
  if (costPesewas === null) return true;
  return (pricePesewas - costPesewas) * BASIS_POINTS < BigInt(floorBasisPoints) * pricePesewas;
}

export interface FigureLine {
  readonly qty: Quantity;
  readonly unitPricePesewas: bigint;
  readonly unitCostPesewas: bigint | null;
  /** The quoted price is below the engine's floor for the line (FR-QUO-003). */
  readonly belowEngineFloor: boolean;
}

export interface VersionFigures {
  readonly lineNets: readonly bigint[];
  readonly netPesewas: bigint;
  readonly taxPesewas: bigint;
  readonly grossPesewas: bigint;
  readonly estimatedCostPesewas: bigint | null;
  /** Margin over the version's net (the lines and the delivery fee, before tax), as UAT scenario 2 reads it. */
  readonly marginPercent: string | null;
  /** Markup over cost on the product lines' net alone: what `margin_percent` has always stored (A-342). */
  readonly markupPercent: string | null;
  readonly belowMarginFloor: boolean;
}

/**
 * A version's figures (FR-QUO-003): each line extended once at its anchor; the tax is the calculator's on those anchors.
 * Tax-exclusive, the lines are net and the tax is added; tax-inclusive, the lines carry their tax, so the net is the
 * lines less the tax. The delivery fee is taxed by the invoice's rule (the owner, 2026-11-23, B11u, A-352, replacing
 * A-309 (d)): it is a line of the calculator's in the version's pricing mode, so `deliveryFeeTaxPesewas` is its tax,
 * added on top of a tax-exclusive fee and taken out of a tax-inclusive one. The margin shown is over that net; the
 * floor is judged on the lines' net of tax alone, over that price (A-342: a delivery fee carries a delivery cost the
 * estimate does not hold, so it never lifts a version over the floor); a version needs approval below the floor or with
 * any line below the engine floor.
 */
export function versionFigures(
  lines: readonly FigureLine[],
  extra: { readonly deliveryFeePesewas: bigint; readonly deliveryFeeTaxPesewas?: bigint; readonly taxPesewas: bigint; readonly floorBasisPoints: number; readonly taxInclusive?: boolean },
): VersionFigures {
  const lineNets = lines.map((l) => lineNet(l.unitPricePesewas, l.qty));
  const anchors = lineNets.reduce((a, b) => a + b, 0n);
  const linesNet = extra.taxInclusive === true ? anchors - extra.taxPesewas : anchors;
  const costs = lines.map((l) => lineCost(l.unitCostPesewas, l.qty));
  const cost = costs.some((c) => c === null) ? null : costs.reduce<bigint>((a, b) => a + b!, 0n);
  const feeTax = extra.deliveryFeeTaxPesewas ?? 0n;
  const net = linesNet + (extra.taxInclusive === true ? extra.deliveryFeePesewas - feeTax : extra.deliveryFeePesewas);
  const tax = extra.taxPesewas + feeTax;
  return {
    lineNets,
    netPesewas: net,
    taxPesewas: tax,
    grossPesewas: net + tax,
    estimatedCostPesewas: cost,
    marginPercent: marginPercent(net, cost),
    markupPercent: markupPercent(linesNet, cost),
    belowMarginFloor: judgeMargin(linesNet, cost, extra.floorBasisPoints) || lines.some((l) => l.belowEngineFloor),
  };
}

const QUOTE_EDGES: Readonly<Record<QuoteStatus, readonly QuoteStatus[]>> = {
  DRAFT: ['PENDING_APPROVAL', 'ISSUED', 'CANCELLED'],
  PENDING_APPROVAL: ['DRAFT', 'ISSUED', 'CANCELLED'],
  ISSUED: ['ACCEPTED', 'DECLINED', 'EXPIRED', 'CANCELLED'],
  ACCEPTED: ['CONVERTED', 'CANCELLED'],
  DECLINED: [],
  EXPIRED: [],
  CONVERTED: [],
  CANCELLED: [],
};

const VERSION_EDGES: Readonly<Record<VersionStatus, readonly VersionStatus[]>> = {
  DRAFT: ['PENDING_APPROVAL', 'ISSUED'],
  // The owner, 2026-11-19: an approval below the floor only approves; the salesperson issues the approved version.
  PENDING_APPROVAL: ['DRAFT', 'APPROVED'],
  APPROVED: ['ISSUED'],
  ISSUED: ['SUPERSEDED', 'ACCEPTED'],
  SUPERSEDED: [],
  ACCEPTED: [],
};

/** The quote's machine (migration 0251 holds the same edges). */
export function canMoveQuote(from: QuoteStatus, to: QuoteStatus): boolean {
  return QUOTE_EDGES[from].includes(to);
}

/** A version's machine: issued, it is frozen but for being superseded or accepted (FR-QUO-006). */
export function canMoveVersion(from: VersionStatus, to: VersionStatus): boolean {
  return VERSION_EDGES[from].includes(to);
}

export type LinkState = 'OPEN' | 'ACCEPTED' | 'DECLINED' | 'EXPIRED' | 'REPLACED' | 'WITHDRAWN';

export interface LinkFacts {
  readonly versionStatus: VersionStatus;
  readonly quoteStatus: QuoteStatus;
  /** The version is the quote's live one: the newest issued. */
  readonly isCurrent: boolean;
  readonly validUntil: Date;
  readonly tokenExpiresAt: Date;
  readonly now: Date;
}

/**
 * What a quote link opens (FR-QUO-008, CR-047): its version while it is live; afterwards only a state. A version
 * replaced by a newer issued one is REPLACED; a withdrawn quote WITHDRAWN; the accepted version ACCEPTED (also once
 * converted); a declined quote DECLINED; past the validity or the token's own expiry, or expired by the job, EXPIRED.
 */
export function linkState(f: LinkFacts): LinkState {
  if (f.quoteStatus === 'CANCELLED') return 'WITHDRAWN';
  if (f.versionStatus === 'ACCEPTED') return 'ACCEPTED';
  if (f.versionStatus === 'SUPERSEDED' || !f.isCurrent) return 'REPLACED';
  if (f.quoteStatus === 'DECLINED') return 'DECLINED';
  if (f.quoteStatus === 'EXPIRED' || f.now > f.validUntil || f.now > f.tokenExpiresAt) return 'EXPIRED';
  return 'OPEN';
}

/** What a quote line holds (`planHold`): the pieces to reserve, what was there to promise, what is held and what is not. */
export interface HoldPlan {
  readonly pieces: readonly { readonly index: number; readonly qty: Quantity }[];
  /** Everything on hand to promise from, a balance below zero counted as nothing (ADR-0081). */
  readonly available: Quantity;
  /** What is reserved: `wanted` or what is on hand, whichever is less. Never more than is there (ADR-0019). */
  readonly held: Quantity;
  /** What is not on hand: the line is subject to stock when this is above nothing (the owner, 2026-11-18). */
  readonly short: Quantity;
}

/**
 * The pieces of available stock, oldest first as given, that hold `wanted` in the base unit, or as much of it as is on
 * hand (the owner, 2026-11-18: a quote for stock not on hand is issued subject to stock, holding only what is there).
 */
export function planHold(wanted: Quantity, available: readonly Quantity[]): HoldPlan {
  let left = wanted;
  let there = Quantity.zero();
  const pieces: { index: number; qty: Quantity }[] = [];
  for (const [index, qty] of available.entries()) {
    if (qty.isZero() || qty.isNegative()) continue;
    there = there.plus(qty);
    if (left.isZero()) continue;
    const take = qty.compareTo(left) >= 0 ? left : qty;
    pieces.push({ index, qty: take });
    left = left.minus(take);
  }
  return { pieces, available: there, held: wanted.minus(left), short: left };
}

/**
 * The estimated cost of one unit of a quote line (FR-QUO-003, A-309 (c)): the average of the cost pools it may be
 * promised from (pool value over pool quantity, in the base unit), times the base quantity of one line unit, rounded
 * half-up once. Null when there is no pool to read. A line of 3 crates (90 eggs) from pools of 105,000 for 900 eggs is
 * 3,500 a crate.
 */
export function unitCost(pools: readonly { readonly valuePesewas: bigint; readonly qty: Quantity }[], baseQty: Quantity, qty: Quantity): bigint | null {
  const value = pools.reduce((a, p) => a + p.valuePesewas, 0n);
  const held = pools.reduce((a, p) => a + p.qty.thousandths, 0n);
  if (pools.length === 0 || held <= 0n) return null;
  // value / held(thousandths) per base thousandth, times baseQty(thousandths) over qty units (thousandths / 1,000).
  return halfUpDivide(value * baseQty.thousandths * 1_000n, held * qty.thousandths);
}
