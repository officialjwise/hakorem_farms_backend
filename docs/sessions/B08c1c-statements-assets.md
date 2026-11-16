# B08 continued 1c: the statements, period balances, year close and the cash figure

Date: 2026-11-16 · Branch `b08c1c-statements-assets`, from `main` (`b248ebc`) · Status: **gate passed for what was built; the phase split before fixed assets and depreciation (A-198).**

Run as a fresh agent inside the 2026-11-15 overnight session: the parent session cannot issue /clear or /compact, so each phase starts in a new context that reads only this handoff from disk.

## Assumptions made this session (in `docs/ASSUMPTIONS.md`, dated 2026-11-16)

| ID | What | Who confirms |
| --- | --- | --- |
| A-195 | **The financial statements.** (a) New permission `fin.report.read`, Owner and Accountant only; without `branchId` a statement covers every branch, as the journal reads do. (b) Trial balance: accounts in code order, nil ones left out unless `includeZero`; `totalDebitPesewas`/`totalCreditPesewas` are the range's debits and credits over the whole filter; `balanced` also needs the closing balances to net to zero and the signed sum to `to` to be exactly zero. (c) Profit and loss: rows per account, income as net credits (contra accounts negative), cost of sales and expenses as net debits, year close entries left out. (d) Balance sheet: rows per account (not the planned example's groups), accumulated depreciation a negative asset row, the earnings not yet closed one equity row with no account, plus `LIABILITIES_AND_EQUITY`. (e) Cash flow: direct method over 1000 to 1130 by code, sections `OPENING_CASH`, `OPERATING`, `INVESTING`, `FINANCING`, `NET_CHANGE`, `CLOSING_CASH`, a counterpart with no category operating, a move between two cash accounts no flow. (f) `fin.period_balance` is trusted only for LOCKED and CLOSED periods. | Accountant (b to f), Owner (a) |
| A-196 | **The dashboard's cash position.** From `fin.pub_cash_balance`: tills 1000, safe 1010, drivers 1020, mobile money 1110, bank for the rest (1100, 1120, 1130 and any cash account added in the range); `totalPesewas` all of them. A figure below zero is shown as its size and named in the new required `CashPosition.negativeFigures` (1.37.0), never clamped. The tile keeps the contract's `rpt.tile.read`, so the Manager sees the cash position (B05x's grant); the dashboard keeps `rpt.dashboard.owner`. | Owner |
| A-197 | **The year close.** Closing period 12 closes the year in the same transaction (the contract has no other operation); per branch, every income, cost and expense account at its exact balance on 31 December to 3200, then 3200 to 3100 by the exact profit or loss, 3300 per investor to 3100; 3900 is not closed. FIN's own ◆ `fin.YearClosed`, one per branch, posted as one `CLOSING` entry into the LOCKED period 12; the closing side's determinant `CLOSED_ACCOUNT` is fixed by the database, the 3200 and 3100 sides are ordinary rules. A refused posting closes nothing (422 `POSTING_RULE_MISSING` or `SUBLEDGER_REQUIRED`). | Accountant |
| A-198 | **The split.** This phase built the statements, the period balances, the year close and the cash figure; **B08 continued 1c2** builds the fixed asset register, disposal, depreciation runs with `fin.DepreciationRun` (spread by `allocate`, once per period under concurrency) and the seeded assets. B08 continued 2 reads 1c2's report. | Owner |

Still open, proceeded on as stated: A-024 to A-029, A-182 to A-194.

Phase, scope and gate, as confirmed at the start:
1. **Phase:** B08 continued 1c (`b08c1c-statements-assets`, from `main`).
2. **Scope:** the trial balance, profit and loss, balance sheet and cash flow for any range; `fin.period_balance`; the year close with `fin.YearClosed`; fixed assets and depreciation with `fin.DepreciationRun`; the owner dashboard's cash figure and `getCashPositionTile`.
3. **Gate:** the four statements tie on the seeded day, each read refusing the wrong role; year close leaves 3200 at zero and 3100 increased by the year's profit, with its exact-amount test; depreciation spreads exactly and posts once per period; every fixed asset write refuses the wrong role; the cash figure answers from the ledger.

## Why the phase split (A-198, ADR-0026 Amendments)

The statements, the projection and the year close took the ledger's own invariants to the database (a new exception in the period trigger, three new constraints, a deferred trigger) and each had to be proved against SQL sums of the lines, as the owner asked. Fixed assets and depreciation are a sub-domain of their own (nine operations, three tables, maker-checker on the run, a concurrency proof, the disposal posting, two decisions on how cost reaches 1510 to 1540 and whether disposal is its own event, and the seeded assets). Starting them here would have left them half built. The opener names this boundary. The 1c gate items that remain for 1c2, unchanged: "a depreciation run spreads the depreciable amount exactly and posts once per period, with `fin.DepreciationRun`'s exact-amount test; every fixed asset write refuses the wrong role". The new opener section is in `docs/prompts/session-openers.md`.

## Contract changes

**1.37.0, minor** (`docs/CONTRACT_CHANGELOG.md`). `getTrialBalance`, `getProfitAndLoss`, `getBalanceSheet`, `getCashFlow` and `getCashPositionTile` move into code with descriptions and `x-error-codes`; `closeAccountingPeriod` says it closes the year for period 12 and lists `POSTING_RULE_MISSING` and `SUBLEDGER_REQUIRED`. **One additive required response field:** `CashPosition.negativeFigures` (the figures below zero). The balance sheet and cash flow examples now show the real shapes (rows per account; `OPENING_CASH` and `CLOSING_CASH`); the profit and loss example's 4210 and 6200 rows match the chart. No field removed, renamed or retyped; nothing a client sends made required. 345 operations from code, 290 planned; `contract:generate --check`, the versioning check against `main` and Redocly clean.

## Built

| Area | What |
| --- | --- |
| Migrations | 0137 (`YEAR_CLOSE` document type); 0138 (`fin.period_balance` PROJECTION with `is_closing`, `fin.refresh_period_balance()`, the trigger computing it whenever a period becomes LOCKED or CLOSED; the year close's exception in `ck_journal_period_open`; `ck_journal_entry_closing`, `uq_journal_entry_closing`, the deferred `ck_journal_closing_period`; determinant `CLOSED_ACCOUNT` with `ck_posting_rule_closed_account`; `fin.YearClosed` and its twelve rules; the view `fin.pub_cash_balance`); 0139, 0140 (`fin.report.read`, granted to the Owner and the Accountant). |
| FIN domain | `statements.ts` (`profitAndLoss`, `balanceSheet`, `cashFlow`, `cashPosition`, `isCashAccount`), `year-close.ts` (`yearCloseAmounts`), `closingPostingDate` in `period.ts`, `CLOSED_ACCOUNT` in `posting.ts`. |
| FIN application | `FinancialStatements` (the four reads, authorised in the handler), `StatementStore` and `PgStatementStore` (one SQL statement per figure set, LOCKED and CLOSED periods from the projection), `YearClose` (run by `Periods.close` for period 12), the `fin.YearClosed` translator in `LedgerPostings`, `Ledger.postIn`'s `closing` mode (kind `CLOSING`, never moved), `LedgerReconciliation` refreshing open periods' balances and reporting `periodBalanceDrift`; `StatementsController` and four fragments. |
| RPT | `getCashPositionTile` and the dashboard's `cash` from `fin.pub_cash_balance` through `cashPosition`; `cash` left `PENDING_FIGURES`. |
| Tests | Unit: `statements.spec.ts` (10), `year-close.spec.ts` (4), 3 in `posting.spec.ts`, 2 in `period.spec.ts`, RPT's pending figures. Integration: `fin/financial-statements` (16), `fin/year-close` (6), RPT dashboard (the cash figure, its scope and the reporting role reading the view). Contract: `b8/statements.contract.spec.ts` (2). Lists extended: the handler walk, the reconciliation report, the worker summary, the drift counts. |
| Docs | ADR-0058 and its index row; A-195 to A-198; `fin.md`; FIN and RPT cards; `API.md`; the changelog; ADR-0003's applied note; the reconciliation runbook (period balance drift, E2); ADR-0026 Amendments; the openers (1c built and split, 1c2 added, B08 continued 2 reads 1c2's report). |

## The gate items built, proved by running them

1. **The four statements tie on the seeded trading day to the pesewa, each refusing the wrong role.** `fin/financial-statements`, every figure compared with sums taken in the test straight from `fin.journal_line` in SQL: the trial balance's totals and every account's closing balance; the profit and loss's income, cost of sales, expenses and net profit (the 4xxx credits less the 5xxx and 6xxx debits); the balance sheet's assets, liabilities and equity, with assets equal to liabilities plus equity accounts plus the period's earnings, both from SQL and from the API's check; the cash flow's opening plus net change equal to its closing, equal to the SQL sum of accounts 1000 to 1130. The SRS's cash flow reconciles exactly: opening 100,000, receipts 300,000, payments 120,000 (100,000 operating, 20,000 investing), closing 280,000. The Manager, Storekeeper, Cashier, Sales, Farm hand and Driver get 403 on all four; a staff user with no grant gets 403 (handler walk).
2. **Year close leaves 3200 at zero and 3100 increased by the year's profit, with `fin.YearClosed`'s exact-amount test.** `fin/year-close`: after the seeded farm and a December journal (500,000 sales, 120,001 power), January to November are locked and closed, December locked; closing December posts exactly one `CLOSING` entry (`JNL-2026-DDW-…`, 31 December) whose lines are each income, cost and expense account's balance from SQL against 3200, and 3200 to 3100 by the profit computed in SQL; afterwards every 4xxx, 5xxx and 6xxx account and 3200 is at nil and 3100 moved by exactly the profit; no balance sheet account moved. The outbox's `fin.YearClosed` carries those exact amounts, its `YEAR_CLOSE` document and the `CLOSE_YEAR` audit the profit. The profit and loss for 2026 still shows the profit; the trial balance closes the P&L accounts at nil; the balance sheet balances with no earnings row. The database refuses a `CLOSING` entry from another event (`ck_journal_entry_closing`), one committed without the close (`ck_journal_closing_period`), and a second one after the close; a journal dated 31 December is refused while December is locked, and everything after the close.
3. **The owner dashboard's cash figure answers from the ledger.** RPT's dashboard test: the seeded day's cash is nil on every figure; after an opening balance journal and a payment from the wallet, the tile and the dashboard answer safe 900,000, bank 675,030 (1100 625,030 and cheques 50,000), mobile money 60,560 named in `negativeFigures`, total 1,514,470, equal to the SQL sum of accounts 1000 to 1130; another branch is nil; the Owner, Manager and Accountant read it, the five other roles get 403; the reporting role reads `fin.pub_cash_balance` and cannot read `fin.journal_line`.

Also proved: a locked period's period balances equal its lines account by account, the statements answer the same from them, a superuser's edit of one row changes the statement and is reported by the nightly job as `periodBalanceDrift` (nothing corrected).

## Mutation checks (run, then removed; never committed)

| Mutation | Went red |
| --- | --- |
| M1 `ck_journal_entry_closing` dropped (scratch migration 0999) | "refuses, in the database, a CLOSING entry that is not the year close" |
| M2 the Manager granted `fin.report.read`, and the period balance trigger dropped (scratch migration 0999) | "refuses the manager every statement" and "reads a locked period with lines from its balances" |
| M3 the profit and loss counting year close entries | "still shows the year's profit in its profit and loss" |

## Security review (hakorem-security-review)

Boundary: back office (staff session), the database. SC-01 strict query schemas (`from` after `to`, unknown fields and a forged cursor are 400); SC-02 every read authorises `fin.report.read` or `rpt.tile.read` in the handler, wrong roles refused in tests, and the permission is granted to the Owner and the Accountant only; SC-03, SC-04 parameterised SQL only; SC-05 integer pesewas throughout, signs carried by `isNegative` and `negativeFigures`, exact in tests; SC-06 reads only, no idempotency needed; `closeAccountingPeriod` keeps its key and step-up; SC-07, SC-08 no personal data beyond a party's display name; SC-16 errors carry the correlation id; SC-17 the year close is no person's input: it posts computed balances, once, only with the close of a period that needed step-up; SC-22 no journal row is updated (the projection is a PROJECTION written only by its function); SC-23 the close runs serializable with the posting in the same transaction; SC-24 the close audited per branch with the profit. **No new path moves money.** One exposure to note: the Manager reads the cash position through `rpt.tile.read`, as B05x granted (A-196, for the Owner). No finding open.

## Decisions

- **ADR-0058 (Proposed):** statements read LOCKED and CLOSED periods from `fin.period_balance`, computed by the database at lock and close; the year close is FIN's own ◆ event posted in the close's transaction, admitted into the locked last period by the database only with the close, once. Fits ADR-0003 (its applied note added, decision unchanged), ADR-0005 and the data dictionary. No ADR conflict; no stop.

## Deferred

- **B08 continued 1c2:** fixed assets, disposal, depreciation runs and `fin.DepreciationRun`, the seeded assets (A-198).
- The receivables figures stay B08 continued 2's; nothing else moved.
- The seed is not extended this phase: a year close cannot be seeded before a year ends, and the statements need no data of their own; 1c2 seeds the assets.

## Contract requests

The frontend's `main` was fetched on 2026-11-16 (`648ad26`, unchanged since B08 continued 1b); it lists CR-001 to CR-021.
- **CR-013:** the cash figure is now live and no longer in `pendingFigures`, as the request asked (one call, a figure per tile); `negativeFigures` is the one addition the screen needs.
- **CR-018:** unchanged; the profit and loss is `getProfitAndLoss`, now answered from the real API.
- **CR-005:** standing decline, unchanged (named empty examples on every list).
- **CR-001 to CR-004, CR-006 to CR-012, CR-014 to CR-017, CR-019 to CR-021:** answered in earlier phases; nothing new is asked.
Nothing is larger than this phase could take.

## Tests (this machine, 2026-11-16)

| Layer | Result |
| --- | --- |
| Unit | **1,142 passed** (19 new: `statements.spec.ts` 10, `year-close.spec.ts` 4, `posting.spec.ts` 3, `period.spec.ts` 2; RPT's pending-figure test changed). |
| Integration | **1,169 passed** in the merged run (the first full run had 4 failures, all lists to extend: the handler walk's routes and queries, the reconciliation report's `periodBalanceDrift`, the worker's summary; fixed in the test files). New: `fin/financial-statements` 16, `fin/year-close` 6, RPT dashboard 1 (and three changed). |
| Coverage, merged (`pnpm test:coverage`) | **2,311 passed**, 189 files. Statements 93.70, branches 83.32 percent (gate 80). Every 100 percent gate holds: `src/modules/fin/domain/**` at 100 on all four measures, `statements.ts` and `year-close.ts` included; `src/modules/rpt/domain/**` at 100. |
| Contract | 82 passed (the drift test now names a still-planned fixed asset operation; 345 in code, 290 planned), `b8/statements` new |
| Lint, typecheck, Redocly, `contract:generate --check`, versioning against `main` | Clean |
| End to end | CI only |

**Test first, honestly:** the domain specs (`statements`, `year-close`, the new `posting` and `period` cases) and RPT's pending-figure unit test were run red before their code. The integration tests were written before running against the new code and passed at their first or second run (two assertions of mine were wrong: the seeded day makes a profit, not a loss, because eggs at standard cost credit 5210; and the drift row compares debits, not balances); the mutations above show the database and permission rules they prove bite. The first full integration run had four failures, all lists to extend (the handler walk, the reconciliation report's new field, the worker's summary). No flaky test seen; nothing skipped, loosened or retried.

## Gate

**Passed for the items built; the rest moved to B08 continued 1c2 (A-198):**
1. The trial balance, profit and loss, balance sheet and cash flow tie to each other on the seeded trading day to the pesewa, each read refusing the wrong role: **passed.**
2. Year close leaves 3200 at zero and 3100 increased by the year's profit, with `fin.YearClosed`'s exact-amount test: **passed.**
3. The owner dashboard's cash figure answers from the ledger: **passed.**
4. A depreciation run spreads exactly and posts once per period, with `fin.DepreciationRun`'s test; every fixed asset write refuses the wrong role: **moved to B08 continued 1c2.**

## Notes for the frontend track

- 1.37.0: the statements screens (F8) can use the real API for the Owner and the Accountant. Read every total from the response; signs are `isNegative`.
- The balance sheet's rows are accounts; group them by code range on screen if wanted. The earnings row has `account: null`.
- The cash flow has `OPENING_CASH` and `CLOSING_CASH` sections with a row per cash account.
- The cash tile: show a figure named in `negativeFigures` as negative (for example "−GHS 605.60" for mobile money).
- Closing December closes the year: say so on the confirm dialog.

## CI

CI runs are listed in the session's closing message: a commit cannot name its own runs. The pull request is merged with a merge commit only once every run on its head is green.

## Next session

B08 continued 1c2, copied from `docs/prompts/session-openers.md`.

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B08c1c-statements-assets.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md): implement what is
reasonable, record in the report what you declined and why, never edit that file and never open frontend source.
For this phase, read the FIN requirement block of docs/SRS.md (nothing else from the SRS), docs/data-model/fin.md,
the FIN card in docs/MODULE_BOUNDARIES.md, ADR-0001, ADR-0003, ADR-0005, ADR-0056 and ADR-0058, and the accountant's
answers on A-024 to A-029 and A-182 to A-198 in docs/ASSUMPTIONS.md (if still open, proceed on them).
Use docs/prompts/module-build-prompt.md as the recipe.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B08 continued 1c2 only, on branch b08c1c2-fixed-assets from main, building on what is merged (do not
rewrite it): FIN's planned fixed asset and depreciation operations in contract/openapi.yaml, each test-first with its
wrong-role refusal: the fixed asset register (FR-FIN-014: listFixedAssets, createFixedAsset, getFixedAsset,
updateFixedAsset, disposeFixedAsset, with disposal posting its gain or loss) and depreciation runs (FR-FIN-015:
listDepreciationRuns, createDepreciationRun, getDepreciationRun, postDepreciationRun, maker and checker never the same
user), the ◆ event `fin.DepreciationRun` (Dr 6500, Cr 1590) with its fin.posting_event_type row, rules and exact-amount
matrix test; `allocate` so each asset's schedule sums exactly to cost less residual, leftover pesewas in the final
months; one run per period held by a database unique key and proved with concurrent runs. Decide first, as an ADR or
an assumption, how an asset's cost reaches 1510 to 1540 (the asset register records; it does not itself post) and
whether disposal is its own ◆ event. Coverage: the 100 percent gate on src/modules/fin/domain/ holds for every new rule.
Extend the seed through the services with the farm's assets (a delivery vehicle, the cold room, pen housing,
equipment), and prove the four statements still tie on the seeded trading day.
If the phase does not fit, split at a sub-domain boundary (for example disposal) and follow "If a session cannot
finish".
Stop at the gate and write docs/sessions/B08c1c2-fixed-assets.md.
```
