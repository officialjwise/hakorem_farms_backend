import { err, ok, type Result } from '@hakorem/kernel';
import type { LivRuleBroken } from './rules';

const MILLISECONDS_PER_DAY = 86_400_000;

/**
 * When a withdrawal hold ends (FR-LIV-008): exactly the withdrawal days after the treatment, to the minute, so a goat
 * treated on 1 November with 28 days may be sold from the same time on 29 November and never sooner. Null with no
 * withdrawal days: then no hold is placed.
 */
export function withdrawalEndsAt(occurredAt: Date, withdrawalDays: number): Date | null {
  return withdrawalDays === 0 ? null : new Date(occurredAt.getTime() + withdrawalDays * MILLISECONDS_PER_DAY);
}

/** The withdrawal days an event carries: the product's by default; a person may lengthen it, never shorten it. */
export function withdrawalDaysFor(requested: number | undefined, productDays: number | null): Result<number, 'WITHDRAWAL_BELOW_PRODUCT'> {
  const floor = productDays ?? 0;
  if (requested === undefined) return ok(floor);
  return requested < floor ? err('WITHDRAWAL_BELOW_PRODUCT') : ok(requested);
}

export interface HealthEventShape {
  readonly hasStockUnit: boolean;
  readonly hasLocation: boolean;
  readonly hasProduct: boolean;
  readonly hasQtyUsed: boolean;
  readonly occurredAt: Date;
  readonly now: Date;
}

/** A health event treats one animal or flock, or every unit in one pen; medication used names its product and quantity. */
export function checkHealthEvent(shape: HealthEventShape): LivRuleBroken[] {
  const broken: LivRuleBroken[] = [];
  if (shape.hasStockUnit === shape.hasLocation) broken.push({ field: shape.hasStockUnit ? '/locationId' : '/stockUnitId', rule: 'ANIMAL_OR_PEN_REQUIRED' });
  if (shape.hasProduct !== shape.hasQtyUsed) broken.push({ field: shape.hasProduct ? '/qtyUsed' : '/productId', rule: 'PRODUCT_AND_QTY_TOGETHER' });
  if (shape.occurredAt > shape.now) broken.push({ field: '/occurredAt', rule: 'IN_THE_FUTURE' });
  return broken;
}
