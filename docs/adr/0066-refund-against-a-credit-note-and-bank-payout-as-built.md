# ADR-0066: The refund against a credit note and the cheque's bank payout as built

- **Status:** Proposed
- **Date:** 2026-11-16
- **Session:** B09a continued 1d
- **Deciders:** backend track; the accountant reviews the posting rows and the settlement reading (A-216); the owner's rules of 2026-11-16 ("refunds are where till fraud lives": a refund against a credit note is approved, with step-up, by someone other than its maker and other than the credit note's maker, and never exceeds the credit note's amount less what was already refunded against it, held by the database)

## Context

ADR-0003's `pay.RefundPaid` row reads "Dr 1200 or 2200, Cr the tender account, or 2210". ADR-0063 built the refund out of a deposit (Dr 2200), drawing only on a payment's unallocated money; ADR-0060's settlement summary refused any credit that took a document below zero outstanding, so a paid invoice could not be credited at all. FR-BIL-007 caps a credit note at the original's uncredited amount; FR-PAY-012 ties a refund to its original payment. Building the refund against a credit note left open: where a credit beyond what is outstanding goes; what a refund against a credit note draws on when the payment's money is all allocated; how the cap holds when two refunds arrive at once, given that PAY may not read BIL's tables; how "other than the credit note's maker" is held; and how a cheque, which ADR-0063 never paid back to its method, is refunded.

## Options considered

1. **Unallocate first, then refund out of deposit.** Reuses ADR-0063 unchanged (an allocation taken off, Dr 1200 Cr 2200, then Dr 2200 Cr tender), but a credit note on a paid invoice still cannot be issued, and the person refunding could take money off any document of the customer's.
2. **Count the refund on the payment's `refunded_pesewas`.** One cap, but the payment's allocated plus refunded would exceed its amount, which the database refuses (`ck_payment_amounts`), and a reversal would be blocked by a refund it does not owe.
3. **The credit note leaves money owed back on its original; the refund draws on the credit note through a BIL function under the credit note's row lock; FIN posts it out of receivables.**

## Decision

Option 3.

- **The settlement balance (BIL, migration 0182).** An issued invoice or receipt keeps one balance: gross less credited less allocated plus refunded. Above zero it is `outstanding_pesewas`; below, `refundable_pesewas`, what the document owes back to the customer. A credit note on a paid document is therefore issued; nothing is refunded until a person asks. A document that owes the customer money takes no allocation.
- **The cap, in the database.** BIL publishes `bil.credit_note_refund(credit note, amount, HOLD | RELEASE)` (ADR-0047), which takes the credit note's row lock and refuses a hold beyond its gross less what is already held against it, or beyond what its original owes back (`ck_credit_note_refund_cap`). PAY's refund trigger (SECURITY DEFINER, so `hk_app` never holds the function) calls it for a refund naming a credit note, and also requires a CLEARED payment of the credit note's customer and branch that paid the credited document at least the credit note refunds it carries (`ck_refund_credit_note_payment`). A refund holds its amount from the moment it is asked for; a rejection releases it. Two refunds of the last amount at once: the second waits on the lock and then fails serialization or the cap; exactly one stands.
- **Two people besides the maker.** `pay.refund.approved_by` is set by the guard when a refund moves to APPROVED and never changes; it is never the refund's maker (`ck_refund_approved_by`) and, against a credit note, never the credit note's maker (`ck_refund_credit_note_checker`, through BIL's read-only `bil.credit_note_facts`). IAM's approval still needs a different holder of `pay.refund.approve` with step-up; PAY's approval handler refuses the credit note's maker first (422 `MAKER_CANNOT_CHECK`).
- **The posting (FIN, migration 0184).** `pay.RefundPaid` gains the amount key `creditRefund`: Dr 1200 against the customer, Cr the tender by `PAYMENT_METHOD_KIND`. ADR-0003's row is unchanged; it already reads "1200 or 2200".
- **A cheque's bank payout.** A cheque refunded to its original method is paid by hand out of the bank account it was paid into: `markRefundPaid` with the payout's reference, by someone other than the maker, with step-up; the event names the tender `BANK_TRANSFER` and the bank account, so FIN credits 1100 against the account's party (the determination of ADR-0065).

## Consequences

- Receivables and the settlement summary agree: a credited paid invoice shows a credit balance on 1200 against the customer until the refund pays it out.
- The smallest team that can refund against a credit note is three people when the credit note's maker is also one of the two approvers; with the Accountant raising credit notes and the Owner or Manager approving, two approvers still suffice.
- The per-payment check is stricter than a per-document one when one payment settled several credited documents (A-216 (b)); the refund can then be split by payment.
- Binds: `docs/data-model/pay.md`, `docs/data-model/bil.md`, `docs/API.md` (PAY, BIL), the PAY, BIL and FIN cards in `docs/MODULE_BOUNDARIES.md`, `tooling/architecture.json`, A-216.

## Verification

- `test/integration/pay/credit-note-refunds.integration.spec.ts`: an invoice of 86,240 paid in full, credited 30,000 (Dr 4200, Cr 1200 30,000, 30,000 owed back); 10,000 asked for, refused for the refund's maker, the credit note's maker and without step-up, approved by the Owner, paid through the provider (Dr 1200 10,000 Tema, Cr 1120 10,000 Paystack, once); two refunds of the last 20,000 at once leave exactly one; one pesewa more refused over the API and by SQL; the credit note's maker refused as approver by SQL; a rejection releases the 20,000, which then goes to store credit (Dr 1200, Cr 2210); a cheque of 50,000 credited 12,500 and paid back by bank payout (Dr 1200 12,500, Cr 1100 12,500 GCB) by someone other than the maker with its reference; an unallocated cheque deposit paid back the same way (Dr 2200, Cr 1100); the wrong roles; the trial balance at zero and the customer's receivable where it started. A run with the database cap removed fails it.
- `src/modules/pay/domain/refund.spec.ts`, `src/modules/fin/domain/event-amounts.spec.ts`, `src/modules/bil/domain/billing.spec.ts`: the rules and the exact amounts.
