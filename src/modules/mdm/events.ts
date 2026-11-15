/**
 * Events MDM publishes (docs/DOMAIN_MODEL.md section 5). Types only: subscribers import them with `import type`.
 */

/** `mdm.ProductCreated` v1: a product entered the catalogue. Storefront search and reporting subscribe (B7, B12). */
export interface ProductCreated {
  readonly productId: string;
  readonly sku: string;
  readonly name: string;
  readonly categoryId: string;
  readonly stockPolicy: 'SERIALISED' | 'CATCH_WEIGHT' | 'COUNTABLE' | 'NON_STOCK';
  readonly tracking: 'SERIAL' | 'LOT' | 'NONE';
  readonly onlineMode: 'HIDDEN' | 'LISTED' | 'REQUEST_TO_BUY';
  readonly status: 'DRAFT' | 'ACTIVE' | 'DISCONTINUED';
}

/**
 * `mdm.ProductChanged` v1: a product's catalogue fields changed (updateProduct). Carries the fields a subscriber
 * filters on and the names of every field that changed; storefront search and offline price packs subscribe (B7, B9b).
 */
export interface ProductChanged {
  readonly productId: string;
  readonly sku: string;
  readonly name: string;
  readonly categoryId: string;
  readonly onlineMode: 'HIDDEN' | 'LISTED' | 'REQUEST_TO_BUY';
  readonly status: 'DRAFT' | 'ACTIVE' | 'DISCONTINUED';
  readonly isSellable: boolean;
  readonly changedFields: readonly string[];
  readonly version: number;
}

/**
 * `mdm.ProductArchived` v1: a product left the catalogue (archiveProduct). Its history stays readable; storefront
 * search and offline price packs drop it (B7, B9b).
 */
export interface ProductArchived {
  readonly productId: string;
  readonly sku: string;
  readonly reason: string;
  readonly version: number;
}

/**
 * `mdm.SupplierRegistered` v1: a supplier entered the register (createSupplier). Procurement subscribes to open the
 * supplier's commercial profile (B7). Identity only: no contact details travel in the event.
 */
export interface SupplierRegistered {
  readonly supplierId: string;
  readonly supplierNo: string;
  readonly name: string;
  readonly categoryIds: readonly string[];
}

/**
 * `mdm.PriceListVersionActivated` v1: a price list version was approved and is in force from `validFrom`. Offline
 * price packs and the storefront catalogue cache subscribe (B9b, B7) so a device never prices from a stale list.
 */
export interface PriceListVersionActivated {
  readonly priceListId: string;
  readonly versionId: string;
  readonly versionNo: number;
  readonly validFrom: string;
  readonly validTo: string | null;
  /** Earlier versions now ending where this one starts. */
  readonly endedVersionIds: readonly string[];
  /** Versions this one replaced outright. */
  readonly supersededVersionIds: readonly string[];
}

/**
 * `mdm.TaxSchemeVersionActivated` v1: a tax scheme version was approved and applies to tax dates from `validFrom`
 * (a business date, Africa/Accra). Offline price packs and cart totals subscribe (B9b, B7) so a total is never
 * calculated with a superseded matrix.
 */
export interface TaxSchemeVersionActivated {
  readonly versionId: string;
  readonly versionNo: number;
  readonly validFrom: string;
  readonly validTo: string | null;
  /** Earlier versions now ending the day this one starts. */
  readonly endedVersionIds: readonly string[];
  /** Versions this one replaced outright. */
  readonly supersededVersionIds: readonly string[];
}

/**
 * `mdm.PromotionActivated` v1: a promotion was approved and discounts lines from `validFrom` (the moment of approval
 * if that was later). Offline price packs (B9b) and the storefront (B7) subscribe so a cached price never misses it.
 */
export interface PromotionActivated {
  readonly promotionId: string;
  readonly code: string;
  readonly validFrom: string;
  readonly validTo: string;
}

/** `mdm.PromotionEnded` v1: an active promotion was ended early; from `validTo` it discounts nothing. */
export interface PromotionEnded {
  readonly promotionId: string;
  readonly code: string;
  readonly validTo: string;
  readonly reason: string;
}
