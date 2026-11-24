/**
 * SHP's published events (ADR-0010): types only. B11's abandoned-cart and notification work and B09a's order
 * placement subscribe to them.
 */

/** `shp.CheckoutStarted`: a checkout priced its lines and reserved every one of them until `reservedUntil`. */
export interface CheckoutStarted {
  readonly checkoutId: string;
  readonly cartId: string;
  readonly reservedUntil: string;
  readonly estimatedTotalPesewas: number;
  readonly lineCount: number;
  /**
   * The keyed hash (HMAC-SHA-256 under the lookup key) of the client address the checkout came from, never the address
   * itself, so RPT counts checkouts started and expired per address for residual risk R18 (B12 continued 3); null for
   * a checkout with no address.
   */
  readonly clientAddressHash?: string | null;
}

/** `shp.CheckoutExpired` (FR-SHP-006) or `shp.CheckoutCancelled`: the checkout ended unpaid and its cart is ACTIVE again. */
export interface CheckoutEnded {
  readonly checkoutId: string;
  readonly cartId: string;
  readonly reservedUntil: string;
  /** The reason INV gave for ending the reservation. */
  readonly reason: string;
}

/** `shp.CheckoutCompleted` (A-232): the order placed from the checkout took over its hold; the cart is CONVERTED. */
export interface CheckoutCompleted {
  readonly checkoutId: string;
  readonly cartId: string;
  readonly orderId: string;
}

/**
 * `shp.CartAbandoned` v1 (FR-SHP-015, B11 continued 12): a cart its customer left idle two hours, with marketing consent,
 * reminded once. It names the cart and its customer only, never what is in the cart; NTF reads the customer through MDM.
 */
export interface CartAbandoned {
  readonly cartId: string;
  readonly customerId: string;
  readonly noticeId: string;
  readonly idleSince: string;
}
