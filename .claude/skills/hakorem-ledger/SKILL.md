---
name: hakorem-ledger
description: "Use when writing or changing code that publishes a financial domain event the ledger posts from, writes or reads `fin.journal_entry` or `fin.journal_line`, touches the chart of accounts or an account code (1200, 2100, 4210, 3000 and so on), `fin.posting_rule`, `fin.account_determination`, `fin.posting_event_type`, accounting periods, period lock or close, manual journals, reversing a journal entry, posting groups, subledgers, trial balance, depreciation, investor distribution postings, or the nightly subledger reconciliation. Also when an event type is flagged `posts_to_ledger`. Money arithmetic inside an amount is hakorem-money; the stock movement behind a posting is hakorem-stock; invoice and receipt output is hakorem-documents. Load it first for a question, plan or estimate on these too, even before the code exists."
---

# The general ledger: events in, balanced journals out

Decisions: `docs/adr/0003-chart-of-accounts-and-posting-matrix.md` (chart and matrix), `docs/adr/0005-aggregate-boundaries-and-isolation.md` (isolation, hot rows), `docs/adr/0010-commands-down-events-up-and-the-outbox.md`, `docs/adr/0012-table-classes.md`. Table dictionary: `docs/data-model/fin.md`. Boundaries: `docs/MODULE_BOUNDARIES.md` (FIN is layer 4; earlier-built modules never import it).

## Checklist

1. **Only FIN knows account codes.** A module with a financial effect publishes an event carrying named amounts and determinants (`value_pesewas`, `gl_group`, `branch_id`, `source_document_id`, a list of `{ levy_id, amount_pesewas }`). It never carries or hard-codes an account code, and never calls FIN.
2. **Posting is a transactional subscriber in the caller's transaction.** FIN's handler builds the journal from `fin.posting_rule` and `fin.account_determination`. If posting fails (closed period, missing rule, unbalanced result) the whole business operation rolls back. Do not catch and swallow that failure.
3. **Every row of the ADR-0003 matrix has a test** asserting exact debit and credit amounts per account and subledger. A new event is added to the event catalogue in `docs/DOMAIN_MODEL.md` section 5. A changed account for an existing event is a posting-rule change (data, approved by a second user). A change to the matrix itself is a new ADR that supersedes ADR-0003 (use hakorem-adr); an ADR is never edited to change its decision.
4. **A new `posts_to_ledger` event needs a handler and a complete rule set**, or the application refuses to boot (safeguard one). Add the boot-assertion case to the CI test.
5. **Journal shape.** Insert-only. A line has `account_id`, `side` (`D`/`C`), `amount_pesewas > 0`, `branch_id`, and `subledger_id` exactly when the account has a `subledger_kind` (receivables, payables, investor capital, levies, tills, drivers, banks). A new investor, supplier or levy needs no new account.
6. **Balanced by the database.** The deferred constraint trigger checks debits equal credits per entry at commit. Every ledger change ships a test that tries an unbalanced entry and expects the database to refuse it.
7. **Period lock.** A trigger rejects any entry whose `posting_date` is in a period that is not `OPEN`. A posting that races a period close fails and retries; that conflict is intended (ADR-0005).
8. **Reverse, never edit.** A correction is a new entry with `reverses_entry_id` set (unique). `UPDATE`, `DELETE` and `TRUNCATE` on the journal are forbidden for every role. `pay.PaymentReversed` reverses the original lines; it does not compute fresh ones.
9. **Serializable, no scans.** Posting runs at serializable isolation with whole-command retry on 40001 and 40P01. Use primary-key and index point reads only; a sequential scan takes a relation-level predicate lock and makes unrelated sales conflict. Do not maintain a synchronous GL balance row.
10. **Posting groups.** A cash sale posts stock issue, invoice and payment as three linked entries sharing one `posting_group_id`; receivables is the clearing account and nets to zero.
11. **Variances land on 4210.** Every difference between resolved and agreed price posts to 4210 with the cashier's shift as source; promotions to 4220; cash over and short to 6900.
12. **Rule and chart changes are maker-checker.** A posting rule change, tax scheme activation or manual journal goes through `iam.approval_request` with a different checker; rule changes also need step-up authentication (ADR-0017). A manual journal publishes `fin.ManualJournalApproved` only after approval.
13. **Branch is a dimension, not a book.** One legal entity, one chart; `branch_id` on every line. Inter-branch transfers post value between branch dimensions.
14. **Nothing auto-corrects.** The nightly reconciliation compares each control account with its subledger and asserts the trial balance sums to zero. A difference is an alert with the rows attached, never a silent fix.

## Correct and incorrect

Incorrect: the module knows accounts, writes journal lines, or edits a posted line.

```ts
// WRONG: inventory (layer 5) importing FIN and naming accounts
import { journal } from "../fin/infrastructure/journal.repo";          // boundary violation
await journal.insert({ debit: "5000", credit: "1310", amount: cost }); // account codes outside FIN
await db.execute(sql`UPDATE fin.journal_line SET amount_pesewas = ${fixed} WHERE id = ${id}`); // never
```

Correct: publish a fact; FIN maps it.

```ts
// src/modules/inv/events.ts  (types only; other modules import it with `import type`)
export interface StockIssuedForSale {
  type: "inv.StockIssuedForSale"; version: 1;
  valuePesewas: bigint; glGroup: "LIVE_ANIMALS" | "MEAT" | "PRODUCE_EGGS" | "BY_PRODUCTS";
  branchId: string; sourceDocumentId: string;
}
// src/modules/inv/application/issue-for-sale.ts
await events.publish<StockIssuedForSale>({ type: "inv.StockIssuedForSale", version: 1, /* ... */ });
```

Reversal in SQL, with the correction as a new row.

```sql
-- RIGHT: a reversing entry; reverses_entry_id is unique so it can be reversed once
INSERT INTO fin.journal_entry (id, posting_date, reverses_entry_id, posting_group_id, branch_id, actor_id)
VALUES ($1, $2, $3, $4, $5, $6);
-- lines: same accounts and subledgers as the original, with D and C swapped

-- WRONG
UPDATE fin.journal_line SET side = 'C' WHERE journal_entry_id = $1;
DELETE FROM fin.journal_entry WHERE id = $1;
```

## Test expectations

- Exact amounts per matrix row; trial balance sums to zero on the seeded trading day (B8 gate).
- Unbalanced entry rejected by the database; posting into a closed period rejected by trigger.
- Removing a handler fails the boot assertion.
- A ledger posting failure rolls back the originating stock movement (B8).
- Adding a fourth levy as data only produces four levy lines and four subledger postings without a code change (ADR-0020).
