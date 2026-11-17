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
  /**
   * Set when the reservation ended only because its stock was promised again, the same, to another document in the
   * same transaction (`Reservations.transferHeldByIn`: an online order taking over its checkout's hold, A-232); null
   * for every other release or expiry. A holder reads it to tell a hand-over from a loss.
   */
  readonly transferredToDocumentId: string | null;
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

/**
 * `inv.GoodsReceiptPosted` v1 (B7, A-164): a goods receipt was posted, published once in its transaction after its
 * movements. Procurement keeps each purchase order line's received quantity from it, inside the same transaction, and
 * refuses a receipt that would take a line past its ordered quantity plus tolerance (FR-PUR-007). Quantities are in
 * the product's base unit, as the receipt books them.
 */
export interface GoodsReceiptPosted {
  readonly goodsReceiptId: string;
  readonly kind: 'PURCHASE' | 'HARVEST' | 'OPENING';
  readonly branchId: string;
  readonly locationId: string;
  readonly supplierId: string | null;
  readonly purchaseOrderId: string | null;
  readonly receivedAt: string;
  readonly lines: readonly {
    readonly goodsReceiptLineId: string;
    readonly productId: string;
    readonly purchaseOrderLineId: string | null;
    readonly qtyReceived: string;
    readonly qtyRejected: string;
  }[];
}
