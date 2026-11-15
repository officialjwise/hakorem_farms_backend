import { err, ok, Weight, type Result } from '@hakorem/kernel';
import type { ProductStatus } from './product';

/** A rule a request breaks; `field` is a JSON pointer, or null when the record as a whole is refused. */
export interface CatalogueRule {
  readonly field: string | null;
  readonly rule: string;
}

/** What still uses a category, as the application counted it. */
export interface CategoryUsage {
  readonly liveProducts: number;
  readonly liveChildren: number;
}

/** A category with live products or live children cannot be archived (FR-MDM-002). */
export function planCategoryArchive(usage: CategoryUsage): Result<void, CatalogueRule[]> {
  const rules: CatalogueRule[] = [];
  if (usage.liveProducts > 0) rules.push({ field: null, rule: 'HAS_LIVE_PRODUCTS' });
  if (usage.liveChildren > 0) rules.push({ field: null, rule: 'HAS_LIVE_CHILDREN' });
  return rules.length > 0 ? err(rules) : ok(undefined);
}

export interface WeightRange {
  readonly minKg: string;
  readonly maxKg: string;
}

/** `numeric(10,3)`: up to seven whole digits and exactly three decimal places. */
const KG_PATTERN = /^\d{1,7}\.\d{3}$/;

function exactKg(text: string): string | null {
  return KG_PATTERN.test(text) ? Weight.parseKg(text).toKgString() : null;
}

/**
 * A weight band is the half-open range [min, max) in kilograms to exactly three places (FR-MDM-005), so 20.000 kg
 * falls in exactly one of two bands that meet there. A value with any other precision is refused, never rounded.
 * Overlap with another band of the species is the database's exclusion constraint.
 */
export function defineWeightBandRange(minKg: string, maxKg: string): Result<WeightRange, CatalogueRule[]> {
  const min = exactKg(minKg);
  const max = exactKg(maxKg);
  const rules: CatalogueRule[] = [];
  if (min === null) rules.push({ field: '/minKg', rule: 'KILOGRAMS_3_PLACES' });
  if (max === null) rules.push({ field: '/maxKg', rule: 'KILOGRAMS_3_PLACES' });
  if (min === null || max === null) return err(rules);
  if (Weight.parseKg(max).compareTo(Weight.parseKg(min)) <= 0) return err([{ field: '/maxKg', rule: 'NOT_ABOVE_MIN' }]);
  return ok({ minKg: min, maxKg: max });
}

/**
 * A grade or band that a live price list version (pending approval or active) prices with cannot be archived: the
 * version is immutable, and archiving under it would leave a price no request can reach (A-106).
 */
export function planReferencedArchive(livePriceUses: number): Result<void, CatalogueRule[]> {
  return livePriceUses > 0 ? err([{ field: null, rule: 'USED_BY_LIVE_PRICES' }]) : ok(undefined);
}

/** Moving a band's range under a live price would change which weights that frozen price covers (A-106). */
export function planRangeChange(current: WeightRange, next: WeightRange, livePriceUses: number): Result<void, CatalogueRule[]> {
  if (livePriceUses === 0) return ok(undefined);
  const rules: CatalogueRule[] = [];
  if (current.minKg !== next.minKg) rules.push({ field: '/minKg', rule: 'USED_BY_LIVE_PRICES' });
  if (current.maxKg !== next.maxKg) rules.push({ field: '/maxKg', rule: 'USED_BY_LIVE_PRICES' });
  return rules.length > 0 ? err(rules) : ok(undefined);
}

/** A product never returns to DRAFT; it may be discontinued and reinstated (A-106). */
export function canChangeProductStatus(from: ProductStatus, to: ProductStatus): boolean {
  return from === to || to !== 'DRAFT';
}
