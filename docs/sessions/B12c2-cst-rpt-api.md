# B12 continued 2: costing (the phase split after CST)

Date: 2026-11-24 · Branch `b12c2-cst-rpt-api`, from `main` at `063fe17` (#145, B12 continued) · Status: **gate passed locally; split after CST (A-389). CI and the merge are named below and in the closing message to the parent session.**

Run as a fresh agent inside the 2026-11-15 overnight session: the parent session cannot issue /clear or /compact, so each phase starts in a new context that reads only this handoff from disk.

## Assumptions made this session (in `docs/ASSUMPTIONS.md`, dated 2026-11-24)

| ID | What | Who confirms |
| --- | --- | --- |
| A-387 | **Costing as built.** (a) A posted allocation credits a new account, **5220 Labour and overhead absorbed into stock**, and debits inventory by GL group (`inv.OverheadAbsorbed`); wages and overheads stay gross. (b) The Accountant creates a run; **the Owner or the Manager posts it** with step-up (new permission `cst.allocation.post`; the planned contract named `cst.allocation.manage` for both), never its creator. (c) Head-days are each Africa/Accra day's whole head on hand in scope at the day's end; EQUAL one each; WEIGHT_GAIN refused (BL-128). (d) A breeding or laying animal's share, or one no longer on hand, is EXPENSED and posts nothing; a capitalised animal gone by posting time refuses the post (`UNIT_NOT_ON_HAND`). (e) Movements are dated when posted. (f) A run without a pen names its branch (`branchId`, added). (g) Charge and adjustment lines count under BY_PRODUCT (they post to 4030); a credit note's every line counts (its whole net posts to 4200); a delivery fee charged (4100) does not. (h) A cost object's elements are what was added to it. (i) Loss rates are null (BL-129). (j) The seed is not extended: the projections build themselves from the seeded farm's events; the report seed (CR-062) is B12 continued 3's. | Owner, Accountant |
| A-388 | **Break-even.** A line's fixed cost is its share by revenue (through `allocate`) of the period's operating expenses; units are the net units billed at the period's mix; break-even units rounded up, at the average net price (the SRS's rule, replacing the planned example's contribution-ratio figures). | Owner, Accountant |
| A-389 | **B12 continued 2 is split after CST** (ADR-0026 Amendments): **B12 continued 3** builds RPT with the daily exception report (every source unchanged, plus abuse case 72 and `cst.ProjectionDriftDetected`), CR-059 to CR-062 and API. | Owner |

**For the parent session to schedule:** **B12 continued 3** (`b12c3-rpt-api`, the new opener section inserted before B09r). It carries every remaining item of the B12 continued 2 opener unchanged: RPT and the daily exception report with every source (cases 2, 5, 12, 13, 27 to 29, 32, 34, 64 to 71, R18, PAY's breaks, the reused till token, CR-032's PIN sign-out), **CR-059 to CR-062**, the owner dashboard's move, **BL-108**, the proof of delivery's reused photograph, runReport for every code, and the public API; plus this phase's **abuse case 72** (`cst.OverheadAllocated`) and `cst.ProjectionDriftDetected`. None of that was started here.

**ADR conflicts: none. No stop.** ADR-0018 (inventory owns cost; CST posts through inventory's interface) holds: the allocation posts through `Stock.postIn`. ADR-0003's matrix gains one row (`inv.OverheadAbsorbed`, Dr inventory, Cr 5220; no existing row changed). ADR-0017 (maker never checks) holds in the application and the database. ADR-0023 (projections rebuildable, published views only). ADR-0067 (dates from the clock: `platform.app_now()` in the refresh functions, no `now()`). **ADR-0102** (new, Proposed) records the as-built choices. FR-CST-004 names `rpt.ProjectionDriftDetected`; an event is named for its publisher, so CST publishes `cst.ProjectionDriftDetected` (ADR-0102, DOMAIN_MODEL).

**Shared modules (additive only):** INV gains a movement type `OVERHEAD_CAPITALISE` (0363), the view `inv.pub_negative_stock_cost` and five columns at the end of `inv.pub_movement`; FIN gains account 5220, the posting event and rules (0364), `FinancialStatements.tradedNetDebitsIn`, and `inv.OverheadAbsorbed` in `STOCK_POSTING_EVENTS`; MDM gains `product_line` at the end of `mdm.pub_product` and `mdm.pub_reason_code` (0365); BIL gains `bil.pub_document_line` (0366); ORD (lane B's) gains `ord.pub_sale_order` and `ord.pub_sale_line` (0367); LIV gains `Animals.purposesIn` and `Batches.stockUnitsOfIn`; platform a document type (0362); IAM five permissions and grants (0369). Nothing existing changed in any of them. POS, PAY and `sale-posting.ts` untouched.

Phase, scope and gate, as confirmed at the start:
1. **Phase:** B12 continued 2, costing, reporting, the daily exception report and the public API (`b12c2-cst-rpt-api`, from `main` `063fe17`), the only lane building.
2. **Scope:** as the opener, planned from the start to split at the first boundary the context would not reach, after a merged green gate (the parent session's order: CST, then RPT and the exception report, then API).
3. **Gate:** the exception report's gate moves with RPT to B12 continued 3; CST's own gate here is FR-CST-001 to FR-CST-008's acceptance on the real engine, with the margin projection tying to the ledger on the seeded trading day. **Passed** (below).

## Baseline (before any change)

`pnpm test:coverage` on `main` at `063fe17`, in the phase worktree: **374 files, 4,472 tests passed, none failed or skipped. Statements 94.17 %, branches 83.77 %, functions 97.95 %, lines 97.30 %.**

## Contract changes

**2.47.0, minor** (its entry in `docs/CONTRACT_CHANGELOG.md`). No field or parameter removed or retyped. **LOUD, planned operations only:** `postOverheadAllocation` is checked as the new `cst.allocation.post` with step-up (it named `cst.allocation.manage`); the `getBreakEven` example is worked in whole units at the average net price (FR-CST-005). Eight CST operations move into code with their planned paths and shapes; additive fields always sent (`OverheadAllocationRun.createdBy`, `postedBy`, `postedAt`; `OverheadAllocationLine.treatment`, `movementId`; `MarginRow.revenueIsNegative`, `costIsNegative`; five on `MarginTotals`; nine on `BreakEvenLine`; `BreakEven.fixedCostPesewas`) and one optional (`OverheadAllocationCreate.branchId`); `ALLOCATION_INVALID` is new. 607 operations from code, 61 planned. Redocly clean, no warnings; `contract:generate --check` up to date.

## Built

| Item | What |
| --- | --- |
| Data | 0362 (document type `OVERHEAD_ALLOCATION`); 0363 (`OVERHEAD_CAPITALISE`, `inv.pub_movement`'s added columns, `inv.pub_negative_stock_cost`); 0364 (5220, `inv.OverheadAbsorbed` and its rules); 0365 (`mdm.pub_product.product_line`, `mdm.pub_reason_code`); 0366 (`bil.pub_document_line`); 0367 (`ord.pub_sale_order`, `ord.pub_sale_line`); 0368 (schema `cst`: the allocation run and line with their guards, the deferred sum check, the checker rule and one posted run a period; the three projections; five `SECURITY DEFINER` refresh functions); 0369 (permissions and grants). |
| CST domain | `allocation.ts`, `cost-object.ts`, `margin.ts`, `break-even.ts`, `losses.ts`, all under a new 100 percent gate (`src/modules/cst/domain/**`). |
| CST application | `OverheadAllocations` (create, list, get, post; `cst.OverheadAllocated` on posting), `CostingReports` (cost objects, margins, break-even, losses), `CostingProjections` (the consumer `cst.costing-projections`, the rebuild, the ledger comparison, the nightly job). |
| Interface | `CostingController`, eight fragments, zod schemas; the worker's `costing-drift` job (02:50 daily). |
| Docs | ADR-0102 and its index row; ADR-0003 and ADR-0026 Amendments; A-387 to A-389; BL-128, BL-129; abuse case 72 (and cases 68 to 71's reader moved to B12 continued 3); `data-model/cst.md` as built; the CST card; DOMAIN_MODEL's CST events; API.md (Costing); OPERATIONS (the job); the drift runbook's costing section; the changelog; the openers (B12 continued 3 inserted before B09r, the reference table, B13 reads B12 continued 3's report). |

## The gate, proved by running it

**Unit, written first and run red (no module):** `src/modules/cst/domain/costing.spec.ts` (29 tests): **30,001 over head-days of 10, 10 and 5 is 12,001, 12,000 and 6,000**; a tie of 9,001 by tag; a tie of one tag by id; the largest amount; nothing to spread, no weight, a unit twice; head-days of an animal and a flock; capitalised or expensed by purpose; posted only from a draft and never by its maker; **purchase 60,000, feed 8,400 and veterinary 3,000 sum to 71,400**; a consumed unit's elements whole, split by `allocate`, reversed; **a processing order of input 71,400 plus direct 5,000**; **85,000 against 71,400 is 13,600 and 16.00**; credits taken back; a loss and a price above list; the percent's half, below, above, zero and the maximum; **fixed 600,000 at 85,000 with 71,400 variable breaks even at 45 heads and 3,825,000**; no break-even at nothing or less; fixed costs by revenue; contribution shares summing to 100.00; **the doe at 62,500 under mortality and 8,000 under wastage**, a reversal taking one back. 100 percent statements, branches, functions and lines.

**Integration, the real engine** (`test/integration/cst/costing.integration.spec.ts`, 11 tests): FR-CST-001: G-0142's view by element equals its cost pool, 71,400; a pen is the animals in it; a processing order shows 60,000, 8,400, 3,000 and 5,000 (76,400) and its output lot 76,400 under PROCESSING; a rebuild gives identical rows; another branch's manager gets 404 for a real and a made-up unit alike; the Cashier refused every read. **FR-CST-002: the Accountant's run of 30,001 over G-0201, G-0202 and G-0203 (10, 10 and 5 head-days) is 12,001, 12,000 and 6,000, a draft that moves nothing; the Accountant cannot post (403), the Cashier cannot create or read; the Owner's own run refused to him (422 `MAKER_CANNOT_CHECK`); a period after today, WEIGHT_GAIN, a virtual scope and an empty store refused; the Manager posts it with step-up: three OVERHEAD_CAPITALISE movements, the pools 62,001, 62,000 and 56,000, three journals Dr 30,001 Cr 5220 30,001, `cst.OverheadAllocated` with 30,001 capitalised, maker and checker apart, abuse case 72; after the outbox, G-0201 reads PURCHASE 50,000 and LABOUR 12,001; a second post refused (`ALREADY_POSTED`), a twin run for the same period refused (`PERIOD_ALREADY_POSTED`); the list pages; the database refuses a changed line (HK004), lines that do not sum at commit (HK010), a changed posted run (HK004), a run posted by its maker (23514) and a delete.** FR-CST-007: the doe at 62,500 under Mortality and the expired lot at 8,000 under Wastage, by cause and by location, cost of sales 0.

**Integration, the seeded trading day** (`test/integration/cst/margins.integration.spec.ts`, 7 tests): the margin facts kept by the consumer as the outbox delivered them equal, row for row, a rebuild from the published views; **by every one of the six dimensions the groups add up to the totals, and the totals equal the ledger's net revenue (4000 to 4030 less 4200, 4210 and 4220), cost of sales (5000 to 5030) and price variance (4210) to the pesewa**; each percent is margin over price; a range after today refused. **FR-CST-004: the comparison finds no drift; deleting one cost row makes it report one drift (cost below the ledger, one `cst.ProjectionDriftDetected` in the outbox); the rebuild restores equality.** FR-CST-005/006: break-even's lines are the margins by product line, their contributions sum to the total margin and their fixed costs to the period's. **FR-CST-008: twelve cost objects (every seeded stock unit and two locations) read identically after the three projections are emptied and rebuilt.**

**Contract:** `test/contract/b12c2/costing.contract.spec.ts` (2 tests): every CST response in its contract shape (`MarginReport` for six dimensions, `BreakEven`, `LossReport` for four, `CostObjectSummary`, `OverheadAllocationRun`, `OverheadAllocationRunPage`, `Error`).

Tests written after their code: the integration and contract specs were written after the application layer; the domain spec for money and weights was written first and seen red.

## Security review (hakorem-security-review, SECURE_CODING_STANDARDS.md item by item)

Boundary crossed: TB2 back office (costing), TB8 the database. No upload, export, webhook, payment provider call, secret or personal data beyond ids.
- **Identity, sessions and browser:** unchanged mechanisms; no cookie added or widened. Every write takes the CSRF token and an idempotency key; posting needs a fresh step-up.
- **Authorisation:** deny by default, every handler authorises through the policy engine (the walks name the eight operations; `test/integration/iam/authorisation`, `no-id-is-a-key`); branch scope on every read, whole-branch grants only, and a run or cost object of another branch answers exactly as a made-up one (404); maker never checker in the application and the database (`ck_overhead_allocation_checker`); the new permission `cst.allocation.post` granted only to the Owner and the Manager.
- **Input:** zod on every body, path and query; unknown fields refused; parameterised SQL only; the margin group key is chosen from a fixed map, never from input.
- **Money paths:** integer pesewas; splits only through `allocate`; one rounding per figure; the posting is the ledger's, in the same serializable transaction; a drift is reported, never corrected.
- **Data protection and logging:** customers and staff appear as ids and names only; no contact details in any projection or event; the drift log carries figures only.
- **Database:** classes and grants by class (DOCUMENT for the runs, PROJECTION read-only to the application, written only by `SECURITY DEFINER` functions with `search_path = pg_catalog`); runs and lines refuse delete and truncate.
- **The parent's abuse paths:** an investor seeing another's figures, a distribution paid without step-up, an export leaking personal data, a public API key too wide, a webhook replayed or forged: none touched here (CAP unchanged; exports and the public API are B12 continued 3's). Maker and checker the same person: refused three ways for the allocation.
- **New abuse path:** case **72** (cost moved out of the period into stock by an allocation), with its controls and tests; its exception report item reads `cst.OverheadAllocated` in B12 continued 3. Residual risk R1 (maker and checker colluding) covers the rest. Findings: none open.

## Contract requests (the frontend's `main` at `43acd8f`, unchanged since B11u continued)

No request names CST. **CR-059 to CR-062** (the exception report's review and kinds, the egg reports, the VAT return, the exports and the report seed) are RPT's and move, unchanged, to **B12 continued 3**. **CR-063** (the till's list of drivers holding cash) was answered in 2.35.0 (`listShiftDriverCashHolders`). Every other request is answered in its phase, as the last reports left them.

## Tests (this machine)

| Layer | Result |
| --- | --- |
| Unit and integration, the whole suite (`pnpm test:coverage`, after the last code change) | **4,519 passed, 377 files, none failed or skipped** (on `e11c06d`, after the DEL fix below; only this report followed). Coverage: statements 94.19 %, branches 83.70 %, functions 97.91 %, lines 97.30 % (baseline 94.17, 83.77, 97.95, 97.30: the new application layer's refusal branches are covered by the integration specs in part; no threshold moved). Every full-coverage gate held, the new `src/modules/cst/domain/` at 100 percent. Earlier whole runs: one started on `acdf8ec` failed one test, `cst/costing`'s posting test, because `cst.OverheadAllocated` was added to the code and the spec while that run was in progress; the spec passed on its own on `2bf804a`, and a whole run on `00605c3` passed (4,519, 377 files). |
| The new specs | `costing` 29 (unit); `cst/costing` 11, `cst/margins` 7 (integration); `b12c2/costing` 2 (contract) |
| Contract (`pnpm test:contract`) | 144 tests, 57 files, passed |
| Lint (ESLint with module boundaries, fixtures, placement, schema names), typecheck, Redocly, `contract:generate --check` | Clean (607 operations from code, 61 planned) |

**A failing test in CI, fixed at its cause (`e11c06d`, its own commit):** push run 45479725836 (on `3a75046`) failed shard 3: `del/scheduling`'s "books eight deliveries into a slot of five at once" got two `SLOT_FULL` where three were due, and the next test, which reads a booked slot, failed after it. The same commit's `pull_request` run (45479810761) passed it, as every local run had. Cause: eight concurrent reschedules into one slot conflict on the slot's row at serializable isolation, and on a slow runner one ran out of its five attempts. Proved by making it fail on purpose: with the unit of work allowed one attempt, the test failed with 1 of 8 booked. Fix: `rescheduleDelivery` names the target slot in `seriesLocks`, the advisory lock taken before the transaction begins (ADR-0005), so bookings of one slot run in turn; with one attempt allowed the test then passes (the limit restored to five). No rule or answer changed. Nothing was re-run to turn red green.

Existing specs changed only for what this phase added: the rollback walk (0362 to 0369), the deny-by-default handler walk (eight operations; `:objectType` filled as `STOCK_UNIT`), the identifier walk (`listLosses` and `listOverheadAllocations` take no identifier; `:objectType` filled), the valid bodies and queries (one body, three queries), the request schema table (one body), and the drift test's counts and its still-planned example (`listApiCredentials`, since `getCostObject` moved into code). No expectation weakened, nothing skipped.

## Deferred

- **To B12 continued 3** (the opener inserted before B09r): RPT with the daily exception report and every source (abuse case 72 and `cst.ProjectionDriftDetected` added), CR-059 to CR-062, the owner dashboard's move, BL-108, the proof of delivery's reused photograph, runReport for every code, the public API.
- **BL-128** (allocation by weight gained), **BL-129** (loss rates per pen and handler).
- **Seed:** not extended for costing (A-387 (j)): the projections build themselves from the seeded farm's events as the worker delivers them; seeding an allocation run would move the ledger every other test asserts. CR-062's report seed is B12 continued 3's.

## Questions for the owner

1. **A-387 (a):** a posted allocation credits a new account 5220 (labour and overhead absorbed into stock), leaving wages and overheads gross in their own accounts. Agreed, or should it credit the expense accounts themselves?
2. **A-387 (b):** the Accountant creates an allocation and the Owner or the Manager posts it. Agreed?
3. **A-388:** break-even assigns each line its share of the period's operating expenses by its revenue. Agreed, or should fixed costs be assigned to lines by hand?

## Notes for the frontend track

- **2.47.0.** The eight costing operations are live. `postOverheadAllocation` needs `cst.allocation.post` (the Owner, the Manager) and a fresh code; the creator never posts (`MAKER_CANNOT_CHECK`). A run without a pen names `branchId`. Every margin figure is a size with an `...IsNegative` flag beside it, and `marginPercent` is margin over the selling price, null with no revenue. Break-even carries the per-unit figures and whole break-even units; `listLosses`' rates are null.

## CI

A report cannot name the runs of the commit that adds it. Pull request #146. On `3a75046` (the first push, the report's first version): **45479810761, `pull_request`, success**; **45479725836, `push`, failure** (shard 3, the DEL concurrency failure above, and the coverage gate on the missing shard). Not re-run: fixed at its cause in `e11c06d` and pushed as a new head with this note. Every run on the final head is named in the session's closing message to the parent session, and the pull request merges only when each is green.

## Next session

B12 continued 3 (`b12c3-rpt-api`, from `main`), exactly as `docs/prompts/session-openers.md` carries it:

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B12c2-cst-rpt-api.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md): implement what is
reasonable, record in the report what you declined and why, never edit that file and never open frontend source.
For this phase, read the RPT and API requirement blocks of docs/SRS.md (nothing else from
the SRS), docs/data-model/rpt.md and api.md, the CAP, CST, RPT and API cards in docs/MODULE_BOUNDARIES.md
(CAP's and CST's for the events they publish), and ADR-0023, ADR-0100, ADR-0101, ADR-0102 and ADR-0026 (the daily
exception report), and section 4 of docs/security/THREAT_MODEL.md (the eighteen abuse cases and the
exception kind each names, and cases 68 to 72). Use docs/prompts/module-build-prompt.md as the recipe.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B12 continued 3 only, on branch b12c3-rpt-api, in this order (CAP was finished in B12 continued,
ADR-0101, and CST in B12 continued 2, ADR-0102: never change their answers):
1. RPT: the reporting read model with its projections and checkpoints, report definitions and schedules, and, as
   ADR-0026 proposes, the daily exception report: GET /exceptions/daily-report, with an item kind for every one of the
   eighteen abuse cases, each item carrying its abuse case numbers, actor, amount and subject document, so that B13
   can assert it.
The exception report must include order splitting (abuse case 27, owner 2026-11-15, A-168): read
PUR's PurchaseOrders.splitSuspectsIn for the report's day and report each run with its maker, supplier,
orders and total; and the payout changes of case 13 from pur.SupplierPayoutChangeRequested and
pur.SupplierPayoutChanged, with SA-17's payment within 24 hours after a change.
It must include case 28 (B07 continued 1b, A-172): each invoice paid on an approved variance
(pur.SupplierInvoiceMatched or ExpenseInvoiceApproved with varianceApprovalRequestId) and each approved supplier
credit note (pur.SupplierCreditNoteApproved with its returned movements), with maker, approver and amount.
It must include PAY's breaks and reversals (the owner, 2026-11-16, B09a continued 1b): every reconciliation break of
every kind (from the provider sweep, from webhooks, from settlement and bank statement matching, and REFUND_FAILED)
read through the published view pay.pub_reconciliation_break, each with its kind, payment or reference, amount, age
and state; every payment mismatch found against Paystack among them; and each pay.PaymentReversalRequested (abuse
case 32) with its maker, amount and reason, beside pay.RefundRequested (case 12) and pay.WebhookRejected (case 5).
It must include case 2's reused death photographs (B06r, A-175): each liv.MortalityPhotoReused with the record,
the reporter and the earlier records whose photograph had the same bytes; and case 29 (A-176): every processing
reversal from prc.ProcessingOrderReversed with its value, the threshold copied onto it, the maker, the approver
when one was needed, and the reason. Residual risk R18 (B07 continued 2): count the storefront checkouts
started and expired per address a day from shp.CheckoutStarted and shp.CheckoutExpired, as an item when one
address holds stock repeatedly without placing an order.
It must include case 34, inflated rejections at the door (B09e continued 3, A-272, ADR-0076): a RECEIPT_CLAIM item for
each pur.SupplierClaimRaised, with the receipt, the receiver, the claim's maker, the supplier, the rejected quantity,
its reason and its value. And every exception source B9b, B09c, B11 and B11u add (their reports name each one; B11u: `quo.QuoteIssued.holds` for case 64 and `quo.QuoteWithdrawn` for case 65; B11u continued: `quo.AcceptedQuoteLapsed` for case 66 and `backorderHeldQty` on `ord.OrderDispatched` and `ord.OrderCollected` for case 67), at least
each reused till receipt token (a possible till fault or tampering, owner 2026-11-17) and each supervisor's PIN
sign-out of a locked cashier (CR-032).
   And CAP's own (B12, abuse cases 68 and 69): each `cap.CapitalWithdrawn` with who asked and who approved, each
   `cap.DistributionDeclared` and `cap.DistributionPaid` with the maker, the checker and the amounts, each
   `cap.CapitalContributed` whose value date is before the day it was recorded, and each run whose retention rate is
   not the owner's 40 percent. And B12 continued's (abuse cases 70 and 71, ADR-0101): each
   `cap.InvestorPayoutChangeRequested` and `cap.InvestorPayoutChanged` with the maker, the checker and the masked details
   before and after, with a distribution payment within 24 hours after a change; each loan or grant drawn
   (`cap.LoanDrawn`, `cap.GrantReceived`) with its maker and approver, and each `cap.LoanRepaid` with who recorded it;
   and each month of a loan or grant the daily accrual job could not accrue (`financing-accrual`'s `blocked`). And CST's own
   (B12 continued 2, abuse case 72, ADR-0102): each `cst.OverheadAllocated` with its maker, its checker, the period and the
   amounts capitalised and expensed, and each `cst.ProjectionDriftDetected` with both figures. And BL-108: a mobile money success the provider reports after the payment had failed
   is raised as a break (`PROVIDER_PAID_AFTER_FAILURE`), as a card's is, and reaches the exception report; PAY is
   shared: build it additively.
The owner dashboard was pulled forward to B05x (A-149): keep getOwnerDashboard's shape, add its caching and the
NFR-023 performance budget, move its reads onto the hk_report connection, and remove `alerts` and
`exceptionsToday` from RPT's PENDING_FIGURES once the daily exception report answers them. runReport must implement
every report code listReportDefinitions lists, SALES_SUMMARY and PURCHASES included (CR-018), each matching its
contract example's columns.
The owner, 2026-11-16 (A-212 (a)): investor capital arrives through the investor module to the bank, never as cash.
The owner, 2026-11-23 (from the frontend's F12 and F10n): build CR-059 to CR-062. Every margin is over the selling price, (price less cost) over price, and anything over cost is markup and named markup (the owner, 2026-11-23), CR-060's margin per crate included. Grant the report and exception
report permissions to the Owner and the Manager (and the Accountant for the financial reports). Give each of these
controls its own exception type: cash drops (witnessed or not), reused photographs, quotes accepted in a staff session,
late cash after a shift closed, and negative stock after an offline sale. Add marking an exception reviewed with a note,
the egg report codes, the VAT return, and the statement and exception report exports. Notes:
- "quotes accepted in a staff session" is the possible staff acceptance of B10 continued 6 (the decision's address and
  browser matched against staff sessions active from the same address in the last 24 hours, never a cookie);
- "reused photographs" means a proof-of-delivery photograph or signature whose content hash matches an earlier upload
  (beside case 2's death photographs); none of B11 continued 6 to 13 recorded that match (B11 continued 13, A-291), so this phase must: record on the proof of delivery whether its photograph or signature matches an earlier upload's SHA-256 in `platform.stored_file` (as liv.MortalityPhotoReused does) and publish it;
- each existing exception kind keeps working, and any rename is LOUD.
2. API: the public API with keys and webhooks.
Stop at the gate and write docs/sessions/B12c3-rpt-api.md.
```
