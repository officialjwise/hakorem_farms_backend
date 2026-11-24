# B12 continued: the rest of CAP and the investor portal (the phase split after CAP)

Date: 2026-11-24 · Branch `b12c-cap-cst-rpt-api`, from `main` at `675cb39` (#144, B12) · Status: **gate passed locally; split after CAP (A-386). CI and the merge are named in the closing message to the parent session.**

Run as a fresh agent inside the 2026-11-15 overnight session: the parent session cannot issue /clear or /compact, so each phase starts in a new context that reads only this handoff from disk.

## Assumptions made this session (in `docs/ASSUMPTIONS.md`, dated 2026-11-24)

| ID | What | Who confirms |
| --- | --- | --- |
| A-384 | **The rest of CAP as built.** (a) Every setting of payout details, the first included, waits for a different person (`INVESTOR_PAYOUT_CHANGE`, `cap.investor.payout.approve`, the Owner, step-up), one at a time. (b) Full details and the identity number revealed only to `cap.investor.payout.read` (the Owner) with step-up, each reveal audited. (c) ROI or IRR above 100 percent (IRR below -99.99) is null: `Percent` carries 0 to 100 (BL-125). (d) Payback in whole calendar months from the first contribution. (e) The IRR's closing value is the investor's share by units of the balance sheet's equity on the day, never below nothing. (f) The statement dates distributions by posting and payment; `documentUrl` null (BL-126). (g) `FLAT` interest refused. (h) A loan or grant is drawn only on another person's approval (`FINANCING`); a repayment needs step-up, no second person, never above what is owed, interest first. (i) A grant needs a term and no rate; equal monthly parts, the earliest months taking any leftover pesewa. (j) The schedule's principal split by `allocate`, the earliest instalments taking any leftover pesewa. | Owner, Accountant |
| A-385 | **The investor's portal login.** `createPortalLogin` (on create and, added, update) opens an INVESTOR account with the investor's email or phone, no role, a random password nobody sees; the investor sets theirs through the password reset; no second factor yet (BL-127). | Owner |
| A-386 | **B12 continued is split** after CAP (ADR-0026 Amendments): **B12 continued 2** builds CST, RPT with the daily exception report (every source unchanged, plus abuse cases 70 and 71) and API. | Owner |

**For the parent session to schedule:** **B12 continued 2** (`b12c2-cst-rpt-api`, the new opener section inserted before B09r). It carries every remaining item of the B12 continued opener unchanged: CST; RPT and the daily exception report with every source (cases 2, 5, 12, 13, 27 to 29, 32, 34, 64 to 67, R18, PAY's breaks, the reused till token, CR-032's PIN sign-out, CAP's 68 and 69) plus this phase's **70 and 71**; **CR-059 to CR-062**; the owner dashboard's move; **BL-108**; the proof of delivery's reused photograph; and the public API. None of that was started here.

**ADR conflicts: none. No stop.** ADR-0003's matrix gains one row by ADR-0101 (`cap.GrantRecognised`, Dr 2450 Cr 4910; no existing row changed); ADR-0017 (maker never checks) holds for both new approvals in IAM, the application and the database; ADR-0022 (subject keys) seals the payout details and identity number; ADR-0067 (dates from the clock). **ADR-0101** (new, Proposed) records the as-built choices.

**Shared modules (additive only):** FIN gains `FinancialStatements.equityIn` and five translators; IAM gains `AccessAdmin.createInvestorLoginIn`, two approval kinds in its request schema, five permissions, two policies and grants (0361); platform two document types (0358); the contract 2.46.0. Nothing existing changed in any of them. POS, PAY and `sale-posting.ts` untouched.

Phase, scope and gate, as confirmed at the start:
1. **Phase:** B12 continued, the rest of CAP, costing, reporting, the daily exception report and the public API (`b12c-cap-cst-rpt-api`, from `main` `675cb39`), the only lane building.
2. **Scope:** as the opener, planned from the start to split at the first boundary the context would not reach, after a merged green gate (the parent session's order: the rest of CAP with the portal, CST, RPT and the exception report, API).
3. **Gate:** UAT scenario 4's steps 4.10 and 4.11 pass through the investor portal, and a loan's interest and repayments match FR-CAP-015 (the exception report's gate moves with RPT to B12 continued 2). **Passed** (below).

## Baseline (before any change)

`pnpm test:coverage` on `main` at `675cb39`, in a clean worktree of it: **370 files, 4,426 tests passed, none failed or skipped. Statements 94.19 %, branches 83.94 %, functions 97.98 %, lines 97.27 %.** (A first baseline run in the phase worktree was spoiled by a second, narrow coverage run started beside it, which removed its coverage directory, as in B12; no test had failed. It was rerun cleanly in a separate worktree of `main`.)

## Contract changes

**2.46.0, minor** (its entry in `docs/CONTRACT_CHANGELOG.md`). No field or parameter removed or retyped. **LOUD:** `createInvestor` and `updateInvestor` no longer answer `FIELD_NOT_YET_SUPPORTED` (the four fields act; `payout` waits for a second person); `recordRepayment` needs step-up and answers its planned 201. Additive: `Investor.pendingPayoutApprovalRequestId`, `Financing.accruedInterestPesewas` and `approvalRequestId` (always sent), `InvestorUpdate.idNumber` and `createPortalLogin`, `ApprovalKind` `INVESTOR_PAYOUT_CHANGE` and `FINANCING`, the schema `InvestorPayoutDetails`; new operations `getInvestorPayoutDetails` and `getInvestorStatement`; fourteen planned operations move into code (`listInvestorDocuments`, `addInvestorDocument`, `getInvestorReturns`, `getOverallReturns`, `listFinancing`, `createFinancing`, `getFinancing`, `recordRepayment` and the six investor-portal reads). 599 operations from code, 69 planned. Redocly clean, no warnings; `contract:generate --check` up to date.

## Built

| Item | What |
| --- | --- |
| Data | 0358 (document types `INVESTOR_PAYOUT_CHANGE`, `FINANCING` `FNC`); 0359 (`cap.investor` sealed columns' companions, `cap.investor_payout_change`, `cap.investor_document`, `cap.financing`, `cap.financing_schedule_line`, `cap.financing_accrual`, `cap.financing_repayment`, with the guards: decided once, never by the maker, one pending change, drafted then drawn, figures frozen, one accrual a month, never repaid above what is owed, HK010); 0360 (FIN's five posting event types and rules); 0361 (permissions, policies, grants). |
| CAP domain | `domain/returns/` (ROI, payback, XIRR in thirty-place fixed point) and `domain/financing/` (interest a month, interest first, the schedule, a grant's parts), both added to the 100 percent gate; `domain/investor/payout.ts` (judging and masking payout details and the identity number). |
| CAP application | `InvestorProfiles` (sealing, the payout change and its approval handler, the reveal, documents, the portal login), `InvestorReturns` (statement, returns per investor and overall), `InvestorPortal` (the six reads, the investor by the session), `Financing` (draft, approval handler, repayment, the daily accrual job). `Capital` hands the four investor fields to `InvestorProfiles`. |
| FIN, IAM (additive) | `equityIn`; translators for `cap.LoanDrawn`, `cap.GrantReceived`, `cap.InterestAccrued`, `cap.GrantRecognised`, `cap.LoanRepaid`; `createInvestorLoginIn`. |
| Interface | Two controllers (`InvestorBooksController`, `InvestorPortalController`), sixteen fragments, zod schemas; the worker's `financing-accrual` job (00:20 daily). |
| Docs | ADR-0101 and its index row; A-384 to A-386; BL-125 to BL-127; abuse cases 70 and 71; `data-model/cap.md` as built; the CAP card; DOMAIN_MODEL's CAP events; API.md (Capital); the changelog; ADR-0026 Amendments; the openers (B12 continued 2 inserted before B09r, the reference table, B13 reads B12 continued 2's report). |

## The gate, proved by running it

**Unit, written first and run red (no module):** `src/modules/cap/domain/returns/returns.spec.ts` (17 tests): FR-CAP-014's acceptance, ROI 5.00 percent and IRR 0.1500 for 100,000 in and 5,000 plus a closing 110,000 back after 365 days, no payback below 100,000; ROI's exact half, below and above half, zero, nothing invested, 100.00 and the largest amount; payback's first date, a later contribution moving the bar, whole months; IRR negative (-0.1000), nil, 730 days (0.1000) and 731 with a leap day (0.0999), flows in any order, none without money both ways or beyond the range, exactly 100 percent; ln and exp in fixed point. `src/modules/cap/domain/financing/financing.spec.ts` (14 tests): **FR-CAP-015's acceptance, `half_up(100,000 x 0.12 x 31 / 365)` = 1,019, and 5,000 repaid as 1,019 interest then 3,981 principal**; the exact half, below and above, zero rate, a part month, repaid principal stopping from its day (896, 866, 921), the largest loan; complete months over a year and a leap February; interest first, more than accrued, more than outstanding, nothing; the schedule 33,334, 33,333, 33,333 with 1,019, 614 and 340 projected; instalments paid in due order; a grant's equal parts. Both folders 100 percent statements, branches, functions and lines. `src/modules/cap/domain/investor/payout.spec.ts` (4 tests).

**UAT scenario 4 steps 4.10 and 4.11 through the portal** (`test/integration/cap/uat-scenario-4.integration.spec.ts`, now 10 tests, the seeded farm with its investors, after the run is paid): Efua opens each investor's portal login (`updateInvestor` `createPortalLogin`); the investor sets a password (the reset, done in SQL by `setPortalPassword`) and signs in through `POST /v1/auth/investor/login`. **4.10: Ama sees 1,000.0000 units, allocated GHS 7,178.53, paid 7,178.53, outstanding 0, contributed 100,000.00; her one distribution line PAID; her statement (contribution 100,000.00 in, 7,178.53 allocated in, 7,178.53 paid out; closing capital 100,000.00) ties to her 3000 subledger (credit 10,000,000) and her 2300 (nil); the Accountant's `getInvestorStatement` answers the same body; no other investor's name appears in any of her answers; the staff reads refuse her session; the portal refuses a staff session.** **4.11: Kofi sees 500.0000 units and GHS 1,833.65, and nothing of Ama's (her name and 717853 in none of his answers).** The existing steps run as before; 4.12 now refreshes the two staff sessions first (the clock has passed the ten-minute access token, as a browser would refresh).

**Integration** (`test/integration/cap/investor-books.integration.spec.ts`, 9 tests): FR-CAP-002: an investor created with an identity number, bank payout details and a portal login answers them masked, the payout not yet in force; **a dump of the tables finds neither the account number nor the identity number in clear**; the Accountant cannot approve (403); the Owner approves with a fresh code and the details come into force (`GCB, ****1180`); the reveal refused to the Accountant and the Manager, answered in full to the Owner with step-up and audited once (`DECRYPT`); the Owner's own change refused to him (422 `MAKER_CANNOT_CHECK`), a second change while one waits refused (`PAYOUT_CHANGE_PENDING`), the database refusing a change applied by its maker (23514), malformed details refused. Documents: a clean agreement kept for Abena; an unscanned or unknown file refused (`FILE_NOT_USABLE`); the Manager refused; Abena lists it and gets a signed link, its issue logged; Kwesi lists nothing and his request for her document answers exactly as for a made-up one (404, nothing of it in the body); a staff and an anonymous caller refused (401). Returns: the shape per investor and overall; the Manager refused both. **Loans: FR-CAP-015's acceptance through the API and the ledger**: the Manager refused (403); `FLAT` refused; a loan of 100,000 at 12 percent from the first of a 31-day month recorded as a numbered DRAFT with its schedule, nothing posted; the Accountant cannot approve it; the Owner approves and it is drawn (Dr 1100 100,000, Cr 2400 100,000 against the financing as the lender's INVESTOR party); the next day the daily job (run twice) accrues **1,019 once**, posted on the month's last day (Dr 6930, Cr 2410); principal before interest refused (`INTEREST_FIRST`), more interest than accrued refused; **5,000 repaid as 1,019 interest and 3,981 principal** (Dr 2400 3,981, Dr 2410 1,019, Cr 1100 5,000), the loan at 96,019 with nothing accrued unpaid and its first instalment paid 5,000; a reused reference 409; more than outstanding refused; **the database refusing more than is owed written by hand (HK010)** and an update of a repayment (HK001); the trial balance even. A grant of 30,001 over three months: a rate and no term refused; drawn on approval (Dr 1100, Cr 2450); its first finished month recognises 10,001 (Dr 2450, Cr 4910), 20,000 left; a repayment refused (`NOT_A_LOAN`); the trial balance even.

**Contract:** `test/contract/b12/capital-distributions.contract.spec.ts` (now 3 tests): every new CAP and portal response in its contract shape (`Investor`, `InvestorPayoutDetails`, `InvestorDocumentPage`, `InvestorStatement`, `InvestorReturns`, `Financing`, `FinancingPage`, `InvestorPortalSummary`, `CapitalTransactionPage`, `InvestorDistributionLinePage`, `Error`).

Tests written after their code: the integration and contract specs and `payout.spec.ts` were written after the application layer (the two domain specs for money were written first and seen red); none passed before the code existed.

## Security review (hakorem-security-review, SECURE_CODING_STANDARDS.md item by item)

Boundary crossed: TB2 back office (the investor books), the investor portal (TB7), TB8 the database. An upload is used (the file store's existing `INVESTOR_DOCUMENT` and `AGREEMENT` uses) but no new upload path; no export, webhook, payment provider call or secret.
- **Identity:** unchanged mechanisms. An investor login is an INVESTOR account with no role and a random password nobody sees; the investor sets one through the existing reset (A-385); no second factor yet (BL-127). Every changing command and both approvals need a fresh step-up.
- **Sessions and browser:** no cookie added or widened (the portal's subdomain and cookie are B13's); the portal's one POST takes the CSRF token.
- **Authorisation:** deny by default, each handler authorises at the head office branch; the portal checks the INVESTOR realm and finds the record by the session's principal, so no request names an investor (tested: another investor's document answers exactly as a made-up one, staff and anonymous refused, no other investor's name in any portal answer); the wrong roles refused every new read and write (Manager, Accountant on the Owner's permissions); maker never checker for both new approvals in IAM, the handlers and the database (`ck_investor_payout_change_checker`, `ck_financing_checker`); the approvals' payload hashes cover the sealed details' hash and the loan's figures.
- **Input:** zod on every body and query, unknown fields refused, payout details judged in the domain; parameterised SQL only.
- **Money paths:** integer pesewas; interest half-up once a month; splits only through `allocate`; IRR in fixed point, never a float; the ledger posts in the business transaction; money only through the farm's own accounts; idempotency keys; repayment references unique; a repayment never above what is owed (application and database).
- **Uploads and files:** only a clean file of an investor use is attached; served only by a signed five-minute link, its issue logged.
- **Data protection:** payout details and the identity number sealed with the investor's subject key (AES-256-GCM, bound to their place), masked in every response and audit row; revealed only to `cap.investor.payout.read` with step-up, audited `DECRYPT`; no payout detail or identity number in any event payload.
- **Logging and errors:** a refused portal read is audited without personal data; the accrual job logs a blocked month by ids only.
- **Database:** classes and grants by class; ledger rows (accruals, repayments) reject update, delete and truncate; the schedule never changes.
- **The parent's abuse paths:** an investor seeing another's figures (refused by construction and tested); a distribution paid without step-up (unchanged, refused); maker and checker the same person (refused three ways, both new approvals); an export leaking personal data, a public API key too wide, a webhook replayed or forged (none built here: B12 continued 2).
- **New abuse paths:** cases **70** (an investor's money redirected or their figures read) and **71** (a loan invented or repaid away), with their controls and tests; their exception report items are B12 continued 2's, as cases 68 and 69 are. Findings: none open.

## Contract requests (the frontend's `main` at `43acd8f`, unchanged since B11u continued)

No request names CAP or the investor portal. **CR-059 to CR-062** (the exception report's review and kinds, the egg reports, the VAT return, the exports and the report seed) are RPT's and move, unchanged, to **B12 continued 2** (named at the top for the parent session). Every other request is answered in its phase, as the last reports left them.

## Tests (this machine)

| Layer | Result |
| --- | --- |
| Unit and integration, the whole suite (`pnpm test:coverage`, after the last code and spec change) | **4,472 passed, 374 files, none failed or skipped** (on `6b9ab22`, after the last code and spec change; only this report followed). Coverage: statements 94.17 %, branches 83.77 %, functions 97.95 %, lines 97.30 % (baseline 94.19, 83.94, 97.98, 97.27: the new application layer's error branches are covered by the integration specs only in part; no threshold moved). Every full-coverage gate held, the new `src/modules/cap/domain/returns/` and `domain/financing/` at 100 percent. A first whole run (on `235b295`) failed one test: B12's register test still asserted `FIELD_NOT_YET_SUPPORTED`, the rule this phase retires (LOUD); it was rewritten to assert the payout rules that replace it, in its own commit (`6b9ab22`), and the whole suite run again. |
| The new and changed specs | `returns` 17, `financing` 14, `payout` 4 (unit); `investor-books` 9, `uat-scenario-4` 10 (was 8), `capital-and-distribution` 11 (integration); `capital-distributions` 3 (was 2, contract) |
| Contract (`pnpm test:contract`) | 141 tests, 56 files, passed (before the B12 contract spec gained its third test; the B12 and drift files passed again after: 29 tests) |
| Lint (ESLint with module boundaries, fixtures, placement, schema names), typecheck, Redocly, `contract:generate --check` | Clean (599 operations from code, 69 planned) |

Existing specs changed only for what this phase added: the rollback walk (0358 to 0361), the deny-by-default handler walk (sixteen operations, the six portal reads as the caller's own), the identifier walk (seven operations that take no identifier; `downloadMyInvestorDocument` among the non-staff operations with one, proved in `cap/investor-books`), the request schema table (three bodies) and the refused bodies (three), the drift test's counts and its still-planned example (`getCostObject`, since `listFinancing` moved into code), UAT scenario 4 (4.12 refreshes its staff sessions first), and B12's register test (above). No expectation weakened, nothing skipped.

## Deferred

- **To B12 continued 2** (the opener inserted before B09r): CST, RPT with the daily exception report and every source (cases 70 and 71 added), CR-059 to CR-062, the owner dashboard's move, BL-108, the proof of delivery's reused photograph, the public API.
- **BL-125** (return metrics above 100 percent), **BL-126** (the statement as a rendered document), **BL-127** (a second factor for investors).
- **Seed:** not extended this phase. The seeded investors have no portal login (UAT 4.10 opens it at the desk, as the script's step would); a seeded loan would need an approval in the seed and moves no UAT step. B12 continued 2's report seed (CR-062) can add both.

## Questions for the owner

1. **A-384 (a):** every setting of an investor's payout details, the first included, waits for your approval. Agreed, or may the Accountant enter the first details alone?
2. **A-384 (h):** a loan or grant is drawn only on your approval, but a repayment needs only the Accountant's fresh code (never above what is owed). Agreed, or should repayments also wait for you?
3. **A-385:** investors sign in with a password they set through the reset, no second factor yet. Agreed until B13?

## Notes for the frontend track

- **2.46.0.** Payout details, the identity number, documents, the statement, returns, loans and grants and the investor portal are live. LOUD: `createInvestor` and `updateInvestor` no longer answer `FIELD_NOT_YET_SUPPORTED`; `payout` never takes effect at once (`pendingPayoutApprovalRequestId` names the approval the Owner decides in the approvals queue). `getInvestorPayoutDetails` (Owner, step-up) reveals the details in full. A loan or grant is a `DRAFT` until approved (`Financing.approvalRequestId`); `recordRepayment` needs a fresh code and the split interest first (`accruedInterestPesewas` is what to pay first). The portal's six reads take no investor id. ROI or IRR above 100 percent is null.

## CI

A report cannot name the runs of the commit that adds it. Every run on the final head is named in the session's closing message to the parent session, and the pull request merges only when each is green.

## Next session

B12 continued 2 (`b12c2-cst-rpt-api`, from `main`), exactly as `docs/prompts/session-openers.md` carries it:

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B12c-cap-cst-rpt-api.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md): implement what is
reasonable, record in the report what you declined and why, never edit that file and never open frontend source.
For this phase, read the CST, RPT and API requirement blocks of docs/SRS.md (nothing else from
the SRS), docs/data-model/cst.md, rpt.md and api.md, the CAP, CST, RPT and API cards in docs/MODULE_BOUNDARIES.md
(CAP's for the events it publishes), and ADR-0018, ADR-0023, ADR-0100, ADR-0101 and ADR-0026 (the daily
exception report), and section 4 of docs/security/THREAT_MODEL.md (the eighteen abuse cases and the
exception kind each names, and cases 68 to 71). Use docs/prompts/module-build-prompt.md as the recipe.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B12 continued 2 only, on branch b12c2-cst-rpt-api, in this order (CAP was finished in B12 continued,
ADR-0101: never change its answers):
1. CST: overhead allocation, cost object summaries, margin and loss facts.
2. RPT: the reporting read model with its projections and checkpoints, report definitions and schedules, and, as
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
   and each month of a loan or grant the daily accrual job could not accrue (`financing-accrual`'s `blocked`). And BL-108: a mobile money success the provider reports after the payment had failed
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
3. API: the public API with keys and webhooks.
Stop at the gate and write docs/sessions/B12c2-cst-rpt-api.md.
```
