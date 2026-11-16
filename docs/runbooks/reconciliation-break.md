# Runbook: reconciliation break

Last reviewed: 2026-11-16 (B8: `ledger-reconcile`; B09a continued 1b: cheques, reversals, store credit; B09a continued 1c: settlement reports, bank statements, the break endpoints). Severity: Critical when a job reports `DRIFT` or `FAILED`; Warning for an ordinary payments break. Related: `docs/ARCHITECTURE.md` section 8 (nightly reconciliation), ADR-0003, ADR-0015, `docs/data-model/pay.md`, `docs/runbooks/stock-balance-drift.md`, `docs/runbooks/audit-chain-integrity.md`, `docs/runbooks/payment-provider-down.md`.

## The rule

**A reconciliation job reports. It never corrects.** Drift is a finding for a person. The fix is always a new, approved, reversing or adjusting record made through the application, never an update of a ledger, stock, allocation or number row. If you are tempted to "just fix the number", you are about to destroy the evidence of what went wrong.

## What the jobs check

| Job (time, Accra) | Compares | On a difference |
| --- | --- | --- |
| `stock-balance-recompute` (02:00) | Every `inv.stock_balance` and `inv.cost_pool` row with the movement ledger | Alert; `inv.stock_exception` of kind `BALANCE_DRIFT` (see `stock-balance-drift.md`) |
| `ledger-reconcile` (02:15; B8 runs the planned `trial-balance-check`, `subledger-reconcile` and `numbering-check` as this one job, A-187) | Total debits equal total credits overall and per entry; each control account with its registered subledger (B8: inventory accounts with cost pools, summed across branches; receivables, provider clearing, tills and drivers join with their modules); every number series contiguous; from B08 continued 1c each LOCKED or CLOSED period's `fin.period_balance` rows equal its lines (it first refreshes the open periods' rows, ADR-0058) | Alert; `fin.TrialBalanceDriftDetected` with the unbalanced entries, each control break with both figures, the series with gaps and each period balance that differs (`periodBalanceDrift`). Read them in `platform.job_run.summary` and the event's payload |
| `settlement-match` (02:45) | Imported provider settlement lines with recorded payments | `pay.reconciliation_break` rows |
| `audit-verify` (03:10) | Hash chain, gaps, head against the anchor | See `audit-chain-integrity.md` |
| `projection-compare` (03:30) | Key totals in `rpt` against the modules of record | Alert; `rpt.ProjectionDriftDetected` |

Outcomes are recorded in `platform.job_run` (`SUCCESS`, `DRIFT`, `FAILED`) with a `summary` that carries the counts and the offending record ids. The health endpoint shows the latest outcome of each (`last_...` checks). `DRIFT` means the check ran and found a difference. `FAILED` means the check itself could not run.

## Symptoms

- Alert: reconciliation job outcome `DRIFT` or `FAILED`; no success in 26 hours (warning) or 36 hours (critical).
- Health check `last_trial_balance_check`, `last_subledger_reconcile`, `last_settlement_match`, `last_numbering_check` or `last_projection_compare` is `DEGRADED`.
- New rows in `GET /reconciliation/breaks` (status `OPEN`), or unmatched payments in `GET /payments/unmatched`.
- The daily exception report has items of kind `RECONCILIATION_BREAK` or `UNMATCHED_PAYMENT`.

## Triage

1. **Open the job result.**
   ```sql
   SELECT job_name, started_at, finished_at, outcome, summary
   FROM platform.job_run
   WHERE finished_at > now() - interval '2 days' AND outcome <> 'SUCCESS'
   ORDER BY finished_at DESC;
   ```
2. **Classify by job.**

| Finding | Seriousness | Go to |
| --- | --- | --- |
| Trial balance does not balance | **Incident.** The database refuses an unbalanced journal at commit, so an imbalance means a rule was bypassed (a superuser edit, a migration, a restore error) or the check is wrong | Section A |
| Stock balance or cost pool differs from the ledger | High | `stock-balance-drift.md` |
| A control account differs from its subledger | High | Section B |
| Numbering gap or orphan | High: a number without a document, or a document without a number | Section C |
| Settlement differs from our payments | Normal | Section D |
| Projection drift | Medium (reporting figures are wrong, the books are not) | Section E |
| Audit mismatch | Incident | `audit-chain-integrity.md` |
| `FAILED` | The check did not run | Section F |

3. **Acknowledge within one business hour** and write the finding in the incident log if it is classed as an incident.

## A. Trial balance does not balance

1. **Stop and capture.** This should be impossible. Treat it as `incident-response.md` step 2 (evidence first). A deferred constraint trigger checks debits equal credits at commit for every journal entry touched.
2. Identify the entries: the job summary lists them. `SELECT e.id, e.posting_date, sum(CASE WHEN l.side='D' THEN l.amount_pesewas ELSE 0 END) d, sum(CASE WHEN l.side='C' THEN l.amount_pesewas ELSE 0 END) c FROM fin.journal_entry e JOIN fin.journal_line l ON l.journal_entry_id = e.id GROUP BY e.id, e.posting_date HAVING sum(CASE WHEN l.side='D' THEN l.amount_pesewas ELSE -l.amount_pesewas END) <> 0;`
3. Check whether the trigger is enabled (`select tgname, tgenabled from pg_trigger where tgrelid = 'fin.journal_line'::regclass;`), whether a recent migration touched the ledger tables, and whether a restore or a superuser session occurred (the database log, the incident log).
4. Do not insert a "balancing" entry until the cause is known. The correction, when the owner agrees, is an approved manual journal (maker the accountant, checker the owner, step-up) with a description that cites the incident.

## B. A control account differs from its subledger

1. Read both figures from the job summary. Typical pairs: inventory accounts (1300 to 1360) against cost pools; trade receivables (1200) against `pay.invoice_settlement` outstanding; provider clearing (1120) against unsettled payments; tills (1000) against shift expected cash; drivers (1020) against driver cash on proofs of delivery.
2. Find the difference at the level of the party or the document: `GET /finance/accounts/{id}/activity` filtered by the subledger party and date; for receivables, `GET /receivables/open-items` against the journal lines for the customer.
3. Common causes and fixes:

| Cause | How to see it | Fix |
| --- | --- | --- |
| A posting rule or account determination changed and is applied to part of a period | Rule change in the audit log (`POSTING_RULE_CHANGE`) | The accountant corrects through an approved journal that reclassifies |
| An event published but the ledger handler missed it | The event in `platform.outbox_message` with no journal for its source document. Boot-time assertion should have prevented it | Fix the code (new release), then the accountant posts the missing entry as an approved manual journal referencing the source document |
| A reversal posted on one side only | The reversing movement without a reversing journal | Same: approved manual journal |
| An offline sale posted late (`OFFLINE_SYNC.md` section 9.4) | `posted_late` flag, over or short items on the shift | The accountant's journal for the over or short as described there |
| A manual journal wrongly coded | The journal and its approver | Reverse with an approved reversing journal and enter the correct one |

4. Never edit open items, balances or journal lines. The correction always posts through approval.

## C. Numbering gap or orphan

1. The job lists the series (`doc_type`, fiscal year, branch, register) and the value. `SELECT * FROM platform.number_allocation WHERE series_id = '<id>' ORDER BY value;` against `platform.number_series.next_value`.
2. **A gap** (a value below `next_value` with no allocation) cannot normally happen: allocation happens inside the document's transaction and rolls back with it. Look for a migration or a manual change. **An orphan** (an allocation whose document does not exist) means a document was removed, which must not happen, or the `document_id` points to a document in another state. Check `platform.business_document` for the id.
3. If a real document is missing, that is a data loss event: check restores and the backup chain. Do not "plug" the number. A voided or cancelled document keeps its number; it appears with its status.
4. Record it as an incident if a document vanished. Otherwise explain it in the finding with the evidence and have the accountant sign the note. The check continues to report it nightly until the explanation is attached to the series.

## D. Settlement and payment breaks (the payments module)

These are `pay.reconciliation_break` rows. Kinds: `UNMATCHED_PAYMENT`, `UNVERIFIED_PAYMENT`, `PROVIDER_AMOUNT_DIFFERS`, `PROVIDER_REFERENCE_UNKNOWN`, `PROVIDER_PAYMENT_MISSING`, `SETTLEMENT_AMOUNT_DIFFERS`, `SETTLEMENT_NOT_FOUND`, `BANK_LINE_UNMATCHED`, `LEDGER_CASH_DIFFERS`, `REFUND_FAILED`.

**As built in B09a continued (2026-11-16, A-210):** the payments flows raise `UNMATCHED_PAYMENT`, `PROVIDER_AMOUNT_DIFFERS`, `PROVIDER_REFERENCE_UNKNOWN`, `PROVIDER_PAYMENT_MISSING` and `REFUND_FAILED`, each once while it is open, each published as `pay.ReconciliationBreakRaised` for the daily exception report. The break endpoints below (list, get, resolve with a posting through approval) arrive with B09a continued 1b (A-211); until then read them as the administrator, read-only, and log the use:

```
SELECT kind, payment_id, refund_id, reference, amount_pesewas, details, raised_at FROM pay.reconciliation_break WHERE status = 'OPEN' ORDER BY raised_at;
```

**As built in B09a continued 1b (2026-11-16, A-212, ADR-0064):** the break endpoints are still B09a continued 1c's (A-213); read breaks as above. Every break of every kind is also published as the view `pay.pub_reconciliation_break` for the daily exception report. Cheques, reversals and store credit:

- **A cheque returned unpaid by the bank.** Never mark it failed by hand. Ask for `POST /payments/{id}/reverse` with `reasonCode: CHEQUE_DISHONOURED` and a note quoting the bank's letter (Owner, Manager or Accountant); a different Owner or Manager approves with step-up. Approved, the cheque is `FAILED`, Dr 1200 Cr 1130 is posted as the mirror of its receipt, and the invoice it settled is open again (check `GET /receivables/open-items?customerId=...`). A cheque that had already cleared is reversed with `RECORDED_IN_ERROR` or `CHEQUE_DISHONOURED`: both its receipt and its clearing are mirrored, so 1100 drops by the cheque.
- **1130 does not equal the cheques awaiting clearance.** Read-only: `SELECT COALESCE(sum(amount_pesewas), 0) FROM pay.payment WHERE method_kind = 'CHEQUE' AND status = 'PENDING';` against the 1130 balance from `GET /finance/accounts/{id}/activity`. They are equal by construction (proved in `test/integration/pay/receipts-reversals.integration.spec.ts`); a difference is Section B's control break.
- **A store credit balance looks wrong.** Read-only: `SELECT direction, sum(amount_pesewas) FROM pay.store_credit_entry WHERE customer_id = $1 GROUP BY 1;` (issues less redemptions and expiries equal `pay.store_credit_balance`), and 2210 against the customer's party. The balance is written only by its trigger and never goes below zero; never edit an entry or the balance. A wrong credit is corrected by reversing the payment or refund that caused it, through approval.
- **A reversal waits.** `pay.payment_reversal` rows in `PENDING_APPROVAL` are in the approvals inbox (kind `PAYMENT_REVERSAL`); a single Owner cannot approve their own: the Manager or a second Owner must. Each request is on the daily exception report (abuse case 32).

**As built in B09a continued 1c (2026-11-16, A-214, ADR-0065):** the break endpoints exist. Read breaks with `GET /reconciliation/breaks?status=OPEN` (Owner, Manager, Accountant), not SQL. **A break is never resolved by hand and never resolves itself:** `POST /reconciliation/breaks/{id}/resolve` (Owner or Accountant) with a note always answers 202; a different Owner or Manager approves it in the approvals inbox (kind `RECONCILIATION_BREAK`) with step-up. The database refuses a break marked resolved without that approval. Fix the cause first through its own operation, then resolve with a note that says what was done.

- **Import.** Upload the provider's settlement file or the bank statement as an `IMPORT` file (`POST /files`), wait for its scan, then `POST /reconciliation/settlement-reports` (`provider`, `fileId`, `bankAccountId`, the GCB current account the provider pays into) or `POST /reconciliation/bank-statements` (`bankAccountId`, `fileId`, `periodStart`, `periodEnd`). Formats (A-214): settlement `settlement_ref,settled_on,reference,amount,fee`; statement `value_date,direction,amount,balance,reference,narration` in the bank's order, amounts in cedis with two places. A refusal names each broken row (`/file/rows/<n>`). The same file twice, the same settlement reference, or an overlapping statement period is refused (`ALREADY_IMPORTED`); nothing is posted twice.
- **Match.** `POST /reconciliation/settlement-reports/{id}/match` once: matched lines post Dr 1100 net, Dr 6910 fees, Cr 1120 gross; each other line is a break. `POST /reconciliation/bank-statements/{id}/match` as often as needed: a transfer recorded `PENDING` whose reference appears on exactly one line at exactly its amount clears from it (Dr 1100, Cr 2200), a settlement payout links to its entry; ties and differences stay breaks for a person, by design.
- **`SETTLEMENT_NOT_FOUND`** (`details.reason`): `NO_PAYMENT` (no payment of ours carries the reference: find the payer in the provider's dashboard; if nobody can be named, resolve with `posting: UNIDENTIFIED_RECEIPT`, which holds it in 2290 on approval); `NOT_CLEARED` (our payment is still pending: run the provider sweep or `checkPaymentStatus`; never clear it by hand; once cleared, resolve with a note); `ALREADY_SETTLED`.
- **`SETTLEMENT_AMOUNT_DIFFERS`:** `details` carries both amounts. Query the provider in writing; the accountant posts any correction by approved manual journal; then resolve with a note.
- **`BANK_LINE_UNMATCHED`** (`details.reason` `NO_CANDIDATE`, `AMOUNT_DIFFERS`, `CANDIDATES_TIE`): record the transfer first if it is missing (`POST /payments`, method bank transfer, its reference), then `POST /bank-statement-lines/{id}/match` with `paymentId`, or with `journalEntryId` for an entry already posted (a supplier payment, a cheque clearing, capital); then resolve with a note. Money in from a payer nobody can name: resolve with `posting: UNIDENTIFIED_RECEIPT` (Dr 1100, Cr 2290). Bank charges: the accountant's approved manual journal to 6920, then resolve with a note.
- **2290 Suspense** equals the unidentified receipts held: `SELECT sum(amount_pesewas) FROM fin.journal_line l JOIN fin.account a ON a.id = l.account_id WHERE a.code = '2290'` (credits less debits) against the resolved breaks with posting `UNIDENTIFIED_RECEIPT`. When the payer is found, the accountant moves it from 2290 to the customer's deposit by approved manual journal (A-214 (e)).

A `REFUND_FAILED` break is closed by the refund being paid (`POST /refunds/{id}/retry` until the provider pays it, or `POST /refunds/{id}/mark-paid` with the payout's reference by someone other than the refund's maker), never by hand.

```
GET /reconciliation/breaks?status=OPEN
GET /reconciliation/breaks/{id}
POST /reconciliation/breaks/{id}/resolve      # body: a note, and the resolution
```

| Kind | Meaning | Resolution |
| --- | --- | --- |
| `UNMATCHED_PAYMENT` | A cleared payment with no order, or a provider line with no payment | Find the order or customer (the reference, the phone, the amount, the time). Allocate it (`POST /payments/{id}/allocate`) or hold it as a customer deposit; if the order no longer exists (the break's `details.reason` is `ORDER_RELEASED` or `PAID_AFTER_WINDOW`), refund (`POST /refunds`; every refund waits for a different approver with step-up). Resolve with the note |
| `PROVIDER_AMOUNT_DIFFERS` | The provider's own record of a charge is for another amount (or currency) than we asked: the payment is not cleared | Read the provider's dashboard for the reference. Never clear it by hand. If the customer paid a different amount, agree with them: refund what they paid through the provider's dashboard or, once B09a continued 1b builds it, resolve the break with the approved posting |
| `PROVIDER_REFERENCE_UNKNOWN` | The provider holds a success under a reference this system never created (from a webhook or the sweep): nothing was posted | Find who paid (the provider's dashboard: phone, time, amount). It is usually a payment made through the provider's own page or another integration. Resolve it as an unidentified receipt (2290) or a customer's deposit with the approved posting (B09a continued 1b), or refund it from the dashboard |
| `PROVIDER_PAYMENT_MISSING` | A charge we sent has no record at the provider 30 minutes later: the payment was failed | The charge never reached the provider (it was down). Confirm in the dashboard that nothing was taken; ask the customer to pay again. If the dashboard does show the money, raise it with the owner: the provider answered "not found" for a real charge |
| `UNVERIFIED_PAYMENT` | An offline unverified mobile money tender (`OFFLINE_SYNC.md` 9.9) | Match it to a settlement or statement line by reference and amount, then resolve. If there is no match within `pay.unverified_window_days` (default 3), ask the provider's dashboard and the mobile money statement; if the money never arrived, request a payment reversal (approval), and deal with the loss under the owner's decision |
| `SETTLEMENT_AMOUNT_DIFFERS` | The provider settled a different amount than we recorded | The difference is usually the provider's fee (posts to 6910 on settlement), a refund netted, or a chargeback. Check the line detail; if the fee is expected, resolve with the note and let the settlement post it. A difference that is not a fee or a refund is queried with the provider in writing |
| `SETTLEMENT_NOT_FOUND` | A settlement line no cleared payment of ours carries (as built; a cleared payment never settled is the nightly `settlement-match` job's, not yet built, A-214 (g)) | See the reasons above: find the payer, wait for the provider's own confirmation, or hold it in 2290 through an approved resolution |
| `BANK_LINE_UNMATCHED` | A bank statement line with no payment | `POST /bank-statement-lines/{id}/match` to the right payment, or record the payment first (bank transfer) and match |
| `LEDGER_CASH_DIFFERS` | Cash per ledger differs from a count or statement | Follow the shift or reconciliation involved; the accountant posts the approved correction |
| `REFUND_FAILED` | A refund was requested and the provider did not complete it | `POST /refunds/{id}/retry`, or settle another way (`mark-paid` with the reference), after checking with the customer |

Every resolution carries a note, and the resolving user is recorded. The maker of a correction is not its approver where an approval applies.

## E. Projection drift

`rpt` and `cst` hold read models fed by events. The books are not wrong; the report is. Find the projector that lags or errs (`queue-backlog.md`), fix the cause, and rebuild the projection from events with the projector's rebuild command (specified in B11 and B12 for each projection). Re-run `projection-compare` and confirm `SUCCESS`. Until then, figures of record come from the module that owns them (the ledger, the stock ledger), and the owner is told the dashboard may be stale.

## E2. Period balance drift (the ledger's own projection, ADR-0058)

`periodBalanceDrift` names a locked or closed period, an account and a branch whose `fin.period_balance` totals differ from the journal lines of that period. The lines are the record; the statements of ranges covering that period read the projection and are wrong until it is fixed. Nothing writes the projection but `fin.refresh_period_balance()`, so a difference means someone wrote it by hand (a superuser) or the function changed. Diagnose: `SELECT * FROM platform.audit_event` and the database log for writes to `fin.period_balance`; compare `SELECT account_id, sum(debit_total_pesewas), sum(credit_total_pesewas) FROM fin.period_balance WHERE period_id = $1 GROUP BY 1` with the same sums over `fin.journal_line` joined to `fin.journal_entry` on `period_id`. Fix, after the evidence is captured (`incident-response.md`): as the migrator, `SELECT fin.refresh_period_balance('<period id>')` for that period only; re-run `ledger-reconcile` and confirm `SUCCESS`. Never edit a journal line to match the projection.

## F. The job failed

`FAILED` means the check could not run: a query timeout, a lock, a database error, a worker crash. Read `summary` and the worker log around the time (`dc logs --since 24h worker | grep reconcil`). Re-run the job once the cause is fixed (administrators can trigger a job from the worker; the schedule is in `docs/OPERATIONS.md` section 8). Two consecutive failures of the same job are escalated, because a check that does not run is a control that is off.

## Verification

- Re-run the relevant job: outcome `SUCCESS`, and the health check returns to `OK`.
- The breaks you resolved show `RESOLVED` with a note and your user; none `OPEN` is older than 7 days without an explanation in the incident log.
- The daily exception report no longer lists the items, or lists them with their resolution.
- For a ledger correction, the correcting journal is posted, approved by a different user, and the trial balance and control accounts agree.

## Escalation

| When | Who |
| --- | --- |
| Trial balance not zero, a vanished document, an audit mismatch | `incident-response.md`; the owner immediately |
| A control account differs by more than GHS 1,000 (100,000 pesewas), or any difference that is not explained within one business day | Owner and accountant |
| A settlement difference that the provider cannot explain after two reports | Accountant with the provider's merchant support |
| The same finding two nights running | Administrator: it is a defect, open an issue, and add the case to the tests |
