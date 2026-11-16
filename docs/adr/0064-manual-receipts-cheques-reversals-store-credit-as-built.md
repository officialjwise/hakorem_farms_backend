# ADR-0064: Payments recorded by hand, cheques, reversals and store credit as built

- **Status:** Accepted (owner, 2026-11-16)
- **Date:** 2026-11-16
- **Session:** B09a continued 1b
- **Deciders:** backend track; the accountant reviews the posting rows (A-212); the owner's rules of 2026-11-16 (reversals and refunds keep maker and checker apart with step-up; store credit never negative, held in the database)

## Context

ADR-0003 names the rows: `pay.PaymentCleared` debits 1130 for a cheque and 2210 for store credit redeemed; `pay.ChequeCleared` moves 1130 to 1100; `pay.PaymentReversed` is "Reverse of the original"; `pay.RefundPaid` credits 2210 for a refund to store credit. ADR-0056 posts a correction as the mirror of the entry its subject names. Building them raised what those leave open: when a cheque posts (it is PENDING, yet ADR-0003 puts 1130 on the clearing event); how a pure mirror event passes the boot assertion, which asks every catalogued event for a debit and a credit rule; how a reversal mirrors a cheque that has also cleared (two entries); which allocations a reversal takes off through `pay.DepositAllocated` and which its mirror already reopens; where a bounced cheque goes (the contract's `reversePayment` names it; the opener names `clearCheque`); and how store credit stays non-negative when two tills redeem the last of it at once.

## Options considered

1. **A separate bounce on `clearCheque`, and reversal entries computed from fresh rules.** Adds a request field and a second way to undo a cheque; recomputing breaks ADR-0056 ("nothing is recomputed").
2. **Seeded rules for `pay.PaymentReversed` that look like the reverse of `pay.PaymentCleared`.** Passes the boot assertion, but the rules would never be used (the mirror copies lines), and a later change to them would do nothing: misleading data.
3. **A mirror event type with no amount keys; one reversal path for a bounce and an error; allocations classed by the transaction that wrote them; the balance held by a row lock in a trigger.**

## Decision

Option 3.

- **A cheque posts at receipt.** `recordPayment` writes it PENDING and publishes `pay.PaymentCleared` with `awaitingClearance: true` (Dr 1130, no party; Cr 1200 for its allocations, Cr 2200 the rest), as ADR-0003's row reads. `clearCheque` moves it to CLEARED and publishes ◆ `pay.ChequeCleared` (Dr 1100 against the bank account's own party, Cr 1130), dated the day the bank confirmed, its subject a fresh `clearance_ref` kept on the payment. A bank transfer is recorded PENDING with nothing posted and nothing allocated; it clears with bank statement matching (B09a continued 1c). Cash and provider methods are never recorded by hand.
- **A mirror event.** `fin.posting_event_type` admits an empty amount key list for `pay.PaymentReversed` only (migration 0173): such an event has no rules, the boot assertion asks none of it, and `Ledger.postIn` refuses it unless it names the subject whose entry it mirrors (`MIRROR_WITHOUT_ORIGINAL`). It carries the original's amount, so a missing original refuses the reversal (`ORIGINAL_NOT_POSTED`).
- **One reversal path.** `reversePayment` always waits for `PAYMENT_REVERSAL` (threshold 0, step-up, approver `pay.reversal.approve`); a cheque still awaiting clearance bounces (it becomes FAILED), anything cleared becomes REVERSED. Approved, in the approval's transaction: every live allocation gets its UNAPPLY row and BIL's settlement moves back; an allocation written in the payment's own transaction (the same `now()`, so its clearing entry credited it) is reopened by the mirror, one applied later from deposit by `pay.DepositAllocated` unapplied; a reversing payment is written REVERSED with `reverses_payment_id` (unique) and is the source of the mirror entries; one `pay.PaymentReversed` per entry the payment posted (`RECEIPT`, and `CLEARING` for a cleared cheque). The database refuses a payment becoming REVERSED or FAILED with anything still allocated or refunded, and a reversing payment that does not mirror its original.
- **Store credit** is `pay.store_credit_entry` (LEDGER, one entry per source document and direction) and `pay.store_credit_balance` (PROJECTION, written only by the entry trigger, SECURITY DEFINER), which takes the balance row's lock and refuses a redemption beyond it (`ck_store_credit_balance`). A refund to store credit is paid at once by its approver (Dr 2200, Cr 2210: `pay.RefundPaid` with tender `STORE_CREDIT`); a store credit tender redeems (Dr 2210); a reversed redemption issues the credit back.
- **The break queue is published** as `pay.pub_reconciliation_break`, every kind, for the daily exception report (RPT, B12); each reversal request is `pay.PaymentReversalRequested` carrying abuse case 32.

## Consequences

- A cheque is in 1130 from the day it is received, so receivables show it settled while it awaits the bank; a bounce reopens the item exactly.
- A single Owner cannot reverse alone; the smallest team (Owner and Manager) can, one asking and the other approving.
- The mirror event extends ADR-0056's correction path to an event of its own; ADR-0003's matrix is unchanged.
- Binds: `docs/data-model/pay.md`, `docs/API.md` (PAY), the PAY card in `docs/MODULE_BOUNDARIES.md`, `docs/runbooks/reconciliation-break.md`, A-212.

## Verification

- `test/integration/pay/receipts-reversals.integration.spec.ts`: the cheque of 100,000 recorded (Dr 1130, Cr 1200), cleared (Dr 1100 GCB, Cr 1130) and bounced (the mirror, the 100,000 item open again) on a different person's approval with step-up; a cleared cheque reversed by two mirrors; the 50,000 mobile money reversal (Dr 2200, Cr 1120, the allocation taken off Dr 1200 Cr 2200); store credit 6,000 refunded (Dr 2200, Cr 2210), 6,001 refused, 6,000 redeemed (Dr 2210, Cr 1200), given back on reversal, two redemptions of the last 6,000 at once leaving exactly one; the database's rules by direct SQL; every new write refusing the wrong role; the trial balance at zero and 1130 equal to the cheques awaiting clearance.
- `src/modules/fin/domain/rule-set.spec.ts` and `event-amounts.spec.ts`: the mirror event's catalogue and the exact amounts of each new row.
