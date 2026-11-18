import { halfUpDivide, Money, type Quantity } from '@hakorem/kernel';

export const QUOTE_STATUSES = ['DRAFT', 'PENDING_APPROVAL', 'ISSUED', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'CONVERTED', 'CANCELLED'] as const;
export type QuoteStatus = (typeof QUOTE_STATUSES)[number];
export const VERSION_STATUSES = ['DRAFT', 'PENDING_APPROVAL', 'ISSUED', 'SUPERSEDED', 'ACCEPTED'] as const;
export type VersionStatus = (typeof VERSION_STATUSES)[number];
export type PriceBasis = 'PER_HEAD' | 'PER_KG' | 'PER_UNIT';

/** The margin floor's default (FR-QUO-005, seed 10 percent), in basis points of cost. */
export const DEFAULT_MARGIN_FLOOR_BASIS_POINTS = 1_000;
const BASIS_POINTS = 10_000n;
const PERCENT_HUNDREDTHS = 10_000n;

/** A quote line extended once at its anchor, half-up (ADR-0001): the quoted unit price times the quantity in its unit. */
export function lineNet(unitPricePesewas: bigint, qty: Quantity): bigint {
  return Money.ofPesewas(unitPricePesewas).timesQuantity(qty).pesewas;
}

/** A line's estimated cost: its unit cost times its quantity, half-up once; unknown stays unknown. */
export function lineCost(unitCostPesewas: bigint | null, qty: Quantity): bigint | null {
  return unitCostPesewas === null ? null : Money.ofPesewas(unitCostPesewas).timesQuantity(qty).pesewas;
}

/**
 * Margin over cost (FR-QUO-003): (net less cost) over cost, as a percentage to two places, rounded half away from
 * zero; null when the cost is unknown or nil. It may be negative (sold below cost) or above 100.
 */
export function marginPercent(netPesewas: bigint, costPesewas: bigint | null): string | null {
  if (costPesewas === null || costPesewas === 0n) return null;
  const gain = netPesewas - costPesewas;
  const hundredths = halfUpDivide((gain < 0n ? -gain : gain) * PERCENT_HUNDREDTHS, costPesewas);
  const whole = hundredths / 100n;
  const cents = String(hundredths % 100n).padStart(2, '0');
  return `${gain < 0n && hundredths > 0n ? '-' : ''}${whole}.${cents}`;
}

/**
 * Whether a net is below the margin floor over its cost (FR-QUO-005), compared exactly in integers, never on the rounded
 * percentage: (net - cost) * 10,000 < floor * cost. An unknown cost cannot be shown to clear the floor, so it is below
 * (A-309 (c)); a nil cost (an animal born on the farm, B06 continued 2) always clears it.
 */
export function judgeMargin(netPesewas: bigint, costPesewas: bigint | null, floorBasisPoints: number): boolean {
  if (costPesewas === null) return true;
  return (netPesewas - costPesewas) * BASIS_POINTS < BigInt(floorBasisPoints) * costPesewas;
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
  readonly marginPercent: string | null;
  readonly belowMarginFloor: boolean;
}

/**
 * A version's figures (FR-QUO-003): each line extended once at its anchor; the tax is the calculator's on those anchors.
 * Tax-exclusive, the lines are net and the tax is added; tax-inclusive, the lines carry their tax, so the net is the
 * lines less the tax. The delivery fee is added to the net untaxed (A-309 (d)). The margin is judged on the lines' net of
 * tax alone, over their summed cost; a version needs approval below the floor or with any line below the engine floor.
 */
export function versionFigures(
  lines: readonly FigureLine[],
  extra: { readonly deliveryFeePesewas: bigint; readonly taxPesewas: bigint; readonly floorBasisPoints: number; readonly taxInclusive?: boolean },
): VersionFigures {
  const lineNets = lines.map((l) => lineNet(l.unitPricePesewas, l.qty));
  const anchors = lineNets.reduce((a, b) => a + b, 0n);
  const linesNet = extra.taxInclusive === true ? anchors - extra.taxPesewas : anchors;
  const costs = lines.map((l) => lineCost(l.unitCostPesewas, l.qty));
  const cost = costs.some((c) => c === null) ? null : costs.reduce<bigint>((a, b) => a + b!, 0n);
  const net = linesNet + extra.deliveryFeePesewas;
  return {
    lineNets,
    netPesewas: net,
    taxPesewas: extra.taxPesewas,
    grossPesewas: net + extra.taxPesewas,
    estimatedCostPesewas: cost,
    marginPercent: marginPercent(linesNet, cost),
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
  PENDING_APPROVAL: ['DRAFT', 'ISSUED'],
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

export type ReservationPlan =
  | { readonly kind: 'PLAN'; readonly pieces: readonly { readonly index: number; readonly qty: Quantity }[] }
  | { readonly kind: 'SHORT'; readonly short: Quantity };

/** The pieces of available stock, oldest first as given, that cover `wanted` in the base unit, or how much is short. */
export function planReservation(wanted: Quantity, available: readonly Quantity[]): ReservationPlan {
  let left = wanted;
  const pieces: { index: number; qty: Quantity }[] = [];
  for (const [index, qty] of available.entries()) {
    if (left.isZero()) break;
    if (qty.isZero() || qty.isNegative()) continue;
    const take = qty.compareTo(left) >= 0 ? left : qty;
    pieces.push({ index, qty: take });
    left = left.minus(take);
  }
  return left.isZero() ? { kind: 'PLAN', pieces } : { kind: 'SHORT', short: left };
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
