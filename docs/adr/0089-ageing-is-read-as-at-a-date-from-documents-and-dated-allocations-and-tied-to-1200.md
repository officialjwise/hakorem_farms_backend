# ADR-0089: Ageing is read as at a date from BIL's documents and PAY's dated allocations, and tied to 1200 beside it

- **Status:** Proposed
- **Date:** 2026-11-18
- **Session:** B10 continued 2 (lane B)
- **Deciders:** backend track; the accountant reviews the reading of the buckets and of what is "not aged" (A-317)

## Context

FR-WHL-010 asks for receivables ageing "as at a date from invoice due dates and payment allocations", by customer, with
a total over the filter, and says "the buckets sum to the receivables control account". The gate of B10 continued 2 adds
that it ties to SQL sums taken from BIL's and PAY's own tables and to 1200, with the date taken as input (ADR-0067). Three
facts shaped the choice:

1. What an invoice has outstanding is kept now, not as at a date: `bil.document_settlement` is a current figure. Credit
   notes carry their own `issue_date`, but a payment allocation (`pay.payment_allocation`) carried only `recorded_at`,
   the database's clock, which ADR-0067 says decides nothing (and in tests differs from the application clock).
2. 1200 holds more than the open items: an opening balance by manual journal, a refund paid against a credit note, an
   allocation posted at another branch than the invoice, and the till's walk-in customer, whom MDM does not hold.
3. FR-WHL-009 wants the ageing summary on the statement, and the statement is already 1200 at one branch (ADR-0085).

## Options considered

1. **A projection (`whl.ageing_snapshot`) kept by subscribers.** Eventually consistent, a second copy of BIL and PAY to
   reconcile, and it cannot answer an arbitrary past date without history anyway.
2. **Age the ledger: 1200's lines matched to invoices.** A payment's 1200 line names the payment, not the invoice it was
   applied to, so the matching would re-derive PAY's allocations from the ledger.
3. **Age the documents as at the date, tie to 1200 beside them.** BIL answers its documents issued by the date with their
   credit notes issued by then; PAY answers each document's allocations applied by the date, dated by a new business-day
   column written from the application clock; FIN answers each customer's 1200 as at the date. The difference between the
   buckets and 1200 is shown, never hidden in a bucket.

## Decision

Option 3.

- **PAY dates each allocation** (`pay.payment_allocation.allocated_on`, migration 0264): the Africa/Accra day of
  `platform.app_now()`, the application clock the unit of work sets, written as a column default so no writer changes;
  the same instant the allocation's journal (`pay.DepositAllocated`) is dated from. Rows written before 0264 are read as
  the Accra day of their `recorded_at`. PAY's new `AllocationsAsAt.netAppliedIn` sums applied less taken off, by document.
- **BIL** adds `Billing.receivablesAsAtIn` (issued invoices, receipts and debit notes to a named customer by the date,
  with their credit notes issued by then); **FIN** adds `Journals.customerReceivableBalancesIn` (each customer's signed
  1200 at the branches as at the date). Each reads in the caller's transaction and authorises nothing.
- **WHL's arithmetic** (`whl/domain/ageing.ts`, 100 percent coverage gate): an item's balance (gross less credited less
  applied) goes whole into the band of its days past due from its due date, or its issue date when it has none (SA-21:
  Current, 1 to 30, 31 to 60, 61 to 90, over 90); a balance of nil or below is no open item. Beside the buckets, 1200 as
  at the date (`ledgerPesewas` or `ledgerCreditPesewas`) and what it holds beyond them (`notAgedPesewas` or
  `notAgedCreditPesewas`), so total plus not aged less not aged credit is 1200 exactly.
- **The report** (`getAgeingReport`, `whl.ageing.read`) reads all three in one serializable snapshot, at the branches the
  reader holds the permission for as a whole, by customer name, with totals over the whole filter; 1200 against a party
  MDM holds no customer for is in the totals and named apart (`otherPartiesPesewas`), on no row.
- **The statement** stores its summary as at its period end at its branch, frozen with it; the database holds that it
  ties to the statement's closing (`ck_statement_ageing_ties`, migration 0265). Template version 2 prints it (0268).
- **No `whl.ageing_snapshot`.** The table is not built; the data model says so.

## Consequences

- The buckets equal the SQL sums of BIL's and PAY's own rows and the report ties to 1200 for every date, with any
  difference visible; the accountant decides what to do with an opening balance that is on no invoice (A-317 (c)).
- An allocation back-dated by a period lock or a payment's value date is aged by the day the allocation was written,
  as the ledger dates it; a later need for a value date on allocations is a forward change of PAY's writer.
- PAY, BIL and FIN each grow by one read and PAY by one defaulted column; nothing existing changes shape.
- Binds: `docs/data-model/whl.md` and `pay.md`, the WHL card in `docs/MODULE_BOUNDARIES.md`, B10 continued 3 (the
  bad-debt write-off closes an open item the ageing shows), B11 (dunning's sends), B12 (RPT's receivables figures).

## Verification

`src/modules/whl/domain/ageing.spec.ts` (every band's first and last day, FR-WHL-010's figures, due on issue, the largest
amounts, what is not aged on either side), written before the code and seen red; `test/integration/whl/ageing-dunning.integration.spec.ts`
(each band against SQL sums from `bil.billing_document` and `pay.payment_allocation` and against 1200 from
`fin.journal_line`, a credit note and a payment on a later day, an opening balance journal, the whole branch page by
page, the statement's summary and the database refusing one that does not tie), mutation-checked.
