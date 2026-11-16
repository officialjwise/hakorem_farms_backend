import { Money, type Quantity, Rate, Weight } from '@hakorem/kernel';
import type { Transaction } from '../../../platform/database/unit-of-work';
import type { OnlineProductFacts, PricingService } from '../../mdm';
import { estimateLine, type LineEstimate, type PriceBasis } from '../domain/pricing-lines';

const THOUSANDTHS_PER_UNIT = 1_000n;

export interface LineToPrice {
  readonly lineRef: string;
  readonly product: OnlineProductFacts;
  /** Whole units of the product's sale unit. */
  readonly quantity: Quantity;
}

export type LinePrice =
  | {
      readonly kind: 'PRICED';
      readonly lineRef: string;
      readonly unitPrice: Money;
      readonly basis: PriceBasis;
      readonly priceListId: string;
      readonly priceListEntryId: string;
      readonly estimate: LineEstimate;
      readonly discount: Money;
      readonly promotions: readonly { readonly promotionId: string; readonly code: string; readonly name: string; readonly discountPesewas: number }[];
    }
  | { readonly kind: 'QUOTE_REQUIRED'; readonly lineRef: string };

function isCatchWeight(product: OnlineProductFacts): boolean {
  return product.stockPolicy === 'CATCH_WEIGHT' && product.nominalPackKg !== null;
}

/** A catch-weight line's estimated weight, for the engine: packs times the nominal pack weight (FR-SHP-007). */
function estimatedKg(product: OnlineProductFacts, quantity: Quantity): string | undefined {
  if (!isCatchWeight(product)) return undefined;
  return Weight.ofGrams((Weight.parseKg(product.nominalPackKg!).grams * quantity.thousandths) / THOUSANDTHS_PER_UNIT).toKgString();
}

/**
 * Prices storefront lines through MDM's engine on the ONLINE channel (FR-SHP-003, FR-SHP-004, ADR-0004, ADR-0040):
 * the price is never a column. A catch-weight line is resolved at its estimated weight, so a promotion's discount is
 * taken from the same anchor the estimate is. A coupon the engine refuses throws its 422.
 */
export async function priceLinesIn(pricing: PricingService, tx: Transaction, branchId: string, couponCode: string | null, lines: readonly LineToPrice[]): Promise<LinePrice[]> {
  if (lines.length === 0 && couponCode === null) return [];
  const result = await pricing.resolveIn(tx, {
    channel: 'ONLINE',
    branchId,
    ...(couponCode === null ? {} : { couponCode }),
    lines: lines.map((line) => {
      const weightKg = estimatedKg(line.product, line.quantity);
      return { lineRef: line.lineRef, productId: line.product.id, quantity: line.quantity.toDecimalString(), ...(weightKg === undefined ? {} : { weightKg }) };
    }),
  });
  return lines.map((line, index): LinePrice => {
    const resolution = result.lines[index]!;
    if (resolution.resolved === null) return { kind: 'QUOTE_REQUIRED', lineRef: line.lineRef };
    const unitPrice = Money.ofPesewas(BigInt(resolution.resolved.listPricePesewas));
    const estimate = estimateLine({
      basis: resolution.resolved.basis,
      unitPrice,
      quantity: line.quantity,
      catchWeight: isCatchWeight(line.product) ? { nominalPack: Weight.parseKg(line.product.nominalPackKg!), tolerance: Rate.parsePercent(line.product.weightTolerancePercent) } : null,
    });
    const discount = Money.sum(resolution.promotions.map((p) => Money.ofPesewas(BigInt(p.discountPesewas))));
    return {
      kind: 'PRICED',
      lineRef: line.lineRef,
      unitPrice,
      basis: resolution.resolved.basis,
      priceListId: resolution.resolved.priceList.id,
      priceListEntryId: resolution.resolved.priceListEntryId,
      estimate,
      discount: discount.compareTo(estimate.estimated) > 0 ? estimate.estimated : discount,
      promotions: resolution.promotions,
    };
  });
}
