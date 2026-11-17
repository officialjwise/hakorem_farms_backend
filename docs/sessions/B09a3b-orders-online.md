# B09a continued 2b: the order record's endpoints, split before the reversals

Date: 2026-11-17 · Branch `b09a3b-orders-online`, from `main` (`dad1d7e`) · Status: **gate passed for the part built; the phase split (A-225)** after the order record's endpoints. The remainder is **B09a continued 2c** (`b09a3c-orders-reversals`), inserted in `docs/prompts/session-openers.md` after this phase and before B09x.

Run as a fresh agent inside the 2026-11-15 overnight session: the parent session cannot issue /clear or /compact, so each phase starts in a new context that reads only this handoff from disk.

## Assumptions made this session (in `docs/ASSUMPTIONS.md`, dated 2026-11-17)

| ID | What | Who confirms |
| --- | --- | --- |
| A-224 | **The order record's endpoints as built**, each the most conservative reading. (a) `ord.order.read` for the Owner, Manager, Accountant, Sales and Cashier; `ord.order.create` and `ord.order.confirm` for the Owner, Manager and Sales; the Cashier sells through the till (B9b), never by entering an order. Reads cover the branches held whole. (b) An order is entered at the one branch where the caller enters orders (`BRANCH_REQUIRED` otherwise), PLACED and numbered, tax-inclusive, every line priced by the engine now; nothing reserved or charged. `DELIVERY` (B11), a line priced per kilogram (catch weight, B11) and a coupon (no adjustments table yet) are refused, so the estimate equals the maximum. Nothing below list without an approval, as the sale posting (A-208 (c)); above list within the ceiling with a reason. One line per product, or per named animal or lot. (c) Confirmation: cash on delivery needs no check; prepaid needs its estimate in cleared payments; credit is refused while no `OrderConfirmationPolicy` answers (WHL, B10); then every line is reserved for the order, oldest stock first, or none, with each shortfall named. (d) Before the billing document, outstanding is the estimate less what was received. (e) `ord.OrderPlaced` and `ord.OrderConfirmed` through the outbox. | Owner (a, b, c), Accountant (d) |
| A-225 | **B09a continued 2b split after the order record's endpoints.** Cancellation, voids, returns with their trigger, price override approvals, `issueProforma`, online placement and payment, the dashboard's sales figures and tiles, the seeded trading day and CR-029 through `placeOrder` move unchanged to B09a continued 2c (`b09a3c-orders-reversals`), which may split again at a sub-domain boundary. | Owner |

Still open, proceeded on as stated: A-033, A-034, A-062, A-182 to A-207, A-209, A-211, A-213, A-214, A-216 to A-225.

Phase, scope and gate, as confirmed at the start:
1. **Phase:** B09a continued 2b (`b09a3b-orders-online`, from `main` at `dad1d7e`).
2. **Scope:** the opener's whole list: ORD's permissions, the order endpoints with confirmation, cancellation and voids, returns, price override approvals, the proforma, online placement, the dashboard's sales figures, the seeded trading day and CR-029 through `placeOrder`. It could not reach its gate in one context, so the session split at the first sub-domain boundary (the order record: read, enter, confirm) once that part was proved (A-225).
3. **Gate:** as the opener states it; the gate below is the one for the part built.

## Contract changes

**1.47.0, minor; no existing shape changed, nothing a client sends made required.** Five planned ORD operations move into code with their descriptions made exact: `listOrders`, `createOrder`, `getOrder`, `confirmOrder`, `listOrderHistory`. One error code is added, `ORDER_INVALID`. The examples of `createOrder` and `confirmOrder` now show an order this build accepts (a cash-on-delivery collection of 4 crates of big eggs at 6,000 and 10 heads of cabbage at 1,500), because the old example (credit, delivery, meat by the kilogram) is refused until B10 and B11. 407 operations from code, 228 planned. `contract:generate` is up to date, the versioning check against `main` passes, and Redocly is clean, with no warnings. `docs/CONTRACT_CHANGELOG.md` and `docs/API.md` (ORD, and the error catalogue) record it.

## Built

| Area | What |
| --- | --- |
| IAM | Migrations 0188 (the three permissions, granted to no role) and 0189 (the grants above), each with a tested rollback. |
| ORD domain | `domain/confirmation.ts`: `planLineReservation` (a line held from the balances it may be promised, oldest first, spread over several if it must, or the shortfall), `receivedForOrder` (cleared payments less refunds), `judgeConfirmation` (the payment or credit check). It is now a 100 percent coverage gate. `domain/paging.ts`: the page probe and the history window. |
| ORD application | `Orders` (`application/orders.ts`): `get`, `list`, `history`, `create`, `confirm`, each authorising in the handler at the order's branch, every write idempotent, audited with before and after values, and publishing through the outbox. The view names customers, products and units through MDM and INV, the salesperson through IAM's `PrincipalNames`, the receipt through the document registry and BIL. `OrderConfirmationPolicy` port with the `ORDER_CONFIRMATION_POLICIES` registry (empty until WHL). `OrderInvalidError` (`ORDER_INVALID`) and `OrderStockShortError` (`STOCK_UNAVAILABLE`, one `NOT_ENOUGH_STOCK` detail per short line, with the shortfall in its message). |
| ORD infrastructure and interface | `PgOrderStore`: `lock`, `confirm` (with the version), `holdLine`, `list` (keyset on id), and the read-only columns the view needs. `OrdersController` with zod schemas; the five fragments under `interface/openapi/`. |
| Lower modules (additive) | INV `StockExceptions.refsIn`; BIL `Billing.viewsIn`. Both read in the caller's transaction and authorise nothing. |
| Docs | A-224, A-225; ADR-0026 Amendments; the openers (2b marked split, 2c inserted, B09x reads 2c's report); API.md; the changelog; the ORD card in MODULE_BOUNDARIES; `docs/data-model/ord.md`; the SRS traceability rows for FR-ORD-001, 002 and 005. |

## The gate, proved by running it

`test/integration/ord/orders.integration.spec.ts` (17 tests, against the seeded farm, the local Paystack fake and real Postgres):
- **Every order operation refuses the wrong role and the wrong branch (ADR-0035).**
  - The Storekeeper and the Investor are refused all five operations (403).
  - The Cashier reads but is refused `createOrder` and `confirmOrder`, and nothing is reserved.
  - A salesperson granted at another branch is refused the order, its history and its confirmation, and lists nothing.
  - A salesperson granted only at a location gets `BRANCH_REQUIRED`.
  - An unknown order is 404.
- **An order is entered PLACED, priced to the pesewa, with nothing reserved.**
  - 4 crates at 6,000 plus 3 heads of cabbage agreed at 1,100 against a list of 1,000 (band 800 to 1,200) total 24,000 + 3,300 = **27,300**. The second line's variance is **300 ABOVE**, reason `REGULAR_CUSTOMER`. The estimate and the maximum are 27,300, and so is what is outstanding.
  - There is one `ord.OrderPlaced` with the exact payload, one `CREATE` audit event, and the history shows PLACED once with its actor.
  - A replay with the same key answers the same order. The same key with another body is 409, and only one row is written.
- **Prices outside the rule are refused, and nothing is written.** 999 (below list) and 1,201 (above the ceiling) are `PRICE_OVERRIDE_NEEDS_APPROVAL` on `/lines/0/agreedUnitPricePesewas`. 1,100 with no reason is `VARIANCE_REASON_REQUIRED`.
- **Every broken rule is named at once:** `FULFILMENT_NOT_AVAILABLE`, `COUPON_NOT_AVAILABLE`, `CUSTOMER_NOT_ACTIVE`, then `PRODUCT_REPEATED`, `ONE_ANIMAL_PER_LINE` and `STOCK_UNIT_REQUIRED`, and beef by the kilogram is `CATCH_WEIGHT_NOT_AVAILABLE`. A goat line names its tag G-0143, quantity one, `PER_HEAD`.
- **FR-ORD-005's acceptance, exactly.**
  - An order for 26 heads of cabbage with 25 available is 422 `STOCK_UNAVAILABLE`, `/lines/1`, "Not enough stock for this line: 1.000 short of 26.000.". It stays PLACED with no reservation.
  - After one more head is received, the same order confirms and holds **26.000**.
- **Confirmation holds every line once.**
  - 4 crates are reserved for the order from the egg lot. The line names its one reservation, the order is CONFIRMED with `creditCheck` `NOT_REQUIRED` and its version moves up by one.
  - The history shows PLACED then CONFIRMED with each actor, and there is one `ord.OrderConfirmed` naming the reservation.
  - A replay reserves nothing more. A second confirmation is `INVALID_STATE_TRANSITION` with code `CONFIRMED`.
- **The last 26 crates are confirmed once under concurrency.** Two salespeople confirm two orders for the last 26 crates at the same moment. The answers are one 200 and one 422 ("26.000 short of 26.000"), and exactly one reservation of 26.000 exists.
- **A prepaid order waits for its whole estimate.**
  - A prepaid order of 2,000 is refused with `PREPAYMENT_SHORT` when unpaid.
  - It is refused again after a cleared mobile money payment of 1,999 (webhook and lookup through the fake). The order then shows paid 1,999, outstanding **1**, `DEPOSIT_HELD`.
  - After 1 more pesewa clears it confirms: paid 2,000, outstanding 0.
- **A credit order is refused while no policy answers** (`CREDIT_CHECK_UNAVAILABLE`), stays PLACED, and nothing is reserved.
- **One list across channels.**
  - A sale posted through `SalePosting.postIn` (2 yams, 4,000 cash) reads as a COMPLETED order with its `RCP-` receipt, PAID, paid equal to its final total, outstanding 0. Its history is PLACED then COMPLETED.
  - The list is newest first and filters by status, channel and order number. Its cursor pages exactly (limit 2, then the next 2).
  - The trial balance is still **0**: entering and confirming orders posts nothing.
- **B9a's one-transaction proof stands:** `sale-posting.integration.spec.ts` and `order-payment-rules.integration.spec.ts` pass unchanged (50 ORD integration tests in all).

Contract: `test/contract/b9/orders.contract.spec.ts` checks an entered, confirmed, read and listed order and its history against `SalesOrder`, `SalesOrderPage` and `OrderStatusChangePage`. It also checks every refusal against `Error`: `ORDER_INVALID`, `PRICE_OVERRIDE_NEEDS_APPROVAL`, `INVALID_STATE_TRANSITION`, 403, 404, 400 and `STOCK_UNAVAILABLE`.

Unit: `src/modules/ord/domain/confirmation.spec.ts` (12 tests) and `paging.spec.ts` (2 tests). These cover the thousandth-exact shortfall (2.999 of 3.000 leaves 0.001), an empty balance skipped, and the prepaid boundary (84,000 confirms, 83,999 does not). The file is at 100 percent statements, branches, functions and lines.

## Test first, as it honestly happened

- **The domain:** the unit spec was written first and failed red, because the module did not exist. After that it passed. The zero-balance case was added to reach 100 percent branches.
- **The integration spec** was written before it was ever run against the code. Its first runs were red for real defects, each fixed in the code and never in the test:
  - the Manager's sign-in needs TOTP (a test setup fix);
  - `delivery_id` does not exist yet (B11's expand), so it was taken out of the read;
  - the engine refuses a `stockUnitId` it cannot see, so the unit is no longer passed to pricing (the sale posting never did);
  - the order line has no `updated_at`;
  - the version must move on confirm (`touch_version`).
  - After those fixes all 17 tests passed.
- **The contract spec** passed on its first run.
- Nothing was skipped, loosened, retried or quarantined. No test was re-run to turn it green.

## Decisions

- No new ADR. The port `OrderConfirmationPolicy` is the one MODULE_BOUNDARIES section 6 already names. Its empty registry refusing credit is A-224. No ADR is contradicted.
- `SalePosting` is unchanged. `Orders` prices lines by the same rules (engine, `judgeAgreedPrice` with nothing allowed below list, the `PRICE_OVERRIDE` reason). B09a continued 2c turns the refusal into an approval in both places.
- A line spread across several balances is held by the order (`holder_document_id`). `reservation_id` names the reservation only when exactly one holds the line, so each line is found by its product, which `PRODUCT_REPEATED` keeps unique.

## Security review (hakorem-security-review)

- **Boundary:** TB2, the authenticated back office.
- **Standards:** run against `SECURE_CODING_STANDARDS.md`. Identity, sessions, uploads, exports, webhooks and encryption are not touched (no change in those paths).
- **Authorisation:**
  - Every handler authorises in `Orders`, first without a scope and then at the order's branch. Every route declares its permission.
  - The new permissions were seeded to no role (0188) and granted in their own migration (0189).
  - Deny by default is proved for five roles and another branch.
- **Input:** zod strict objects (unknown fields refused, 400 proved), parameterised SQL only, and `q` bound as a parameter.
- **Money:** integer pesewas through `Money` and `extendPrice`, with no number arithmetic (the lint rule held). Prepayment is read only from cleared payments, never from the client.
- **Idempotency:** both writes take the key as their first write; replay and reuse are proved.
- **Audit:** before and after values on both writes.
- **Logging:** no new log of personal data.
- **Rate limit:** the `console` group.
- **Abuse paths:**
  - No money or stock moves when an order is entered.
  - Confirmation reserves stock, so a salesperson could hold stock with orders that are never fulfilled. Every reservation names its order and actor. A manager already lists and releases reservations by hand with a reason (INV, B05 continued 3b), and cancellation arrives in 2c. No new exception kind is needed yet. This is a residual note for 2c's review, not a blocker.
  - The override abuse case (3) stays blocked outright, because a price below list is refused.

## Deferred

All of these go to B09a continued 2c, with its opener carrying them unchanged:
- `cancelOrder` and `voidOrder`, the latter with `SALE_VOID` on the exception report;
- returns with the trigger, proved under concurrency;
- role limits and the approval of a price below list;
- `issueProforma`;
- `placeOrder`, `trackOrder`, `listMyOrders` and `getMyOrder`;
- the dashboard's six B9a figures, `getSalesTodayTile` and `getSalesSeries`;
- the seeded trading day;
- CR-029 through `placeOrder`.

## Contract requests

I fetched the frontend's `main` at `0efb338`. It lists CR-001 to CR-033. Since `382a820` (the last read) two requests changed: CR-032 and CR-033 each gained the exact shape F10 builds against. No request is new.
- **CR-013** (the owner dashboard's figures): **not built here; it moves to B09a continued 2c** with the dashboard's sales figures. This is scheduling, not a decline.
- **CR-033** (the public digital receipt, the offline link, the SMS once on sync) and **CR-032** (the till PIN verifiers): stay placed in B9b, with B11 for CR-033's SMS, as already scheduled. Their new exact shapes are B9b's to answer.
- **CR-031** stays with B9b. CR-005, CR-023, CR-027 and CR-028 stay with B09x. CR-029 was built in 1.46.0, and its proof through `placeOrder` is 2c's. The others were answered in earlier phases.
- No request is larger work that is unplaced.

## Tests (this machine, 2026-11-17)

| Layer | Result |
| --- | --- |
| Unit | **1,416 passed** (new: 14 in `src/modules/ord/domain/`) |
| Integration | **1,389 passed**, ORD's 50 among them (new: 17 in `orders.integration.spec.ts`; the handler walk in `iam/authorisation` lists the five routes) |
| Coverage, merged (`pnpm test:coverage`) | **2,805 passed**, 226 files, exit 0, on `479aba6`. Statements 93.6 percent, branches 83.34 percent (gate 80), functions 97.11, lines 96.22. Every 100 percent gate held, the new `src/modules/ord/domain/confirmation.ts` included. The first full run, before the handler walk was updated, failed its 2 handler-walk tests (stale lists, fixed in `479aba6`) |
| Contract | **96 passed**, 37 files (new: `b9/orders.contract.spec.ts`). `contract:generate` is up to date (407 from code, 228 planned); versioning against `main` passes; Redocly is clean, with no warnings |
| Lint, typecheck | Clean. Locally, eslint was run with `.claude/**` ignored; the test placement check found all 271 specs in place |
| End to end | CI only |

## Gate

**Passed for the part built; the phase split (A-225).**
- Every ORD read and write built so far refuses the wrong role and another branch.
- An order is entered PLACED, priced by the engine to the pesewa, with nothing reserved.
- A confirmation runs the payment or credit check, then reserves every line or keeps the order PLACED naming each shortfall (FR-ORD-005's acceptance, exactly). The last stock is confirmed once under concurrency.
- A sale posted through `SalePosting.postIn` reads as one order among the others, and B9a's one-transaction proof stands.
- The trial balance stays at 0.
- The rest of the opener's gate (cancellation, voids, returns, override approval, online placement and the dashboard) is B09a continued 2c's.

## Notes for the frontend track

- **Contract 1.47.0:** `createOrder`, `getOrder`, `listOrders`, `listOrderHistory` and `confirmOrder` are live.
- **What `createOrder` refuses for now:** `DELIVERY`, a line priced per kilogram and a coupon (`ORDER_INVALID`, A-224).
- **What `confirmOrder` refuses for now:** a credit order (`CREDIT_CHECK_UNAVAILABLE`, until B10).
- **A short confirmation is 422 `STOCK_UNAVAILABLE`.** Each detail names `/lines/<lineNo>`, and its message says how much is short.

## CI

- **`479aba6`** (all code, tests and documents before this report; pull request #74 was opened on it): run **43997956514 (push)**, failure, and run **43997996220 (pull_request)**, failure. Only the contract job failed, on two stale tests that the local contract run also showed: `api/openapi-drift` still counted 233 planned operations (now 228), and `b3/slice-and-login` had no request schema for `createOrder`'s example. Neither is flaky; both were stale after the operations moved into code, and were fixed in `69ff626` (the local contract suite then passed, 96 of 96). Nothing was re-run.
- A commit cannot name its own runs, so the push and pull_request runs on the final head (this report's commit) are named in the session's closing message. The pull request is merged with a merge commit only once every run on its head is green.

## Next session

B09a continued 2c, copied from `docs/prompts/session-openers.md`, where this phase inserted it.

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md (the B9a row).
List docs/sessions/ and read only the most recent report (docs/sessions/B09a3b-orders-online.md), and also
docs/sessions/B09a3-orders-online.md, the handoff of the orders work this phase continues.
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md): implement what is
reasonable, record in the report what you declined and why, never edit that file and never open frontend source.
For this phase, read the ORD (core) requirement block of docs/SRS.md and FR-RPT-001 (nothing else from the SRS),
docs/data-model/ord.md, the ORD, PAY, BIL and RPT cards in docs/MODULE_BOUNDARIES.md, DOMAIN_MODEL section 7,
ADR-0010, ADR-0021 and ADR-0026, the abuse cases 1, 3 and 12 in docs/security/THREAT_MODEL.md, and A-149, A-200,
A-201, A-208, A-209, A-210, A-211, A-212, A-213, A-216, A-218, A-224 and A-225 in docs/ASSUMPTIONS.md, ADR-0063,
ADR-0064 and ADR-0066 (a void's refund is a reversal or a refund to store credit; returns use the refund against a
credit note, built in B09a continued 1d), and ADR-0067 with A-217 (a rule's "now" is the application clock's). Load
hakorem-pricing, hakorem-money, hakorem-stock, hakorem-ledger, hakorem-documents, hakorem-security-review,
hakorem-endpoint, hakorem-migration and hakorem-tests. Use docs/prompts/module-build-prompt.md as the recipe.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B09a continued 2c only, on branch b09a3c-orders-reversals, branched from main. B09a continued 2b built
ORD's read, create and confirm permissions (0188, 0189) and getOrder, listOrders, listOrderHistory, createOrder and
confirmOrder in `Orders` (src/modules/ord/application/orders.ts), with the `OrderConfirmationPolicy` port; build on
them: the permissions and grants of what follows; cancelOrder (releasing the order's reservations, held by the order
as `holder_document_id`, and requesting the refund of anything paid, in one transaction) and voidOrder (a supervisor
who is not the cashier, a credit note and reversing entries, every void on the exception report), each test-first
with its wrong-role refusal; returns against the original sale (createReturn, getReturn, submitReturn, never more
than sold less returned, by database trigger, proved under concurrency); price variance and override limits per role
with approval by a different user (PRICE_OVERRIDE_NEEDS_APPROVAL becomes an approval request, on createOrder and on
the sale posting alike; the database already requires the approval once an order is past PLACED); issueProforma
(POST /orders/{id}/proforma) on Billing.issueIn (A-201); online order placement and payment (placeOrder, trackOrder,
listMyOrders, getMyOrder) on B09a continued's provider port (cancelOrder releases the order's pending charges through
ProviderPayments.releaseChargeIn, an order confirms on pay.PaymentCleared only when it is not heldAsUnmatched, and
the webhook for a cancelled order is proved again through cancelOrder, A-210); and the owner dashboard's B9a figures
(A-149): remove `salesTodayPesewas`, `salesYesterdayPesewas`, `salesMonthToDatePesewas`, `salesByChannel`,
`salesSeries` and `topMovers` from RPT's PENDING_FIGURES and answer them from completed orders through a published
view, and build the planned tiles getSalesTodayTile and getSalesSeries, each test-first with its wrong-role refusal.
Extend the seed with a trading day of sales posted through SalePosting, keeping the B5 hand count and the trial
balance tests true. CR-029 was built in B09a continued 2 (`Cart.checkoutId`, contract 1.46.0): when placeOrder
completes a checkout, prove through placeOrder itself that the cart's checkoutId is null again. The integration tests
run against the local Paystack fake, which answers as Paystack's test mode did (A-218): its MTN test number pays at
once, a payer email on `.example` is refused, and a refund's idempotency key is honoured only through the adapter's
note lookup.
Two rules from B09t (ADR-0067): no new now() or current_date in business SQL (due dates, expiries, holds, business
days and as-of times take the application clock, as a parameter or platform.app_now()); and no new fixed calendar
date in the seed or a test (build dates from the seed's or the test's clock); the seeded trading day this phase adds
takes its dates from the seed calendar (src/seed/seed-calendar.ts, A-220, A-222).
If it does not fit, split at a sub-domain boundary after a proven, merged gate.
Stop at the gate, write docs/sessions/B09a3c-orders-reversals.md, and merge into main when every run on the pull
request is green.
```
