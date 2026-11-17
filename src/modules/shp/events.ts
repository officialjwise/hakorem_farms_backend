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
