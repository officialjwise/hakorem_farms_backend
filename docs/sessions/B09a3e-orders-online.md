# B09a continued 2e: price override approvals and the proforma, split before online placement

Date: 2026-11-17 · Branch `b09a3e-orders-online`, from `main` (`88c0d9f`) · Pull request #77 · Status: **gate passed for the part built; the phase split (A-231)** after price override approvals and the proforma. The remainder is **B09a continued 2f** (`b09a3f-orders-online`), inserted in `docs/prompts/session-openers.md` after this phase and before B09x.

Run as a fresh agent inside the 2026-11-15 overnight session: the parent session cannot issue /clear or /compact, so each phase starts in a new context that reads only this handoff from disk.

## Assumptions made this session (in `docs/ASSUMPTIONS.md`, dated 2026-11-17)

| ID | What | Who confirms |
| --- | --- | --- |
| A-230 | **Price override approvals and the proforma as built**, each the most conservative reading. (a) `ord.price_override.approve` (step-up) goes to the Owner and the Manager. `bil.proforma.create` goes to the Owner, the Manager and Sales. `PRICE_OVERRIDE` has threshold 0. (b) A price outside the band always waits. A price below list waits when the line's whole variance is beyond the seller's `PRICE_OVERRIDE_PER_LINE`: the largest limit among the roles the seller holds at the order's branch. **No limit is seeded, so every price below list still waits**: the owner's interim holds as data. A price above list up to the ceiling needs only its reason. The per-shift limit is B9b's. (c) `createOrder` enters the order `PLACED` with its flagged lines naming one approval and answers 202. Until the approval, the order can be neither confirmed nor given a proforma. A rejection leaves it unconfirmable; a cancellation withdraws a waiting request. (d) The sale posting is pre-approved: `SalePosting.requestOverrideIn`, then the same seller's `postIn` names the approval, bound by the hash of the flagged lines' pricing record. (e) The approver is neither the asker (IAM), nor the salesperson, nor the order's writer (ORD and the database). The pricing record is fixed once a request is named. (f) A proforma is issued once per `PLACED` or `CONFIRMED` order and posts nothing. (g) `ord.PriceOverrideRequested` and `ord.PriceOverrideApproved` carry abuse case 3. | Owner (a to d), Accountant (f) |
| A-231 | **B09a continued 2e split after price override approvals and the proforma.** Online placement and payment with CR-029 through `placeOrder`, the dashboard's six B9a figures and two tiles (CR-013) and the seeded trading day move unchanged to **B09a continued 2f** (`b09a3f-orders-online`). 2f may split again (online placement; the dashboard and the seed). | Owner |

Still open, proceeded on as stated: A-033, A-034, A-062, A-182 to A-207, A-209, A-211, A-213, A-214, A-216 to A-231.

Phase, scope and gate, as confirmed at the start:
1. **Phase:** B09a continued 2e (`b09a3e-orders-online`, from `main` at `88c0d9f`).
2. **Scope:** the opener's list: price override limits and their approval on `createOrder` and the sale posting, `issueProforma`, online placement and payment with CR-029 through `placeOrder`, the dashboard's figures and tiles, and the seeded trading day. The whole list could not reach its gate in one context, so the session built the first sub-domain the opener names (pricing approvals and the proforma), proved it, and split (A-231).
3. **Gate:** as the opener states it; the gate below is the one for the part built.

## Contract changes

**1.50.0, minor. Nothing a client sends is made required, and no field is removed, renamed or retyped.**
- `createOrder` gains a `202` response with an `ApprovalPending` body (kind `PRICE_OVERRIDE`, its subject the order). Before, a price outside the band, or below list beyond the limit, answered 422 `PRICE_OVERRIDE_NEEDS_APPROVAL`; now the same request enters the order and waits. **A client that handled that 422 now receives 202.** Every other answer is unchanged.
- `confirmOrder` describes its new refusal: 422 `PRICE_OVERRIDE_NEEDS_APPROVAL` while an override waits.
- The planned `issueProforma` (`POST /orders/{id}/proforma`) moves into code. Its example's number now uses the series prefix, `PRO-`.
- No error code is added. `PRICE_OVERRIDE_NEEDS_APPROVAL` has its detail codes listed in `docs/API.md` section 10.
- There are 413 operations from code and 222 planned. `contract:generate` is up to date and Redocly is clean, with no warnings. `docs/CONTRACT_CHANGELOG.md` and `docs/API.md` (ORD) record it.

## Built

| Area | What |
| --- | --- |
| IAM | 0201: `ord.price_override.approve` (step-up) and `bil.proforma.create`, granted to no role, and the `PRICE_OVERRIDE` policy (threshold 0, step-up). 0202: the grants. `Authoriser.limitIn` reads a role limit: the largest live limit of a kind among the roles held at a branch, 0 when none. `Approvals.ofSubjectIn` is a read-only list of a subject's requests of a kind. |
| ORD domain | `domain/price-override.ts`: `judgeOverride`, `judgePriceApprover`, `overridePayload` and `PRICE_OVERRIDE_KIND`. It is at 100 percent under the `ord/domain/**` gate. |
| ORD database | 0203: `variance_approved_by` and `variance_approved_at` on the line, with `ck_sales_order_line_approved` and `ck_sales_order_line_flagged`. `ck_sales_order_line_priced` fixes the pricing record once a request is named, and the approver once written. `ck_sales_order_settled_lines` (replaced) requires, past `PLACED` and not cancelled, every flagged line to name its request and an approver who is neither the order's writer nor its salesperson. `proforma_document_id` is unique and written once (`ck_sales_order_proforma`). Each migration has a tested rollback (the 0155 rollback test walks back through 0203 to 0201). |
| ORD application | `PriceOverrides`: the limit, the request, the 202 view, `unapprovedIn`, `withdrawIn`, and IAM's `PRICE_OVERRIDE` handler. The handler applies the approval to an entered order; for a sale not yet written it records the approval only. `Orders.create` answers 202; `Orders.confirm` refuses while an override waits; `Orders.issueProforma` issues through `Billing.issueIn`. `SalePosting.requestOverrideIn` is new, and `postIn` names an approval it finds. `OrderReversals.cancel` withdraws a waiting override. `PriceApproverIsSellerError` answers `MAKER_CANNOT_CHECK`. |
| ORD interface | `POST /orders/{id}/proforma`. `createOrder` answers 201 or 202. The fragments `issueProforma.yaml` (new), `createOrder.yaml` and `confirmOrder.yaml` changed. |
| Events | `ord.PriceOverrideRequested` and `ord.PriceOverrideApproved`, both carrying abuse case 3. |
| Docs | ADR-0069 and its index row; A-230 and A-231; ADR-0026 Amendments; the openers (2e marked split, 2f inserted, B09x reads 2f's report); `docs/data-model/ord.md`; API.md (ORD and section 10); the changelog; the ORD and IAM cards; abuse case 3; the SRS traceability row for FR-ORD-003. |

## The gate, proved by running it

`test/integration/ord/price-override.integration.spec.ts` runs 14 tests against the seeded farm and real Postgres. Cabbage is on the base list: floor 800, list 1,000, ceiling 1,200.

- **createOrder waits for a different user:**
  - 2 heads at 950 answer 202 `PRICE_OVERRIDE`, its subject the order `SO-…`. The line holds a variance of **100** `BELOW`, flagged, naming the approval, with no approver. The approval's amount is **100**, asked by Sales.
  - A replay answers the same approval.
  - Confirming is 422 `PRICE_OVERRIDE_NEEDS_APPROVAL` `APPROVAL_PENDING` on `/lines/1/agreedUnitPricePesewas`, and nothing is reserved.
- **Outside the band always waits:** 799 and 1,201 answer 202 with a limit of 1,000,000.
- **The limit, at its bound:**
  - With a Sales limit of 100, 950 × 2 (**100** off) is 201 and is not flagged; it then confirms.
  - 949 × 2 (**102** off) answers 202, with an amount of **102**.
  - The Manager, whose role has no limit, waits at 999.
  - A limit of 1,000,000 on a role Efua holds only at the other branch gives her nothing here: 900 × 2 answers 202.
  - Above list within the ceiling (1,100) is 201.
- **Who decides:**
  - Sales, the second salesperson, the Cashier, the Storekeeper, the Accountant, the Investor and a Manager of the other branch are each refused (403).
  - The Manager who entered the order is refused (422 `MAKER_CANNOT_CHECK`), and the request stays `PENDING`.
- **Approved:** the line names the Manager. The order confirms and reserves its line. The outbox holds `ord.PriceOverrideRequested` then `ord.PriceOverrideApproved`, carrying 200, the asker, the approver and abuse case 3.
- **Rejected or cancelled:**
  - The Owner's rejection leaves the order `PLACED`, and confirming it is `APPROVAL_REJECTED`.
  - A cancellation withdraws the request (`CANCELLED`), and a later approval is 422 `APPROVAL_ALREADY_DECIDED`.
- **The salesperson and the writer, each on its own:**
  - The order is credited by SQL to the Manager as salesperson while Sales asked. ORD refuses the Manager (422 `MAKER_CANNOT_CHECK`).
  - In SQL, approving as the salesperson and then confirming is refused (`ck_sales_order_settled_lines`). So is approving as the writer and confirming, and so is confirming with no approver.
  - The Owner may approve.
- **The record is fixed:** a changed agreed price, a changed quantity and an approver on an unflagged line are each refused by SQL (`ck_sales_order_line_priced`, `ck_sales_order_line_approved`).
- **The sale posting** (wholesale GOAT-M: list 58,500, floor 36,000, ceiling 65,000):
  - At 58,000 with no approval it is `BEYOND_ROLE_LIMIT`.
  - `requestOverrideIn` answers `PRICE_OVERRIDE` on the sale's id for **500**, and asked again answers the same approval.
  - While it waits the sale is `APPROVAL_PENDING` and nothing is written.
  - Sales, the Cashier and the Accountant cannot decide.
- **The approved sale:**
  - Once the Manager approves, another seller cannot spend the approval (409 `IDEMPOTENCY_KEY_REUSED`), and 57,000 is `APPROVAL_DIFFERS`.
  - The sale posts `COMPLETED`: resolved 58,500, agreed 58,000, variance **500** `BELOW`, the line naming the Manager.
  - The receipt journal is **Dr 1200 58,000, Dr 4210 500, Cr 4000 58,500**. A replay answers the same sale, and the trial balance is **0**.
  - A second ask with other prices while one waits is `OVERRIDE_PENDING`. A sale at list has `NO_OVERRIDE_TO_APPROVE`. Another cashier cannot ask for or post a sale whose approval someone else asked for.
- **issueProforma:**
  - The Cashier, the Storekeeper, the Investor, the Accountant and the other branch are refused (403), and an unknown order is 404.
  - 2 heads at list give `PRO-…` of **2,000**: lines at 1,000 and 1,000, no journal entry.
  - A replay answers the same proforma, and a second proforma is `PROFORMA_ISSUED`.
  - A waiting override is `PRICE_OVERRIDE_NEEDS_APPROVAL`. Approved at 900, the proforma is **1,800**, at 900 against 1,000 resolved.
  - A cancelled order is `INVALID_STATE_TRANSITION`. The trial balance is 0.

`test/contract/b9/price-override.contract.spec.ts` checks the shapes: 202 `ApprovalPending`, refusals in `Error`, `ApprovalRequest`, `BillingDocument` and `SalesOrder`.

**B9a's one-transaction proof stands:** `sale-posting`, `order-payment-rules`, `orders`, `order-reversals` and `order-return` pass. The posting's new pre-approval path reaches the same `postIn`.

### Mutation runs (scratch, never committed)

Each rule was broken on its own in scratch (the file restored from a copy afterwards), then the new integration spec and the domain unit spec were run. The test data has a maker, a salesperson and a poster who differ: Sales asks, the Manager is made salesperson by SQL, and the order's writer stays Sales.

| Mutation | Result |
| --- | --- |
| M1 ORD: the approver may be the order's salesperson | red |
| M2 ORD: the approver may be the order's writer | **green**: unreachable. A `createOrder` order's writer is always the person who asked, whom IAM already refuses. The database half (M3) is reached by SQL. Kept as defence in depth. |
| M3 database: `ck_sales_order_settled_lines` without its writer half | red |
| M4 database: without its salesperson half | red |
| M5 database: without the approver at all (request id only, as 0163) | red |
| M6 ORD: confirmation ignores an unapproved override | red |
| M7 domain: the limit compared with `>=` (100 at a limit of 100 would wait) | red (unit and integration) |
| M8 IAM: a role limit counted from any branch | red |
| M9 database: the pricing record not fixed | red |
| M10 sale posting: any approved override accepted, whatever its prices | red |
| M11 sale posting: another seller may spend the approval | red |
| M12 sale posting: `judgePriceApprover` not called | **green**: unreachable. The seller is the person who asked, whom IAM refuses, and the database refuses the salesperson and writer too. Kept as defence in depth. |
| M13 cancellation does not withdraw a waiting override | red |
| M14 proforma ignores an unapproved override | red |
| M15 domain: above the ceiling not outside the band | red (unit and integration) |
| M16 IAM: the role limit ignored (always 0) | red |
| M17 database: an approver on an unflagged line allowed | red |
| M18 proforma issued twice | red |

## Test first, as it honestly happened

- **The domain unit spec** was written first and was red (no module). Its first green run had 100 percent of branches but missed the sort comparator (one flagged line). A test with three lines out of order was added before the commit.
- **The integration spec** was written before any code of this phase and was red, 14 of 14. Its first runs after the code failed on the test's own mistakes, each fixed in the test:
  - the proforma prefix (`PRO-`, not `PRF-`);
  - the outbox column (`event_type`);
  - the version moves that direct SQL must make;
  - the expected status of a decision on a withdrawn request (422, not 409).
- **The branch-scoped limit test** was added after the code and before the mutation run, which proved it (M8).
- **The contract spec** was written after the code.
- **Stale tests updated because this phase made them stale:**
  - `orders.integration.spec.ts` › the override test now proves 202;
  - the 0155 rollback list (0203 to 0201);
  - the handler walk (`issueProforma`);
  - the drift counts (413 from code, 222 planned);
  - `b9/orders.contract.spec.ts`, whose override refusal is now a 202 `ApprovalPending`.
- Nothing was skipped, quarantined or retried, and no test was re-run to turn it green.

## Decisions

- **ADR-0069 (Proposed):**
  - `createOrder` takes the approval on the order.
  - The sale posting is pre-approved for the exact sale and then posted by its seller, because the tenders have nowhere to wait before B9b's held sales.
  - The limit is IAM's role attribute, read by ORD and judged in ORD's domain, as ADR-0017 says.
  - It contradicts no ADR. ADR-0017 holds: the payload hash binds the approval to the sale's prices, nothing posts until a different user approves, and the handler's effect on a sale not yet written is to record the approval, which the sale then spends. This is flagged for the owner in A-230 (d).
- **The split (A-231, ADR-0026 Amendments):** pricing approvals and the proforma are one sub-domain. Online placement, and the dashboard with the seed, follow in 2f.

## Security review (hakorem-security-review)

- **Boundary:** TB2, the back office.
- **Standards:** `SECURE_CODING_STANDARDS.md` was run item by item. Identity, sessions, uploads, exports, webhooks and encryption are not touched.
- **Authorisation:**
  - `Orders.issueProforma` authorises without a scope and then at the order's branch.
  - The approval is decided through IAM's inbox with the policy's permission and step-up.
  - Permissions were seeded to no role (0201) and granted in their own migration (0202).
  - Deny by default is proved for every wrong role and the other branch.
- **Maker and checker:**
  - The approver is never the asker (IAM's `ck_approval_request_maker_not_checker`) and never the salesperson or the writer (ORD and `ck_sales_order_settled_lines`).
  - The approval is bound to the exact pricing record. The record is fixed in the database once a request is named.
  - A pre-approval cannot be spent by another seller or on other prices.
- **Money:**
  - The limit and the variance are exact integer pesewas, extended once at the line (ADR-0001).
  - Every variance still posts to 4210 through the receipt (A-200 (b)); a below-list sale is proved to the pesewa.
- **Input:** zod strict objects; parameterised SQL only; no dynamic SQL.
- **Idempotency:** the key is claimed first. The pre-approval is idempotent by the sale's id and hash.
- **Audit:**
  - the approval's request and decision (IAM);
  - `APPROVE_PRICE_OVERRIDE` and `ISSUE_PROFORMA` (ORD);
  - the order's creation, as before.
- **Logging:** no personal data added.
- **Rate limit:** the `console` group.
- **Abuse case 3:**
  - Blocked per line: no price below list without approval while no limit is set.
  - Made visible: `ord.PriceOverrideRequested` and `ord.PriceOverrideApproved` carry the value, the asker, the salesperson and the approver for the daily exception report (B12, `PRICE_OVERRIDE`).
  - The per-shift limit needs the shift (B9b). The threat model row is updated.
- **A residual note:** a seller and a manager colluding can still approve a low price (residual risk R1); both names are on the event and the report.

## Deferred

To **B09a continued 2f**, with its opener carrying them:
- `placeOrder`, `trackOrder`, `listMyOrders` and `getMyOrder`, with CR-029 through `placeOrder`;
- the dashboard's six figures and two tiles (CR-013), deciding how a completed return counts;
- the seeded trading day.

To **B9b**:
- the per-shift limit;
- the till's call of `requestOverrideIn` (a supervisor approving at the counter);
- an offline override approved after the fact (OFFLINE_SYNC).

To **B11**: the posting of an order whose overrides were approved at entry, at dispatch.

## Contract requests

I fetched the frontend's `main` at `0efb338`, the same commit 2c and 2d read. It lists CR-001 to CR-033, and nothing is new or changed.
- **CR-013** (the dashboard's figures): **not built here; it moves to B09a continued 2f.** This is scheduling, not a decline.
- **CR-029's proof through `placeOrder`** is 2f's.
- **CR-031, CR-032 and CR-033** stay placed in B9b, with B11 for CR-033's SMS.
- **CR-005, CR-023, CR-027 and CR-028** stay with B09x.
- The others were answered in earlier phases. No request is unplaced larger work.

## Tests (this machine, 2026-11-17)

| Layer | Result |
| --- | --- |
| Unit | **1,446 passed** (new: 9 in `ord/domain/price-override.spec.ts`) |
| Integration | **1,428 passed** (new: 14 in `ord/price-override`) |
| Coverage, merged (`pnpm test:coverage`) | **2,874 passed**, 232 files, exit 0. Statements 93.67 percent, branches 83.47 percent (gate 80), functions 97.17, lines 96.30. Every 100 percent gate held, the new `src/modules/ord/domain/price-override.ts` included |
| Contract | **98 passed** (new: `b9/price-override.contract.spec.ts`). `contract:generate` is up to date (413 from code, 222 planned); Redocly is clean |
| Lint, typecheck | Clean. Locally, eslint was run with `.claude/**` ignored; the test placement check found 279 specs in place; schema names and lint fixtures pass |
| End to end | CI only |

**A red run, recorded:** the first full local coverage run had one failure, in `iam/authorisation.integration.spec.ts` (the handler walk). The walk did not yet list the new `issueProforma` route. The first contract run had two failures: the drift counts, and `b9/orders.contract.spec.ts`, which expected the old 422 for a price outside the band. All three tests were stale because of this phase, not flaky. They were fixed in the feature commit before anything was pushed, and the second full runs were green.

## Gate

**Passed for the part built; the phase split (A-231).**
- **A different user approves:** a price outside the band, or below list beyond the seller's per-line limit, is approved by someone other than the asker, the salesperson and the writer. This holds on `createOrder` and on the sale posting alike, in IAM, ORD and the database, and nothing is reserved, issued or paid before.
- **Each bound is proved at its edge.**
- **The proforma** is issued once, at the approved prices, and posts nothing.
- **Every new write refuses the wrong role and the other branch.**
- **B9a's one-transaction proof stands,** and the trial balance is 0.
- **The rest of the opener's gate** (online placement through `SalePosting.postIn`, the dashboard's figures, the seeded trading day) is B09a continued 2f's.

## Notes for the frontend track

- **Contract 1.50.0:** `createOrder` may answer **202** `ApprovalPending` (`PRICE_OVERRIDE`). The order exists (`subject.id`, its number) and waits.
- **The approval inbox** shows it with the order as subject. Only the Owner or the Manager decides, never the person who entered the order.
- **Until it is approved,** `confirmOrder` and `issueProforma` answer 422 `PRICE_OVERRIDE_NEEDS_APPROVAL`, with `APPROVAL_PENDING` or `APPROVAL_REJECTED` per line.
- **`issueProforma`** is live (`PRO-…`, once per order; print another copy with `reprintBillingDocument`).
- **No limit is seeded,** so every price below list waits until the owner sets `PRICE_OVERRIDE_PER_LINE` on a role.

## CI

- **`5f046b6`** (all code, tests and documents before this report; pull request #77 was opened on it): run **44021362996 (push)**, success; run **44021398216 (pull_request**, which also compares the contract with `main`), success. Nothing was red and nothing was re-run.
- A commit cannot name its own runs, so the push and pull_request runs on the final head (this report's commit) are named in the session's closing message. The pull request is merged with a merge commit only once every run on its head is green.

## Next session

B09a continued 2f, copied from `docs/prompts/session-openers.md`, where this phase inserted it.

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md (the B9a row).
List docs/sessions/ and read only the most recent report (docs/sessions/B09a3e-orders-online.md), and also
docs/sessions/B09a3-orders-online.md, the handoff of the orders work this phase continues.
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md): implement what is
reasonable, record in the report what you declined and why, never edit that file and never open frontend source.
For this phase, read the ORD (core) requirement block of docs/SRS.md and FR-RPT-001 (nothing else from the SRS),
docs/data-model/ord.md, the ORD, PAY, SHP and RPT cards in docs/MODULE_BOUNDARIES.md, DOMAIN_MODEL section 7,
ADR-0010, ADR-0021, ADR-0026 and ADR-0069, and A-149, A-208, A-210, A-218, A-224, A-226, A-228, A-230 and A-231 in
docs/ASSUMPTIONS.md, and ADR-0067 with A-217 (a rule's "now" is the application clock's). Load hakorem-money,
hakorem-ledger, hakorem-security-review, hakorem-endpoint, hakorem-migration, hakorem-offline (only if a POS path is
touched), hakorem-seed and hakorem-tests. Use docs/prompts/module-build-prompt.md as the recipe. Do not read any other
document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B09a continued 2f only, on branch b09a3f-orders-online, branched from main. B09a continued 2b to 2e
built ORD's order record, reversals, returns and price override approvals in `Orders`, `OrderReversals`, `Returns`
and `PriceOverrides` (src/modules/ord/application/). Build on them, each test-first with its wrong-role refusal: the
permissions and grants of what follows; online order placement and payment (placeOrder, trackOrder, listMyOrders,
getMyOrder) on B09a continued's provider port (an order confirms on pay.PaymentCleared only when it is not
heldAsUnmatched; cancelOrder already releases the order's pending charges and the late webhook clears as unmatched,
proved in B09a continued 2c; an online price is the engine's, so no override arises; the customer reads only their own
orders); and the owner dashboard's B9a figures (A-149, CR-013): remove `salesTodayPesewas`, `salesYesterdayPesewas`,
`salesMonthToDatePesewas`, `salesByChannel`, `salesSeries` and `topMovers` from RPT's PENDING_FIGURES and answer them
from completed orders through a published view (a VOIDED order is not a sale; decide and record how a completed
return's credit note counts), and build the planned tiles getSalesTodayTile and getSalesSeries. Extend the seed with a
trading day of sales posted through SalePosting, keeping the B5 hand count and the trial balance tests true. CR-029 was
built in B09a continued 2 (`Cart.checkoutId`, contract 1.46.0): when placeOrder completes a checkout, prove through
placeOrder itself that the cart's checkoutId is null again. The integration tests run against the local Paystack fake,
which answers as Paystack's test mode did (A-218): its MTN test number pays at once, a payer email on `.example` is
refused, and a refund's idempotency key is honoured only through the adapter's note lookup.
Two rules from B09t (ADR-0067): no new now() or current_date in business SQL (due dates, expiries, holds, business
days and as-of times take the application clock, as a parameter or platform.app_now()); and no new fixed calendar
date in the seed or a test (build dates from the seed's or the test's clock); the seeded trading day this phase adds
takes its dates from the seed calendar (src/seed/seed-calendar.ts, A-220, A-222).
If it does not fit, split at a sub-domain boundary after a proven, merged gate.
Stop at the gate, write docs/sessions/B09a3f-orders-online.md, and merge into main when every run on the pull
request is green.
```
