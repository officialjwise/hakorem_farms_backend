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

/**
 * `inv.ReservationExpired` and `inv.ReservationReleased` v1 (ADR-0019): a reservation ended, by the expiry job or by
 * a person, and gave back exactly `qty`. The holder (a checkout, an order, a quote) reacts: SHP tells the shopper the
 * checkout lapsed (B7), QUO marks the animal no longer set aside (B10).
 */
export interface ReservationEnded {
  readonly reservationId: string;
  readonly holderDocumentId: string;
  readonly productId: string;
  readonly stockUnitId: string | null;
  readonly locationId: string;
  readonly qty: string;
  readonly expiresAt: string | null;
  readonly reason: string;
}

/**
 * ◆ `inv.UpkeepExpensed` v1 (ADR-0003, ADR-0018, A-134 (i)): feed or veterinary cost spent on breeding stock, which is
 * expensed rather than capitalised onto the animal, so no cost pool changes and no movement carries it. The feed or
 * medication itself left the store by its own FEED_ISSUE or MEDICATION_ISSUE. B8 posts 5200 debit, 1300 credit.
 */
export interface UpkeepExpensed {
  readonly stockUnitId: string;
  readonly productId: string;
  readonly branchId: string;
  readonly locationId: string;
  readonly valuePesewas: number;
  readonly costElement: 'FEED' | 'VETERINARY';
  readonly sourceDocumentId: string;
  readonly sourceLineRef: string | null;
}
