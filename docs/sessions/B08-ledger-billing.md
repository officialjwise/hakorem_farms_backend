# B8: the general ledger core and its gate

Date: 2026-11-16 · Branch `b08-ledger-billing`, from `main` (`c904fe3`) · Status: **gate passed: all three items proven. The phase split after its gate (A-187): billing, documents and FIN's interface are B08 continued and B08 continued 2.**

Run as a fresh agent inside the 2026-11-15 overnight session: the parent session cannot issue /clear or /compact, so each phase starts in a new context that reads only this handoff from disk.

## Assumptions made this session (in `docs/ASSUMPTIONS.md`, dated 2026-11-16)

| ID | What | Who confirms |
| --- | --- | --- |
| A-182 | **The seeded rules and determinations.** Only events published today are catalogued (INV's twelve, PRC's two, PUR's four; later sessions add theirs with an exact-amount test or the application does not boot); seeded rules carry no approval (System); a matched line clears 2010 at its order value and the rest, non-reclaimable levies included, goes to 5140; expense lines to their category, default 6800; credit notes clear 2010 at the returned cost, the rest to 5140 or the expense; payouts cash 1010, bank and cheque 1100, mobile money 1110; feed, supplies and services sell to 4030 and 5030; write-offs by loss group (5100, 5120, else 5110); the processing reversal's direct cost Dr 5110 Cr 1340; codes 6000, 6100, 6200, 6300, 6400, 6800 and 1510 to 1540; 1300 postable (ADR-0003 posts to it). | Accountant |
| A-183 | **Periods and the posting date.** 2026 to 2030 seeded OPEN, monthly; an event posts on its own day when that period is open, otherwise on the day it is recorded (FR-FIN-009), else 422 `PERIOD_NOT_OPEN`. | Accountant |
| A-184 | **Inter-branch transfers** of untracked stock move pool value without a journal (no movement publishes `inv.StockTransferredBetweenBranches`), so the stock reconciliation is per account across branches (BL-064). | Accountant |
| A-185 | **A supplier payment that names no bank account** posts to 1100 or 1110 against the party "Bank account not yet named" until B08 continued builds bank accounts. | Accountant |
| A-186 | **The journal number** `JNL-<YEAR>-<BRANCH>-<SEQ>` is allocated in the posting transaction; concurrent postings in a branch retry on 40001; B9a and B9b declare the series lock on the sale and sync commands. | Owner |
| A-187 | **The split** after the gate, and the three nightly checks run as one job `ledger-reconcile`; the ledger refusals join `x-error-codes` in B08 continued. | Owner |

Still open, proceeded on as stated and answerable as data: A-020 (confirmed), A-024 to A-029, A-033, A-034 (A-033 and A-034 bite only in billing, B08 continued 2).

Phase, scope and gate, as confirmed at the start:
1. **Phase:** B8 (`b08-ledger-billing`, from `main`).
2. **Scope:** the opener's B8 (ledger, billing, documents, statements, dashboard figures, PUR's waiting events), built ledger core first and proved before anything else, as the owner asked; split at a sub-domain boundary if it does not fit.
3. **Gate:** the trial balance sums to zero on a seeded trading day; an unbalanced journal is rejected by the database itself; numbering stays gap-free under concurrent load.

## Contract changes

**None.** Version 1.33.0; `contract:generate` unchanged (317 operations from code, 318 planned); Redocly clean. No operation added or changed. A stock or purchase operation can now answer 422 `PERIOD_NOT_OPEN`, `POSTING_RULE_MISSING` or `SUBLEDGER_REQUIRED` (codes already in `docs/API.md`); none is reachable from a client until periods can be locked, and B08 continued lists them in `x-error-codes` (A-187).

## Built

| Area | What |
| --- | --- |
| Platform (0122) | `platform.number_series` (PROJECTION), `platform.number_allocation` (LEDGER, written only by `allocate_number`, HK011 `ck_number_allocation_writer`), `open_number_series`, `allocate_number` (`<PREFIX>-<YEAR>-<BRANCH>[-<SUB>]-<SEQ>`, never truncated). `NumberSeries.allocateIn` and `gapsIn`. Document type `JOURNAL`. `DomainEvents.declareLedgerEvents`; `DocumentRegistry.branchOf`. |
| FIN schema (0123) | `fin.account` (the chart of ADR-0003), `subledger_party`, `accounting_period` (2026 to 2030, no overlap), `posting_event_type`, `posting_rule`, `account_determination`, `journal_entry` (with `event_subject_id`), `journal_line`. HK012 rules: `ck_journal_lines`, `ck_journal_balanced` (deferred constraint triggers), `ck_journal_period`, `ck_journal_period_open` (period read FOR SHARE), `ck_journal_line_entry`, `ck_journal_line_account`, `ck_journal_line_subledger`, `ck_account_change`, `ck_period_change`; checks on amount and side; `reject_change` on both journal tables. |
| FIN domain | `buildJournalLines` (rules, determinations with `*` fallback, subledger by account kind, balance), `reverseLines`, `choosePostingDate` (late-event rule), `postingCatalogueGaps` (the boot assertion), `trialBalance`, `subledgerByAccount`, `controlAccountBreaks`, event amounts for stock movements, processing, supplier invoices, credit notes and payments. 100 percent gate uncommented in `vitest.config.mts`. |
| FIN application | `Ledger.postIn`, `LedgerPostings` (handlers for all eighteen events; boot assertion at `onApplicationBootstrap`, or at the first posting if the database was down at boot), `SubledgerSources`, `LedgerReconciliation` (job `ledger-reconcile`, 02:15), `FinancialStatements.trialBalanceIn`, `LedgerPostingRefusedError`. |
| Other modules | MDM: `glGroup` on `ProductFacts`, `lossAccountGroup` on `ReasonCodeFacts`. INV, PRC, PUR declare their ◆ events; INV registers `StockValueSource`. No B5 to B7 command was changed. |
| Seed | Regenerated through the services, unchanged in content: with FIN subscribed, every seeded receipt, harvest, expense invoice and credit note posted its own journal; no journal is written by hand. |
| Docs | ADR-0056 and its index line; A-182 to A-187; BL-064; `fin.md`, `platform.md`; FIN and INV cards; OPERATIONS and the reconciliation runbook; `API.md` (ledger refusals); ADR-0003's applied note; ADR-0026 amendment; openers for B08 continued and B08 continued 2, B9a now reading the latter. |

## Decisions

- **ADR-0056** (Proposed): FIN reads published payloads by their documented fields and never imports a higher module; publishers declare their ledger events; a correction reverses the original's lines found by `event_subject_id`; higher modules register subledger sources (the ADR-0051 pattern); the journal number and its contention. No ADR conflict: ADR-0003, ADR-0005, ADR-0015 are applied as written.
- **PUR's waiting events are posted** (A-164 closed for posting): matched and expense invoices, credit notes, payments. The opener's PUR expand migration (`bank_account_id`, `remittance_document_id`) needs `fin.bank_account` and moves to B08 continued.

## Deferred (to the new opener sections, in order)

- **B08 continued:** FIN's operations (accounts, bank accounts, periods lock, close and reopen, journals, manual journals, rule changes, the four statements, period balances, fixed assets, depreciation), FIN's own ◆ events, `x-error-codes`, PUR's bank account expand migration, the `cash` figure and `getCashPositionTile`.
- **B08 continued 2:** BIL (proforma, invoice, credit and debit notes, receipt, levy lines, their ◆ events and matrix rows, the fourth-levy test), DOC (templates, PDF and ESC/POS rendering, archive and hash, reprint marker, the remittance advice), customer statements, the receivables figures and `getReceivablesTile`.
- **B9a:** PAY's matrix rows; the journal series lock on the sale command (A-186).
- BL-064: inter-branch transfer postings.

## Contract requests

The frontend's `main` was fetched on 2026-11-16; it lists CR-001 to CR-021, the same as at B07 continued 3. None concerns FIN, BIL or DOC.
- **CR-005:** standing decline, unchanged (named empty examples on every list).
- **CR-001 to CR-004, CR-006 to CR-021:** answered in earlier phases; nothing new is asked.

## Tests (this machine, 2026-11-16)

| Layer | Result |
| --- | --- |
| Unit | **1,069 passed** (44 new in `src/modules/fin/domain/`). |
| Integration | **1,062 passed**, 52 new: `fin/journal-rules` (17), `fin/posting-matrix` (24), `fin/trial-balance` (6), `platform/number-series` (4), `platform/worker` (1 more). |
| Coverage, merged | 2,131 passed. Statements 93.42, branches 83.09 percent (gate 80). Every 100 percent gate holds, **including the new `src/modules/fin/domain/**` (100 on all four measures)**. |
| Contract | **75 passed** (unchanged). |
| Lint, typecheck, Redocly, `contract:generate` | Clean |
| End to end | CI only |

**Test first, honestly:** each domain spec was run red (module missing) before its code. The first full integration run after wiring FIN found three real failures, each fixed in the code: the balance trigger read a column the entry row does not have (PL/pgSQL), the health test's app could not boot when the database was down (the boot assertion now falls back to the first posting), and wallet payments failed the subledger rule (A-185). A matrix test first failed on its own fixture (no cost element on the receipt) and was fixed. No flaky test seen; nothing skipped, loosened or retried.

**Mutation checks (each a scratch migration `0999_scratch_mutation.sql`, run, then deleted; never committed):**

| Mutation | Went red |
| --- | --- |
| M1 balance check removed from `fin.assert_balanced` | the unbalanced 10,000 / 9,999 entry committed |
| M2 line count check removed | the single-line and the empty entry (error no longer `ck_journal_lines`) |
| M3 `ck_journal_line_amount` dropped | the zero line was accepted |
| M4 `ck_journal_line_side` dropped | lines of side `B` and `X` were accepted |
| M5 `trg_journal_entry_period_open` dropped | the LOCKED and CLOSED period postings, and the date outside its period |
| M6 `reject_change` triggers dropped on both journal tables | the owner's UPDATE and DELETE succeeded |
| M7 `allocate_number` made non-transactional (a sequence) | all three numbering tests: gaps `[1, 2, 3, 6, 7, 9, ...]` |
| M8 the receipt's debit rule pointed at 1360 | the reconciliation found the inventory break (the trial balance stayed zero, as it should) |

## Gate

**Passed: all three items proven.**
1. **Trial balance sums to zero on the seeded trading day** (`test/integration/fin/trial-balance.integration.spec.ts`): the farm seeded through the services; every posting event with a value has exactly one journal and none with zero; total debits and total credits from `fin.journal_line` both equal the independent sum of the posted events' values, signed sum exactly 0; `trialBalanceIn` agrees and each account equals the sum of its lines; `ledger-reconcile` is clean and the inventory accounts equal the cost pools; a superuser's unbalanced entry is then reported with its inventory break and left in place.
2. **An unbalanced journal is rejected by the database itself** (`test/integration/fin/journal-rules.integration.spec.ts`): raw SQL as hk_app, every rule with its named error, M1 to M6 above.
3. **Numbering gap-free under concurrent load** (`test/integration/platform/number-series.integration.spec.ts`): 120 allocations from 40 sessions with a third rolled back, and 30 serializable commands with every fifth failing, leave contiguous series without duplicates; M7 above.

Also: every published ADR-0003 row posts exact amounts and subledgers; a reversal swaps the original's lines; a replay collides on `event_id`; a refused posting rolls the stock movement back; the boot assertion names a removed handler and a removed rule and stops the application.

## Notes for the frontend track

- No contract change. FIN's screens (F8) wait for B08 continued's operations; billing documents for B08 continued 2.
- A stock or purchase write may answer 422 `PERIOD_NOT_OPEN`, `POSTING_RULE_MISSING` or `SUBLEDGER_REQUIRED` once periods can be locked; show the message and correlation id.

## CI

CI ran on `8e32cb4`, the pushed head before this report (pull request #49), and these are every run that exists for it:
- run 43805478831, `push`, success;
- run 43805512541, `pull_request`, success (the run that compares the contract with `main`).

A commit cannot name its own runs, so the runs on the final head (this report's commit) and `main`'s `push` run on the merge commit are listed in the session's closing message. The pull request is merged with a merge commit only once every run on its head is green.

## Next session

B08 continued, copied from `docs/prompts/session-openers.md` (B9a follows B08 continued 2 and now reads its report).

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B08-ledger-billing.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md): implement what is
reasonable, record in the report what you declined and why, never edit that file and never open frontend source.
For this phase, read the FIN requirement block of docs/SRS.md (nothing else from the SRS), docs/data-model/fin.md,
the FIN card in docs/MODULE_BOUNDARIES.md, ADR-0003, ADR-0005, ADR-0017, ADR-0022 and ADR-0056, and the accountant's
answers on A-024 to A-029 and A-182 to A-187 in docs/ASSUMPTIONS.md (if still open, proceed on them).
Use docs/prompts/module-build-prompt.md as the recipe.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B08 continued only, on branch b08c-ledger-interface, building on the ledger core B8 merged (do not
rewrite it): FIN's planned operations in contract/openapi.yaml, each test-first with its wrong-role refusal: the chart
of accounts (FR-FIN-001, FR-FIN-002), bank accounts with encrypted numbers and step-up (`fin.bank_account`), periods with
lock, close and reopen (FR-FIN-009, FR-FIN-010, `PERIOD_REOPEN`), journals read only, manual journals with a different
approver and step-up (FR-FIN-008, the opening balance journal), posting rule and determination changes through
`POSTING_RULE_CHANGE`, the trial balance, profit and loss, balance sheet and cash flow for any range (FR-FIN-011 to
FR-FIN-013), the period balance projection, fixed assets and depreciation (FR-FIN-014, FR-FIN-015), and FIN's ◆ events
(`fin.ManualJournalApproved`, `fin.DepreciationRun`, `fin.YearClosed`) with their matrix rows and exact-amount tests.
List PERIOD_NOT_OPEN, POSTING_RULE_MISSING and SUBLEDGER_REQUIRED in the x-error-codes of every operation that posts
(A-187). Add, by an expand migration, pur.supplier_payment.bank_account_id and remittance_document_id with their
foreign keys (docs/DATA_MODEL.md, Migrations), lift PUR's BANK_ACCOUNT_NOT_AVAILABLE refusal and carry the bank account
on pur.SupplierPaymentMade so FIN posts it to its own subledger party (A-185).
Make the owner dashboard's cash figure live (B05x, A-149): remove `cash` from RPT's PENDING_FIGURES
(src/modules/rpt/domain/dashboard.ts) and answer it from the ledger (accounts 1000 to 1130) through a published view,
and build the planned tile getCashPositionTile, test-first with its wrong-role refusal.
If the phase does not fit, split at a sub-domain boundary (for example fixed assets and depreciation) and follow
"If a session cannot finish".
Stop at the gate and write docs/sessions/B08c-ledger-interface.md.
```
