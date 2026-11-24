# B12: capital, investors and profit distribution (the phase split after CAP's gate)

Date: 2026-11-24 · Branch `b12-capital-costing-reporting`, from `main` at `deabe9d` (#143, B11u continued) · Status: **gate passed locally; split after CAP (A-383). CI and the merge are named in the closing message to the parent session.**

Run as a fresh agent inside the 2026-11-15 overnight session: the parent session cannot issue /clear or /compact, so each phase starts in a new context that reads only this handoff from disk.

## Assumptions made this session (in `docs/ASSUMPTIONS.md`, dated 2026-11-24)

| ID | What | Who confirms |
| --- | --- | --- |
| A-380 | **Capital as built.** (a) Units are the amount over the unit price exactly, never rounded (`UNITS_NOT_EXACT`). (b) The unit price is GHS 100.00 unless given (UAT 3.5, the contract's default). (c) A contribution needs no approval; a withdrawal always does (FR-CAP-003 and FR-CAP-004 as written). (d) A value date after today, or in a locked, closed or missing period, is refused; one before the ledger's first period (1 January 2026) posts on that period's first day, its units still counting from the value date. (e) Investors are INV-001, INV-002 in order. (f) Payout details, the identity number, documents, the agreement, the portal login, the statement, return metrics, loans and grants are B12 continued's; `createInvestor` and `updateInvestor` refuse those fields (`FIELD_NOT_YET_SUPPORTED`). (g) The seed's investors and the July to September 2026 trading summary are UAT's fixed historical dates and load only with `seedUnits(env, { investors: true })` (`pnpm db:seed` always). | Owner, Accountant |
| A-381 | **Who keeps the investor books.** Kept at the head office branch (every CAP permission checked there); the Owner and the Accountant only, the Manager none; the Owner also holds the maker's permissions (IAM lets a granter grant only what they hold) and is the only checker; the maker never checks. A fresh step-up for changing the register, recording capital, posting a run and recording a payment to an investor (the last added: money leaving the farm), and for both approvals. | Owner |
| A-382 | **A submitted distribution run is never edited.** "Editing a submitted run voids the approval" is held by refusing every edit once submitted (`RUN_NOT_EDITABLE`, the database's guard): the approval decides exactly what was submitted and the schedule archived then; a run that must change is rejected or withdrawn and drafted again. A draft may be recomputed at will, each computation kept. | Owner, Accountant |
| A-383 | **B12 is split** after CAP's gate (ADR-0026 Amendments): **B12 continued** builds the rest of CAP with the portal, CST, RPT with the daily exception report and API, in that order, splitting again if it must. | Owner |

**For the parent session to schedule:** **B12 continued** (the new opener section, inserted before B09r). It carries every remaining item of the B12 opener unchanged: the rest of CAP (FR-CAP-002, 013, 014, 015, the portal, UAT 4.10 and 4.11), CST, RPT and the daily exception report with every source the B12 opener named (cases 2, 5, 12, 13, 27 to 29, 32, 34, 64 to 67, R18, PAY's breaks, the reused till token, CR-032's PIN sign-out) plus CAP's cases 68 and 69, **CR-059 to CR-062**, the owner dashboard's move, **BL-108** and the proof of delivery's reused photograph, and the public API. None of that was started here.

**ADR conflicts: none. No stop.** ADR-0028 is implemented as written (its five tests under their names); ADR-0003's CAP rows are migration 0354; ADR-0017 (maker never checks) holds in IAM, the application and the database; ADR-0067 (no `now()` in business SQL; dates from the clock in the tests). **ADR-0100** (new, Proposed) records the as-built choices.

**Shared modules (additive only):** FIN gains `FinancialStatements.netProfitIn` and `Periods.allIn` (reads) and four translators in `LedgerPostings`; platform gains three document types (0352); DOC one template (0357); IAM ten permissions, two approval policies and grants (0355, 0356); the seed one unit behind an option; the contract 2.45.0. Nothing existing changed in any of them. POS, IAM's code, PAY and `sale-posting.ts` untouched.

Phase, scope and gate, as confirmed at the start:
1. **Phase:** B12, capital, costing, reporting and the public API, and the daily exception report (`b12-capital-costing-reporting`, from `main` `deabe9d`), the only lane building.
2. **Scope:** as the opener; planned from the start to split at the first boundary the context would not reach, after CAP's gate (the parent session's order: CAP, CST, RPT and the exception report, API).
3. **Gate:** a distribution matches a hand calculation on unit-days and ties exactly to the ledger. **Passed** (below).

## Baseline (before any change)

`pnpm test:coverage` on `main` at `deabe9d` (in a clean worktree of it): **367 files, 4,381 tests passed, none failed or skipped. Statements 94.25 %, branches 84.17 %, functions 98.00 %, lines 97.31 %.** (A first baseline run in the phase worktree was spoiled by a second coverage run started beside it, which removed its coverage directory; no test had failed. It was rerun cleanly in a separate worktree of `main`.)

## Contract changes

**2.45.0, minor** (its entry in `docs/CONTRACT_CHANGELOG.md`). No field or parameter removed or retyped; no shared schema changed. Sixteen planned CAP operations move into code with their planned paths, permissions and shapes (`listInvestors`, `createInvestor`, `getInvestor`, `updateInvestor`, `listCapitalTransactions`, `recordCapitalTransaction`, `getCapitalTransaction`, `getCapitalRegister`, `listDistributionRuns`, `createDistributionRun`, `getDistributionRun`, `recomputeDistributionRun`, `submitDistributionRun`, `postDistributionRun`, `getDistributionSchedule`, `recordDistributionPayment`). **LOUD:** the planned `submitDistributionRun` always answers 202 (its planned 200 is dropped); `createInvestor` and `updateInvestor` refuse `idNumber`, `payout`, `agreementFileId` and `createPortalLogin` until B12 continued (`FIELD_NOT_YET_SUPPORTED`); `recordDistributionPayment` now needs step-up; the planned `addInvestorDocument` is marked `x-requires-step-up` (its permission needs one). 583 operations from code, 83 planned. Redocly clean; `contract:generate --check` up to date.

## Built

| Item | What |
| --- | --- |
| Data | 0352 (document types `CAPITAL_TRANSACTION` `CAP`, `CAPITAL_WITHDRAWAL`, `DISTRIBUTION_RUN` `DST`); 0353 (schema `cap`: investor, unit_holding, capital_withdrawal_request, capital_transaction, distribution_run, distribution_line, distribution_payment, with their triggers: the number, the exact units, the approved withdrawal, the holding never below nothing, the run's lifecycle and frozen figures, the checker, the deferred allocation sum, the payment cap, the period exclusion); 0354 (FIN's four posting event types and rules); 0355, 0356 (permissions, policies, grants); 0357 (the schedule template). |
| CAP domain | `domain/distribution/` (100 percent gate, uncommented in `vitest.config.mts`): units and shares, unit-days and holdings, distributable profit, the allocation through the kernel's `allocate`, the lifecycle, the payment cap. |
| CAP application | `Capital` (the register, contributions, withdrawals and their approval handler, the capital register as at a date), `Distributions` (draft, recompute, submit with the schedule rendered and archived after commit, the approval handler, post, pay, the schedule link, the archive consumer). |
| FIN (additive) | `netProfitIn`, `Periods.allIn`, translators for `cap.CapitalContributed`, `cap.CapitalWithdrawn`, `cap.DistributionDeclared`, `cap.DistributionPaid` (the bank or wallet by the account's own kind, read in FIN). |
| Interface | Two controllers, sixteen fragments, zod schemas. |
| Seed | `farm-cap.ts`: the five investors of UAT 3.5 and their six contributions (4,200 units, GHS 420,000.00), and one manual journal a month for July to September 2026 (net profit GHS 41,666.70), Accountant maker, Owner checker; loaded by `pnpm db:seed` and by the tests that read it. |
| Docs | ADR-0100 and its index row; A-380 to A-383; abuse cases 68 and 69; `data-model/cap.md` as built; the CAP card; DOMAIN_MODEL's CAP events; API.md (Capital and four error codes); the changelog; ADR-0026 Amendments; the openers (B12 continued inserted before B09r, the reference table, B13 reads B12 continued's report). |

## The gate, proved by running it

**Unit** (`src/modules/cap/domain/distribution/distribution.spec.ts`, 26 tests, written first and run red: no module): ADR-0028's Tests 1 to 4 under their names (`allocates an awkward amount across three investors without creating or losing a pesewa`: 630,474, 157,618, 211,909, sum 1,000,001, half-up each shown to lose a pesewa; `breaks a tie between equal remainders by investor number`: 34, 33, 33; `counts the contribution day and not the withdrawal day`: 1,000 unit-days; `refuses to allocate when all weights are zero`), the retention's rounding cases (exactly half, below half, zero, 0 and 100 percent, a loss), the withholding's, the largest amount, leap days, fractional units, UAT part A's 320,400 unit-days and five allocations. 100 percent statements, branches, functions and lines.

**Integration, ADR-0028's Test 5** (`test/integration/cap/capital-and-distribution.integration.spec.ts`, 11 tests, over the seeded farm with no seeded investors, a 90-day period ending on the last day of the third month after the clock's, the clock then moved on): `the posted distribution ties to the ledger`: 3300 debited 630,474, 157,618 and 211,909 (1,000,001) and 2300 credited the same against INV-001 to INV-003, the trial balance even. Also: investors numbered; the Manager, the Cashier and an Owner of another branch refused every read and write (403); the register's change without step-up refused; a contribution's units and its Dr 1100 Cr 3000; `UNITS_NOT_EXACT`, `VALUE_DATE_IN_FUTURE`, `BANK_ACCOUNT_UNKNOWN`, `PERIOD_NOT_OPEN`; a withdrawal of 600 of 500 refused, of 100 waiting (202, nothing moved), refused to its maker, refused without a fresh code, approved and redeemed from its date (Dr 3000 against INV-004); two withdrawals that together exceed: the second refused at approval, and **the database refusing the same row written by hand (HK010)**; capital rows never updated or deleted (HK001); the run refused over open periods; drafted 1,666,668, 666,667, 1,000,001 over 142,750 unit-days, the investor with none left out; recomputed to the same; submitted; recompute and post refused while pending; its maker refused; approved; the database refusing the maker as checker and a changed figure (HK004); posted; paid 300,000 then 330,474, 330,475 refused, a reused reference 409, the database refusing a line paid above net payable; the run `PAID` and 2300 at nil; the period distributed once.

**UAT scenario 4 at the desk** (`test/integration/cap/uat-scenario-4.integration.spec.ts`, 8 tests, the seeded farm with its investors): 4.1 the register as of 30 September 2026: 1,000, 500, 500, 200 and 2,000 units, 4,200 in all, GHS 420,000.00 paid in (Akwaaba 47.6190 percent of the units that day), the Manager refused; 4.2 net profit GHS 41,666.70; 4.3 refused while open, then July to September locked; **4.4 and 4.5: 92 days, 41,666.70, 40.00 percent, 16,666.68 kept, 25,000.02 to share, 320,400 unit-days; 92,000, 23,500, 30,500, 18,400, 156,000; 7,178.53, 1,833.65, 2,379.84, 1,435.71, 12,172.29; Kofi, Esi and Yaw marked with the extra pesewa; withheld 0.00** (the hand calculation of part A, to the pesewa); 4.6 and 4.7 Efua refused her own approval, Akua refused with a code older than five minutes and approving with a fresh one, the schedule archived and served; 4.8 3300 debited 25,000.02 in all, 2300 credited each investor's share, nothing posted for what is kept, the trial balance even; 4.9 Yaw paid by mobile money (Cr 1110 1,435.71), the others by bank, 2300 at nil for each, the run `PAID` at 25,000.02; 4.12 posted once and approved once, a second run over the quarter refused. **Steps 4.10 and 4.11 (the portal) are B12 continued's.**

**Contract:** `test/contract/b12/capital-distributions.contract.spec.ts` (2 tests): every CAP response in its contract shape.

Tests written after their code: the two integration specs and the contract spec were written after the application layer (the domain spec was written first and seen red); none passed before the code existed.

## Security review (hakorem-security-review, SECURE_CODING_STANDARDS.md item by item)

Boundary crossed: TB2 back office (the investor books), TB8 the database. No upload, export, webhook, payment provider call or secret.
- **Identity, sessions:** unchanged; the approvals and four commands need a fresh step-up (A-381 (c)).
- **Authorisation:** deny by default, every handler authorises its permission at the head office branch in the application layer (tested: Manager, Cashier and another branch's Owner refused every read and write); no identifier is a key (the walk covers the new operations); maker never checker in IAM, the handlers and the database (`ck_capital_withdrawal_request_checker`, `ck_distribution_run_checker`); the approval's payload hash covers the run and every line, and a submitted run never changes.
- **Input:** zod on every body and query, unknown fields refused; parameterised SQL only.
- **Money paths:** integer pesewas, one half-up each for retention and withholding, splits only through `allocate`; posting in the business transaction; money only through the farm's own accounts (never cash, A-212 (a)); idempotency keys; a payment's reference unique.
- **Data protection:** investor data confidential, read by the Owner and the Accountant only; no payout detail is stored or decrypted yet (refused until B12 continued); no personal data in the posting payloads beyond the investor's name for the subledger.
- **Database:** classes and grants by class (the projection written only by a SECURITY DEFINER trigger); ledger rows reject update, delete and truncate.
- **The parent's abuse paths:** an investor seeing another's figures (no investor read is built yet; the portal is B12 continued's, under its own subdomain from B13); a distribution paid without step-up (refused: step-up on post and pay, A-381 (c)); maker and checker the same person (refused three times); an export leaking personal data, a public API key with too wide a scope, a webhook replayed or forged (none built here: B12 continued's API).
- **New abuse paths:** cases 68 (investor money taken out) and 69 (profit shifted between investors), with their controls; their exception items are B12 continued's (the daily exception report). Findings: none open.

## Contract requests (the frontend's `main` at `43acd8f`, unchanged since B11u continued)

No request names CAP. **CR-059 to CR-062** (the exception report's review and kinds, the egg reports, the VAT return, the exports and the report seed) are RPT's and move, unchanged, to **B12 continued** with the rest of RPT (named at the top for the parent session). Every other request is answered in its phase, as the last report left them.

## Tests (this machine)

| Layer | Result |
| --- | --- |
| Unit and integration, the whole suite (`pnpm test:coverage`, after the last code change) | **4,426 passed, 370 files, none failed or skipped** (on `873861f`, after the last code and spec change; only docs followed). Coverage: statements 94.19 %, branches 83.94 %, functions 97.98 %, lines 97.27 % (baseline 94.25, 84.17, 98.00, 97.31: the new application layer's error branches are covered by the integration specs only in part; no threshold moved). Every full-coverage gate held, the new `src/modules/cap/domain/distribution/` at 100 percent. A first whole run (on `a72a671`) failed one test, the deny-by-default handler walk, which did not yet name the sixteen CAP operations: fixed in its own commit and the whole suite run again. |
| The new specs | `distribution` 26 (unit), `capital-and-distribution` 11, `uat-scenario-4` 8 (integration), `capital-distributions` 2 (contract) |
| Contract (`pnpm test:contract`) | 141 tests, 56 files, passed |
| Lint (ESLint with module boundaries, fixtures, placement, schema names), typecheck, Redocly, `contract:generate --check` | Clean (583 operations from code, 83 planned) |

Existing specs changed only for what this phase added: the rollback walk (0352 to 0357, and its safety cap from 200 to 300 steps, which the walk from 0357 down to 0155 now needs), the identifier walk (four operations that take no identifier; five request bodies), the drift test's counts and its still-planned example (`listFinancing`, since `listInvestors` moved into code), the request schema table. No expectation weakened, nothing skipped.

## Deferred

- **To B12 continued** (the opener inserted before B09r): everything of the B12 opener not built here (above), with CR-059 to CR-062 and BL-108.
- **Seed:** extended (`farm-cap.ts`).

## Questions for the owner

1. **A-381 (a):** the investor books at the head office branch, read by the Owner and the Accountant only (not the Manager). Agreed?
2. **A-380 (d):** a contribution dated before the books began (1 January 2026) posts on the books' first day, its units counting from its own date. Agreed, or should the books open in 2025?
3. **A-382:** a submitted distribution run is never changed; to change it, it is rejected and drafted again. Agreed?

## Notes for the frontend track

- **2.45.0.** The investor register, capital and distribution runs are live with their planned shapes. A withdrawal and a run's submission answer 202 (`ApprovalPending`); the Owner approves through the approvals queue with a fresh code. A submitted run cannot be recomputed (`RUN_NOT_EDITABLE`). Payout details, documents, returns, financing and the portal are not built yet: the four investor fields are refused with `FIELD_NOT_YET_SUPPORTED`. Recording a distribution payment needs a fresh code.

## CI

A report cannot name the runs of the commit that adds it. Every run on the final head is named in the session's closing message to the parent session, and the pull request merges only when each is green.

## Next session

B12 continued (`b12c-cap-cst-rpt-api`, from `main`), exactly as `docs/prompts/session-openers.md` carries it:

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B12-capital-costing-reporting.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md): implement what is
reasonable, record in the report what you declined and why, never edit that file and never open frontend source.
For this phase, read the CAP, CST, RPT and API requirement blocks of docs/SRS.md (nothing else from
the SRS), docs/data-model/cap.md (its "As built in B12" notes first), cst.md, rpt.md and api.md, the CAP, CST, RPT and
API cards in docs/MODULE_BOUNDARIES.md, and ADR-0018, ADR-0023, ADR-0028, ADR-0100 and ADR-0026 (the daily
exception report), and section 4 of docs/security/THREAT_MODEL.md (the eighteen abuse cases and the
exception kind each names, and cases 68 and 69). Use docs/prompts/module-build-prompt.md as the recipe.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B12 continued only, on branch b12c-cap-cst-rpt-api, in this order:
1. The rest of CAP (A-380 (f), ADR-0100; build on B12's Capital and Distributions, never change their answers):
   payout details and the identity number sealed (FR-CAP-002: column-encrypted, masked in every response, a payout
   change approved by a different person, each decryption audited), investor documents and the agreement, lifting
   `FIELD_NOT_YET_SUPPORTED` additively; the per-investor statement (FR-CAP-013, tied to the 3000 and 2300
   subledgers); return metrics (FR-CAP-014: ROI, payback and IRR without a float, as exact as the SRS asks);
   loans and grants (FR-CAP-015, ADR-0003's cap.LoanDrawn, cap.InterestAccrued, cap.LoanRepaid and
   cap.GrantReceived, the interest accrued monthly half-up, a repayment to interest first; a lender who is not an
   investor still gets an INVESTOR subledger party for 2400, decided in an ADR); and the investor portal's read model
   (the six `investor` operations, the INVESTOR realm, an investor reading only their own record), with UAT scenario
   4's steps 4.10 and 4.11.
2. CST: overhead allocation, cost object summaries, margin and loss facts.
3. RPT: the reporting read model with its projections and checkpoints, report definitions and schedules, and, as
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
   not the owner's 40 percent. And BL-108: a mobile money success the provider reports after the payment had failed
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
4. API: the public API with keys and webhooks.
Stop at the gate and write docs/sessions/B12c-cap-cst-rpt-api.md.
```
