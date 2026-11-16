# B08 continued 1c2: fixed assets, depreciation runs and disposal

Date: 2026-11-16 · Branch `b08c1c2-fixed-assets`, from `main` (`761a7a4`) · Status: **gate passed.**

Run as a fresh agent inside the 2026-11-15 overnight session: the parent session cannot issue /clear or /compact, so each phase starts in a new context that reads only this handoff from disk.

## Assumptions made this session (in `docs/ASSUMPTIONS.md`, dated 2026-11-16)

| ID | What | Who confirms |
| --- | --- | --- |
| A-199 | **Fixed assets, depreciation runs and disposal (ADR-0059).** (a) Registering posts nothing; cost reaches 1510 to 1540 the way the money left (supplier invoice mapped to the asset account, manual journal, opening balance journal) and the nightly reconciliation compares the register with 1510 to 1540 and 1590; an asset the farm already had is registered at its carrying amount with its remaining life. (b) The month of acquisition is the first month of depreciation; what is left is split with `allocate` over the months left, the leftover pesewas in the **earliest** months, because FR-FIN-015's acceptance figures (333,334, 333,334, 333,333) require it; its rule text "leftover pesewas in the final months" is read as "the final month takes whatever is left"; a change of life or residual is prospective. (c) One run per period, ever, for a period that has ended and is open; a run catches up every month no posted run charged; posted by someone other than its maker (both holding `fin.fixed_asset.manage`), directly, with no IAM approval request, answering 200 as the contract plans; no step-up; posting recomputes every line (`RUN_STALE`); one `fin.DepreciationRun` per branch on the period's last day; `journalEntryId` the first entry by branch id; a draft run of an open period freezes its assets' estimate and disposal (`DEPRECIATION_RUN_PENDING`). (d) Disposal is FIN's own ◆ `fin.FixedAssetDisposed` (new matrix row): Dr 1590, Dr proceeds (named bank account or wallet, else the safe 1010), Cr 15xx at cost, gain or loss on the new account 4920; on its date or not at all; no automatic depreciation to the disposal date; no proceeds on credit; one person, no checker (FR-FIN-014 names none), audited and carrying `abuseCases: [30]`. (e) `FA-0001` numbers from a sequence (not gap-free); cost, category, branch, acquisition date and method never change; residual up to cost; life 1 to 600 months; the full schedule has no contract field (BL-068). | Accountant (a to d), Owner (c) |

Still open, proceeded on as stated: A-024 to A-029, A-182 to A-198.

Phase, scope and gate, as confirmed at the start:
1. **Phase:** B08 continued 1c2 (`b08c1c2-fixed-assets`, from `main`).
2. **Scope:** the fixed asset register (`listFixedAssets`, `createFixedAsset`, `getFixedAsset`, `updateFixedAsset`, `disposeFixedAsset` with its gain or loss) and depreciation runs (`listDepreciationRuns`, `createDepreciationRun`, `getDepreciationRun`, `postDepreciationRun`, maker and checker apart), `fin.DepreciationRun` with its rules and exact-amount test, the seeded assets.
3. **Gate:** depreciation spreads exactly with `allocate` (1,200,000 over 120 months at 10,000; 1,000,001 over 3 at 333,334, 333,334, 333,333) and posts once per period, a second run refused by a database unique key under concurrent runs, with `fin.DepreciationRun`'s exact-amount test; a run posts only once a different person posts it; every fixed asset write refuses the wrong role; disposal posts its exact gain or loss; the four statements still tie on the seeded trading day with the seeded assets.

## Contract changes

**1.38.0, minor** (`docs/CONTRACT_CHANGELOG.md`). The nine planned fixed asset and depreciation operations move into code with descriptions and `x-error-codes`; `listFixedAssets`'s `category` and `status` query parameters are enumerated; the examples now agree with the rule and with each other (six assets through October 2026, six lines per run). **No existing shape changed:** no schema edited, no field removed, renamed, retyped or made required. New error codes `FIXED_ASSET_INVALID`, `DEPRECIATION_RUN_EXISTS`, `DEPRECIATION_RUN_INVALID`. 354 operations from code, 281 planned; `contract:generate`, Redocly clean.

## Built

| Area | What |
| --- | --- |
| Migrations | 0141 (`DEPRECIATION_RUN`, `FIXED_ASSET_DISPOSAL` document types); 0142 (`fin.fixed_asset` MASTER, `fin.depreciation_run` DOCUMENT, `fin.depreciation_line` LEDGER; `fin.fixed_asset_guard()`, `fin.depreciation_line_guard()`, `fin.depreciation_run_post()`; `uq_depreciation_run_period`, `ck_depreciation_run_maker_checker`, `ck_depreciation_run_post`, `ck_depreciation_line_stale`, `ck_fixed_asset_change`, `uq_journal_entry_depreciation`, `uq_journal_entry_disposal`; account 4920; determination roles `ASSET` and `ACCUMULATED_DEPRECIATION` with eight rows; events `fin.DepreciationRun` and `fin.FixedAssetDisposed` with seven rules); 0143, 0144 (`fin.fixed_asset.read`, `fin.fixed_asset.manage`, the Owner and the Accountant). |
| FIN domain | `fixed-asset.ts` (`depreciationCharge` through `allocate`, `statusFor`, `disposalAmounts`, the two events' posting amounts, the rules of a new asset, an estimate change and a disposal, `judgeRunPost`), `asset-months.ts` (month counting, kept apart from Money by ADR-0001's lint rule). |
| FIN application | `FixedAssets` (nine operations, each authorised in its handler, writes at the asset's branch, audited, idempotent; dispose and post serializable), `FixedAssetStore` and `PgFixedAssetStore`, `Ledger.postIn`'s fixed `postingDate` (never moved), the two translators in `LedgerPostings`, two subledger sources registered by FIN, `DepreciationRunsController` and `FixedAssetsController`, nine fragments. |
| Seed | `fin-fixed-assets`: a delivery van, the 12 m³ cold room (4,500,000 less 500,000 over 36 months), the goat and sheep pen house and a platform scale, registered by the seeded Accountant, their cost journaled once (Dr 1510 to 1540, Cr 3900) by the Accountant and approved by the Owner. |
| Tests | Unit: `fixed-asset.spec.ts` (21), `asset-months.spec.ts` (12). Integration: `fin/fixed-assets` (11), `fin/depreciation-runs` (10), one new in `fin/financial-statements`. Contract: `b8/fixed-assets` (2). Lists extended: the handler walk, the request schemas, the drift test (now `listBillingDocuments`), the reconciliation sources, the seed units, the trial balance's posting events. |
| Docs | ADR-0059 and its index row; ADR-0003's applied note; A-199; BL-068; `fin.md`; FIN card; `DOMAIN_MODEL.md` (FIN events and invariants); `API.md`; the changelog; THREAT_MODEL abuse case 30 (`ASSET_DISPOSAL`); the openers. |

## The gate, proved by running it

1. **Depreciation spreads exactly with `allocate`.** `fixed-asset.spec.ts`: 1,200,000 over 120 months is 10,000 every month and 1,200,000 in all; 1,000,001 over three months 333,334, 333,334, 333,333; the cold room 4,500,000 less 500,000 over 36 months 111,112 for four months then 111,111, 4,000,000 in all; nothing after the last month; a catch-up of two months 666,668; after a change of estimate, what is left over the months left. Over the API (`fin/depreciation-runs`): the three-month asset charged 333,334 (June), 333,334 (July), 333,333 (September, August caught up), summing to 1,000,001 in the journal's 6500 lines, `FULLY_DEPRECIATED`; the seeded cold room caught up March to June as 444,448.
2. **Once per period, under concurrency, held by the database.** Four concurrent `createDepreciationRun` for June: one 201, three 422 `DEPRECIATION_RUN_EXISTS`, one row; a raw SQL second run refused by `uq_depreciation_run_period`; two different checkers posting at once: one 200, one 422, one entry. With the unique key removed (mutation) the concurrency test went red.
3. **`fin.DepreciationRun`'s exact-amount test.** Each asset's Dr 6500 and Cr 1590 at its line's amount, the asset as cost object, dated 30 June; the 6500 debits equal the run's total; the outbox event carries the same amounts and months.
4. **Maker and checker apart.** The maker posting gets 403 `FORBIDDEN` and nothing posts; raw SQL posting by the maker is refused (`ck_depreciation_run_maker_checker`), and a run posted without its own entries (`ck_depreciation_run_post`). With the application's check removed (mutation) the test went red.
5. **Never into a locked period.** August locked: posting its draft is 422 `PERIOD_NOT_OPEN`, nothing applied; a new run for August refused; September's run catches August up.
6. **Every fixed asset write refuses the wrong role.** `fin/fixed-assets`: the Manager, Storekeeper, Cashier, Sales, Farm hand and Driver get 403 on all nine operations and nothing is written; an Accountant of the smoke-test branch is refused every write on a Dodowa asset; the handler walk refuses a staff user with no grant everywhere.
7. **Disposal posts its exact gain or loss.** A scale at 420,000 with 116,670 depreciated sold for 150,000 into the GCB account: Cr 1540 420,000, Dr 1590 116,670, Dr 1100 150,000 against the account's own party, Dr 4920 153,330; a fully depreciated generator sold for 50,001 in cash: Cr 1540 500,000, Dr 1590 500,000, Dr 1010 50,001, Cr 4920 50,001; the event carries the loss and `abuseCases: [30]`.
8. **The four statements still tie on the seeded trading day with the seeded assets.** `fin/financial-statements`: 1510 to 1540 equal the register's cost; after October's run posts, 1590 and 6500 equal the run's total in SQL, the profit and loss shows it, the balance sheet balances with 1590 a negative asset row, the trial balance balances; every earlier statement test passes on the seeded farm with the assets in it (the trial balance's opening balances are now the asset journal's five accounts).

Also proved: the database refuses a change of cost, a depreciation moved by hand, any write to a disposed asset and a delete; a stale run (an asset's life changed underneath it) is 422 `RUN_STALE` and posts once fresh; the reconciliation's two new sources are clean on the seeded farm and after every run and disposal, and a superuser's edit of a register cost is reported as `fin.TrialBalanceDriftDetected` on 1530 and corrected by nobody.

## Mutation checks (run, then removed; never committed)

| Mutation | Went red |
| --- | --- |
| M1 `allocate` keys reversed (leftover in the final months) | five unit tests, among them "charges 1,000,001 over 3 months 333,334, 333,334 and 333,333" |
| M2 `uq_depreciation_run_period` removed from 0142 | "lets exactly one of four concurrent runs for June through" and the five that follow |
| M3 the application's maker check bypassed | "refuses its maker posting it (403)" and three that follow |

## Security review (hakorem-security-review)

Boundary: back office (staff session), the database. Authorisation: every handler authorises first, deny by default, writes at the asset's branch, the permissions granted to the Owner and the Accountant only (a new permission to no role first, 0143 then 0144); maker never checker in the domain, the trigger and a CHECK. Input: strict schemas, unknown fields and an unknown enum value 400, parameterised SQL only. Money paths: integer pesewas end to end, split only by `allocate`, every posting through `Ledger.postIn` in a serializable transaction with the business change; idempotency keys on every write; no external call. Data: no personal data beyond a staff name in the audit trail. Logging and errors: correlation id, no internals. Database: classes declared, grants by class, the LEDGER line insert only. Not applicable, with reason: uploads, exports, webhooks and payments (none in this change). **One new abuse path,** an asset disposed of below its worth: THREAT_MODEL case 30, exception kind `ASSET_DISPOSAL`; the event carries the actor's figures and `abuseCases: [30]` for B12's daily report. No finding open.

## Decisions

- **ADR-0059 (Proposed):** the register records and never posts its cost, reconciled nightly with 1510 to 1540 and 1590; runs spread with `allocate`, once per period, posted by a different person per branch on the period's last day; disposal is FIN's own ◆ `fin.FixedAssetDisposed`, adding a row to ADR-0003's matrix and account 4920. It adds to ADR-0003 without changing its decision (applied note), and fits ADR-0001 (the tie-break gives the acceptance figures), ADR-0005 and ADR-0058. No ADR conflict; no stop.

## Deferred

- **BL-068:** the full schedule as a field of `getFixedAsset`, and charging depreciation up to a disposal date (no contract field; the frontend has not asked).
- B12's daily exception report lists `ASSET_DISPOSAL` (abuse case 30) from `fin.FixedAssetDisposed`.
- Nothing else moved; the receivables figures stay B08 continued 2's.

## Contract requests

The frontend's `main` was fetched on 2026-11-16 (`648ad26`, unchanged since B08 continued 1b); it lists CR-001 to CR-021.
- **CR-005 (named empty examples on every list):** still declined as a whole, and **named for the parent to schedule**: it is examples-only but touches every list operation (one scripted pass over all list fragments and the planned file), larger than this phase. The two new lists keep one example each so that pass stays uniform.
- **CR-013, CR-018:** unchanged; nothing in them concerns fixed assets.
- **CR-001 to CR-004, CR-006 to CR-012, CR-014 to CR-017, CR-019 to CR-021:** answered in earlier phases; nothing new is asked.

## Tests (this machine, 2026-11-16)

| Layer | Result |
| --- | --- |
| Unit | **1,175 passed** (33 new: `fixed-asset.spec.ts` 21, `asset-months.spec.ts` 12) |
| Integration | **1,191 passed** in the merged run (22 new: `fin/fixed-assets` 11, `fin/depreciation-runs` 10, `fin/financial-statements` 1). The first full run had 8 failures, all lists and seeded-day figures to extend for the new seed and routes: the handler walk, the seed units, the trial balance's posting events and sources, the statements' opening balances, and an October that now carries the run. They were fixed in the test files. |
| Coverage, merged (`pnpm test:coverage`) | **2,366 passed**, 193 files, exit 0. Statements 93.72 percent, branches 83.30 percent (gate 80). Every 100 percent gate held, including `src/modules/fin/domain/**` on all four measures, with `fixed-asset.ts` and `asset-months.ts` at 100. |
| Contract | **84 passed** (`b8/fixed-assets` new) |
| Lint, typecheck, Redocly, `contract:generate` | Clean |
| End to end | CI only |

**Test first, honestly:** the domain specs were run red (module missing) before `fixed-asset.ts` and `asset-months.ts` existed, and one of my expected figures was wrong (a residual of 100,001 leaves 999,999, not 1,099,999; the test now uses a residual of 1). The integration tests were written before the code was run against them and passed at their first run except one database assertion (the BEFORE trigger refused a maker's post before the CHECK could; the trigger now names `ck_depreciation_run_maker_checker` itself) and one missing request context in my test; the mutations above show the rules they prove bite. No flaky test seen; nothing skipped, loosened or retried.

## Gate

**Passed:**
1. Depreciation spreads exactly with `allocate` and posts once per period, a second run refused by the database's unique key under concurrent runs, with `fin.DepreciationRun`'s exact-amount test: **passed.**
2. A run posts only once a different person posts it: **passed.**
3. Every fixed asset write refuses the wrong role: **passed.**
4. Disposal posts its exact gain or loss: **passed.**
5. The four statements still tie on the seeded trading day with the seeded assets: **passed.**

## Notes for the frontend track

- 1.38.0: the register and runs screens (F8) can use the real API for the Owner and the Accountant. Show every figure from the response: `netBookValuePesewas` and each run's `totalPesewas` are the server's.
- Posting a run is the checker's button: hide it from the run's maker (the API refuses with 403 anyway).
- A disposal with no `bankAccountId` is cash into the safe; say so on the form.
- `DEPRECIATION_RUN_PENDING` on an asset edit means "post this period's run first".

## CI

CI runs are listed in the session's closing message: a commit cannot name its own runs. The pull request is merged with a merge commit only once every run on its head is green.

## Next session

B08 continued 2, copied from `docs/prompts/session-openers.md`.

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B08c1c2-fixed-assets.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md): implement what is
reasonable, record in the report what you declined and why, never edit that file and never open frontend source.
For this phase, read the BIL and DOC requirement blocks of docs/SRS.md (nothing else from the SRS),
docs/data-model/bil.md and doc.md, the BIL and DOC cards in docs/MODULE_BOUNDARIES.md, and ADR-0001, ADR-0015,
ADR-0020 and ADR-0056. Read the accountant's answers on A-020, A-033 and A-034 in docs/ASSUMPTIONS.md: if they are
still open, proceed on the stated assumptions, record that in the report, and make each answerable as data.
Use docs/prompts/module-build-prompt.md as the recipe.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B08 continued 2 only, on branch b08c2-billing-documents: billing documents (proforma, invoice, credit
note, debit note, receipt) with levy lines from MDM's tax calculator, numbered through platform.allocate_number in
the issuing transaction, and their ◆ events (bil.InvoiceIssued, bil.CreditNoteIssued, bil.DebitNoteIssued) added to
fin.posting_event_type with their rules and an exact-amount matrix test for each row; the test that adds a fourth levy
as data only; document templates, rendering (HTML to PDF and ESC/POS), the immutable archive with its content hash, and
reprint with the reprint marker; customer statements; DOC's rendering of the supplier remittance advice from
pur.SupplierRemittanceReady (FR-PUR-013). Extend the seed through the services so the seeded trading day carries billing
documents, and prove the trial balance still sums to zero on it.
Make the owner dashboard's receivables figures live (B05x, A-149): remove `receivablesOutstandingPesewas` and
`receivablesOverduePesewas` from RPT's PENDING_FIGURES and answer them from the ledger (account 1200) and billing's due
dates through published views, and build the planned tile getReceivablesTile, test-first with its wrong-role refusal.
If the phase does not fit, split at a sub-domain boundary (for example rendering and the archive) and follow
"If a session cannot finish".
Stop at the gate and write docs/sessions/B08c2-billing-documents.md. End the report with B09a's opening message
(ADR-0026 verification).
```
