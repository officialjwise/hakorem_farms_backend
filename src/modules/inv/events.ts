/**
 * Events INV publishes beyond the ledger postings (docs/DOMAIN_MODEL.md section 5). Types only: subscribers import
 * them with `import type`.
 */

/**
 * `inv.StockUnitRegistered` v1: a goods receipt registered a stock unit, an animal by its tag or a lot by its batch.
 * The livestock register opens an animal record from `animal` (B6); reporting counts arrivals (B12).
 */
export interface StockUnitRegistered {
  readonly stockUnitId: string;
  readonly productId: string;
  readonly tracking: 'SERIAL' | 'LOT';
  readonly identifier: string;
  readonly locationId: string;
  readonly supplierId: string | null;
  readonly sourceDocumentId: string;
  readonly sourceLineRef: string;
  readonly expiresOn: string | null;
  readonly animal: {
    readonly sex: 'MALE' | 'FEMALE' | 'UNKNOWN';
    readonly breed: string | null;
    readonly weightKg: string | null;
    readonly weightSource: 'SCALE' | 'MANUAL' | 'ESTIMATE' | null;
    readonly dateOfBirth: string | null;
    readonly purpose: 'GROWING' | 'BREEDING';
  } | null;
}
