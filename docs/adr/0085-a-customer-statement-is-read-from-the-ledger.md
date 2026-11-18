# ADR-0085: A customer statement is read from the ledger's receivables through FIN's door, numbered once and archived once

- **Status:** Proposed
- **Date:** 2026-11-17
- **Session:** B08 continued 2d (lane B)
- **Deciders:** backend track; the accountant reviews the reading of the figures and the lines' kinds (A-300)

## Context

FR-WHL-009 asks for a customer statement for a period that shows the opening balance, invoices, credit notes, payments
and the closing balance, with "opening plus charges less credits and payments equals closing, exactly", archived and
later sent by NTF. The gate of B08 continued 2d adds that it ties to the ledger's 1200 for the customer's subledger party
and period, to the pesewa, is numbered from its own gap-free series, rendered after commit and archived exactly once.
WHL's card in `docs/MODULE_BOUNDARIES.md` imports platform, IAM, MDM, DOC, BIL, PAY and ORD, and no FIN. A-206 records
why that matters: an opening balance the accountant enters by manual journal against a customer (A-005) is on 1200 but on
no billing document, and a refund paid against a credit note, a reversed payment or an allocation taken off are on 1200
and on no billing document either. FR-WHL-009's acceptance also says that regenerating the same period gives the same
document hash. Nothing in the contract names a branch on a statement, yet the number series, the document registry and
the authorisation are all per branch (ADR-0015, ADR-0017).

## Options considered

1. **Sum the documents: BIL's issued documents and PAY's payments, read through their doors.** Uses the card as it
   stands. It misses every amount on 1200 that no billing document or payment carries (the opening balance journal, a
   refund against a credit note, a reversal), so the statement would disagree with the ledger for exactly the customers
   the accountant cares most about, and the gate could not hold.
2. **Read the customer's 1200 activity from the ledger through FIN's door, each line named by its source document.**
   WHL (layer 10) imports FIN (layer 4), which the layer rule permits; FIN keeps the account code, and FIN gains one
   read in the caller's transaction. The statement then ties to 1200 by construction, and B9a's payments, a till's
   included, arrive without a change. It needs WHL to know which events mean an invoice, a payment or a credit, which
   it reads from the event codes, the public language of `docs/DOMAIN_MODEL.md` section 5.
3. **Keep a statement projection in WHL, fed by subscribing to every financial event.** Eventually consistent, a
   second copy of the ledger to reconcile, and it still could not see a manual journal without FIN publishing one more
   event for WHL.

## Decision

Option 2.

- **FIN's door.** `Journals.customerReceivablesIn(tx, { customerId, branchId, from, to })` answers the signed balance of
  1200 against the customer's `CUSTOMER` subledger party at the branch before `from` (debits less credits) and the
  lines from `from` to `to`, oldest first (posting date, entry number, line), each with its entry, side, amount, event
  code, entry kind and source document and that document's number from the platform's registry where it has one. It
  reads `ix_journal_line_subledger` by point lookups, runs in the caller's transaction and authorises nothing; WHL's
  command has. A customer never posted to reads zero and no lines.
- **WHL's arithmetic (pure, `src/modules/whl/domain/statement.ts`, under a 100 percent coverage gate).** Each line is
  classified by its event and side: `bil.InvoiceIssued` debit `INVOICE`, `bil.DebitNoteIssued` debit `DEBIT_NOTE`,
  `bil.CreditNoteIssued` credit `CREDIT_NOTE`, `pay.RefundPaid` debit `REFUND`, any other `pay.*` credit `PAYMENT` and
  debit `PAYMENT_REVERSAL`, everything else (a manual or opening journal, an event on a side it never posts to)
  `ADJUSTMENT`. Invoiced is the invoices and debit notes, credited the credit notes, paid the payments; refunds,
  reversals and adjustment debits are other charges, adjustment credits other credits. Opening less opening credit,
  plus invoiced and other charges, less credited, paid and other credits, is closing less closing credit, exactly. A
  balance in the customer's favour is shown beside a balance of zero (`openingCreditPesewas`, `closingCreditPesewas`,
  each line's `balanceSide` `C`), as `docs/data-model/whl.md` asks. A line is named by its source document's number,
  or by `Payment` or `Journal` and its journal's number when the source has none.
- **One branch.** A statement is the customer's account at one branch, the branch whose 1200 lines it reads and whose
  series numbers it. `StatementCreate.branchId` is optional and additive: without it the caller must hold
  `whl.statement.create` at exactly one whole branch (`BRANCH_REQUIRED`), as `createOrder` does.
- **Numbered once, archived once.** An issued statement takes `STM-<YEAR>-<BRANCH>-<SEQUENCE>` from the `STATEMENT`
  series of its issue date's year in the producing serializable transaction, after the series lock (ADR-0005), and asks
  DOC to render it with `Documents.requestRenderIn` in that transaction; WHL's consumer `whl.statement-archive-link`
  sets `archived_document_id` once. One issued statement exists per customer, branch and period
  (`uq_statement_issued_period`); asking again answers the first as it stands, so the same period gives the same
  document and hash. A draft is stored with no number and no rendering. The database holds the balance identity, the
  totals and running balances against the lines, the number against the platform's allocation, and that the row is
  written once (migration 0242).
- **WHL imports FIN.** WHL's card adds FIN to its imports. Sending a statement stays planned for B11 (ADR-0062).

## Consequences

- The statement agrees with the trial balance's 1200 for the customer at every branch and date, whatever posted to it;
  a new financial event that touches 1200 appears on statements as an adjustment until WHL names its kind.
- An issued statement is a record of what was sent: a payment posted later into an earlier open date does not change
  it; a statement of a later period shows it.
- FIN's door grows by one read; no posting rule, account or event changes.
- Binds: `docs/data-model/whl.md`, the WHL and FIN cards in `docs/MODULE_BOUNDARIES.md`, the `hakorem-documents` and
  `hakorem-ledger` skills, B10 (ageing, dunning and the business account build on `whl`), B11 (`sendStatement`).

## Verification

- `src/modules/whl/domain/statement.spec.ts`: FR-WHL-009's case (opening 100,000, invoices 250,000, a credit note of
  20,000, a payment of 150,000, closing 180,000), a customer in credit, an opening in credit, other charges and credits,
  the largest balance, every classification and reference; written before the code and seen red.
- `test/integration/whl/statements.integration.spec.ts`: the gate against SQL sums taken straight from
  `bil.billing_document` and `fin.journal_line`, with the opening by manual journal and the payment taken at a till
  shift; a customer in credit; rendered after commit and archived once with the SHA-256 of its stored bytes; five
  concurrent requests for one period answered by one statement, one number, one render and one archive; concurrent
  statements numbered densely; every database rule refused by SQL; every operation refusing the wrong role, a
  customer's sign-in and the Owner of another branch.
