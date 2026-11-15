import { err, Money, ok, Quantity, Rate, type Result } from '@hakorem/kernel';
import type { Channel, PriceListKind } from './pricing-engine';

/**
 * Promotions and coupons (FR-MDM-018, ADR-0004 point 5). Pure: the application layer loads the active promotions and
 * passes them in. A promotion is applied after the base price, as a discount recorded beside the price on the line,
 * and only to a price that came from a tier, channel or base list: a customer's contract price is never discounted.
 * At most one promotion per stack group applies, the larger; an exclusive promotion excludes every other.
 */

export const PROMOTION_KINDS = ['PERCENT_OFF', 'AMOUNT_OFF', 'BUNDLE_PRICE', 'FREE_DELIVERY'] as const;
export type PromotionKind = (typeof PROMOTION_KINDS)[number];
export const PROMOTION_SCOPES = ['LINE', 'ORDER'] as const;
export type PromotionScope = (typeof PROMOTION_SCOPES)[number];
export const PROMOTION_STATUSES = ['DRAFT', 'PENDING_APPROVAL', 'ACTIVE', 'ENDED', 'REJECTED'] as const;
export type PromotionStatus = (typeof PROMOTION_STATUSES)[number];
export type CouponRefusal = 'EXPIRED' | 'LIMIT_REACHED' | 'NOT_APPLICABLE' | 'ALREADY_USED';

/** The price lists whose prices a public promotion may discount. */
const DISCOUNTABLE_LISTS: ReadonlySet<PriceListKind> = new Set(['TIER', 'CHANNEL', 'BASE']);
const COUPON_CODE = /^[A-Z0-9][A-Z0-9-]{2,39}$/;

/** An active promotion as the engine sees it. */
export interface PromotionRule {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly kind: PromotionKind;
  readonly percentOff: Rate | null;
  readonly amountOffPesewas: bigint | null;
  readonly appliesTo: PromotionScope;
  readonly channel: Channel | null;
  readonly minOrderPesewas: bigint | null;
  readonly stackGroup: string;
  readonly isExclusive: boolean;
  readonly requiresCoupon: boolean;
  readonly validFrom: Date;
  readonly validTo: Date;
  readonly productIds: readonly string[];
  readonly categoryIds: readonly string[];
}

/** A resolved line: the product, where its price came from, and the line extended at list price. */
export interface PromotableLine {
  readonly productId: string;
  /** The product's category and every category above it: a promotion on "Meat" covers "Beef". */
  readonly categoryIds: readonly string[];
  readonly channel: Channel;
  readonly priceListKind: PriceListKind;
  readonly lineAmountPesewas: bigint;
  readonly at: Date;
}

export interface PromotionContext {
  /** The order extended at list, the sum of the line integers, for a minimum-order promotion. */
  readonly orderAmountPesewas: bigint;
  /** The promotion the buyer's coupon unlocks, if they gave a valid one. */
  readonly couponPromotionId: string | null;
}

export interface AppliedDiscount {
  readonly promotion: PromotionRule;
  readonly discountPesewas: bigint;
}

/**
 * The discount one line promotion gives on a line amount: a percentage rounded half-up once, or a fixed amount taken
 * off the line once and never more than the line. Bundle, delivery and order promotions give a line nothing here:
 * the order works them out from the whole basket.
 */
export function promotionDiscount(promotion: PromotionRule, lineAmountPesewas: bigint): bigint {
  if (promotion.kind === 'PERCENT_OFF') {
    return Money.ofPesewas(lineAmountPesewas).timesRate(promotion.percentOff!).pesewas;
  }
  if (promotion.kind === 'AMOUNT_OFF') {
    return promotion.amountOffPesewas! < lineAmountPesewas ? promotion.amountOffPesewas! : lineAmountPesewas;
  }
  return 0n;
}

function applies(promotion: PromotionRule, line: PromotableLine, context: PromotionContext): boolean {
  return (
    promotion.appliesTo === 'LINE' &&
    (promotion.channel === null || promotion.channel === line.channel) &&
    line.at.getTime() >= promotion.validFrom.getTime() &&
    line.at.getTime() < promotion.validTo.getTime() &&
    (promotion.productIds.includes(line.productId) || line.categoryIds.some((id) => promotion.categoryIds.includes(id))) &&
    (!promotion.requiresCoupon || context.couponPromotionId === promotion.id) &&
    (promotion.minOrderPesewas === null || context.orderAmountPesewas >= promotion.minOrderPesewas)
  );
}

/** Larger discount first; equal discounts by promotion code, so the result never depends on the order of loading. */
function better(a: AppliedDiscount, b: AppliedDiscount): number {
  if (a.discountPesewas !== b.discountPesewas) {
    return a.discountPesewas > b.discountPesewas ? -1 : 1;
  }
  return a.promotion.code < b.promotion.code ? -1 : 1;
}

/**
 * The discounts on one resolved line, largest first. Nothing on a contract price. If any exclusive promotion applies,
 * the best exclusive one alone. Otherwise the best of each stack group, taken largest first and capped so that
 * together they never exceed the line; a promotion that would give nothing is not recorded.
 */
export function applyLinePromotions(line: PromotableLine, promotions: readonly PromotionRule[], context: PromotionContext): AppliedDiscount[] {
  if (!DISCOUNTABLE_LISTS.has(line.priceListKind)) {
    return [];
  }
  const candidates = promotions
    .filter((promotion) => applies(promotion, line, context))
    .map((promotion) => ({
      promotion,
      discountPesewas: promotionDiscount(promotion, line.lineAmountPesewas),
    }))
    .filter((candidate) => candidate.discountPesewas > 0n)
    .sort(better);
  const exclusive = candidates.find((candidate) => candidate.promotion.isExclusive);
  if (exclusive !== undefined) {
    return [exclusive];
  }
  const groups = new Set<string>();
  const applied: AppliedDiscount[] = [];
  let remaining = line.lineAmountPesewas;
  for (const candidate of candidates) {
    if (groups.has(candidate.promotion.stackGroup) || remaining === 0n) {
      continue;
    }
    groups.add(candidate.promotion.stackGroup);
    const discountPesewas = candidate.discountPesewas < remaining ? candidate.discountPesewas : remaining;
    remaining -= discountPesewas;
    applied.push({ promotion: candidate.promotion, discountPesewas });
  }
  return applied;
}

export interface PromotionTargetDraft {
  readonly productId: string | null;
  readonly categoryId: string | null;
  readonly bundleQty: string | null;
}

/** The parts of a promotion its rules constrain, as the request carries them. */
export interface PromotionDraft {
  readonly kind: PromotionKind;
  readonly percentOff: string | null;
  readonly amountOffPesewas: bigint | null;
  readonly bundlePricePesewas: bigint | null;
  readonly appliesTo: PromotionScope;
  readonly maxRedemptions: number | null;
  readonly validFrom: Date;
  readonly validTo: Date;
  readonly targets: readonly PromotionTargetDraft[];
}

export interface PromotionInvalid {
  readonly field: string;
  readonly code: 'PROMOTION_INVALID';
}

function invalid(field: string): Result<never, PromotionInvalid> {
  return err({ field, code: 'PROMOTION_INVALID' });
}

function positivePercent(text: string | null): boolean {
  if (text === null) {
    return false;
  }
  try {
    return !Rate.parsePercent(text).isZero();
  } catch {
    return false;
  }
}

/** The one value field each kind needs, then the fields it must leave empty, in the order they are checked. */
function valueField(draft: PromotionDraft): string | null {
  const percent = draft.percentOff !== null;
  const amount = draft.amountOffPesewas !== null;
  const bundle = draft.bundlePricePesewas !== null;
  switch (draft.kind) {
    case 'PERCENT_OFF':
      return !positivePercent(draft.percentOff) ? '/percentOff' : amount ? '/amountOffPesewas' : bundle ? '/bundlePricePesewas' : null;
    case 'AMOUNT_OFF':
      return !amount || draft.amountOffPesewas! <= 0n ? '/amountOffPesewas' : percent ? '/percentOff' : bundle ? '/bundlePricePesewas' : null;
    case 'BUNDLE_PRICE':
      return !bundle || draft.bundlePricePesewas! <= 0n ? '/bundlePricePesewas' : percent ? '/percentOff' : amount ? '/amountOffPesewas' : null;
    case 'FREE_DELIVERY':
      return percent ? '/percentOff' : amount ? '/amountOffPesewas' : bundle ? '/bundlePricePesewas' : draft.appliesTo !== 'ORDER' ? '/appliesTo' : null;
  }
}

/**
 * The rules of a promotion definition (FR-MDM-018, docs/data-model/mdm.md): one value for its kind and no other,
 * a window that ends after it starts, a positive redemption limit, and targets that each name exactly one product or
 * category, once. A line promotion or a bundle needs a target; only a bundle target carries a positive quantity.
 */
export function definePromotion(draft: PromotionDraft): Result<void, PromotionInvalid> {
  const field = valueField(draft);
  if (field !== null) {
    return invalid(field);
  }
  if (draft.validTo.getTime() <= draft.validFrom.getTime()) {
    return invalid('/validTo');
  }
  if (draft.maxRedemptions !== null && draft.maxRedemptions < 1) {
    return invalid('/maxRedemptions');
  }
  if (draft.targets.length === 0 && (draft.appliesTo === 'LINE' || draft.kind === 'BUNDLE_PRICE')) {
    return invalid('/targets');
  }
  const seen = new Set<string>();
  for (const [index, target] of draft.targets.entries()) {
    const key = target.productId ?? target.categoryId;
    if ((target.productId === null) === (target.categoryId === null) || seen.has(key!)) {
      return invalid(`/targets/${index}`);
    }
    seen.add(key!);
    const bundleTarget = draft.kind === 'BUNDLE_PRICE';
    if (bundleTarget !== (target.bundleQty !== null) || (bundleTarget && Quantity.parse(target.bundleQty!).isZero())) {
      return invalid(`/targets/${index}/bundleQty`);
    }
  }
  return ok(undefined);
}

export interface CouponDraft {
  readonly code: string;
  readonly maxUses: number | null;
  readonly perCustomerLimit: number | null;
}

export interface CouponInvalid {
  readonly field: string;
  readonly code: 'COUPON_INVALID';
}

/** A coupon code is stored trimmed and upper-case; its limits, when set, are positive, and one buyer's never exceeds the total. */
export function defineCoupon(draft: CouponDraft): Result<CouponDraft, CouponInvalid> {
  const code = draft.code.trim().toUpperCase();
  const refuse = (field: string) => err<CouponInvalid>({ field, code: 'COUPON_INVALID' });
  if (!COUPON_CODE.test(code)) {
    return refuse('/code');
  }
  if (draft.maxUses !== null && draft.maxUses < 1) {
    return refuse('/maxUses');
  }
  if (draft.perCustomerLimit !== null && (draft.perCustomerLimit < 1 || (draft.maxUses !== null && draft.perCustomerLimit > draft.maxUses))) {
    return refuse('/perCustomerLimit');
  }
  return ok({
    code,
    maxUses: draft.maxUses,
    perCustomerLimit: draft.perCustomerLimit,
  });
}

export interface CouponState {
  readonly maxUses: number | null;
  readonly perCustomerLimit: number | null;
  readonly usedCount: number;
  readonly promotionStatus: PromotionStatus;
  readonly validFrom: Date;
  readonly validTo: Date;
}

/**
 * Whether a coupon may be used now by a buyer who has used it `customerUses` times; null when it may. The database
 * holds the total limit again under a row lock, so two buyers racing for the last use cannot both have it.
 */
export function judgeCoupon(coupon: CouponState, customerUses: number, at: Date): CouponRefusal | null {
  if (coupon.promotionStatus === 'ENDED' || at.getTime() >= coupon.validTo.getTime()) {
    return 'EXPIRED';
  }
  if (coupon.promotionStatus !== 'ACTIVE' || at.getTime() < coupon.validFrom.getTime()) {
    return 'NOT_APPLICABLE';
  }
  if (coupon.maxUses !== null && coupon.usedCount >= coupon.maxUses) {
    return 'LIMIT_REACHED';
  }
  if (coupon.perCustomerLimit !== null && customerUses >= coupon.perCustomerLimit) {
    return 'ALREADY_USED';
  }
  return null;
}
