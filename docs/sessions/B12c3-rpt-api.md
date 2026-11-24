# B12 continued 3: the daily exception report (the phase split after it)

Date: 2026-11-24 · Branch `b12c3-rpt-api`, from `main` at `d3b83f4` (#146, B12 continued 2) · Status: **gate passed locally; split after the exception report (A-391). CI and the merge are named below and in the closing message to the parent session.**

Run as a fresh agent inside the 2026-11-15 overnight session: the parent session cannot issue /clear or /compact, so each phase starts in a new context that reads only this handoff from disk.

## Assumptions made this session (in `docs/ASSUMPTIONS.md`, dated 2026-11-24)

| ID | What | Who confirms |
| --- | --- | --- |
| A-390 | **The daily exception report as built (ADR-0103).** (a) Kinds for cases 48 to 72, which the threat model named by their events only, and `OFFLINE_SALE_REVIEW` and `CHECKOUT_HOLDING` (66 kinds in all; a source's own as `sourceKind`). (b) A company-wide item is kept at the head office branch. (c) The investor books' items need `cap.capital.read` too (the Owner and the Accountant, never the Manager). (d) A review is once (409 `ALREADY_REVIEWED`) and never by the person the item names (422 `REVIEWER_IS_ACTOR`). (e) Rates only where the report has a fair base (voids over counter sales, over or short over expected cash, hand-in variance over expected, approval pairs over the maker's decisions); the others carry count and value with the rate null (BL-130). (f) R18: an address hash that let 3 checkouts end unpaid in a day with none completed. (g) SA-17 and case 70: a payment within 24 hours after a payout change, URGENT. (h) The sweep every quarter hour for today and yesterday; a swept record never replaces an event's item. (i) BL-108 built under a new abuse case 73. (j) A reused proof photograph or signature is the bytes of another upload or the file an earlier proof carries; the proof's API shape unchanged (BL-131). (k) The seed is not extended here: it moves with CR-062's report seed to B12 continued 4. | Owner |
| A-391 | **B12 continued 3 is split after the exception report** (ADR-0026 Amendments): **B12 continued 4** builds the reports, exports and dashboard, then API. | Owner |

**For the parent session to schedule:** **B12 continued 4** (`b12c4-rpt-reports-api`, the new opener section inserted before B09r). It carries, unchanged, every remaining item of this phase's opener: report definitions and schedules and runReport for every listed code (SALES_SUMMARY and PURCHASES included, CR-018), the reporting facts and FR-RPT-010's drift check, **CR-060** (the egg reports), **CR-061** (the VAT return), **CR-062** (the statement and exception report exports, and its report seed), **the seed B12 to B12 continued 3 left** (the investor portal, a CST allocation run, an exception item of each kind on a seeded day), the owner dashboard's move (caching, NFR-023, `hk_report`, `alerts` and `exceptionsToday` out of PENDING_FIGURES), and **the public API** (keys and webhooks).

**ADR conflicts: none. No stop.** ADR-0023 (a reporting schema fed by events, rebuildable, checkpoints, read under `hk_report`) holds. ADR-0026 (the daily exception report) holds. ADR-0017 (maker never checks) holds for the review, in the application and the database. ADR-0011: RPT reads other modules only through published views (`inv.pub_stock_exception` new), their index (`PurchaseOrders.splitSuspectsIn`, `MasterDataRefs.headOfficeBranchIn`) and events; the outbox's history and the audit trail through new platform readers (`OutboxHistory`, `AuditFindings`), as the schema-name check requires. **ADR-0103** (new, Proposed) records the as-built choices.

**Shared modules (additive only):** PAY BL-108 (a new branch in `settleIn`; every existing answer unchanged); DEL (lane B's) `del.ProofFileReused` and two flags on the proof (0372); INV the view `inv.pub_stock_exception` (0371); CAP `cap.FinancingAccrualBlocked` and `retentionRatePercent` on `cap.DistributionDeclared`; SHP `clientAddressHash` on `shp.CheckoutStarted`; IAM `amountPesewas` on `iam.ApprovalDecided` and two permissions (0373); platform `FileStore.earlierWithSameContent`, `AuditFindings`, `OutboxHistory`. Nothing existing changed. POS, PAY's card provider and `sale-posting.ts` untouched.

Phase, scope and gate, as confirmed at the start:
1. **Phase:** B12 continued 3, reporting, the daily exception report and the public API (`b12c3-rpt-api`, from `main` `d3b83f4`), the only lane building.
2. **Scope:** as the opener, in the parent session's order (the read model and the exception report; then reports, exports and dashboard; then API), splitting at the first boundary the context would not reach, after a merged green gate.
3. **Gate:** `GET /exceptions/daily-report` answers an item kind for every one of the eighteen abuse cases and every later source, each item with its abuse case numbers, actor, amount and subject document. **Passed** (below).

## Baseline (before any change)

`pnpm test:coverage` on `main` at `d3b83f4`: **377 files, 4,519 tests passed, none failed or skipped.** The run's coverage figures are not a clean baseline: it ran while this phase's first domain files were being written into the worktree, so the new, then untested `src/modules/rpt/domain/` files counted against the totals and the RPT domain gate. The figures of record for the same commit are B12 continued 2's last whole run: statements 94.19 %, branches 83.70 %, functions 97.91 %, lines 97.30 %.

## Contract changes

**2.48.0, minor** (its entry in `docs/CONTRACT_CHANGELOG.md`). No field or parameter of an implemented operation removed or retyped. `listExceptions` and `getDailyExceptionReport` move into code; `reviewException` is new. **LOUD:** `ExceptionKind` (a response enum) gains 44 values; `ExceptionItem` gains `sourceKind` and `review` (always sent) and its `branchId` is nullable; `ApprovalPair` gains `frequencyPercent`; `listExceptions` takes `reviewed`, its `severity` is an enum, 422 `REPORT_PERIOD_INVALID`. 610 operations from code, 59 planned. Redocly clean, no warnings.

## Built

| Item | What |
| --- | --- |
| Data | 0370 (schema `rpt`: `exception_item` PROJECTION keyed by source with a fixed id, `exception_review` LEDGER, `projection_checkpoint` WORK, `approval_fact`, `checkout_fact`, `payout_change_fact`; the `SECURITY DEFINER` writers; `hk_report` reads); 0371 (`inv.pub_stock_exception`); 0372 (the proof's match flags); 0373 (`rpt.exceptions.read`: Owner, Manager, Accountant; `rpt.exceptions.review`: Owner, Manager). |
| RPT domain | `exception-kinds.ts`, `classify.ts` (one classifier per source event: 80 event types), `sweep.ts` (audit refusals and exports, the audit verification, stock exceptions, order splitting), `rates.ts` (FR-RPT-008), under RPT's existing 100 percent gate. |
| RPT application | `ExceptionProjector` (consumer `rpt.exception-items`, the facts, SA-17 and R18, checkpoints, rebuild), `ExceptionSweep` (the worker's `exception-sweep`, every 15 minutes), `ExceptionReports` (the report, the list, the review). |
| Interface | `ExceptionsController` and three fragments. |
| Sources | BL-108 (PAY); the reused proof photograph (DEL, CR-059); the CAP, SHP and IAM event fields. |
| Docs | ADR-0103 and its index row; ADR-0026 Amendments; A-390, A-391; BL-130, BL-131; abuse case 73 and the kinds of cases 48 to 72; `data-model/rpt.md` as built; the RPT card; DOMAIN_MODEL's new events; API.md (Reporting); OPERATIONS (the job); the changelog; the openers (B12 continued 4 inserted before B09r, the reference table, B13 reads B12 continued 4's report). |

## The gate, proved by running it

**Unit** (`src/modules/rpt/domain/exceptions.spec.ts`, 214 tests): every one of the 80 event types the projector reads, with its full payload, raises an item of a known kind tied to its event and carries no phone number, TIN or address; with an empty payload it never throws; the void (SALE_VOID, case 1, the cashier, GHS 1,275.00, the sales order); every till finding to its kind (negative stock its own, keyed as the stock exception so the sweep's row is the same item); a break keyed by its id; adjustments with cases 7, 21, 55; payout changes 13 and 70; CAP's items restricted to the investor books; a run at 30 percent retention RETENTION_RATE, at 40 none; **a cashier with 4 voids in 40 sales at 10.00 percent; a pair approving 9 of 10 at 90.00 percent**; GHS 120.00 short of GHS 8,200.00 at 1.46; half-up percentages. 100 percent statements, branches, functions and lines over `src/modules/rpt/domain/`. The rates' expectations were written before `rates.ts` passed; the classifier's spec was written after its first draft (both seen red, then green).

**Integration, the gate** (`test/integration/rpt/exception-report.integration.spec.ts`, 15 tests, the seeded farm): one event of each of the 80 source types (and a second till finding, a reused receipt token) written into the outbox for the projector alone (so no other consumer, the ledger above all, acts on a made-up event), and the sweep's records made as their modules make them (the Cashier's refused read, an export through the audit trail, a failed audit verification, a transfer variance and a serial conflict, a break, **three purchase orders of 190,000 to one supplier submitted through PUR's API**). The Owner's report for the day: **every abuse case 1 to 18 under its kind, case 15 under both AUDIT_INTEGRITY and RECONCILIATION_BREAK; every later source with its kind and case (19 to 73, 55 pairs)**; every event raised an item with its abuse cases, actor (where the source names a person), amount and subject document; the swept items (AUTHORISATION_FAILURE with the permission asked, BULK_EXPORT of 412 rows, AUDIT_CHAIN_DRIFT, TRANSFER_VARIANCE, the break with `breakState` OPEN and its age, ORDER_SPLITTING of 570,000 by the storekeeper); urgent first; counts by kind; a second sweep raises nothing. **The Manager never sees the investor books' items; the Owner and the Accountant do. The Cashier and the Storekeeper are refused (403); another branch's Manager is refused this branch, real or made up, and sees none of its items.** The list pages newest first, filters by kind, severity, actor and `reviewed`, and refuses a reversed range. **A review: the Cashier 403, another branch's Manager 404, a made-up id 404, an empty note 400; the Manager's 200 with the review, its replay the same answer, the Owner's second 409 `ALREADY_REVIEWED`, the Manager reviewing an item that names her 422 `REVIEWER_IS_ACTOR`; the unreviewed list drops it; audited once.** The database: the application cannot change a review (42501), no role can (HK001), a review by the item's own actor refused (23514), the application cannot write the projection (42501). **A rebuild from the outbox gives the same items with the same ids and keeps the review; the checkpoint records it.** `hk_report` reads the projection and is refused `ord.sales_order` and `pay.payment` (42501). **SA-17: a supplier payment 2 hours after a payout change is URGENT with case 13; one 25 hours after is not. R18: three checkouts ended unpaid from one address hash is one CHECKOUT_HOLDING item; an address that paid one is none. R1: 9 of 10 at 90.00 percent with GHS 90.00.**

**Integration, the sources:** BL-108 (`pay/payment-edge-cases`): a mobile money charge the provider answers failed, then paid: FAILED, no journal, one URGENT `PROVIDER_PAID_AFTER_FAILURE` with case 73 (**red without the change**, then green). The reused proof photograph (`del/van-returns`): the first proof with a photograph is unflagged; a later proof with the same file is flagged and publishes `del.ProofFileReused` naming the earlier proof; another upload of the same bytes is matched by SHA-256. CAP (`cap/investor-books`): a loan's finished month in a locked period publishes `cap.FinancingAccrualBlocked` and posts nothing; (`cap/capital-and-distribution`) `retentionRatePercent` '40.00' on the declared run. SHP (`shp/storefront-checkout`): the checkout's start carries a 64-hex address hash and never the address. IAM (`iam/approvals`): `iam.ApprovalDecided` carries the amount.

**Contract** (`test/contract/b12c3/exceptions.contract.spec.ts`, over the seeded trading day): `DailyExceptionReport`, `ExceptionItemPage`, `ExceptionItem` (a review) and `Error` (409, 422) in their contract shapes.

## Security review (hakorem-security-review, SECURE_CODING_STANDARDS.md item by item)

Boundary crossed: TB2 back office (the report and the review), TB8 the database; TB1 only as SHP's client address, hashed.
- **Identity, sessions and browser:** unchanged mechanisms; no cookie added or widened (the investor portal's move is B13's). The review takes the CSRF token and an idempotency key.
- **Authorisation:** deny by default; every handler authorises through the policy engine (the walks name the three operations); whole-branch grants only; another branch's item answers as a made-up one (404 for the review, 403 for a branch filter, real or made up alike); **the investor books' items need `cap.capital.read` as well (an investor's figures never reach the Manager)**; maker and checker: a review never by the person the item names, in the application and the database; the report goes to the Owner, the Manager and the Accountant, never to an approver role alone.
- **Input:** zod on every query, path and body; unknown parameters refused; parameterised SQL only; the filters are fixed clauses.
- **Money paths:** amounts are integer pesewas sizes; percentages half-up once; BL-108 raises and never clears (the payment stays FAILED, nothing posts); a break is reported, never corrected.
- **Data protection and logging:** the projector keeps each source's fields by name and strips any key that could carry a phone, email, address, TIN, buyer or IP at every depth (tested); a till's refused submission and a delivery report's source address are never copied; payout details appear only masked, as their modules publish them; the checkout's client address is an HMAC under the lookup key, never the address.
- **Exports:** none built here (B12 continued 4); every MDM export already reaches the report as BULK_EXPORT.
- **Uploads:** no new upload; the proof's file match reads hashes only.
- **Database:** classes and grants by class (PROJECTION written only by `SECURITY DEFINER` functions with `search_path = pg_catalog`, LEDGER review insert-only); `hk_report` reads `rpt` and published views only (tested).
- **The parent's abuse paths:** an investor seeing another investor's figures (not touched; a Manager cannot see the investor books' items); a distribution paid without step-up (not touched; each paid distribution is now on the report, and one within 24 hours after a payout change is URGENT); maker and checker the same person (the review refuses it; approval pairs show collusion, R1); an export leaking personal data (no export here; items carry no contact details); a public API key too wide and a webhook replayed or forged (B12 continued 4).
- **New abuse path:** case **73** (mobile money paid after its payment failed), its control and its report item, tested. Residual risk R18 now has its report item. Findings: none open.

## Contract requests (the frontend's `main` at `43acd8f`, unchanged since B11u continued)

- **CR-059: implemented** (points 1 to 5): `reviewException` (a second review is 409 `ALREADY_REVIEWED`, the first stands; audited); `ExceptionItem.review` always sent; `listExceptions?reviewed=`; the five kinds `CASH_DROP` (witnessed or not by `sourceKind`), `MORTALITY_PHOTO_REUSED`, `QUOTE_ACCEPTED_BY_STAFF`, `CASH_HANDED_IN_LATE` (a till's `OFFLINE_LATE_CASH` and `OFFLINE_CASH_NOT_TAKEN`), `NEGATIVE_STOCK`; the grants (Owner and Manager read and review, the Accountant reads).
- **CR-060, CR-061, CR-062: moved, unchanged, to B12 continued 4** (the egg reports, the VAT return, the exports and the report seed): each is a `runReport` code, which that phase builds.
- **CR-063:** answered in 2.35.0. Every other request is answered in its phase, as the last reports left them.

## Tests (this machine)

| Layer | Result |
| --- | --- |
| Unit and integration, the whole suite (`pnpm test:coverage`, after the last code change) | **4,732 passed, 379 files, none failed or skipped** (on `77fff71`, the last code change; only documents followed). Coverage: statements 94.25 %, branches 84.06 %, functions 97.91 %, lines 97.32 % (B12 continued 2's last whole run on the base: 94.19, 83.70, 97.91, 97.30); every full-coverage gate held, RPT's domain at 100 percent with the new files. |
| The new specs | `rpt/domain/exceptions` 214 (unit); `rpt/exception-report` 15 (integration); `b12c3/exceptions` 1 (contract); added tests in `pay/payment-edge-cases`, `del/van-returns`, `cap/investor-books`, `cap/capital-and-distribution`, `shp/storefront-checkout`, `iam/approvals` |
| Contract (`pnpm test:contract`) | 145 tests, 58 files, passed (with the new `b12c3/exceptions` spec; the two specs that count operations and request schemas updated for 2.48.0 and run again green) |
| Lint (ESLint with module boundaries, fixtures, placement, schema names), typecheck, Redocly, `contract:generate` | Clean (610 operations from code, 59 planned) |

Existing specs changed only for what this phase added: the rollback walk (0370 to 0373), the deny-by-default handler walk (three operations), the valid bodies and queries (one each), the request schema table (one body), the drift test's counts (669 operations, 59 planned; the still-planned example's phase renamed to B12 continued 4). No expectation weakened, nothing skipped.

## Deferred

- **To B12 continued 4** (the opener inserted before B09r): report definitions and schedules, runReport for every code, the reporting facts and FR-RPT-010, CR-060 to CR-062, the seed, the dashboard's move, the public API.
- **BL-130** (rates for overrides, refunds, mortality, adjustments and exports), **BL-131** (the proof's match flags in its API shape).

## Questions for the owner

1. **A-390 (c):** items about the investor books (capital, distributions, investor payout changes, loans and grants) are shown only to the Owner and the Accountant, not to the Manager. Agreed?
2. **A-390 (f):** an address that lets 3 storefront checkouts end unpaid in a day, with none paid, is an item for review. Is 3 the right number?
3. **A-390 (e):** the rates for overrides, refunds, mortality and adjustments are left empty until the report has a fair base for each (BL-130). Which matters most to you?

## Notes for the frontend track

- **2.48.0.** `getDailyExceptionReport`, `listExceptions` and `reviewException` are live (CR-059). Show items urgent first; a kind the build does not know by its code; `sourceKind` names the source's own finer kind; `review` is null until someone reviews it; a second review is 409 and the person an item names cannot review it (422). `ExceptionItem.branchId` may be null only before a head office exists. `ApprovalPair.frequencyPercent` is always sent. The Manager never receives the investor books' items.

## CI

A report cannot name the runs of the commit that adds it. Pull request #147. On `1022bf9` (every code and document change of the phase, before this report): **45501523756, `push`, success**; **45501580575, `pull_request`, success**. No run failed and nothing was re-run. Every run on the final head (this report's commit) is named in the session's closing message to the parent session, and the pull request merges only when each is green.

## Next session

B12 continued 4 (`b12c4-rpt-reports-api`, from `main`), exactly as `docs/prompts/session-openers.md` carries it:

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B12c3-rpt-api.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md): implement what is
reasonable, record in the report what you declined and why, never edit that file and never open frontend source.
For this phase, read the RPT and API requirement blocks of docs/SRS.md (nothing else from the SRS),
docs/data-model/rpt.md and api.md, the RPT and API cards in docs/MODULE_BOUNDARIES.md, ADR-0023, ADR-0103 and
ADR-0026, and section 4 of docs/security/THREAT_MODEL.md (cases 9 and 73, and the rows 74 and 75 this phase may add).
Use docs/prompts/module-build-prompt.md as the recipe.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B12 continued 4 only, on branch b12c4-rpt-reports-api, in this order (CAP was finished in B12 continued,
ADR-0101, CST in B12 continued 2, ADR-0102, and the daily exception report in B12 continued 3, ADR-0103: never change
their answers; a new exception source is a classifier entry and its test):
1. RPT: report definitions and schedules (`rpt.report_definition`, `rpt.report_schedule`, `rpt.report_run`), with the
   reporting facts each report reads (`docs/data-model/rpt.md`) and FR-RPT-010's nightly comparison of their key totals
   (`rpt.ProjectionDriftDetected`). runReport must implement every report code listReportDefinitions lists,
   SALES_SUMMARY and PURCHASES included (CR-018), each matching its contract example's columns; every export audited
   with its row count (a bulk export needs step-up and lands on the exception report as BULK_EXPORT, which B12
   continued 3 already reads from the audit trail).
The owner dashboard was pulled forward to B05x (A-149): keep getOwnerDashboard's shape, add its caching and the
NFR-023 performance budget, move its reads onto the hk_report connection, and remove `alerts` and
`exceptionsToday` from RPT's PENDING_FIGURES (the daily exception report answers them now: B12 continued 3).
The owner, 2026-11-23 (from the frontend's F12 and F10n): build CR-060 to CR-062. Every margin is over the selling
price, (price less cost) over price, and anything over cost is markup and named markup (the owner, 2026-11-23),
CR-060's margin per crate included. Grant the report permissions to the Owner and the Manager (and the Accountant for
the financial reports). Add the egg report codes (CR-060), the VAT return (CR-061), and the statement and exception
report exports (CR-062: PROFIT_AND_LOSS, BALANCE_SHEET, TRIAL_BALANCE and DAILY_EXCEPTIONS, their figures the
operations' own). With CR-062's report seed, extend the seed as B12 to B12 continued 3 left it: invented data so the
seeded farm exercises the investor portal (logins seeded only without a usable password, set through the reset), a
CST allocation run, and at least one exception item of each kind on a seeded day. Never seed a password, token or key.
2. API: the public API with keys and webhooks.
Stop at the gate and write docs/sessions/B12c4-rpt-reports-api.md.
```
