# B09a continued 2c: cancellation and the void of a sale, split before returns

Date: 2026-11-17 · Branch `b09a3c-orders-reversals`, from `main` (`49cb6f5`) · Status: **gate passed for the part built; the phase split (A-227)** after the order's own reversals. The remainder is **B09a continued 2d** (`b09a3d-orders-returns`), inserted in `docs/prompts/session-openers.md` after this phase and before B09x.

Run as a fresh agent inside the 2026-11-15 overnight session: the parent session cannot issue /clear or /compact, so each phase starts in a new context that reads only this handoff from disk.

## Assumptions made this session (in `docs/ASSUMPTIONS.md`, dated 2026-11-17)

| ID | What | Who confirms |
| --- | --- | --- |
| A-226 | **Cancellation and the void as built**, each the most conservative reading. (a) `ord.order.cancel` for the Owner, the Manager and Sales; `ord.order.void` (asking) for the Owner, the Manager, Sales and the Cashier; `ord.void.approve` (step-up) for the Owner and the Manager; `SALE_VOID` at threshold 0. (b) Only a `PLACED` or `CONFIRMED` order is cancelled, with a `CANCELLATION` reason. In one transaction its reservations are released, its pending charges released, and a refund of exactly what each cleared payment still holds is asked for (`ORDER_CANCELLED`, waiting under `REFUND`, the canceller its maker). (c) Only a `COMPLETED` counter or collection sale is voided, on its Accra business day by the application clock (the shift's day until B9b; judged again at approval), paid only in cash or store credit, cleared and never refunded. Mobile money, card, cheque and bank transfer go back through a return and a refund against its credit note (ADR-0066). The approver is never the asker, the sale's poster or its salesperson. On approval the payments are reversed (`SALE_VOIDED`), the receipt is credited in full and the stock issues are reversed. (d) No new error code. | Owner (a, b, c), Accountant (b, c) |
| A-227 | **B09a continued 2c split after cancellation and the void.** Returns with their trigger under concurrency, price override approvals, `issueProforma`, online placement and payment, the dashboard's sales figures and tiles, the seeded trading day and CR-029 through `placeOrder` move unchanged to **B09a continued 2d** (`b09a3d-orders-returns`), which may split again (returns; pricing approvals and the proforma; online placement; the dashboard and the seed). | Owner |

Still open, proceeded on as stated: A-033, A-034, A-062, A-182 to A-207, A-209, A-211, A-213, A-214, A-216 to A-227.

Phase, scope and gate, as confirmed at the start:
1. **Phase:** B09a continued 2c (`b09a3c-orders-reversals`, from `main` at `49cb6f5`).
2. **Scope:** the opener's whole list: cancellation, voids, returns with their trigger, price override approvals, the proforma, online placement, the dashboard's sales figures, the seed and CR-029 through `placeOrder`. It could not reach its whole gate in one context. So the session built the first sub-domain the opener names, the order's own reversals (cancel and void), proved it, and split before returns, a separate aggregate (`Returns`, its own tables and trigger) (A-227).
3. **Gate:** as the opener states it; the gate below is the one for the part built.

## Contract changes

**1.48.0, minor; no existing shape changed, nothing a client sends made required.** Two planned ORD operations move into code with their descriptions made exact: `cancelOrder` and `voidOrder`. `voidOrder` always answers 202 `ApprovalPending` (its planned 200 response is kept, unused, so nothing is removed). No error code is added. There are 409 operations from code and 226 planned. `contract:generate` is up to date and Redocly is clean, with no warnings. `docs/CONTRACT_CHANGELOG.md` and `docs/API.md` (ORD) record it.

## Built

| Area | What |
| --- | --- |
| IAM, MDM | Migration 0190 seeds the three permissions (to no role) and the `SALE_VOID` policy. Migration 0191 holds the grants above. Migration 0192 adds the reasons `ORDER_CANCELLED` (REFUND) and `SALE_VOIDED` (PAYMENT_REVERSAL). Each has a tested rollback. |
| PAY | `Refunds.requestIn` (`requestRefund` now delegates to it). `Receipts.reverseApprovedIn` makes an approved reversal under the caller's approval. Migration 0193 makes `uq_payment_reversal_approval` unique on the approval and the payment together, so one void can reverse several tenders. `Receipts` is exported from PAY. |
| BIL | `Billing.creditIn`: a credit note issued at once under the caller's approval, by `issueCreditNote`'s rules with a `VOID` reason admitted. `noteReasonRule` takes the admitted domains. |
| INV | `Reservations.releaseHeldByIn`: every active reservation of a document, read by `ix_stock_reservation_holder` under row locks. |
| ORD domain | `domain/reversal.ts` holds `judgeCancellation`, `planCancellationMoney` (the exact deposit of each cleared payment, the pending charges), `judgeVoid` and `judgeVoidApprover`. It is at 100 percent under the existing `ord/domain/**` gate. |
| ORD application, infrastructure | `OrderReversals` (`cancel`, `requestVoid`, the `SALE_VOID` approval handler), registered in `OrdModule.onModuleInit`. `PgOrderStore` gains `cancel`, `markVoided`, the void's reads and writes, and `createdBy` on the header. Events: `ord.OrderCancelled`, `ord.SaleVoidRequested` and `ord.OrderVoided`; the last two carry abuse case 1, the asker, the cashier and the approver. `VoidApproverIsCashierError` answers `MAKER_CANNOT_CHECK`. |
| ORD database | Migration 0194 adds `voided_by` and `voided_at` with `ck_sales_order_void_checker`: a VOIDED order's voider is never its poster nor its salesperson. The guard now lets a completed order change only its void columns. `ord.order_void` (DOCUMENT) is written PENDING_APPROVAL, decided once and then frozen, decided by someone other than its maker, and holds one open void per sale. |
| Interface | `POST /orders/{id}/cancel` and `POST /orders/{id}/void` with a strict `ReasonCodeBody`. Their two fragments are under `interface/openapi/`. |
| Docs | A-226 and A-227; ADR-0026 Amendments; the openers (2c marked split, 2d inserted, B09x reads 2d's report); API.md; the changelog; `docs/data-model/ord.md`; the ORD, PAY, BIL and INV cards; abuse case 1 in the threat model; the SRS traceability rows for FR-ORD-002 and FR-ORD-014. |

## The gate, proved by running it

`test/integration/ord/order-reversals.integration.spec.ts` (14 tests, against the seeded farm, the local Paystack fake and real Postgres):

**Cancellation (FR-ORD-014):**
- **Every cancellation refuses the wrong role and branch.** The Cashier, the Storekeeper, the Investor and a salesperson of another branch are refused (403). The order stays CONFIRMED with its 4.000 still ACTIVE. An unknown order is 404.
- **A placed order is cancelled once.**
  - It is CANCELLED, its line CANCELLED, UNPAID.
  - The history shows PLACED, then CANCELLED with "CUSTOMER_CANCELLED: Customer called".
  - There is one `ord.OrderCancelled`.
  - A replay answers the same version.
  - A second cancel is `INVALID_STATE_TRANSITION` `CANCELLED`.
  - A `VOID` reason is `REASON_NOT_ALLOWED`, and nothing changes.
- **A confirmed order gives its 4 crates back.** Available is down by exactly 4 after confirmation and back to the same figure after the cancellation. The reservation is RELEASED.
- **A prepaid order is paid back exactly, and money arriving late is not the order's.**
  - The order was paid 2,000 and has a further charge of 500 pending.
  - Cancelling releases the 2.000 heads, asks for exactly **2,000** back (`ORDER_CANCELLED`, PENDING_APPROVAL, made by the salesperson, an IAM `REFUND` request), and releases the pending charge at the clock's instant.
  - When the customer then pays the 500, it clears with `heldAsUnmatched: true` and one `UNMATCHED_PAYMENT` break, and the order stays CANCELLED (A-210, proved through `cancelOrder`).
  - The canceller cannot approve the refund (403). The Owner approves with step-up (APPROVED).
  - The trial balance is **0**.
- **All or nothing.** A trigger installed for the test refuses the refund row, so the cancellation fails (500). The order stays CONFIRMED, its reservation ACTIVE and the charge unreleased; there is no refund and no event. With the trigger removed, the same cancellation succeeds and asks for 1,000 back.
- **A completed sale is never cancelled** (`INVALID_STATE_TRANSITION` `COMPLETED`).

**The void under SALE_VOID (abuse case 1):**
- **Every void refuses the wrong role and branch.** The Storekeeper, the Investor, the Accountant and another branch are refused (403), and no void row is written.
- **The cashier's request changes nothing.**
  - It is 202, `SALE_VOID`, with the order as its subject, and a replay gives the same approval.
  - The sale stays COMPLETED with no credit note.
  - `ord.SaleVoidRequested` carries 4,000, the asker, the cashier and `abuseCases: [1]`.
  - A second request names `VOID_PENDING` and `REASON_NOT_ALLOWED` at once.
- **Only a supervisor can approve.** The cashier approving their own void and Sales (no `ord.void.approve`) are refused, and the sale stays COMPLETED.
- **The Owner's approval with step-up voids the sale exactly:**
  - The order is VOIDED, with `voided_by` the Owner.
  - One credit note `CRN-…` of **4,000** is issued, made by the Owner with the void's reason. Its journal is **Dr 4200 4,000, Cr 1200 4,000 Walk-in customer**. The receipt's settlement is credited 4,000, allocated 0, outstanding 0.
  - The cash payment is REVERSED. Its mirror is **Cr 1000 4,000 C3, Dr 1200 4,000 Walk-in customer**, and the till C3 is back from 4,000 to **0**.
  - One reversing stock movement, sourced from the credit note, posts **Dr 1330 2,400, Cr 5020 2,400**, and the yams are back on hand to the unit.
  - The history shows PLACED and COMPLETED (by the cashier), then VOIDED (by the Owner). There is one `ord.OrderVoided` with abuse case 1.
  - The trial balance is **0**. A second void is `INVALID_STATE_TRANSITION` `VOIDED`.
- **A supervisor cannot approve the void of their own sale.** On the Manager's own sale, the Manager's approval is 422 `MAKER_CANNOT_CHECK` and the sale stays COMPLETED. The Owner's rejection leaves it COMPLETED with the till untouched (2,000 on C4), the void REJECTED, and a new request is accepted.
- **The database holds the checker.** Direct SQL voiding a sale with `voided_by` its poster, or its salesperson, is refused by `ck_sales_order_void_checker`. A void written APPROVED is refused (HK004).
- **The day closes the void.** Just past Accra midnight, a new request is `VOID_DAY_CLOSED`, and the approval of yesterday's request is refused the same way. The sale stays COMPLETED and the trial balance is 0.

**B9a's one-transaction proof stands:** `sale-posting.integration.spec.ts`, `order-payment-rules.integration.spec.ts` and `orders.integration.spec.ts` pass unchanged (64 ORD integration tests in all).

Unit: `src/modules/ord/domain/reversal.spec.ts` (9 tests) checks the exact deposit (84,000 and 1,999 less 1 refunded gives **85,998**), every status the cancellation refuses, every void refusal named at once, and the approver rule. The file is at 100 percent statements, branches, functions and lines. `src/modules/bil/domain/billing.spec.ts` gains the admitted `VOID` domain.

## Test first, as it honestly happened

- **The domain:** the unit spec was written first and failed red because the module did not exist. Its first green run failed once more on a call to a `Money` method that does not exist (`isPositive`), which was fixed in the code.
- **The integration spec** was written after the application code and before it was ever run, so it was not red before the code existed. Its first runs were red for real defects, each fixed in the code and never by loosening a rule:
  - ORD's module constructor lacked its `@Inject` decorators;
  - `ord.order_void`'s update did not move its version;
  - a void's refusals were not all named at once (the reason is now judged with the rest).
- **Test-side corrections:**
  - the direct-SQL updates had to move the version, as the version trigger demands;
  - the session lifetime was too short to cross midnight;
  - the mirror is read from the reversing payment, as PAY's own tests read it;
  - the journals' line order.
- **Stale tests updated because this phase made them stale:**
  - three IAM tests used `SALE_VOID` as an unbuilt probe kind (now `QUOTE_BELOW_MARGIN`, B10's);
  - the Cashier's sign-in permission list;
  - the handler walk and the contract body map list the two routes;
  - the drift counts;
  - the 0155 rollback list.
- Nothing was skipped, quarantined or retried, and no test was re-run to turn it green.

## Decisions

- **No new ADR.** The four lower-module methods are commands down in the caller's transaction (ADR-0010), the pattern of `Billing.issueIn` and `Payments.recordIn`; none is an inverted port. No ADR is contradicted.
- **A void reverses its payments instead of refunding them.** ADR-0066 says a void's refund is a reversal or store credit; the reversal's mirror gives the till back exactly what it took. So a void is limited to cash and store credit tenders.
- **The void's approver is held twice.** It is held in the application, and in the database by columns on the order itself (`voided_by` against `created_by` and `salesperson_id`), so no cross-schema read is needed.

## Security review (hakorem-security-review)

- **Boundary:** TB2, the authenticated back office.
- **Standards:** run against `SECURE_CODING_STANDARDS.md` item by item. Identity, sessions, uploads, exports, webhooks and encryption are not touched by this change. The webhook path is exercised only through the existing clearing.
- **Authorisation:**
  - Both handlers authorise in `OrderReversals`, first without a scope and then at the order's branch, and both routes declare their permission.
  - The new permissions were seeded to no role (0190) and granted in their own migration (0191).
  - Deny by default is proved for every wrong role and another branch.
- **Maker and checker:** a void is never approved by its asker (IAM), its poster or its salesperson (application and database). Its refund is never approved by the canceller (PAY's `REFUND`, with step-up).
- **Input:** zod strict objects; parameterised SQL only.
- **Money:** integer pesewas through `Money`. The refund amount is computed from the payment's own figures, never from the client, and is exact.
- **Idempotency:** both writes claim the key first.
- **Audit:** before and after values on every write, and on the approval's effect.
- **Logging:** no personal data added.
- **Rate limit:** the `console` group.
- **Abuse paths:**
  - **Case 1** is blocked by the supervisor rule and published for the daily exception report on every request and every void (B12 builds the report; `SALE_VOID`).
  - **A residual note:** a cashier could ask for voids repeatedly to probe supervisors. Each request is published, so the void rate by cashier is computable. No new exception kind is needed.
  - **Cancellation:** a cancellation cannot move money out. It only asks for a refund that a different person approves, and every refund request already reaches the report (case 12).

## Deferred

To **B09a continued 2d**, with its opener carrying them unchanged:
- returns with their trigger, proved under concurrency, refunded against their own credit note;
- price override limits and their approval;
- `issueProforma`;
- `placeOrder`, `trackOrder`, `listMyOrders` and `getMyOrder`;
- the dashboard's six B9a figures (a VOIDED order is not a sale), `getSalesTodayTile` and `getSalesSeries`;
- the seeded trading day;
- CR-029 through `placeOrder`.

To **B11**: cancelling an order once picking has begun (returning picked stock with `cancelFulfilment`).

To **B9b**: the void's "same shift" read from the shift itself, once shifts exist; until then the business day stands for it.

## Contract requests

I fetched the frontend's `main` at `0efb338` (the same commit B09a continued 2b read). It lists CR-001 to CR-033, and nothing is new or changed.
- **CR-013** (the owner dashboard's figures): **not built here; it moves to B09a continued 2d** with the dashboard's sales figures. This is scheduling, not a decline.
- **CR-031, CR-032 and CR-033** stay placed in B9b, with B11 for CR-033's SMS. **CR-005, CR-023, CR-027 and CR-028** stay with B09x. CR-029's proof through `placeOrder` is 2d's. The others were answered in earlier phases.
- No request is larger work that is unplaced.

## Tests (this machine, 2026-11-17)

| Layer | Result |
| --- | --- |
| Unit | **1,426 passed** (new: 9 in `ord/domain/reversal.spec.ts`, 1 in `bil/domain/billing.spec.ts`) |
| Integration | **1,403 passed**, ORD's 64 among them (new: 14 in `ord/order-reversals.integration.spec.ts`) |
| Coverage, merged (`pnpm test:coverage`) | **2,829 passed**, 228 files, exit 0, on `1eb5afe`. Statements 93.65 percent, branches 83.43 percent (gate 80), functions 97.13, lines 96.27. Every 100 percent gate held, the new `src/modules/ord/domain/reversal.ts` included. The first full run, on `922d046`, failed 1 test: `mdm/reference-data`'s count of reason codes, stale after migration 0192 (52, now 54). It was fixed in `1eb5afe`. It was stale, not flaky, and nothing was re-run to turn it green |
| Contract | **96 passed**, 37 files. `contract:generate` is up to date (409 from code, 226 planned); Redocly is clean, with no warnings |
| Lint, typecheck | Clean. Locally, eslint was run with `.claude/**` ignored; the test placement check found all 273 specs in place; schema names and lint fixtures pass |
| End to end | CI only |

## Gate

**Passed for the part built; the phase split (A-227).**
- **Cancellation:** it releases the order's reservations and pending charges and asks for the refund of what was paid in one transaction, proved by a refused refund that leaves all three untouched.
- **The void:** it is approved only by a supervisor who is neither the asker nor the cashier, held in the application and the database. It leaves the order, a credit note of the full receipt and reversing entries for the payment and the stock, with the trial balance at 0.
- **Every ORD write built so far refuses the wrong role and another branch.**
- **B9a's one-transaction proof** of `SalePosting.postIn` stands unchanged.
- **The rest of the opener's gate** (returns by trigger under concurrency, a price below list approved by a different user, online placement, the dashboard's figures) is B09a continued 2d's.

## Notes for the frontend track

- **Contract 1.48.0:** `cancelOrder` and `voidOrder` are live.
- **`cancelOrder`** answers the order, now CANCELLED. Its refund appears in `listRefunds`, waiting for a different approver.
- **`voidOrder`** always answers 202. The approval inbox shows `SALE_VOID` with the order as its subject. The Cashier may ask; only the Owner or the Manager approve, and never for a sale they made.
- **A void is refused for a sale paid by mobile money, card, cheque or bank transfer** (`TENDER_NOT_VOIDABLE`), and after the sale's day (`VOID_DAY_CLOSED`). Use a return (2d) for those.

## CI

- **`922d046`** (all code, tests and documents before the stale-count fix; pull request #75 was opened on it): run **44005366905 (push)** and run **44005398922 (pull_request)**, both **cancelled** before their tests finished, when `1eb5afe` was pushed (the workflow's concurrency group). Lint, the scans and the image had passed on the pull_request run. Nothing was re-run.
- **`1eb5afe`** (the stale reason-code count fixed): run **44005616552 (push)**, success; run **44005622262 (pull_request**, which also compares the contract with `main`), success.
- A commit cannot name its own runs, so the push and pull_request runs on the final head (this report's commit) are named in the session's closing message. The pull request is merged with a merge commit only once every run on its head is green.

## Next session

B09a continued 2d, copied from `docs/prompts/session-openers.md`, where this phase inserted it.

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md (the B9a row).
List docs/sessions/ and read only the most recent report (docs/sessions/B09a3c-orders-reversals.md), and also
docs/sessions/B09a3-orders-online.md, the handoff of the orders work this phase continues.
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md): implement what is
reasonable, record in the report what you declined and why, never edit that file and never open frontend source.
For this phase, read the ORD (core) requirement block of docs/SRS.md and FR-RPT-001 (nothing else from the SRS),
docs/data-model/ord.md, the ORD, PAY, BIL and RPT cards in docs/MODULE_BOUNDARIES.md, DOMAIN_MODEL section 7,
ADR-0010, ADR-0021 and ADR-0026, the abuse cases 3 and 12 in docs/security/THREAT_MODEL.md, and A-149, A-200,
A-201, A-208, A-210, A-216, A-218, A-224, A-226 and A-227 in docs/ASSUMPTIONS.md, ADR-0063 and ADR-0066 (returns use
the refund against a credit note, built in B09a continued 1d), and ADR-0067 with A-217 (a rule's "now" is the
application clock's). Load hakorem-pricing, hakorem-money, hakorem-stock, hakorem-ledger, hakorem-documents,
hakorem-security-review, hakorem-endpoint, hakorem-migration and hakorem-tests. Use docs/prompts/module-build-prompt.md
as the recipe. Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B09a continued 2d only, on branch b09a3d-orders-returns, branched from main. B09a continued 2b and 2c
built ORD's order record and its reversals in `Orders` and `OrderReversals` (src/modules/ord/application/), with
the in-transaction ports they call: BIL's `Billing.creditIn` (a credit note issued at once under the caller's own
approval), PAY's `Refunds.requestIn` and `Receipts.reverseApprovedIn`, and INV's `Reservations.releaseHeldByIn`.
Build on them, each test-first with its wrong-role refusal: the permissions and grants of what follows; returns
against the original sale (createReturn, getReturn, submitReturn, `ord.order_return` and `ord.order_return_line`,
never more than sold less returned, by database trigger, proved under concurrency; submitReturn issues the credit note
through `Billing.creditIn`, posts the stock back through INV by its disposition and asks for the refund against that
credit note through `Refunds.requestIn`, approved by someone who is neither the return's maker nor the credit note's,
ADR-0066); price variance and override limits per role with approval by a different user (PRICE_OVERRIDE_NEEDS_APPROVAL
becomes an approval request, on createOrder and on the sale posting alike; the database already requires the approval
once an order is past PLACED); issueProforma (POST /orders/{id}/proforma) on Billing.issueIn (A-201); online order
placement and payment (placeOrder, trackOrder, listMyOrders, getMyOrder) on B09a continued's provider port (an order
confirms on pay.PaymentCleared only when it is not heldAsUnmatched; cancelOrder already releases the order's pending
charges and the late webhook clears as unmatched, proved in B09a continued 2c); and the owner dashboard's B9a figures
(A-149): remove `salesTodayPesewas`, `salesYesterdayPesewas`, `salesMonthToDatePesewas`, `salesByChannel`,
`salesSeries` and `topMovers` from RPT's PENDING_FIGURES and answer them from completed orders through a published
view (a VOIDED order is not a sale), and build the planned tiles getSalesTodayTile and getSalesSeries.
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
Stop at the gate, write docs/sessions/B09a3d-orders-returns.md, and merge into main when every run on the pull
request is green.
```
