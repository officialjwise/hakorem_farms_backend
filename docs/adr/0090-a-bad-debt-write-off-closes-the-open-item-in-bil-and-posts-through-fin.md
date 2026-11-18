# ADR-0090: A bad-debt write-off closes the open item in BIL itself and posts through FIN, maker and checker held by the database

- **Status:** Proposed
- **Date:** 2026-11-18
- **Session:** B10 continued 3 (lane B)
- **Deciders:** backend track, with the parent session's leave of 2026-11-18 to change BIL's settlement functions; the accountant and the owner review the recovery rule (BL-091)

## Context

FR-WHL-012: an unrecoverable open item is written off with a reason after approval by a different user, Dr 6940 Cr
1200, the customer record keeps the history, the invoice is not edited, and the open item closes with a link to the
write-off journal. Whether an invoice is open is answered in one place today: BIL's `bil.document_settlement`, kept by
`SECURITY DEFINER` functions (`bil.document_settlement_keep`, `bil.apply_settlement`, `bil.credit_note_refund`), and read
by PAY's open items, WHL's credit exposure, the overdue hold and dunning. Ageing reads BIL's documents and PAY's dated
allocations as at a date (ADR-0089).

Lane B owns WHL and may change BIL only additively. A write-off kept in WHL alone would leave two answers to "is this
invoice open": closed in WHL, outstanding in BIL and PAY. A later payment could then be allocated onto the amount written
off, and the money would be counted twice (once as bad debt, once as received).

## Options considered

1. **WHL keeps the write-off; WHL's readers subtract it.** No BIL change; BIL and PAY still show the item open and accept
   a payment onto it. Rejected: two sources of truth for an open item (the parent session's ruling).
2. **The write-off as a credit note.** A credit note posts to revenue and VAT, not to 6940, and edits what the invoice
   "was worth". Rejected by FR-WHL-012 and ADR-0003.
3. **BIL's summary carries what was written off, and every function that computes the balance subtracts it.** One answer
   everywhere; the database refuses an allocation or a credit note reaching into the amount written off.

## Decision

Option 3, under the parent session's leave (conditions: only these functions, no signature changed, identical behaviour
with nothing written off, the database enforcing it, a rollback restoring the old bodies).

- **BIL (migration 0271):** `bil.document_settlement.written_off_pesewas` (default nil, `ck_document_settlement_written_off`:
  never negative, and a document with anything written off never owes the customer money). `document_settlement_keep`,
  both forms of `apply_settlement` and `credit_note_refund` are replaced word for word but for subtracting it; a credit
  note reaching into it is refused as BIL's credit cap already is (`ck_billing_document_credit_cap`), an allocation as
  the outstanding cap already is (`ck_document_settlement_outstanding`). New: `bil.apply_write_off(document, amount, at)`
  (more than nothing, at most what is outstanding, under the summary's lock) and `Billing.writeOffIn`. The payment status
  of a document with something written off is UNPAID when nothing was paid or credited, PART_PAID otherwise; no status
  is added to the contract (A-321 (d)). The rollback restores 0182's and 0187's bodies and refuses to run once anything
  has been written off.
- **WHL (migration 0272):** `whl.bad_debt_write_off_request` (DOCUMENT, the ask; decided once by someone other than its
  maker, `ck_bad_debt_write_off_request_checker`) and `whl.bad_debt_write_off` (LEDGER, insert-only, the write-off
  applied with its journal; `ck_bad_debt_write_off_checker` and the trigger `whl.bad_debt_write_off_check`: only for an
  APPLIED request, as asked, by its maker and checker). A correction is a reversing row (BL-092); none is updated.
- **Maker and checker:** IAM's `BAD_DEBT_WRITE_OFF` approval (threshold nil, step-up), the asker's permission
  `whl.bad_debt.write_off` (the Accountant; the Owner too, because an Owner may grant only what it holds) and the
  approver's `whl.bad_debt.approve` (the Owner). The maker never checks: in IAM, in WHL's handler and in the database.
- **Posting:** WHL's ◆ `whl.BadDebtWrittenOff` (declared with `declareLedgerEvents`), posted by FIN in the approving
  transaction: Dr 6940 the amount, Cr 1200 against the customer's party (ADR-0003's row; migration 0273,
  `uq_journal_entry_bad_debt`). The write-off row names that entry.
- **Ageing:** a write-off is dated (`written_off_on`, the application clock's day), so the ageing as at a date takes off
  what was written off by then; 1200 was credited the same day, so the tie of ADR-0089 holds.
- **After a write-off:** money the customer pays later is never posted as a recovery: the database refuses it onto the
  amount written off, and WHL's consumer of PAY's payments publishes `whl.WrittenOffCustomerPaid` for the exception
  report (B12). A system overdue hold of a customer with a write-off is not released by itself (A-321 (e)). The recovery
  rule is the owner's (BL-091).

## Consequences

- One answer to "is this open" for PAY, WHL and the ageing; no double count.
- BIL's three functions now carry one more term each; the equivalence on documents with nothing written off is proved by
  `test/integration/bil/settlement-write-off.integration.spec.ts` (the old bodies run beside the new on the same steps).
- BIL's credit note approval handler does not translate a database refusal into 422 (true already for the credit cap
  race); a credit note reaching a written-off amount is refused with 500 until BL-093.
- Lane A's till paths that call `apply_settlement` are unchanged in behaviour; the rebase keeps their changes.
