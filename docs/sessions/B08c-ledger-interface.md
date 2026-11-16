# B08 continued: the savepoint fix, the chart of accounts and the accounting periods

Date: 2026-11-16 · Branch `b08c-ledger-interface`, from `main` (`a416dad`) · Status: **gate passed for what was built; the phase split after its chart and periods (A-189): the rest is B08 continued 1b and B08 continued 1c.**

Run as a fresh agent inside the 2026-11-15 overnight session: the parent session cannot issue /clear or /compact, so each phase starts in a new context that reads only this handoff from disk.

## Assumptions made this session (in `docs/ASSUMPTIONS.md`, dated 2026-11-16)

| ID | What | Who confirms |
| --- | --- | --- |
| A-188 | **The chart and the period lifecycle.** (a) A new account takes its type's normal side (contra accounts only by migration), its code's first digit is its type's class, a header takes no subledger, a parent is of the same type; it closes only at a nil balance once no rule or determination in force names it (new code `ACCOUNT_INVALID`). (b) Only an `OPEN` period locks, the current one included; a `LOCKED` period closes only after its last day and once every earlier one is `CLOSED`; the database holds the transitions and the close order. (c) Only the Owner asks to reopen (step-up, reason), always 202 `PERIOD_REOPEN`, approved by a different holder of the new `fin.period.reopen_approve` (the Accountant or a second Owner); the request is a `PERIOD_REOPEN` document at the head office branch. (d) Only the Owner and the Accountant hold any FIN permission. | Accountant (a, b), Owner (c, d) |
| A-189 | **The split** after the chart and periods: B08 continued 1b (journals, manual journals, posting rule changes, bank accounts with PUR's expand migration) and B08 continued 1c (the four statements, period balances, year close, fixed assets and depreciation, the cash tile), inserted before B08 continued 2. | Owner |

Still open, proceeded on as stated: A-024 to A-029, A-182 to A-187.

Phase, scope and gate, as confirmed at the start:
1. **Phase:** B08 continued (`b08c-ledger-interface`, from `main`).
2. **Scope:** first the parent session's two ledger items (the savepoint false refusal, `SET CONSTRAINTS ALL IMMEDIATE`), each test first in its own commit; then FIN's interface as the opener lists it, split at a sub-domain boundary if it does not fit.
3. **Gate:** every FIN write refuses the wrong role and a maker approving their own manual journal, rule change or period reopen; a period locks, closes and refuses postings through the API; the four statements tie on the seeded day; depreciation spreads exactly and posts once per period.

## Contract changes

**1.34.0, minor** (`docs/CONTRACT_CHANGELOG.md`). Seven planned FIN operations move into code (`listAccounts`, `createAccount`, `updateAccount`, `listAccountingPeriods`, `lockAccountingPeriod`, `closeAccountingPeriod`, `reopenAccountingPeriod`), with no schema changed; their descriptions state the rules and their `x-error-codes` are listed. One new error code, `ACCOUNT_INVALID`. The reopen's 202 example names a `PERIOD_REOPEN` subject (it said `STOCK_ADJUSTMENT`). `PERIOD_NOT_OPEN`, `POSTING_RULE_MISSING` and `SUBLEDGER_REQUIRED` join the `x-error-codes` of the seventeen operations that post. No field removed, renamed or retyped; nothing a client sends made required. 324 operations from code, 311 planned, 635 published; `contract:generate --check` and Redocly clean.

## Built

| Area | What |
| --- | --- |
| The savepoint fix (0124) | `fin.journal_entry.written_xact_id` (xid8), set by `fin.record_written_xact()` to `pg_current_xact_id()` (the top-level transaction, even inside a subtransaction) whatever the writer supplies; `fin.assert_line_valid()` compares it instead of `xmin`. Entries before 0124 carry NULL, which no transaction matches. |
| Period lifecycle (0126) | `fin.accounting_period_guard()` now also refuses any transition but FUTURE→OPEN, OPEN→LOCKED, LOCKED→OPEN, LOCKED→CLOSED, a locked period without who locked it, an open one with it (`ck_period_transition`), and a close while an earlier period is not closed (`ck_period_close_order`). `fin.period_reopen` (DOCUMENT, frozen once decided, one pending per period). |
| Platform and IAM (0125, 0127, 0128) | Document type `PERIOD_REOPEN`; permissions `fin.account.read`, `.manage`, `fin.period.read`, `.lock`, `.close` (step-up), `.reopen` (step-up), `.reopen_approve` (step-up); approval policy `PERIOD_REOPEN`; grants to Owner and Accountant only (reopen: Owner only). |
| FIN domain | `accounts.ts` (`normalSideOf`, `checkNewAccount`, `checkAccountClosing`), `period-lifecycle.ts` (`judgeLock`, `judgeClose`, `judgeReopen`); 100 percent on all four measures. |
| FIN application and interface | `ChartOfAccounts`, `Periods` (also the `PERIOD_REOPEN` `ApprovalHandler`), `ChartStore` and `PgChartStore`, `AccountsController`, `PeriodsController`, schemas, seven fragments. Lock, close and the reopen request run at serializable isolation and read the period `FOR UPDATE`; every write is idempotent and audited. FIN now imports IAM. |
| x-error-codes | The seventeen posting operations, found empirically: a scratch instrumentation (never committed) recorded every `Ledger.postIn` with its correlation id and every request's route, over the INV, LIV, PRC, PUR, MDM and approval suites. |
| Docs | A-188, A-189; `API.md` (FIN section, `ACCOUNT_INVALID`, the posting operations); `fin.md`; FIN card; DC-15; ADR-0026 amendment; openers for B08 continued 1b and 1c, B08 continued 2 now reading 1c's report. |

## The parent session's two items

1. **The savepoint false refusal was real.** The new test (an entry and its lines written inside a SAVEPOINT as hk_app) was run before the fix and went red: with the savepoint around the entry and its lines, or around the entry alone, the entry's own lines were refused `ck_journal_line_entry`, and an unbalanced entry in a savepoint was refused for the wrong reason (`ck_journal_line_entry`, not `ck_journal_balanced`). The savepoint around only the lines passed, as expected. Migration 0124 fixed it; all three now commit, and the unbalanced one is refused `ck_journal_balanced`. The existing test (a later transaction appending a balanced pair to a posted entry) is kept, and a new one does the same inside a savepoint. A writer cannot forge the column: the trigger overwrites it.
2. **`SET CONSTRAINTS ALL IMMEDIATE` only makes the check earlier.** Three tests: an unbalanced entry is refused at the `SET` itself; with the checks immediate before any write, the entry is refused at its own statement (`ck_journal_lines`); a line added after the checks ran immediately on a balanced entry and were deferred again is refused at commit. Each row event of the per-line constraint trigger is checked once whatever the mode, so no mode change lets a later line escape.

**Mutation checks (scratch migration `0999_scratch_mutation.sql`, run, then deleted; never committed):**

| Mutation | Went red |
| --- | --- |
| M1 the line trigger's "earlier transaction" check made always true | both tests appending lines to an entry another transaction committed (plain and inside a savepoint) |
| M2 the trigger recording `written_xact_id` dropped | 22 of 26 journal-rule tests (no line can join any entry) |
| M3 the trigger trusting a supplied `written_xact_id` | the forged-transaction-id test |
| M4 the per-line balance trigger dropped | the re-deferred `SET CONSTRAINTS` test (the unbalanced line committed) |
| M5 the period guard restored to 0123's | `ck_period_transition` and `ck_period_close_order` tests |
| M6 the Manager granted the chart and period permissions, the Accountant `fin.period.reopen` | the Manager's wrong-role tests for accounts and periods, and both reopen tests |

## Decisions

- No new ADR: the period lifecycle, the close order and the reopen under `PERIOD_REOPEN` apply FR-FIN-009, FR-FIN-010 and ADR-0017 as written; the readings that were mine are A-188. No ADR conflict found.
- Two existing raw-SQL period tests (B8) set a period CLOSED straight from OPEN and reopened one leaving `locked_at` set; under 0126 they now follow the lifecycle (lock then close the first period; reopen clearing who locked it). Their assertions are unchanged.
- **The split (A-189)** at sub-domain boundaries, after items 1 and 2: the rest of FIN's interface is about thirty operations, three ◆ events, encrypted bank accounts and PUR's expand migration, which cannot reach a gate in what remained of this context.

## Deferred (to the new opener sections, in order)

- **B08 continued 1b:** journals read only, manual journals (`MANUAL_JOURNAL`, the opening balance journal, `fin.ManualJournalApproved`), posting rule and determination changes (`POSTING_RULE_CHANGE`), bank accounts with encrypted numbers, PUR's `bank_account_id` and `remittance_document_id` (A-185 lifted).
- **B08 continued 1c:** trial balance, profit and loss, balance sheet, cash flow, account activity's totals, `fin.period_balance`, year close (`fin.YearClosed`), fixed assets and depreciation (`fin.DepreciationRun`), the cash figure and `getCashPositionTile`.
- **B08 continued 2** (billing) and **B9a** unchanged, B08 continued 2 now reading 1c's report.

## Contract requests

The frontend's `main` was fetched on 2026-11-16; it lists CR-001 to CR-021, the same as at B8. None concerns FIN.
- **CR-005:** standing decline, unchanged (named empty examples on every list).
- **CR-001 to CR-004, CR-006 to CR-021:** answered in earlier phases; nothing new is asked.

## Tests (this machine, 2026-11-16)

| Layer | Result |
| --- | --- |
| Unit | **1,085 passed** (16 new: `fin/domain/accounts.spec.ts`, `period-lifecycle.spec.ts`). |
| Integration | **1,099 passed**: `fin/journal-rules` 28 (11 new: savepoints, `SET CONSTRAINTS`, the lifecycle), `fin/accounts` 13 and `fin/accounting-periods` 13 (new), the handler walk with the seven routes. |
| Coverage, merged | 2,184 passed. Statements 93.49, branches 83.16 percent (gate 80). Every 100 percent gate holds, `src/modules/fin/domain/**` at 100 on all four measures. |
| Contract | **77 passed** (2 new, `test/contract/b8/chart-periods.contract.spec.ts`). |
| Lint, typecheck, Redocly, `contract:generate --check` | Clean |
| End to end | CI only |

**Test first, honestly:** the savepoint test went red before migration 0124; the two domain specs were run red (modules missing) before their code; the API tests were written after the services, so their permission tests were proved by mutation M6. The first full runs found real failures, each fixed: the step-up test's clock outran the session (fresh sessions now), a NOT VALID check on `written_xact_id` refused the reconciliation test's superuser tamper and was dropped (NULL already fails closed), and the handler walk and the contract tests needed the new routes. No flaky test seen; nothing skipped, loosened or retried.

## Gate

**Passed for what was built (the split narrows it, A-189):**
1. **An entry written inside a savepoint keeps its own lines, and `SET CONSTRAINTS ALL IMMEDIATE` only makes the check earlier** (`test/integration/fin/journal-rules.integration.spec.ts`), red before the fix, M1 to M4.
2. **Every chart and period operation refuses the wrong role** (Manager, Storekeeper, Cashier, Sales, Farm hand, Driver: 403 on every one; the Accountant 403 on reopen), and **the Owner approving their own reopen is refused** `MAKER_CANNOT_CHECK` (`fin/accounts`, `fin/accounting-periods`, the handler walk), M6.
3. **A period locks, closes and then refuses postings, through the API** (`fin/accounting-periods`): on the seeded farm the Accountant locks last month (a harvest dated in it posts today, late), closes every earlier month and then last month, the Owner cannot reopen a closed one; with the current month locked a harvest's posting is 422 `PERIOD_NOT_OPEN` and writes no movement or journal; the Owner's reopen waits until the Accountant approves, then the harvest posts; a rejected reopen leaves the period locked.

Not part of this narrowed gate, and scheduled: manual journals and rule changes (1b), the four statements and depreciation (1c).

## Notes for the frontend track

- 1.34.0: the chart and periods screens (F8) can use the real API. A reopen is the Owner's and always 202; it appears in the approvals inbox for the Accountant. Show `details[].code` for `INVALID_STATE_TRANSITION` and `ACCOUNT_INVALID`.
- A stock, livestock, processing, purchase or approval write can now really answer 422 `PERIOD_NOT_OPEN`: show the message and the correlation id.

## CI

CI runs are listed in the session's closing message: a commit cannot name its own runs. The pull request is merged with a merge commit only once every run on its head is green.

## Next session

B08 continued 1b, copied from `docs/prompts/session-openers.md`.

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B08c-ledger-interface.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md): implement what is
reasonable, record in the report what you declined and why, never edit that file and never open frontend source.
For this phase, read the FIN requirement block of docs/SRS.md (nothing else from the SRS), docs/data-model/fin.md,
the FIN card in docs/MODULE_BOUNDARIES.md, ADR-0003, ADR-0005, ADR-0017, ADR-0022 and ADR-0056, and the accountant's
answers on A-024 to A-029 and A-182 to A-189 in docs/ASSUMPTIONS.md (if still open, proceed on them).
Use docs/prompts/module-build-prompt.md as the recipe.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B08 continued 1b only, on branch b08c1b-journals-rules-banks from main, building on the ledger core and the
chart and periods already merged (do not rewrite them): FIN's planned operations in contract/openapi.yaml, each
test-first with its wrong-role refusal: journals read only (listJournalEntries, getJournalEntry, listAccountActivity);
manual journals with a different approver and step-up (FR-FIN-008, kind MANUAL_JOURNAL, the opening balance journal
against 3900, A-005, OPENING_ALREADY_POSTED), with `fin.ManualJournalApproved` added to fin.posting_event_type with its
matrix row and an exact-amount test; posting rule and determination changes through `POSTING_RULE_CHANGE` with step-up
(listPostingEventTypes, listPostingRules, createPostingRule, listAccountDeterminations, createAccountDetermination),
keeping the boot assertion whole; bank accounts with encrypted numbers and step-up (`fin.bank_account`, ADR-0022).
Add, by an expand migration, pur.supplier_payment.bank_account_id and remittance_document_id with their foreign keys
(docs/DATA_MODEL.md, Migrations), lift PUR's BANK_ACCOUNT_NOT_AVAILABLE refusal and carry the bank account on
pur.SupplierPaymentMade so FIN posts it to its own subledger party (A-185).
If the phase does not fit, split at a sub-domain boundary (for example bank accounts) and follow
"If a session cannot finish".
Stop at the gate and write docs/sessions/B08c1b-journals-rules-banks.md.
```
