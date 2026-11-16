# ADR-0058: The statements, the period balances and the year close as built

- **Status:** Proposed
- **Date:** 2026-11-16
- **Session:** B08 continued 1c
- **Deciders:** backend track; the accountant reviews the statement conventions and the year close (A-195, A-197)

## Context

ADR-0003 decides that "trial balance is a period snapshot plus lines since" and lists `fin.YearClosed` in the matrix ("4xxx to 3200, then 3100; 5xxx and 6xxx closed to 3200; 3300 closed to 3100"). ADR-0005 decides that no ledger balance is kept synchronously. `docs/data-model/fin.md` names `fin.period_balance`, "computed when a period is locked and refreshed nightly". Building the four statements and the year close raised questions those documents leave open: when a snapshot may be trusted, how a statement tells a year close entry from trading, where the closing entry is dated when the last period must already be locked before it can close, and how one event posts an account the rules cannot name in advance.

## Options considered

1. **Statements from the journal lines only; the year close as a manual journal the accountant enters.** Exact and simple, but it leaves the projection unused, and a hand-entered close can be wrong by a pesewa or posted twice.
2. **Statements from `fin.period_balance` for every period, refreshed nightly, plus lines recorded since `computed_at`.** Fast, but "since" is unsafe: a transaction that began before the refresh and committed after it has lines older than `computed_at` that the refresh never saw.
3. **The projection is trusted only for a period that is LOCKED or CLOSED, where nothing else can post; the year close is FIN's own ◆ event posted in the transaction that closes the last period.** Exact by construction, and the close is computed from the balances, once.

## Decision

Option 3.

- **Period balances.** `fin.period_balance` (PROJECTION) holds, per period, account, branch, subledger party and whether a year close entry posted it (`is_closing`), the exact debit and credit totals of the period's lines. Only `fin.refresh_period_balance(period)`, a `SECURITY DEFINER` function, writes it. A trigger calls it whenever a period becomes `LOCKED` or `CLOSED`, in that transaction and whoever changes the row, so the snapshot of a locked period is complete: every posting reads the period row `FOR SHARE` and a lock writes it (ADR-0005), and nothing posts into a locked period except the year close below, after which the period closes and is refreshed again. The nightly `ledger-reconcile` job refreshes the open periods and reports any locked or closed period whose rows differ from its lines (`periodBalanceDrift` on `fin.TrialBalanceDriftDetected`), never correcting.
- **Statements.** Each statement is one SQL statement over the ledger: a LOCKED or CLOSED period wholly before the range (its opening) or wholly inside it is read from its period balances, every other line from `fin.journal_line`. A reopened period is OPEN and is read from its lines until it locks again. The profit and loss leaves out year close entries, so a closed year still shows the profit it made; the trial balance and the balance sheet include them. The balance sheet shows the earnings not yet closed (every income, cost and expense balance to date) as one equity row with no account, so assets equal liabilities plus equity exactly whenever the ledger balances. The cash flow is the direct method over accounts 1000 to 1130: on each entry that moved cash, every other line is a flow in its account's `cash_flow_category` (operating when it has none), so the flows sum to the change in cash exactly with no allocation.
- **Year close.** Closing period 12 runs `YearClose` in the close's serializable transaction before the status changes: for each branch with a balance to close it registers a `YEAR_CLOSE` document and publishes `fin.YearClosed`, whose amounts are the balances on 31 December (`yearCloseAmounts`, pure, under the 100 percent gate). The ledger posts it through `Ledger.postIn` like every other event, as the branch's one `CLOSING` entry dated 31 December. Its rules are data (migration 0138): the side that closes an account takes the new determinant `CLOSED_ACCOUNT` (the account whose balance the amount closes, as `ENTERED` is the account a person entered for a manual journal); the other side names 3200 or 3100 as a fixed account, so the accountant can read ADR-0003's row in `fin.posting_rule`. The database holds the rest: `ck_journal_period_open` admits exactly one exception (a `CLOSING` entry on the last day of a year into its LOCKED last period), `ck_journal_entry_closing` ties `CLOSING` to `fin.YearClosed` both ways, `uq_journal_entry_closing` allows one per period and branch, `ck_journal_closing_period` refuses it at commit unless its period closed in the same transaction, and `ck_posting_rule_closed_account` keeps `CLOSED_ACCOUNT` on the closing sides of `fin.YearClosed` only. Afterwards the closed year refuses every posting through the ordinary period rule.
- **Published cash.** `fin.pub_cash_balance` publishes each cash and bank account's balance per branch for RPT's dashboard (ADR-0011): RPT reads no FIN table.

## Consequences

- A statement over closed years reads a few hundred projection rows instead of every line, and stays exact; an open period costs a range scan of its lines, which the index on `(account_id, posting_date)` serves.
- The year close cannot be forgotten, repeated, posted into the wrong date or committed without the close, and it posts nothing a person typed.
- A projection row edited by a superuser changes the statements until the nightly job reports it; the report names the period and account. Recomputing it is the documented fix (`docs/runbooks/reconciliation-break.md`), never automatic.
- Per-branch statements stay balanced, because every line of an entry carries the entry's branch and the year close posts one entry per branch.
- Binds: `docs/data-model/fin.md`, the `hakorem-ledger` skill, FIN and RPT cards in `docs/MODULE_BOUNDARIES.md`.

## Verification

- `src/modules/fin/domain/statements.spec.ts`, `year-close.spec.ts`, `period.spec.ts`, `posting.spec.ts` (the 100 percent gate on `src/modules/fin/domain/`).
- `test/integration/fin/financial-statements.integration.spec.ts`: the four statements on the seeded trading day against SQL sums of the lines; the SRS cash flow; a locked period read from its balances, a tampered row changing the statement and reported by the nightly job; every statement refusing the wrong role.
- `test/integration/fin/year-close.integration.spec.ts`: 3200 and every income, cost and expense account at nil and 3100 moved by the profit computed in SQL; the event's exact amounts; the database refusing a CLOSING entry from another event, one committed without the close, and a second one.
