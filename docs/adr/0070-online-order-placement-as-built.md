# ADR-0070: Online order placement as built

- **Status:** Proposed
- **Date:** 2026-11-17
- **Session:** B09a continued 2f
- **Deciders:** backend track; the owner confirms the guest-only placement and the cancellation rule (A-232)

## Context

FR-SHP-005 and the contract's `placeOrder`: "Creates the order and initiates payment for the estimated total. The order is confirmed only by the verified provider callback. For cash on delivery, the order is confirmed at once." The checkout (B07 continued 2) holds every line's stock through INV for 15 minutes (A-045), held by the checkout document; the provider port (ADR-0063, A-210) clears a charge in one place, `ProviderPayments.settleIn`, and publishes `pay.PaymentCleared` with `heldAsUnmatched` when the money came after the order stopped waiting. ORD sits below SHP (layer 9 and 10) and cannot read a checkout; SHP cannot write an order. The tracking link must be "signed; not the order id". No external call may happen inside a business transaction (ADR-0010).

## Options considered

1. **Hand the checkout's hold to the order at placement.** The order holds the stock from the start, with the checkout's expiry. The checkout's end then depends on ORD's events, and an unpaid order holds stock under its own id with an expiry INV must keep.
2. **The checkout keeps its hold until the order is confirmed, which takes it over whole.** At placement nothing about the stock changes; on confirmation INV ends each of the checkout's reservations and promises the same stock to the order in the same transaction, marking the end as a hand-over; the checkout completes on that fact. If the hold ends first, the order is cancelled on that fact.
3. **Re-reserve at confirmation from what is promisable.** The checkout's stock would be free for a moment, and another buyer could take the last crate between the payment and the confirmation.

## Decision

Option 2.

- **Placement (`Checkouts.place`, SHP).** In one serializable transaction: the guest's open checkout is handed down to ORD's `OnlineOrders.placeIn`, which writes the order ONLINE and PLACED from the checkout (its source document; one per checkout, `uq_sales_order_online_source`), every line priced by MDM's engine now with the checkout's figures, else 422 `PRICE_CHANGED`. The checkout moves to `AWAITING_PAYMENT` naming its order (`fk_checkout_session_order`, `ck_checkout_session_awaiting`). Mobile money: PAY's `ProviderPayments.chargeIn` writes the charge PENDING for the estimate in the same transaction; `sendCharge` sends it after the commit. Cash on delivery: the order is confirmed at once.
- **Confirmation (`OnlineOrders.confirmFromCheckoutIn`).** INV's new `Reservations.transferHeldByIn` ends each of the checkout's reservations RELEASED with `transferredToDocumentId` and reserves the same stock for the order with no expiry. SHP's existing in-transaction subscriber completes the checkout and converts the cart when the hand-over names its order. A prepaid order is confirmed in the clearing's transaction by ORD's transactional subscriber on `pay.PaymentCleared`, only when the money is the order's (`paymentConfirms`: not `heldAsUnmatched`) and covers the estimate.
- **Stopping.** ORD subscribes in the transaction to `inv.ReservationExpired` and `inv.ReservationReleased` (not a hand-over) and to `pay.PaymentFailed`: a PLACED online order whose checkout's hold ended, or whose charge failed, is cancelled (`PAYMENT_NOT_RECEIVED`) through the cancellation's own path, which releases its pending charge, so money that still arrives is held unmatched with a break (A-210). A cancellation by staff or a failed charge also releases the checkout's stock, after the order is CANCELLED, so the cart comes back at once.
- **Tracking.** The token is `trk_` and base64url of the order id's 16 bytes and a 128-bit HMAC-SHA256 under a key derived from the lookup key for this purpose; it is never stored and is checked in constant time.
- **Guest only.** Placement takes no customer session (the public route's actor is the Storefront principal); the contract's `customerSession` and optional CSRF header are removed from `placeOrder`. A signed-in customer's own orders are read through `listMyOrders` and `getMyOrder`.

## Consequences

- Nothing is free between the payment and the confirmation: the stock passes from the checkout to the order in one transaction.
- The four transactional subscribers are of the kind ADR-0010 permits (a module keeping its own aggregate consistent with a lower module's fact); none throws for a business reason, so a payment's clearing or a reservation's expiry is never rolled back by the order.
- B11 posts a confirmed online order through `SalePosting` at dispatch or collection; B9a's proof of `postIn` for the ONLINE channel stands. Registered checkout (a customer session on placement, saved addresses), card payment, and promotions on an order (`ord.sales_order_adjustment`) are not built.
- Binds: `docs/data-model/ord.md`, `docs/data-model/shp.md`, the INV, PAY, ORD and SHP cards in `docs/MODULE_BOUNDARIES.md`, `docs/API.md` (SHP and ORD), A-232.

## Verification

- `test/integration/ord/online-orders.integration.spec.ts` (22 tests): placement, replay and the closed checkout; the payment clearing by the sweep confirming the order, the stock moved, the checkout completed and the cart's `checkoutId` null again (CR-029); cash on delivery confirmed at once with its fee; every refusal; catch weight's estimate; the hold lapsing, money after the window, a smaller payment, a failed charge and a staff cancellation; the database rules by direct SQL; tracking and a tampered token; a customer's own orders only, and every other caller refused.
- `src/modules/ord/domain/online.spec.ts` under the `ord/domain` gate.
- Mutation runs (the B09a continued 2f report).
