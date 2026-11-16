# ADR-0060: Billing documents as built: the issue port, the rules the database holds, and the three posting rows

- **Status:** Accepted (owner, 2026-11-16)
- **Date:** 2026-11-16
- **Session:** B08 continued 2
- **Deciders:** backend track; the accountant reviews the posting reading and the credit note policy (A-200)

## Context

ADR-0015 decides gap-free numbers allocated in the issuing transaction, ADR-0020 a levy row per line and levy, and ADR-0003 three matrix rows for billing (`bil.InvoiceIssued`, `bil.CreditNoteIssued`, `bil.DebitNoteIssued`). Building them left open: how a selling module (B9a's sale posting, B9b's counter) issues a document inside its own transaction; which rules the database holds rather than code; how an issued document's settlement is shown before payments exist; how BIL (layer 6) shows the animal or lot a line sold without reading INV's tables; and how ADR-0003's "40xx at resolved net" reads on a tax-inclusive line.

## Options considered

1. **An HTTP-only billing command that the selling module calls after its own commit.** Simple, but a sale and its document could disagree, which the shared brief forbids ("one business operation is one transaction").
2. **The selling module writes BIL's rows itself.** Breaks the one-owner rule (MODULE_BOUNDARIES section 1).
3. **A public, in-transaction method on BIL's door (`Billing.issueIn`), like MDM's `TaxService.calculateIn` and INV's `Stock.postIn`, with every document rule held by BIL's own triggers.** The seller's transaction issues, numbers and posts the document; a rollback returns the number.

## Decision

Option 3.

- **The port.** `Billing.issueIn(tx, actor, request)` issues an INVOICE, RECEIPT or PROFORMA in the caller's serializable transaction. It authorises nothing (the caller's command has); it refuses any other isolation. `Billing.seriesLocksFor(kind, branchId)` names the document's series and the journal's (`<KIND>:<YEAR>:<BRANCH>`, `JOURNAL:<YEAR>:<BRANCH>`) for the caller's `seriesLocks`, so concurrent issuers queue (ADR-0005, A-186). Levy rows come from `TaxService.calculateIn` on the line anchors (ADR-0001); totals are the sums of the lines. A document is written DRAFT, numbered by `platform.allocate_number`, and issued in the same transaction; issuing publishes its event, which the ledger posts there (ADR-0056). Credit and debit notes are BIL's own HTTP commands against an issued invoice or receipt; a credit note waits for `CREDIT_NOTE` approval and is issued by the approval's handler.
- **The database holds** (migration 0147): a document is written DRAFT and issued once; an issued document never changes but for its credited amount, its content hash (set once) and its certified totals; lines and levy rows change only in a draft; at commit an issued document's totals are its lines', each line's tax its levy rows', and its number the one the platform allocated to it (`platform.number_allocated`, a shared read-only function); a note corrects an issued invoice or receipt of the same branch and customer; credit notes never exceed the original, and its credited amount is exactly its issued credit notes. Migration 0148 adds one journal entry per billing document (`uq_journal_entry_billing`).
- **Settlement.** `bil.document_settlement` (PROJECTION) is written by a `SECURITY DEFINER` trigger at issue and at each credit; allocated is 0 until PAY's subscribers (B9a) write it. `bil.pub_document` publishes issued documents with their due date and outstanding amount; `fin.pub_receivable_balance` publishes 1200 per branch; RPT reads both for the receivables figures.
- **Snapshots, not reads.** A line stores the stock unit's identifier and tracking as the seller names them; the customer's name is copied from MDM's `MasterDataRefs.customersIn` at issue.
- **The three posting rows** (migration 0148, ADR-0003 unchanged): an invoice or receipt debits 1200 at the agreed gross against the customer (or the walk-in party), credits each line's income at its net plus its discount plus its price variance (resolved less agreed, each extended once) by GL group or to 4100 for delivery, credits 2100 per levy against the levy, and posts the variance to 4210 (debit below, credit above) and the discount to 4220; a credit note debits 4200 at its net and 2100 per levy and credits 1200; a debit note debits 1200 and credits 40xx and 2100. Every levy goes through the one `TAX_LEVY`/`OUTPUT` determination, so a fourth levy is data only.

## Consequences

- B9a's sale posting calls `Billing.issueIn` in the transaction that issues stock and records payment; it never writes `bil` rows.
- BIL never imports INV or FIN: FIN reads BIL's events by their documented fields (ADR-0056) and RPT reads the published views.
- On a tax-inclusive line the variance and the promotion carry the tax that would have been on them; the accountant may ask for them split out (A-200), a change of FIN's translator only.
- Rendering, the archive and reprints are DOC's, in B08 continued 2b (A-201); until then `archivedDocumentId` and `contentHash` are null.
- Binds: `docs/data-model/bil.md`, `docs/MODULE_BOUNDARIES.md` (BIL card), the `hakorem-documents` and `hakorem-ledger` skills, B9a's sale posting.

## Verification

- `test/integration/bil/billing-documents.integration.spec.ts`: a caller that rolls back after `issueIn` leaves the series as it was; 200 issues from eight concurrent issuers with 25 rolled back leave 175 receipts numbered consecutively, allocations equal to `next_value - 1`; the invoice, credit note and debit note post their exact lines per levy; every rule above refused by SQL as hk_app; the wrong role refused everywhere.
- `test/integration/bil/fourth-levy.integration.spec.ts`: a levy and a scheme version added through MDM's services give four levy rows and four 2100 lines against four parties, with no code change.
- `test/integration/fin/trial-balance.integration.spec.ts`: the seeded trading day with its billing documents sums to zero.
