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
