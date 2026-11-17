# B09a continued 2f: online placement, split before the dashboard and the seed

Date: 2026-11-17 · Branch `b09a3f-orders-online`, from `main` (`0d8d4bf`) · Pull request #78 · Status: **gate passed for the part built; the phase split (A-233)** after online placement. The remainder is **B09a continued 2g** (`b09a3g-dashboard-seed`), inserted in `docs/prompts/session-openers.md` after this phase and before B09x.

Run as a fresh agent inside the 2026-11-15 overnight session: the parent session cannot issue /clear or /compact, so each phase starts in a new context that reads only this handoff from disk.

## Assumptions made this session (in `docs/ASSUMPTIONS.md`, dated 2026-11-17)

| ID | What | Who confirms |
| --- | --- | --- |
| A-232 | **Online placement as built**, each the most conservative reading. (a) `placeOrder` takes a **guest** checkout only (the public route acts as the Storefront principal; registered checkout is not built), so an online order has no customer; the contract's `customerSession` and optional CSRF header are removed from `placeOrder`, and no call that worked stops working. (b) Mobile money on PREPAID terms, or cash on delivery on COD; a **card** is refused (`CARD_NOT_AVAILABLE`), so is a **coupon or promotion** (`PROMOTION_NOT_AVAILABLE`: `ord.sales_order_adjustment` is not built), and a method that is not the checkout's terms. Every line is priced by the engine at placement and must give the checkout's figures exactly, else 422 `ORDER_INVALID` `PRICE_CHANGED`. A catch-weight line keeps its packs, estimated weight and tolerance; the estimate is charged (ADR-0021). (c) The checkout keeps its hold while the order waits; on confirmation INV hands the reservations to the order whole, and the checkout completes and the cart converts. (d) Confirmation only in the transaction that clears a payment naming the order, only for money not held as unmatched, and only when cleared money covers the estimate. (e) A PLACED online order is cancelled (`PAYMENT_NOT_RECEIVED`) when its hold ends first or its charge fails; its charge is released, so late money is held unmatched. (f) The tracking token is an HMAC-signed id, never stored. (g) A customer reads only their own orders. (h) **Gate reading:** the online order's own posting through `SalePosting.postIn` is at dispatch or collection (B11, A-208 (b)); B9a's proof of `postIn` for the ONLINE channel stands. | Owner (a, b, e), Accountant (d) |
| A-233 | **B09a continued 2f split after online placement.** The dashboard's six B9a figures and two tiles (CR-013) and the seeded trading day move unchanged to **B09a continued 2g** (`b09a3g-dashboard-seed`), before B09x. | Owner |

Still open, proceeded on as stated: A-033, A-034, A-062, A-182 to A-207, A-209, A-211, A-213, A-214, A-216 to A-233.

Phase, scope and gate, as confirmed at the start:
1. **Phase:** B09a continued 2f (`b09a3f-orders-online`, from `main` at `0d8d4bf`).
2. **Scope:** the opener's list: the permissions of what follows; online placement and payment (`placeOrder`, `trackOrder`, `listMyOrders`, `getMyOrder`) with CR-029 through `placeOrder`; the dashboard's six figures and two tiles (CR-013); the seeded trading day; and the parent's docs fix to 1.50.0 (LOUD). The whole list could not reach its gate in one context, so the session built the first sub-domain the opener names (online placement), proved it, and split (A-233).
3. **Gate:** as the opener states it; the gate below is the one for the part built.

## Contract changes

**1.51.0, minor. No existing response shape changed, no field removed, renamed or retyped, nothing a client sends made required.**
- `placeOrder` (SHP; owner ORD), `trackOrder`, `listMyOrders` and `getMyOrder` move into code with exact descriptions.
- `placeOrder` is **narrowed to a guest's checkout**: `security: []` only (the planned `customerSession` alternative is removed) and the optional `X-CSRF-Token` parameter is removed. A client that sent either still succeeds. It gains a `503` response.
- No error code is added. 417 operations from code, 218 planned. `contract:generate` is up to date, Redocly is clean with no warnings, and the versioning check against `main` passes.
- **The parent's docs fix:** the 1.50.0 entry now marks `createOrder`'s 202 (where it answered 422) **LOUD**, and a "Read first (cold-read summary)" block at the top of `docs/CONTRACT_CHANGELOG.md` names it; the "Reading cold" section has a 1.50.0 paragraph. Its own docs commit (`ca7a246`).

## Built

| Area | What |
| --- | --- |
| INV | `Reservations.transferHeldByIn`: every active reservation of one document handed to another in the caller's serializable transaction, each ended RELEASED with `transferredToDocumentId` and the same stock reserved again with no expiry. `ReservationEnded` carries `transferredToDocumentId` (null otherwise). |
| PAY | `ProviderPayments.chargeIn` (a mobile money charge for an order written PENDING in the caller's transaction, the same write `initiateMobileMoneyCharge` makes, now shared) and `sendCharge` (sent after the commit). |
| ORD domain | `domain/online.ts`: `trackingSteps` and `paymentConfirms`, at 100 percent under the `ord/domain/**` gate. |
| ORD application | `OnlineOrders`: `placeIn`, `confirmFromCheckoutIn`, the transactional subscribers on `pay.PaymentCleared`, `pay.PaymentFailed`, `inv.ReservationExpired` and `inv.ReservationReleased`, and the reads `track`, `mine`, `mineOne`. `TrackingTokens` (`trk_` + HMAC). `OrderReversals.stopWaitingIn` (the System's cancellation of an online order that stops waiting); the cancellation releases an online PLACED order's checkout hold after the order is CANCELLED. |
| ORD database | 0204: `uq_sales_order_online_source` (one online order per checkout; the handlers' point read). |
| SHP | `Checkouts.place` (placeOrder); the hand-over completes the checkout and converts the cart (`shp.CheckoutCompleted`). 0205: `fk_checkout_session_order` (the expand 0119 announced) and `ck_checkout_session_awaiting`. SHP now imports ORD and PAY. |
| Interface | `POST /shop/checkouts/{id}/place` (SHP), `GET /shop/orders/track/{token}`, `GET /me/orders`, `GET /me/orders/{id}` (ORD). |
| Docs | ADR-0070 and its index row; A-232, A-233; ADR-0026 Amendments; the openers (2f marked split, 2g inserted, B09x reads 2g's report); `docs/data-model/ord.md` and `shp.md`; API.md (ORD and SHP); the changelog; the INV, PAY, ORD and SHP cards; the TB1 threat table; the SRS traceability rows for FR-SHP-010, FR-SHP-011 and FR-SHP-013. |

No permission is added: placement is the guest's (ownership by the cookie), the reads are the customer realm's own (ownership by the sign-in), and confirmation and cancellation are the System's in the clearing's or the expiry's transaction.

## The gate, proved by running it

`test/integration/ord/online-orders.integration.spec.ts` runs 22 tests against the seeded farm, real Postgres and the local Paystack fake. Big eggs are 6,000 a crate online; beef 3,213 a kg; Dodowa's zone 1,500.

- **Placement:** 2 crates answer 201 with `SO-…`, a `trk_` token that does not contain the order id, the charge PENDING ("GHS 120.00"), and the checkout `AWAITING_PAYMENT` naming the order. The order is ONLINE, PLACED, guest, from the checkout, no salesperson, **12,000** estimated and maximum; its line is ENGINE at 6,000 × 2 = **12,000**, variance 0, unflagged. One `ord.OrderPlaced`. The payment is PENDING for **12,000** and the fake holds a charge of 12,000. The stock stays with the checkout (2.000 ACTIVE, expiring); the cart still names its checkout.
- **Replay and closed:** the same key answers the same order and payment with no second `/charge`; another key is 409 `CHECKOUT_NOT_OPEN`; one order per checkout. Another guest and no cookie are 404.
- **Confirmed by its own money:** the sweep clears the payment (Dr 1120 **12,000**, Cr 2200 **12,000**). The order is CONFIRMED (`NOT_REQUIRED`), history PLACED → CONFIRMED, the order holds 2.000 with no expiry and its line names the reservation, the checkout's is RELEASED, the checkout is COMPLETED, and the cart is CONVERTED with `checkoutId` **null** (CR-029, through `placeOrder`). One `ord.OrderConfirmed`. Staff read `DEPOSIT_HELD`, paid 12,000, outstanding 0. The trial balance is **0**. A second sweep and a late expiry run change nothing.
- **Cash on delivery:** 2 crates to Dodowa are **13,500** (12,000 and the fee of 1,500), CONFIRMED at once with no payment, the zone, the area and the fee on the order, the stock held by the order, the checkout COMPLETED and the cart CONVERTED.
- **Refusals, nothing placed:** COD on a prepaid checkout (`PAYMENT_METHOD_MISMATCH`), a card (`CARD_NOT_AVAILABLE`), no phone (`PAYER_PHONE_REQUIRED`), no network (`NETWORK_REQUIRED`), a coupon (`PROMOTION_NOT_AVAILABLE`), a price the engine no longer gives (`ORDER_INVALID` `PRICE_CHANGED`) and a lapsed hold (409).
- **Catch weight:** one 15 kg beef pack at 3,213 a kg is **48,195** estimated, the checkout's maximum, weight 15.000 and the tolerance on the line, and a charge of **48,195**.
- **Stopping:**
  - The hold expires before the customer pays: the order is CANCELLED (`PAYMENT_NOT_RECEIVED`), the checkout EXPIRED, the cart ACTIVE, the charge released. The customer then pays: the payment clears with one `UNMATCHED_PAYMENT` break, the order stays CANCELLED with no reservation, no `ord.OrderConfirmed`, trial balance 0.
  - Paid after the charge window but **before the expiry job ran**: cleared with an `UNMATCHED_PAYMENT` break, the order stays PLACED with nothing reserved; the expiry then cancels it.
  - **A smaller payment** (1,000 taken against the order by a cashier) clears and the order stays PLACED, its stock still the checkout's.
  - **A failed charge** cancels the order, releases the checkout's stock and gives the cart back.
  - **A staff cancellation** of a placed online order releases the checkout's stock and the pending charge.
- **The database:** a second ONLINE order from the same checkout is refused (`23505`), and a checkout awaiting payment with no order is refused (`23514`), by direct SQL.
- **trackOrder:** the token answers the number, PLACED, its first step done and the rest not, 6,000 estimated, paid 0, the line's name and quantity, and no key naming a phone, contact, address, cost, floor, ceiling, variance or customer. A tampered token, the order id and `trk_` are 404.
- **A customer's own orders:** the customer lists their order (PLACED, UNPAID, one item, **18,000**) and never the stranger's, who sees only theirs; `getMyOrder` has no cost, floor, ceiling, variance, resolved price, salesperson or rule, a line at 6,000 and 18,000; another customer's order and an unknown id are 404. A staff session and an anonymous caller are 401 on these routes, and the customer session is 401 on `createOrder` and `cancelOrder`.

`test/contract/b9/online-orders.contract.spec.ts` checks `PlaceOrderResult`, `OrderTracking`, `CustomerOrderSummaryPage`, `CustomerOrder` and the `Error` refusals.

**B9a's one-transaction proof stands:** `sale-posting`, `order-payment-rules`, `orders`, `order-reversals`, `order-return` and `price-override` pass.

### Mutation runs (scratch, never committed)

Each rule was broken on its own in scratch (the file restored afterwards) and the new integration spec run. The test data has distinct makers: the guest (Storefront), the cashier who took a smaller payment, the Sales user who entered and cancelled orders, and two customers.

| Mutation | Result |
| --- | --- |
| M1 confirmation ignores `heldAsUnmatched` | red (money after the window, before the expiry ran) |
| M2 the hold-ended handler ignores a hand-over | red (3 tests) |
| M3 getMyOrder without ownership | red |
| M4 the tracking token's MAC not checked | red |
| M5 a promotion not refused | red |
| M6 the engine's price not compared | red |
| M7 SHP completes on a hand-over to any document | **green**: unreachable. Only ORD hands a checkout's hold over, and only to the order placed from it. Kept as defence in depth. |
| M8 a staff cancellation keeps the checkout's hold | red |
| M9 0204 not unique | red |
| M10 0205's check removed | red |
| M11 listMyOrders not filtered by customer | red |
| M12 confirmation ignores the payment check | first green, then red: the smaller-payment test was added for it (its first run failed for the test's own reason, a local phone number the endpoint refuses, fixed in the test before M12 was run again) |
| M13 a failed charge does not cancel | red |

## Test first, as it honestly happened

- **The integration spec** was written before any code of this phase and was red, 11 failing and 7 not reached. Its first run failed in its own setup (a cart quantity written `2`, which the endpoint refuses; fixed in the test). After the code, one test failed on the test's own body (`note: null`, which `cancelOrder` refuses); fixed in the test.
- **The edge tests** (money after the window before the expiry, the price check, the database rules, a customer on staff writes) were added after the code and before the mutation run, which proved them; the price check's first draft failed on the checkout line's write-once trigger, so the test steps past it as the superuser.
- **The domain unit spec** was written with its code, not before it, and was green on its first run at 100 percent.
- **The contract spec** was written after the code.
- **Stale tests updated because this phase made them stale:** the drift counts (417 from code, 218 planned), the request-schema table (`placeOrder`), the 0155 rollback walk (0205 and 0204).
- Nothing was skipped, quarantined or retried, and no test was re-run to turn it green.

## Decisions

- **ADR-0070 (Proposed):** the checkout keeps its hold until the order is confirmed, then hands it over whole; confirmation in the clearing's transaction on the order's own money only; cancellation when the hold ends first or the charge fails; the signed tracking token; guest-only placement. It contradicts no ADR: the four new transactional subscribers are of the kind ADR-0010 permits and never throw for a business reason, and no external call is made inside a transaction (the charge is sent after the commit).
- **The split (A-233, ADR-0026 Amendments):** online placement is one sub-domain; the dashboard with the seed follows in 2g.

## Security review (hakorem-security-review)

- **Boundary:** TB1, the public storefront; TB5 indirectly (a payment's clearing now confirms an order).
- **Standards:** `SECURE_CODING_STANDARDS.md` was run item by item. Identity, sessions, uploads, exports and encryption are not touched.
- **Authorisation:** placement is reached only with the guest cookie that proves the cart (404 otherwise, no enumeration); the customer reads check the realm and ownership in the handler (MDM's `customerOfPrincipalIn`), another customer's order 404; a customer session is refused on staff writes. No permission was added, and none is granted.
- **Money:** an order is confirmed only by a payment cleared through PAY's one clearing path (the provider's own answer), never by the browser; only money that is the order's (not `heldAsUnmatched`) and covers the estimate confirms it; amounts are exact integer pesewas from the engine, compared exactly with the checkout's; the charge is written in the transaction and sent after it (ADR-0010).
- **Input:** zod strict objects; parameterised SQL only; the token is decoded and its MAC checked in constant time.
- **Idempotency:** the key is claimed first and bound to the guest token's hash; a replay sends no second charge; one online order per checkout in the database.
- **Data:** the tracking view shows no name, phone or address; the payer's phone is stored masked by PAY, and the idempotency row holds a hash of the request; the tracking token is in the stored response it replays. Logging adds no personal data.
- **Rate limit:** `checkout` for placement, `public` for tracking, `console` for the customer reads.
- **Abuse paths:** an online order confirmed by money that is not its own is blocked and, for late money, visible as `UNMATCHED_PAYMENT` (the TB1 threat table has the row). Holding stock by placing orders adds nothing to the existing checkout hold, which placement never extends.

## Deferred

To **B09a continued 2g**: the dashboard's six B9a figures and the two tiles (CR-013, deciding how a completed return counts), and the seeded trading day.

To **B11**: the online order's posting through `SalePosting` at dispatch or collection; re-pricing a catch-weight line at the scale; `delivery` in the tracking and customer views; `pendingConsent`.

Not scheduled, named for the parent: **registered checkout** (a customer session on `placeOrder`, saved addresses, FR-SHP-010 in part), **card payment** through the provider's hosted page, and **promotions on an order** (`ord.sales_order_adjustment`).

## Contract requests

I fetched the frontend's `main` at `0efb338`, the same commit 2c to 2e read. It lists CR-001 to CR-033, and nothing is new or changed.
- **CR-029's proof through `placeOrder`: done** (the cart's `checkoutId` is null again once `placeOrder`'s order is confirmed, and after a cash-on-delivery placement).
- **CR-013** (the dashboard's figures): **not built here; it moves to B09a continued 2g.** This is scheduling, not a decline.
- **CR-031, CR-032 and CR-033** stay placed in B9b, with B11 for CR-033's SMS.
- **CR-005, CR-023, CR-027 and CR-028** stay with B09x.
- The others were answered in earlier phases. No request is unplaced larger work.

## Tests (this machine, 2026-11-17)

| Layer | Result |
| --- | --- |
| Unit | **1,452 passed** (new: 6 in `ord/domain/online.spec.ts`) |
| Integration | **1,450 passed** (new: 22 in `ord/online-orders`) |
| Coverage, merged (`pnpm test:coverage`) | **2,902 passed**, 234 files, exit 0. Statements 93.72 percent, branches 83.57 percent (gate 80), functions 97.19, lines 96.35. Every 100 percent gate held, the new `src/modules/ord/domain/online.ts` included |
| Contract | **99 passed** (new: `b9/online-orders.contract.spec.ts`). `contract:generate` is up to date (417 from code, 218 planned); Redocly is clean; the versioning check against `main` passes |
| Lint, typecheck | Clean. Locally, eslint was run with `.claude/**` ignored; the test placement check found 281 specs in place; schema names and lint fixtures pass |
| End to end | CI only |

**A red run, recorded:** the first full local coverage run had two failures, both in `iam/authorisation.integration.spec.ts` (the handler walk and the permission rule): the walk did not yet list the four new routes, nor the two customer-realm reads as the caller's own. Both were stale because of this phase, not flaky; they were fixed before anything was pushed, and the second full run was green. The first contract run had two failures for the same reason (the drift counts and the request-schema table).

## Gate

**Passed for the part built; the phase split (A-233).**
- **Placed from a checkout:** an online order is written from the guest's checkout, priced by the engine at the checkout's figures, one per checkout.
- **Confirmed only on its own money:** in the transaction that clears a payment naming it, never for money held as unmatched or less than the estimate, the checkout's hold passing to it whole and the checkout completing.
- **It stops waiting** when its hold ends first or its charge fails, and the late money is held unmatched.
- **The customer reads only their own orders.**
- **Every new write refuses the wrong caller,** and B9a's one-transaction proof stands (the online order's own posting is B11's, A-232 (h)). The trial balance is 0.
- **The rest of the opener's gate** (the dashboard's figures and the seeded trading day) is B09a continued 2g's.

## Notes for the frontend track

- **Contract 1.51.0:** `placeOrder` is live for a guest checkout. Mobile money answers 201 with `payment` PENDING and words to show; poll `getCheckout` (it becomes `COMPLETED` with the order confirmed) or `trackOrder`. Cash on delivery answers 201 with the checkout `COMPLETED`.
- **If the hold lapses or the charge fails,** the order is cancelled and the cart is `ACTIVE` again: offer to start the checkout again.
- A card, a coupon or a promotion is refused for now (`CARD_NOT_AVAILABLE`, `PROMOTION_NOT_AVAILABLE`).
- `trackOrder` takes the `trackingToken` from `placeOrder`'s answer. `listMyOrders` and `getMyOrder` answer a signed-in customer's own orders; online orders placed as a guest are not yet linked to an account.

## CI

- **`68046ba`** (all code, tests and documents before this report; pull request #78 was opened on it): run **44029159328 (push)**, success; run **44029199411 (pull_request**, which also compares the contract with `main`), success. Nothing was red and nothing was re-run.
- A commit cannot name its own runs, so the push and pull_request runs on the final head (this report's commit) are named in the session's closing message. The pull request is merged with a merge commit only once every run on its head is green.

## Next session

B09a continued 2g, copied from `docs/prompts/session-openers.md`, where this phase inserted it.

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md (the B9a row).
List docs/sessions/ and read only the most recent report (docs/sessions/B09a3f-orders-online.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md), in particular CR-013:
implement what is reasonable, record in the report what you declined and why, never edit that file and never open
frontend source.
For this phase, read FR-RPT-001 of docs/SRS.md (nothing else from the SRS), docs/data-model/ord.md, the ORD and RPT
cards in docs/MODULE_BOUNDARIES.md, ADR-0011, ADR-0023, ADR-0026 and ADR-0067, and A-149, A-208, A-217, A-220,
A-222, A-226, A-228 and A-233 in docs/ASSUMPTIONS.md. Load hakorem-money, hakorem-ledger, hakorem-endpoint,
hakorem-migration, hakorem-seed and hakorem-tests. Use docs/prompts/module-build-prompt.md as the recipe. Do not read
any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B09a continued 2g only, on branch b09a3g-dashboard-seed, branched from main. Each test-first with its
wrong-role refusal: the owner dashboard's B9a figures (A-149, CR-013): remove `salesTodayPesewas`,
`salesYesterdayPesewas`, `salesMonthToDatePesewas`, `salesByChannel`, `salesSeries` and `topMovers` from RPT's
PENDING_FIGURES (src/modules/rpt/) and answer them from completed orders through a published ORD view (ADR-0011,
ADR-0023; RPT never reads ORD's tables): a VOIDED order is not a sale; decide and record how a completed return's
credit note counts; days are Africa/Accra business dates from the application clock. Build the planned tiles
getSalesTodayTile and getSalesSeries on the same figures. Assert exact pesewa figures on the seeded trading day,
with every wrong role refused (`rpt.dashboard.owner`, `rpt.tile.read`). Extend the seed with a trading day of sales
posted through SalePosting (hakorem-seed), its dates from the seed calendar (src/seed/seed-calendar.ts, A-220,
A-222), keeping the B5 hand count, the trial balance at 0 and every existing exact amount in the tests true.
Two rules from B09t (ADR-0067): no new now() or current_date in business SQL, and no new fixed calendar date in the
seed or a test.
If it does not fit, split at a sub-domain boundary after a proven, merged gate.
Stop at the gate, write docs/sessions/B09a3g-dashboard-seed.md, and merge into main when every run on the pull
request is green.
```
