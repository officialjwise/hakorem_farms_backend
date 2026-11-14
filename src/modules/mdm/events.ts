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
