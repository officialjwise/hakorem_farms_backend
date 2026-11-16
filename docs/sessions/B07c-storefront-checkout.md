# B07 continued 2: the storefront catalogue, cart and checkout reservation, delivery slots and the shared sort

Date: 2026-11-15 · Branch `b07c-storefront-checkout`, from `main` (`43127f9`) · Pull request #47 · Status: **gate passed. The phase split (A-179): CR-019's four console lists move to B07 continued 3, before B8.**

Run as a fresh agent inside the 2026-11-15 overnight session: the parent session cannot issue /clear or /compact, so each phase starts in a new context that reads only this handoff from disk.

## Assumptions made this session (in `docs/ASSUMPTIONS.md`, dated 2026-11-15)

| ID | What | Who confirms |
| --- | --- | --- |
| A-177 | **Who the storefront serves and acts as (ADR-0055).**<ul><li>**(a) Guests only:** carts and checkouts are guest carts proved by the `__Host-hk_guest` cookie token. Customer sessions, saved addresses (`SAVED_ADDRESS_NEEDS_ACCOUNT`) and adopting a cart at sign-in wait for B09a, because no customer account is linked to a customer record. The cart operations publish `security: [{}]` without `customerSession` or the optional CSRF header; B09a adds them back (additive).</li><li>**(b) The actor:** guest writes act as the SYSTEM Storefront principal (migration 0115), with no grants.</li><li>**(c) The branch:** the storefront sells from the head office (Dodowa); a zone of another branch is `DELIVERY_UNAVAILABLE`.</li><li>**(d) DEL permissions:** `del.slot.read` and `del.slot.manage` to the Owner and Manager only.</li><li>**(e) Abuse limits:** a fail-closed `checkout` rate-limit group (30 per address per 10 minutes); at most 50 lines a cart and 999 of one item.</li></ul> | Owner |
| A-178 | **How the catalogue, cart and checkout read FR-SHP-001 to FR-SHP-008 where they are silent.**<ul><li>**Listing:** rebuilt by the seed and every minute by `catalogue-refresh`, so at most a minute behind; carts and checkouts price and check stock live. A product with no SEO slug gets one from its name, told apart by its SKU on a collision.</li><li>**Price range:** a banded product is resolved by the engine at each band's floor weight; the range is lowest to highest list price, never floor or ceiling.</li><li>**Availability:** whole sale units of promisable stock (a catch-weight pack at its nominal weight), low at five or fewer (`shp.low_stock_units`). Promisable excludes in transit, a site, a returns hold, a vehicle, a held unit and an expired lot.</li><li>**Quantities:** whole sale units only.</li><li>**Catch weight:** a line reserves packs times the nominal pack weight in kilograms, the estimate it is priced on (FR-SHP-007). The nominal weight is the product's own estimate field (A-157), not a unit conversion; every other sale unit converts through `MasterDataRefs.toBaseIn`.</li><li>**Money:** the maximum line is the estimate plus `half_up(estimate x tolerance)`; a coupon's discount comes off its line; the zone fee is waived only strictly above the threshold; online prices must be tax-inclusive; cash on delivery needs delivery.</li><li>**Coupons:** validated at apply and at checkout, redeemed only at order placement (B09a).</li><li>**Endings:** an expiry ends the checkout `EXPIRED`; a reservation released by hand ends it `CANCELLED`; the cart is active again either way.</li><li>**Seed:** no stock moves and no checkout is seeded, so the B5 and B05x hand counts are unchanged.</li></ul> | Owner; accountant (tax-inclusive only) |
| A-179 | **The split.** The shared sort is built, proved and applied to the catalogue and the slot lists. Applying it to `listProducts`, `listStockOnHand`, `listStockUnits` and `listStockMovements` moves to **B07 continued 3** (`b07c3-console-sort`, report `B07c3-console-sort.md`, from `main`), still before B8, as the owner's instruction allows. B8 reads that report. | Owner |

Phase, scope and gate, as confirmed at the start:
1. **Phase:** B07 continued 2 (`b07c-storefront-checkout`, from `main`).
2. **Scope:** CR-019's shared sort; the public catalogue and product page; the cart with engine prices and coupons; checkout reservation through INV, the catch-weight estimate and maximum, the zone fee; `del.delivery_slot` with generation and a slot stored by checkout; the seed.
3. **Gate:** the shared sort pages without skipping or repeating through ties and concurrent inserts; checkout reserves stock and releases it on timeout; a live animal cannot be added to a cart; the catalogue carries no cost; `del.delivery_slot` exists with generation and checkout stores a slot through its FK; every staff write refuses the wrong role.

## Contract changes

**Version 1.32.0, minor. No field removed, renamed or retyped; nothing a client sends made required.**
- **Counts:** 317 operations from code, 318 planned, 635 published.
- **Moved into code (tag `shp`):** `listCatalogue`, `getCatalogueProduct`, `listShopCategories`, `createCart`, `getCart`, `addCartLine`, `updateCartLine`, `removeCartLine`, `applyCartCoupon`, `removeCartCoupon`, `listDeliverySlotOptions`, `startCheckout`, `getCheckout`, `updateCheckout`. **(Tag `del`):** `listDeliverySlots`, `generateDeliverySlots`, `updateDeliverySlot`.
- **Security on the cart and checkout operations:** `[{}]` only, and the optional CSRF header removed (guests have neither, A-177). No client breaks: a client that sends a cookie or the header is still answered.
- **Sort:** `listCatalogue`'s `sort` keeps its four values and now orders the whole list before paging (ADR-0054); any other value is 400 with detail `SORT_NOT_ALLOWED`.
- **New error codes:** `REQUEST_TO_BUY_ONLY`, `PRODUCT_UNAVAILABLE`, `QUANTITY_INVALID`, `CART_EMPTY`, `COUPON_ALREADY_APPLIED`, `STOCK_UNAVAILABLE`, `DELIVERY_UNAVAILABLE`, `SLOT_UNAVAILABLE`, `CHECKOUT_INVALID`, `SLOT_REQUEST_INVALID`, `CAPACITY_BELOW_BOOKED` (422); `CART_NOT_ACTIVE`, `CHECKOUT_NOT_OPEN` (409).
- **Checks:** changelog entry and cold-read line written; Redocly lint clean, no warnings; `contract:generate` matches the committed file.

## Built

| Area | What |
| --- | --- |
| Platform | `keyset-sort.ts` (ADR-0054): allow-list, id tie-breaker, nulls last, keyset condition, cursor positions. `OperationSpec.publicActor`, bound by IAM's guard on a public route (ADR-0055). The `checkout` rate-limit group. |
| Migrations | **0115:** `del.slot.read`, `del.slot.manage`, the Storefront principal. **0116:** their grants (Owner, Manager). **0117:** document type `CHECKOUT_SESSION`. **0118:** schema `del`, `del.delivery_slot` with `ck_delivery_slot_booked`, `uq_delivery_slot_start`, `ix_delivery_slot_start`. **0119:** schema `shp`: `cart`, `cart_line` (WORK), `checkout_session`, `checkout_line` (DOCUMENT, frozen or write-once), `product_listing` (PROJECTION, written only by `shp.replace_product_listing`), with an index per catalogue sort. |
| MDM | `Storefront`: online products (category chain, images, no cost), categories, deliverable zones and zone refs, the delivery tax category, price lists' tax inclusiveness, band floors, address and phone checks. |
| INV | `StockQueries.promisableIn`: the balances a remote buyer may be promised, oldest first. |
| DEL | `Slots`: generate, list (keyset by start), change capacity, `listOptions` (public), `slotIn` (for checkout). |
| SHP | `CatalogueListing` (rebuild) and `Catalogue` (list, product page, categories); `Carts` (guest token, engine prices, one coupon, request-to-buy refused); `Checkouts` (start with serializable reservation of every line, get, update delivery, and `reservationEndedIn` subscribed in-transaction to `inv.ReservationExpired` and `inv.ReservationReleased`); events `shp.CheckoutStarted`, `shp.CheckoutExpired`, `shp.CheckoutCancelled`. |
| Worker | `catalogue-refresh`, every minute. |
| Seed | `farm-shp.ts`: the Manager generates Dodowa's fortnight of slots (Tue, Thu, Sat; 10:00 and 14:00, 8 each), and the listing is built. |
| Docs | ADR-0054, ADR-0055 and their index lines; A-177 to A-179; changelog; `API.md` (section 5 sorted lists, the shp and del notes, the checkout limit); `shp.md` and `del.md` as built; SHP and DEL cards; `OPERATIONS.md`; THREAT_MODEL R18; ADR-0026 Amendments; the new opener B07 continued 3; B8 now reads its report; B12's opener gains R18's item. |

## Decisions

- **ADR-0054 (proposed):** one server-side sort mechanism for every sorted list.
- **ADR-0055 (proposed):** guest writes act as a Storefront principal and are proved by a cart token.
- **The checkout ends in INV's transaction:** SHP subscribes to the reservation's end in-transaction (ADR-0010's "a module keeping its own aggregate consistent"), not asynchronously as the SHP card had planned; the card is updated.
- **The listing is rebuilt on a schedule,** not by subscription: INV publishes no movement event and a price list in force changes with time.
- **No ADR conflict.** ADR-0047, ADR-0051 and ADR-0052 are untouched. ADR-0019's reservation and ADR-0021's estimate and maximum are applied as written.

## Contract requests

The frontend's `main` was fetched on 2026-11-15 and lists CR-001 to CR-021.
- **CR-019: partly implemented.** The shared mechanism is built and proved; the catalogue (`listCatalogue`) and the slot lists use it. The four console lists it names are scheduled in **B07 continued 3** (A-179), not declined.
- **CR-005:** standing decline, unchanged.
- **The rest** were answered in earlier phases.

## Security review (hakorem-security-review)

Written into pull request #47. `docs/security/SECURE_CODING_STANDARDS.md` was run item by item.
- **Boundaries:** TB1 the public storefront; TB2 the back office (slots); TB8 the database.
- **Input:** strict zod schemas; whole units; limits on lines and quantities.
- **Authorisation:** slot operations deny by default in the handler at the zone's branch; six wrong roles refused. Public routes have no permission; a cart is reached only with its token, 404 otherwise (no enumeration).
- **SQL:** parameterised only; sort fields are expressions written in code.
- **Money:** integer pesewas, one half-up per anchor, engine prices only.
- **Idempotency:** every write, bound to the cart token.
- **Browser:** host-only, httpOnly, Secure, SameSite=Strict cookie; an allowed Origin on every guest write.
- **Rate limits:** checkout fails closed.
- **Data protection:** no personal data in audit rows of guest actions.
- **Stock:** reserved only through INV at serializable isolation.
- **Not applicable:** payments, webhooks, uploads and exports (none here).
- **Abuse paths:** R18 added (checkout hoarding by script); its exception item is in B12's opener.

## Deferred

- **B07 continued 3:** CR-019 on the four console lists.
- **B09a:** customer sessions on the cart operations, adopting a guest cart, saved addresses, order placement and payment, coupon redemption, a late payment after expiry, `order_id`'s foreign key, per-customer and per-cart checkout limits.
- **B11:** slot capacity and booking, cut-offs, abandoned-cart notices, `shp.abandoned_cart_notice`.
- **B12:** R18's exception item.
- **`quoteDelivery`:** unchanged (MDM cannot read DEL's slots); its `slots` stay empty and the shop lists slots with `listDeliverySlotOptions`.

## Tests (this machine, 2026-11-15)

| Layer | Result |
| --- | --- |
| Unit | **1,021 passed** (39 new: `keyset-sort.spec.ts` 11, `del/domain/slots.spec.ts` 9, `shp/domain/pricing-lines.spec.ts` 11, `listing.spec.ts` 6, `checkout-clock.spec.ts` 2). |
| Integration | **962 passed**. New: `platform/keyset-sort` (2), `shp/storefront-checkout` (17), `del/delivery-slots` (10). Updated: `iam/authorisation` (the handler walk lists the 17 operations), `platform/seed` (the new unit). |
| Coverage, merged | 1,983 passed. Statements 93.38, branches 82.87 percent (gate 80). Every 100 percent gate holds, including the two added this phase: `src/modules/shp/domain/**` and `src/platform/http/keyset-sort.ts`. |
| Contract | **75 passed**. New: `b7/storefront` (2: the catalogue, product page, categories, cart, checkout and slot lists against their schemas). Updated: the drift counts (317 and 318) and the request schemas of the seven new request bodies. |
| Lint, typecheck, Redocly, `contract:generate` | Clean |
| End to end | CI only |

**Test first, honestly:**
- `shp/domain/pricing-lines.spec.ts` (the money of a line, the fee, the totals and the reservation spread) was written before `pricing-lines.ts` and seen red (`Cannot find module`).
- The sort's unit and integration specs were written with the mechanism; the integration test was then made to fail on purpose by dropping the tie-breaker (rows skipped: "expected 5 to be 13"), and restored.
- With SHP's subscription to `inv.ReservationExpired` disabled, the expiry test went red (the checkout stayed `STARTED`), and was restored.
- `listing.spec.ts`, `slots.spec.ts` and `checkout-clock.spec.ts` were written alongside their code, not before.
- **Failures before green, each fixed in the code:** updates without the version bump `platform.touch_version` requires (carts, checkouts, slots); the error envelope read wrongly in the new test (`body.error.code`); the seed unit counting its records again on a second run (its own commit).
- **Flaky tests:** none seen. Nothing skipped or loosened.

## Gate

**Passed.** Proved over the real API on the seeded farm (`test/integration/shp/storefront-checkout.integration.spec.ts`, `test/integration/del/delivery-slots.integration.spec.ts`, `test/integration/platform/keyset-sort.integration.spec.ts`):
- **The shared sort:** a probe table with long runs of tied and null prices is walked two rows a page, ascending and descending, while three rows arrive between each of the first pages. Every original row is seen exactly once, in order, and no row twice. The catalogue walked two at a time by `PRICE_ASC` equals the one-page list, unpriced items last. `sort=COST_ASC` is 400 `SORT_NOT_ALLOWED`; a cursor from another sort is 400.
- **The catalogue carries no cost:** no key matching cost, floor, ceiling, on hand, quantity or reserved in the listing or a product page. Big eggs 6,000 `IN_STOCK`; beef 3,213 a kg `LOW_STOCK` (45 kg is 3 packs); small eggs `OUT_OF_STOCK`; the goat `ON_REQUEST` from 25,000 to 170,000; offal (HIDDEN) absent. "goat" finds the goat and goat meat only.
- **A live animal cannot be added:** the goat is 422 `REQUEST_TO_BUY_ONLY`; 1.500 crates is `QUANTITY_INVALID`.
- **The cart:** 2 crates 12,000; 2 beef packs at 30.000 kg 96,390; subtotal 108,390. Another guest's token, or none, is 404; a forged Origin is 403. One coupon: `WELCOME10` applies; `XMAS2026` is `COUPON_ALREADY_APPLIED`.
- **Checkout reserves stock:** the cart starts at 107,190 (eggs less 1,200, no fee above 50,000), at most 116,829, held exactly 15 minutes; INV holds 2.000 crates and 30.000 kg ACTIVE for it. A cart whose second line cannot be covered starts nothing (yam stays unreserved). Two buyers of the last 28 crates at once: exactly one 201, one 422 `STOCK_UNAVAILABLE`, 30.000 reserved in all.
- **The zone fee:** a 4,000 cart to Dodowa totals 5,500; Kumasi is `DELIVERY_UNAVAILABLE`; collection totals 4,000; cash on delivery with collection is `CHECKOUT_INVALID`.
- **The slot:** an unknown slot is `SLOT_UNAVAILABLE`; the chosen slot is stored in `shp.checkout_session.delivery_slot_id` (its FK to `del.delivery_slot`); `updateCheckout` moves it.
- **Released on timeout:** 15 minutes and 1 second later the expiry job ends both reservations `EXPIRED` with exactly 2.000 and 30.000; the balances' reserved quantities fall by exactly that; the checkout is `EXPIRED`, its cart `ACTIVE`, one `shp.CheckoutExpired` in the outbox; a second run releases nothing; the eggs check out again.
- **In the database:** a checkout line cannot change (HK004); an ended checkout is frozen (HK004); a maximum below the estimate is `ck_checkout_session_totals`; `hk_app` cannot write the listing (42501); a capacity below bookings is `ck_delivery_slot_booked`; a slot cannot be deleted (42501).
- **Slots:** the seeded fortnight is 12 slots (two each of Tuesday, Thursday and Saturday, two runs of 8); the next fortnight generates 12, a replay answers the same, a second generation skips 12; past, overlapping and unknown-zone requests are refused; capacity cannot go below 4 booked.
- **Every staff write refuses the wrong role:** the Accountant, Storekeeper, Cashier, Sales, Farm hand and Driver are refused list, generate and update (403); a user with no grant is refused in the handler walk.

## Notes for the frontend track

- **Guest cart:** call `createCart` once, with credentials, and keep the `__Host-hk_guest` cookie (the browser does). Send `Idempotency-Key` on every write and no CSRF header. A 404 on a cart means "start a new cart".
- **Adding:** whole numbers only. On 422 `REQUEST_TO_BUY_ONLY` show "Request a quote". Show `estimatedLineTotalPesewas` and `estimatedSubtotalPesewas`; never sum rows.
- **Checkout:** show `estimatedTotalPesewas`, `maximumTotalPesewas`, `taxPesewas` and `finalChargeRule`, and count down to `reservedUntil`. On 422 `STOCK_UNAVAILABLE`, its `details[].field` is `/lines/{cartLineId}`. On `DELIVERY_UNAVAILABLE`, offer collection. After expiry the checkout is `EXPIRED` and the cart can check out again.
- **Slots:** from `listDeliverySlotOptions?zoneId=`; `quoteDelivery` still answers `slots: []`.
- **Catalogue sort:** `listCatalogue`'s `sort` now orders the whole list; the "this page only" label can go for the catalogue. The console lists follow in B07 continued 3.

## CI

CI ran on `a6551b4`, the pushed head before this report (pull request #47):
- run 43794975233, `push`, success;
- run 43795010856, `pull_request`, success.

A commit cannot name its own runs, so the runs on the final head (this report's commit) and `main`'s `push` run on the merge commit are listed in the session's closing message. The pull request is merged with a merge commit only once every run on its head is green.

## Next session

B07 continued 3, copied from `docs/prompts/session-openers.md` (inserted by this phase's split).

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B07c-storefront-checkout.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md): implement what is
reasonable, record in the report what you declined and why, never edit that file and never open frontend source.
For this phase, read CR-019 in that file, ADR-0054, docs/API.md section 5 and the as-built notes of
docs/data-model/mdm.md and inv.md for the four lists' tables (nothing else from the SRS). Use
docs/prompts/module-build-prompt.md as the recipe. Load hakorem-endpoint, hakorem-migration and hakorem-tests.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B07 continued 3 only, on branch b07c3-console-sort, branched from main: apply the shared sort of
src/platform/http/keyset-sort.ts (ADR-0054, built and proved in B07 continued 2) to the console lists of products,
stock on hand, lots and movements, with CR-019's fields (listProducts: name, sku, category, status, updatedAt;
listStockOnHand: product name, location name, onHandQty, valueAtCostPesewas; listStockUnits: product name,
identifier, expiresOn, valueAtCostPesewas; listStockMovements: occurredAt, product name, valuePesewas), `sort` and
`direction` query parameters, an index per allowed field in each module's own migration (a field whose value is
computed, such as a value at cost or another module's name, is sorted only if it can be indexed honestly in the
owning schema: otherwise decline that field in the report with the reason), and each list's default order unchanged
and shown in its example. A cost field stays readable only with its cost permission (ADR-0052): sorting by it is
refused to a role that cannot read it. Write a test per list that pages through ties and concurrent inserts.
Stop at the gate, write docs/sessions/B07c3-console-sort.md, and merge into main when every run on the pull
request is green.
```
