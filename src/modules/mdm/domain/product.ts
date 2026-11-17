import { err, KernelError, ok, Rate, Weight, type Result } from '@hakorem/kernel';

export type StockPolicy = 'SERIALISED' | 'CATCH_WEIGHT' | 'COUNTABLE' | 'NON_STOCK';
export type Tracking = 'SERIAL' | 'LOT' | 'NONE';
export type OnlineMode = 'HIDDEN' | 'LISTED' | 'REQUEST_TO_BUY';
export type TempClass = 'AMBIENT' | 'CHILLED' | 'FROZEN';
export type ProductStatus = 'DRAFT' | 'ACTIVE' | 'DISCONTINUED';
export type GlGroup = 'LIVE_ANIMALS' | 'MEAT' | 'OFFAL' | 'PRODUCE_EGGS' | 'FEED_MEDICATION' | 'SUPPLIES' | 'SERVICE';
export type UomKind = 'COUNT' | 'WEIGHT' | 'VOLUME';

/**
 * Fields the server assigns and never takes as input (B09q, ADR-0072): a product's SKU is generated at creation from
 * its category's prefix and never edited. A request that carries one is refused, never silently ignored.
 */
export const SERVER_ASSIGNED_PRODUCT_FIELDS = ['sku'] as const;

/** The JSON pointers of the server-assigned fields an input carries (any value, even null or empty), in order. */
export function serverAssignedFieldsIn(input: object): string[] {
  return SERVER_ASSIGNED_PRODUCT_FIELDS.filter((field) => Object.prototype.hasOwnProperty.call(input, field)).map((field) => `/${field}`);
}

/** What a user asks for (the contract's `ProductCreate`, already parsed at the boundary). The SKU is the server's. */
export interface ProductDraft {
  readonly name: string;
  readonly categoryId: string;
  readonly stockPolicy: StockPolicy;
  readonly speciesId?: string | undefined;
  readonly baseUom: string;
  readonly saleUom: string;
  /** Kilograms, a decimal string with three places. */
  readonly nominalPackKg?: string | undefined;
  /** A percentage, a decimal string. */
  readonly weightTolerancePercent?: string | undefined;
  readonly taxCategoryId?: string | undefined;
  readonly shelfLifeDays?: number | undefined;
  readonly storageTempClass?: TempClass | undefined;
  readonly withdrawalDays?: number | undefined;
  readonly description?: string | undefined;
  readonly onlineMode: OnlineMode;
  readonly seo?: { readonly slug?: string | undefined; readonly title?: string | undefined; readonly description?: string | undefined } | undefined;
  readonly isPurchasable?: boolean | undefined;
  readonly isSellable?: boolean | undefined;
}

/** What the draft refers to, as the application found it. */
export interface ProductReferences {
  readonly category: { readonly id: string; readonly glGroup: GlGroup; readonly taxCategoryId: string } | null;
  readonly speciesFound: boolean;
  /** How the draft's species is kept (`mdm.species.tracking_default`), when it has one and it was found. */
  readonly speciesTrackingDefault?: 'SERIAL' | 'LOT' | undefined;
  readonly taxCategoryFound: boolean;
  /** Every unit of measure by code, with its kind. */
  readonly units: ReadonlyMap<string, UomKind>;
}

/** A product ready to store: every derived field filled in, decimals normalised. Its SKU is allocated on insert. */
export interface ProductDefinition {
  readonly name: string;
  readonly categoryId: string;
  readonly stockPolicy: StockPolicy;
  readonly tracking: Tracking;
  readonly speciesId: string | null;
  readonly baseUom: string;
  readonly saleUom: string;
  readonly nominalPackKg: string | null;
  /** At least two decimal places, as the contract shows it ("10.00"). */
  readonly weightTolerancePercent: string;
  readonly taxCategoryId: string;
  readonly glGroup: GlGroup;
  readonly shelfLifeDays: number | null;
  readonly storageTempClass: TempClass | null;
  readonly withdrawalDays: number | null;
  readonly description: string | null;
  readonly onlineMode: OnlineMode;
  readonly seoSlug: string | null;
  readonly seoTitle: string | null;
  readonly seoDescription: string | null;
  readonly isPurchasable: boolean;
  readonly isSellable: boolean;
  readonly status: ProductStatus;
}

export interface FieldRule {
  readonly field: string;
  readonly rule: string;
}

export type ProductRefusal =
  | { readonly code: 'REFERENCE_NOT_FOUND'; readonly fields: readonly FieldRule[] }
  | { readonly code: 'STOCK_POLICY_CONFLICT'; readonly fields: readonly FieldRule[] };

/** Default catch-weight tolerance (docs/data-model/mdm.md, ADR-0021). */
const DEFAULT_TOLERANCE_PERCENT = '10';
const MAX_PERCENT_PLACES = 4;
const MIN_PERCENT_PLACES = 2;

/** "10" -> "10.00", "7.5" -> "7.50", "2.125" -> "2.125": at least two places, the exact value kept. */
function percentText(rate: Rate): string {
  const text = rate.toPercentString();
  const [whole, fraction = ''] = text.split('.');
  return `${whole}.${fraction.padEnd(MIN_PERCENT_PLACES, '0')}`;
}

function parseTolerance(text: string | undefined): string | null {
  try {
    const value = text ?? DEFAULT_TOLERANCE_PERCENT;
    const places = value.includes('.') ? value.split('.')[1]!.length : 0;
    if (places > MAX_PERCENT_PLACES) {
      return null;
    }
    return percentText(Rate.parsePercent(value));
  } catch (error) {
    if (error instanceof KernelError) {
      return null;
    }
    throw error;
  }
}

function trackingOf(draft: ProductDraft, references: ProductReferences): Tracking {
  switch (draft.stockPolicy) {
    case 'SERIALISED':
      return 'SERIAL';
    case 'CATCH_WEIGHT':
      return 'LOT';
    case 'COUNTABLE':
      // A countable with a shelf life is held in lots so its expiry can be tracked (A-082); so is a flock of a species
      // kept in lots, such as broilers (A-107).
      return draft.shelfLifeDays !== undefined || references.speciesTrackingDefault === 'LOT' ? 'LOT' : 'NONE';
    case 'NON_STOCK':
      return 'NONE';
  }
}

/**
 * Turns a product draft into a definition, or names every reason it cannot be one (FR-MDM-001). The rules are the
 * three stock archetypes of the shared brief plus services: an individual animal is tracked by serial and has a
 * species, and is never put in a cart; a catch-weight lot is held in kilograms; a countable is a plain count, held
 * in lots when it expires; a service holds no stock. The database enforces the same archetype checks.
 */
export function defineProduct(draft: ProductDraft, references: ProductReferences): Result<ProductDefinition, ProductRefusal> {
  const missing: FieldRule[] = [];
  if (references.category === null) missing.push({ field: '/categoryId', rule: 'UNKNOWN' });
  if (draft.speciesId !== undefined && !references.speciesFound) missing.push({ field: '/speciesId', rule: 'UNKNOWN' });
  if (draft.taxCategoryId !== undefined && !references.taxCategoryFound) missing.push({ field: '/taxCategoryId', rule: 'UNKNOWN' });
  if (!references.units.has(draft.baseUom)) missing.push({ field: '/baseUom', rule: 'UNKNOWN' });
  if (!references.units.has(draft.saleUom)) missing.push({ field: '/saleUom', rule: 'UNKNOWN' });
  if (missing.length > 0 || references.category === null) {
    return err({ code: 'REFERENCE_NOT_FOUND', fields: missing });
  }

  const conflicts: FieldRule[] = [];
  const policy = draft.stockPolicy;
  if (policy === 'SERIALISED' && draft.speciesId === undefined) conflicts.push({ field: '/speciesId', rule: 'REQUIRED_FOR_SERIALISED' });
  if (policy === 'SERIALISED' && draft.onlineMode === 'LISTED') conflicts.push({ field: '/onlineMode', rule: 'LIVE_ANIMALS_ARE_REQUEST_TO_BUY' });
  if (policy === 'CATCH_WEIGHT' && draft.baseUom !== 'KG') conflicts.push({ field: '/baseUom', rule: 'CATCH_WEIGHT_IN_KG' });
  if (policy !== 'CATCH_WEIGHT' && draft.nominalPackKg !== undefined) conflicts.push({ field: '/nominalPackKg', rule: 'ONLY_FOR_CATCH_WEIGHT' });
  if (policy === 'NON_STOCK' && draft.speciesId !== undefined) conflicts.push({ field: '/speciesId', rule: 'NOT_FOR_NON_STOCK' });
  if (policy === 'NON_STOCK' && draft.shelfLifeDays !== undefined) conflicts.push({ field: '/shelfLifeDays', rule: 'NOT_FOR_NON_STOCK' });

  let nominalPackKg: string | null = null;
  if (draft.nominalPackKg !== undefined) {
    try {
      const weight = Weight.parseKg(draft.nominalPackKg);
      if (weight.isZero()) {
        conflicts.push({ field: '/nominalPackKg', rule: 'POSITIVE' });
      }
      nominalPackKg = weight.toKgString();
    } catch (error) {
      if (!(error instanceof KernelError)) throw error;
      conflicts.push({ field: '/nominalPackKg', rule: 'KILOGRAMS_3_PLACES' });
    }
  }
  const tolerance = parseTolerance(draft.weightTolerancePercent);
  if (tolerance === null) conflicts.push({ field: '/weightTolerancePercent', rule: 'PERCENT_0_TO_100' });
  if (conflicts.length > 0 || tolerance === null) {
    return err({ code: 'STOCK_POLICY_CONFLICT', fields: conflicts });
  }

  return ok({
    name: draft.name,
    categoryId: draft.categoryId,
    stockPolicy: policy,
    tracking: trackingOf(draft, references),
    speciesId: draft.speciesId ?? null,
    baseUom: draft.baseUom,
    saleUom: draft.saleUom,
    nominalPackKg,
    weightTolerancePercent: tolerance,
    taxCategoryId: draft.taxCategoryId ?? references.category.taxCategoryId,
    glGroup: references.category.glGroup,
    shelfLifeDays: draft.shelfLifeDays ?? null,
    storageTempClass: draft.storageTempClass ?? null,
    withdrawalDays: draft.withdrawalDays ?? null,
    description: draft.description ?? null,
    onlineMode: draft.onlineMode,
    seoSlug: draft.seo?.slug ?? null,
    seoTitle: draft.seo?.title ?? null,
    seoDescription: draft.seo?.description ?? null,
    isPurchasable: draft.isPurchasable ?? true,
    isSellable: draft.isSellable ?? true,
    // Created products are active: nothing sells without a price list entry anyway (A-083).
    status: 'ACTIVE',
  });
}
