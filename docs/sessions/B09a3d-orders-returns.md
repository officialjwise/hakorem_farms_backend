# B09a continued 2d: returns against the sale, split before price override approvals

Date: 2026-11-17 · Branch `b09a3d-orders-returns`, from `main` (`a89ce7e`) · Pull request #76 · Status: **gate passed for the part built; the phase split (A-229)** after returns. The remainder is **B09a continued 2e** (`b09a3e-orders-online`), inserted in `docs/prompts/session-openers.md` after this phase and before B09x.

Run as a fresh agent inside the 2026-11-15 overnight session: the parent session cannot issue /clear or /compact, so each phase starts in a new context that reads only this handoff from disk.

## Assumptions made this session (in `docs/ASSUMPTIONS.md`, dated 2026-11-17)

| ID | What | Who confirms |
| --- | --- | --- |
| A-228 | **Returns against the sale as built**, each the most conservative reading. (a) `ord.return.create` for the Owner, the Manager, Sales and the Cashier (FR-ORD-015's actors and the supervisors); `ord.return.read` adds the Accountant; `ord.return.approve` (step-up) for the Owner and the Manager; `RETURN` at threshold 0, because a credit note is money (A-200 (c)). (b) Only a `COMPLETED` sale. Kind `RETURN` only (an exchange waits for B9b). A named animal comes back whole. A per-kilogram line is refused until B11's catch weight. A `RETURN` reason. `RETURNS_HOLD` only where the branch has that location. (c) Only the maker submits; the approver is never the maker; a rejection gives the quantities back. (d) On approval, in one transaction: the credit note (the maker's, under the approval); the stock back at its share of the issue's value, unless the line is `WRITE_OFF` (no stock moves and the cost stays in cost of sales); and, when the sale then owes money back, a refund of at most the credit note's amount, against it, asked as the maker, from the cleared payment that paid the most (`ORDER_RETURNED`). A refund split across tenders is B9b's. (e) `ord.ReturnSubmitted` and `ord.ReturnCompleted` carry abuse case 12. No new error code. | Owner (a, c, d), Accountant (d) |
| A-229 | **B09a continued 2d split after returns.** Price override limits and their approval, `issueProforma`, online placement and payment with CR-029 through `placeOrder`, the dashboard's six B9a figures and two tiles (CR-013) and the seeded trading day move unchanged to **B09a continued 2e** (`b09a3e-orders-online`), which may split again. | Owner |

Still open, proceeded on as stated: A-033, A-034, A-062, A-182 to A-207, A-209, A-211, A-213, A-214, A-216 to A-229.

Phase, scope and gate, as confirmed at the start:
1. **Phase:** B09a continued 2d (`b09a3d-orders-returns`, from `main` at `a89ce7e`).
2. **Scope:** first the void's test-first gap that 2c left (a mutation check of each rule, tests for any left green); then the opener's list: returns, price override approvals, the proforma, online placement, the dashboard's sales figures, the seed and CR-029 through `placeOrder`. The whole list could not reach its gate in one context, so the session built the first sub-domain the opener names, returns, proved it, and split (A-229).
3. **Gate:** as the opener states it; the gate below is the one for the part built.

## Contract changes

**1.49.0, minor; no existing shape changed, nothing a client sends made required.** Three planned ORD operations move into code with their descriptions made exact: `createReturn`, `getReturn` and `submitReturn`. `submitReturn` always answers 202 `ApprovalPending` under the new approval kind `RETURN`; its planned 200 response is kept, unused, and its 202 example now names an `ORDER_RETURN` subject. No error code is added. There are 412 operations from code and 223 planned. `contract:generate` is up to date and Redocly is clean, with no warnings. `docs/CONTRACT_CHANGELOG.md` and `docs/API.md` (ORD) record it.

## The void's test-first gap (done first)

B09a continued 2c wrote its void integration spec after the code. Each rule was broken on its own in scratch (`git checkout` restored it; nothing committed), then `ord/domain/reversal.spec.ts` and the void tests of `order-reversals.integration.spec.ts` were run.

| Mutation | Before the new tests | After |
| --- | --- | --- |
| M1 application: the approver may be the sale's poster (`postedBy` ignored) | **green** | red |
| M2 application: the approver may be the salesperson (`salespersonId` null) | **green** | red |
| M3 application: `judgeVoidApprover` not called | red | red |
| M4 database: `ck_sales_order_void_checker` without its poster half | **green** | red |
| M5 database: `ck_sales_order_void_checker` without its salesperson half | **green** | red |
| M6 database: `ck_order_void_decided` without "never its maker" | **green** | red |
| M7 IAM: the maker may decide (`decideApproval`) | red (IAM unit) | red (unit and the new ORD test) |
| M8 domain: the void allowed after the sale's day | red | red |
| M9 application: the day not judged again at approval | red | red |
| M10 application: the tenders not passed to `judgeVoid` | **green** | red |
| M11 domain: every tender kind voidable | red (unit) | red (unit) |

Why five were green: every sale built so far is posted by its own salesperson, so each half of the approver rule hid the other, in the application and in the database alike. No test had a supervisor approve a void they had asked for. And no sale had a tender other than cash. Three tests close them, in their own commit (`4eb916e`, `test(ord): …`):
- a supervisor who asked is refused in IAM (422 `MAKER_CANNOT_CHECK`) and by SQL (`ck_order_void_decided`);
- a sale credited to a salesperson other than its poster (written by the admin connection, as B9b's counter and B10's quotes will make them) refuses the salesperson and the poster each on their own, in the application and by SQL, and the Owner then voids it with the books at 0;
- a sale that also holds a mobile money payment is `TENDER_NOT_VOIDABLE`.

## Built

| Area | What |
| --- | --- |
| Platform, IAM, MDM | 0195: the `ORDER_RETURN` document type (`RET`). 0196: the three permissions (granted to no role) and the `RETURN` policy (threshold 0, step-up). 0197: the grants. 0198: the REFUND reason `ORDER_RETURNED`. Each has a tested rollback (the 0155 rollback test walks back through them). |
| INV | 0199: `inv.stock_movement.returns_movement_id`. With `ck_stock_sale_return`, every `SALE_RETURN` that is not a reversal names its sale issue, comes from where the issue went (same product, unit and branch, an issue never reversed), and never exceeds what the issue issued less its returns, under the issue's row lock. The trigger sets the value, `half_up(V x (p+q)/Q) - half_up(V x p/Q)`, and the issue's cost element. `StockMovements.returnSaleIn` is the in-transaction port. |
| BIL, PAY | Read-only `Billing.creditPreviewIn` (BIL's credit rules without writing, from a refactor of `draftCreditIn` into plan and write), `Billing.linesByOrderLineIn` and `Refunds.summariesIn`. |
| ORD domain | `domain/order-return.ts` holds `judgeReturn`, `judgeReturnApprover` and `planReturnRefund`. It is at 100 percent under the `ord/domain/**` gate. |
| ORD database | 0200: `ord.order_return` and `ord.order_return_line` (DOCUMENT). The sale must be COMPLETED, with its own receipt and branch (`ck_order_return_sale`). The number is the allocated one (`ck_order_return_number`). Only the maker submits (`ck_order_return_submitted`); the decider is never the maker (`ck_order_return_decided`); credit note and refund only when COMPLETED. `ck_order_return_line_cap` holds the quantity under the sold line's row lock. What was asked never changes, and a decided return is frozen (HK004). |
| ORD application, interface | `Returns`, with `PgReturnStore` and the `RETURN` approval handler registered in `OrdModule.onModuleInit`. `ReturnsController`: `POST /returns`, `GET /returns/{id}`, `POST /returns/{id}/submit`, with a strict `ReturnCreateBody` and three fragments under `interface/openapi/`. Events: `ord.ReturnSubmitted` and `ord.ReturnCompleted`. `ReturnApproverIsMakerError` answers `MAKER_CANNOT_CHECK`. |
| Docs | ADR-0068 and its index row; A-228 and A-229; ADR-0026 Amendments; the openers (2d marked split, 2e inserted, B09x reads 2e's report); `docs/data-model/ord.md` and `inv.md`; API.md; the changelog; the ORD, INV, BIL and PAY cards; abuse case 12; the SRS traceability row for FR-ORD-015. |

## The gate, proved by running it

`test/integration/ord/order-return.integration.spec.ts` (8 tests, against the seeded farm and real Postgres):

- **Every return write refuses the wrong role and branch:**
  - the Accountant, the Storekeeper, the Investor and Sales of another branch cannot make one (403), and nothing is written;
  - the Storekeeper, the Investor and the other branch cannot read one (403), while the Owner, the Accountant, Sales and the Cashier can;
  - an unknown return is 404;
  - the Storekeeper, the Investor and the Accountant cannot submit one (403);
  - Sales cannot submit the Cashier's return (422 `NOT_RETURN_MAKER`).
- **Cannot exceed the quantity sold (FR-ORD-015's acceptance):**
  - Sold 2, returned 1: the return is `REQUESTED`, `RET-…`, with `refundPesewas` **2,000**, and a replay answers the same return.
  - Returning 2 more is 422 `RETURN_EXCEEDS_SOLD`.
  - 2 written into another return of the same sale by SQL is refused (`ck_order_return_line_cap`). The line holds **1.000**, and the order stays COMPLETED.
- **Only a completed sale** takes a return: a PLACED order is `INVALID_STATE_TRANSITION` `PLACED`, and an unknown order is 404.
- **An exchange and a wrong reason are refused together** (`EXCHANGE_NOT_AVAILABLE`, `REASON_NOT_ALLOWED`). `RETURN_QUALITY` without its note is `NOTE_REQUIRED`, and with it the return is taken.
- **Under concurrency:**
  - Over the API, two returns of the last 2 at once answer 201 and 422 `RETURN_EXCEEDS_SOLD`.
  - In SQL, without the application, two read-committed transactions each write the carrots' last 2 into two returns of the sale. The second waits on the sold line's lock and is refused when the first commits; the line holds exactly **2.000**.
- **The approval:**
  - Submitting is 202 `RETURN` with the return as its subject, and a replay gives the same approval. A second submit is `INVALID_STATE_TRANSITION` `PENDING_APPROVAL`. Nothing is credited before approval.
  - Sales cannot approve (403). The maker (the Manager) is refused, 422 `MAKER_CANNOT_CHECK`, and SQL deciding it as its maker is refused (`ck_order_return_decided`). A line's quantity cannot be changed by SQL (HK004).
  - The Owner's rejection leaves it `REJECTED` with no credit note, and the quantity can be returned again.
- **An approved return of 2 of 3 yams:**
  - It is `COMPLETED`.
  - Credit note `CRN-…` of **4,000**, made by the Manager (the return's maker) with `RETURN_UNWANTED`: **Dr 4200 4,000, Cr 1200 4,000 Walk-in customer**.
  - One `SALE_RETURN` of 2.000 to the shop, naming the issue, valued **2,400**: **Dr 1330 2,400, Cr 5020 2,400**. The shelf is up by exactly 2.
  - A refund of **4,000** against the credit note, made by the Manager (`ORDER_RETURNED`, `ORIGINAL_METHOD`). The Manager cannot approve it (422 `MAKER_CANNOT_CHECK`); the Owner can (APPROVED).
  - One `ord.ReturnCompleted` with abuse case 12. The order stays COMPLETED and the trial balance is **0**.
  - The third yam, written off: credited and refunded **2,000**, no movement, the shelf unchanged, a second credit note. A further return is refused. The trial balance is 0.
- **Each part of an issue at its share:**
  - 3 carrot crates issued at **10,000** come back as RESTOCK, RETURNS_HOLD and RESTOCK at **3,333, 3,334 and 3,333**, which sum to the issue exactly. Each is refunded **25,000**. The shop holds 2.000 and the holding area 1.000.
  - A fourth return written by SQL is refused (`ck_stock_sale_return`), and so is a `SALE_RETURN` naming no issue. The trial balance is 0.

`test/contract/b9/returns.contract.spec.ts`: a return made, read, submitted and approved answers in `OrderReturn` and `ApprovalPending`, and five refusals answer in `Error`.

**B9a's one-transaction proof stands:** `sale-posting`, `order-payment-rules`, `orders` and `order-reversals` pass, now 17 in the reversals spec.

Unit: `src/modules/ord/domain/order-return.spec.ts` (11 tests) covers:
- exactly what is left, and one thousandth more refused;
- every status refused;
- every line rule named at once;
- a whole animal;
- the approver;
- the refund (the largest cleared payment, capped by what is owed back, none when nothing is owed, a tie broken by the first).

### Mutation runs on returns (scratch, never committed)

| Mutation | Result |
| --- | --- |
| R1 domain: no sold-less-returned check | red (the API's 422 and the concurrency test) |
| R2 database: `ck_order_return_line_cap` off | red (the direct insert and the SQL race) |
| R3 database: `ck_order_return_decided` without "never the maker" | red |
| R4 application: `judgeReturnApprover` not called | **green**. IAM already refuses the requester, who is always the maker (only the maker submits), and the database refuses it too. The check is kept as defence in depth and is unreachable while IAM's holds. No test can reach it honestly. |
| R5 INV: each return valued by its own share (not cumulative) | red (3,333 + 3,333 + 3,333) |
| R6 application: the refund asked as the approver | red (the maker could approve the refund) |
| R7 INV: over-return of an issue allowed | red |

## Test first, as it honestly happened

- **The void's tests** came after the mutation run, as the parent asked. They were green on the code as it stood (they prove existing rules), and each was shown to turn red under its mutations. Their first run failed on a test-side error: the direct SQL did not move the version.
- **Returns:**
  - The unit spec was written first and was red (no module). Its first green run failed once on the test's own expectation: a sixth asked line repeated a line, so it named `LINE_REPEATED`. The test was corrected to use another line.
  - The integration spec was written before any return code and was red, 8 of 8 (no route).
  - The contract spec was written after the code.
  - The concurrency and rounding tests were set up again in the test before the code existed: a carrot sale with no stock, and SQL holders on another sale.
- **Stale tests updated because this phase made them stale:**
  - the drift counts;
  - the request-body map (`createReturn`);
  - the handler walk and its no-grant request bodies;
  - the Cashier's sign-in permission list;
  - the reason-code count (54, now 55);
  - the 0155 rollback list.
- Nothing was skipped, quarantined or retried, and no test was re-run to turn it green.

## Decisions

- **ADR-0068 (Proposed):**
  - Every return waits for `RETURN`.
  - The credit note and the refund are the return's maker's, so ADR-0066's existing database rules refuse the maker as the refund's approver.
  - Returned goods take their share of the issue's value, set by the database, never the pool's current average.
  - It contradicts no ADR. ADR-0010 (commands down in the caller's transaction) and ADR-0066 are applied as written.
- **The split (A-229, ADR-0026 Amendments):** returns are their own aggregate and tables. Pricing approvals, the proforma, online placement and the dashboard follow in 2e.

## Security review (hakorem-security-review)

- **Boundary:** TB2, the back office.
- **Standards:** `SECURE_CODING_STANDARDS.md` was run item by item. Identity, sessions, uploads, exports, webhooks and encryption are not touched.
- **Authorisation:**
  - `Returns` authorises without a scope and then at the sale's branch; every route declares its permission.
  - The permissions were seeded to no role (0196) and granted in their own migration (0197).
  - Deny by default is proved for every wrong role and another branch.
- **Maker and checker:** a return is approved by nobody who made it (IAM, the application and `ck_order_return_decided`). Its refund is approved by nobody who made it or its credit note (PAY's `ck_refund_approved_by` and `ck_refund_credit_note_checker`, proved here through a return).
- **Input:** zod strict objects; parameterised SQL only; no dynamic SQL.
- **Money:**
  - Refund amounts come from BIL's credit rules and PAY's caps, never from the client.
  - The stock value is set by the database.
  - All figures are exact integer pesewas.
- **Idempotency:** the key is claimed first in both writes.
- **Audit:** before and after values on creation, submission, approval and rejection.
- **Logging:** no personal data added.
- **Rate limit:** the `console` group.
- **Abuse case 12 (false return):** blocked by the quantity cap and the two-person rule. It is made visible by `ord.ReturnSubmitted` and `ord.ReturnCompleted` (abuse case 12) and the existing `pay.RefundRequested`, for the daily exception report (B12, `REFUND`). The threat model row is updated.
- **A residual note:** a seller and a supervisor colluding can still return goods that never came back (residual risk R1); the refund and its maker are on the report.

## Deferred

To **B09a continued 2e**, with its opener carrying them:
- price override limits and their approval;
- `issueProforma`;
- `placeOrder`, `trackOrder`, `listMyOrders` and `getMyOrder`, with CR-029 through `placeOrder`;
- the dashboard's six figures and two tiles (CR-013), deciding how a completed return counts;
- the seeded trading day.

To **B9b**:
- exchanges;
- a refund split across several tenders;
- the counter's returns;
- `listReturns` (still planned).

To **B11**: returns of lines sold by weight.

## Contract requests

I fetched the frontend's `main` at `0efb338`, the same commit 2c read. It lists CR-001 to CR-033, and nothing is new or changed.
- **CR-013** (the dashboard's figures): **not built here; it moves to B09a continued 2e.** This is scheduling, not a decline.
- **CR-031, CR-032 and CR-033** stay placed in B9b, with B11 for CR-033's SMS.
- **CR-005, CR-023, CR-027 and CR-028** stay with B09x.
- **CR-029's proof through `placeOrder`** is 2e's.
- The others were answered in earlier phases. No request is unplaced larger work.

## Tests (this machine, 2026-11-17)

| Layer | Result |
| --- | --- |
| Unit | **1,437 passed** (new: 11 in `ord/domain/order-return.spec.ts`) |
| Integration | **1,414 passed** (new: 8 in `ord/order-return`, 3 in `ord/order-reversals`) |
| Coverage, merged (`pnpm test:coverage`) | **2,851 passed**, 230 files, exit 0. Statements 93.66 percent, branches 83.46 percent (gate 80), functions 97.16, lines 96.30. Every 100 percent gate held, the new `src/modules/ord/domain/order-return.ts` included |
| Contract | **97 passed** (new: `b9/returns.contract.spec.ts`). `contract:generate` is up to date (412 from code, 223 planned); Redocly is clean |
| Lint, typecheck | Clean. Locally, eslint was run with `.claude/**` ignored; the test placement check found 276 specs in place; schema names and lint fixtures pass |
| End to end | CI only |

**A red run, recorded:** the first full local integration and contract run had 7 failures in 6 files, all lists and counts this phase made stale (above). They were fixed in the feature commit before anything was pushed. The rerun of those six files and the full coverage run were green. They were stale, not flaky.

## Gate

**Passed for the part built; the phase split (A-229).**
- **The cap:** a return never exceeds what was sold less what was returned, held by a database trigger under the sold line's lock and proved under concurrency, over the API and in SQL.
- **The refund:** a return is refunded against its own credit note, which a different approver approves; neither the return's maker nor the credit note's maker can.
- **The stock** comes back at exactly the cost it left at, and the trial balance is 0.
- **Every return write refuses the wrong role and another branch.**
- **The void's rules** are each proved on their own.
- **B9a's one-transaction proof** stands.
- **The rest of the opener's gate** (a price below list approved by a different user, online placement, the dashboard's figures) is B09a continued 2e's.

## Notes for the frontend track

- **Contract 1.49.0:** `createReturn`, `getReturn` and `submitReturn` are live.
- **A return is made against a completed sale's lines** (`orderLineId` from `getOrder`) and shows each line's refund before it is submitted.
- **`submitReturn` always answers 202:** the approval inbox shows `RETURN` with the return (`ORDER_RETURN`) as its subject. Only the return's maker submits it; the Owner or the Manager approves it, never the maker.
- **After approval**, `getReturn` shows the credit note and the refund, which waits in `listRefunds` for an approver who is neither the maker nor the credit note's maker.
- **Refused for now:**
  - exchanges (`EXCHANGE_NOT_AVAILABLE`);
  - lines sold by weight (`WEIGHED_LINE_NOT_RETURNABLE`);
  - part of an animal (`SERIAL_RETURNS_WHOLE`);
  - `listReturns` is still planned.

## CI

- **`78c4e85`** (all code, tests and documents before this report; pull request #76 was opened on it): run **44013789632 (push)**, success; run **44013822674 (pull_request**, which also compares the contract with `main`), success. Nothing was red and nothing was re-run.
- A commit cannot name its own runs, so the push and pull_request runs on the final head (this report's commit) are named in the session's closing message. The pull request is merged with a merge commit only once every run on its head is green.

## Next session

B09a continued 2e, copied from `docs/prompts/session-openers.md`, where this phase inserted it.

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md (the B9a row).
List docs/sessions/ and read only the most recent report (docs/sessions/B09a3d-orders-returns.md), and also
docs/sessions/B09a3-orders-online.md, the handoff of the orders work this phase continues.
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md): implement what is
reasonable, record in the report what you declined and why, never edit that file and never open frontend source.
For this phase, read the ORD (core) requirement block of docs/SRS.md and FR-RPT-001 (nothing else from the SRS),
docs/data-model/ord.md, the ORD, PAY, BIL and RPT cards in docs/MODULE_BOUNDARIES.md, DOMAIN_MODEL section 7,
ADR-0010, ADR-0021, ADR-0026 and ADR-0068, the abuse case 3 in docs/security/THREAT_MODEL.md, and A-149, A-200,
A-201, A-208, A-210, A-218, A-224, A-226, A-228 and A-229 in docs/ASSUMPTIONS.md, and ADR-0067 with A-217 (a rule's
"now" is the application clock's). Load hakorem-pricing, hakorem-money, hakorem-ledger, hakorem-documents,
hakorem-security-review, hakorem-endpoint, hakorem-migration, hakorem-seed and hakorem-tests. Use
docs/prompts/module-build-prompt.md as the recipe. Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B09a continued 2e only, on branch b09a3e-orders-online, branched from main. B09a continued 2b to 2d
built ORD's order record, its reversals and returns in `Orders`, `OrderReversals` and `Returns`
(src/modules/ord/application/). Build on them, each test-first with its wrong-role refusal: the permissions and
grants of what follows; price variance and override limits per role with approval by a different user
(PRICE_OVERRIDE_NEEDS_APPROVAL becomes an approval request, on createOrder and on the sale posting alike; the
database already requires the approval once an order is past PLACED); issueProforma (POST /orders/{id}/proforma) on
Billing.issueIn (A-201); online order placement and payment (placeOrder, trackOrder, listMyOrders, getMyOrder) on
B09a continued's provider port (an order confirms on pay.PaymentCleared only when it is not heldAsUnmatched;
cancelOrder already releases the order's pending charges and the late webhook clears as unmatched, proved in B09a
continued 2c); and the owner dashboard's B9a figures (A-149, CR-013): remove `salesTodayPesewas`,
`salesYesterdayPesewas`, `salesMonthToDatePesewas`, `salesByChannel`, `salesSeries` and `topMovers` from RPT's
PENDING_FIGURES and answer them from completed orders through a published view (a VOIDED order is not a sale; decide
and record how a completed return's credit note counts), and build the planned tiles getSalesTodayTile and
getSalesSeries. Extend the seed with a trading day of sales posted through SalePosting, keeping the B5 hand count and
the trial balance tests true. CR-029 was built in B09a continued 2 (`Cart.checkoutId`, contract 1.46.0): when
placeOrder completes a checkout, prove through placeOrder itself that the cart's checkoutId is null again. The
integration tests run against the local Paystack fake, which answers as Paystack's test mode did (A-218): its MTN
test number pays at once, a payer email on `.example` is refused, and a refund's idempotency key is honoured only
through the adapter's note lookup.
Two rules from B09t (ADR-0067): no new now() or current_date in business SQL (due dates, expiries, holds, business
days and as-of times take the application clock, as a parameter or platform.app_now()); and no new fixed calendar
date in the seed or a test (build dates from the seed's or the test's clock); the seeded trading day this phase adds
takes its dates from the seed calendar (src/seed/seed-calendar.ts, A-220, A-222).
If it does not fit, split at a sub-domain boundary after a proven, merged gate.
Stop at the gate, write docs/sessions/B09a3e-orders-online.md, and merge into main when every run on the pull
request is green.
```
