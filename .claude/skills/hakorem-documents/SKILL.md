---
name: hakorem-documents
description: "Use when changing the content, layout or issuing of an invoice, proforma, receipt, credit note, debit note, quote, statement, delivery note, distribution schedule, remittance advice or shift report: document templates (`doc.template`, `doc.template_version`), PDF (HTML to PDF) or ESC/POS thermal rendering, document numbers, number series and `platform.allocate_number`, the gap-free sequence, provisional references printed offline, reprint or resend and the reprint marker, the immutable archive (`doc.archived_document`, `content_hash`), the tax and levy breakdown printed on a document, certified totals, or signed document links. The arithmetic behind the printed figures is hakorem-money; when the numbers come from a posting, hakorem-ledger; the offline receipt flow is hakorem-offline."
---

# Documents: numbered once, archived immutably, reprinted never re-created

Decisions: `docs/adr/0015-gap-free-numbering-and-offline-provisional-references.md`, `docs/adr/0020-tax-engine-named-levies.md`, `docs/adr/0012-table-classes.md`, `docs/adr/0010-commands-down-events-up-and-the-outbox.md`, `docs/adr/0005-aggregate-boundaries-and-isolation.md` (the series lock). Tables: `docs/data-model/bil.md`, `doc.md`, and `platform.md` (number series, document registry). Requirements: the BIL and DOC sections of `docs/SRS.md`.

## Checklist

1. **Number inside the transaction, from the series.** `platform.allocate_number(series_id, document_id)` runs in the issuing transaction; a rollback returns the number. Never use a PostgreSQL sequence (it leaves gaps), never format a number in application code, never reserve numbers for a device. Series are keyed by document type, fiscal year, branch and (for receipts) register; format `<PREFIX>-<YEAR>-<BRANCH>-<SEQUENCE>`, receipts add the register (`INV-2026-ACC-000123`, `RCP-2026-ACC-T1-000456`). Prefixes and padding are settings; the mechanism is not.
2. **Allocate first, hold the series lock.** The command declares its series; the unit of work takes the session-level advisory lock before `BEGIN` and the number is the first write (ADR-0005). The fiscal year comes from the posting date in Africa/Accra.
3. **Offline sales get two numbers.** The device prints the provisional reference and the sale id as a QR code and says the official number follows; the official number is allocated at sync. `bil.billing_document.provisional_ref` and `document_no` are both stored and either finds the sale. Never let a device allocate an official number.
4. **An issued document is immutable.** Status `ISSUED` freezes it; only `credited_pesewas`, `archived_document_id`, `content_hash` (set once) and the certification columns may change. A correction is a credit note or debit note referencing the original, never an edit; a credit note cannot exceed the uncredited amount.
5. **Totals are sums of line integers.** Header totals equal the sum of lines and `net + tax = gross` (deferred trigger on issue). Never recompute a document total from another total (hakorem-money). Certified totals from an electronic invoicing service go in the optional `certified_*` fields; line sums are never silently replaced.
6. **Print the tax breakdown from the stored rows.** Iterate `bil.billing_document_line_tax`: levy code and name as printed, treatment, rate, base, amount, and the scheme version used, for every levy including those at zero, so a zero-rated or exempt line says so. Templates never compute tax and never hard-code VAT, NHIL or GETFund; a fourth levy appears with no template change.
7. **Snapshots, not references, for what was printed.** Customer name, TIN and billing address, line descriptions and the template version are copied at issue. A later edit to the customer must not change an issued invoice.
8. **Render after commit, through the outbox.** The sale or invoice commits first; the worker renders the PDF or thermal output, stores the bytes in the immutable archive, and records `sha256` equal to the billing document's `content_hash`. Object storage is never called inside the business transaction. A receipt can still be printed from stored data when rendering is queued.
9. **Archive is a ledger.** `doc.archived_document` is insert-only: one row per business document and revision, holding the file, the hash, the template version and the exact `render_data`. A quote version or a signed delivery note produces a new revision; an invoice has exactly one.
10. **Reprint is the archived bytes plus a marker.** Never re-render from current data, never allocate a new number. Each reprint or resend writes `bil.reprint_log` with `copy_no` ("Reprint 2"), channel (`THERMAL`, `PDF`, `SMS`, `WHATSAPP`, `EMAIL`) and actor. The reprint is otherwise identical to the original.
11. **Templates are data, versioned, sandboxed.** `doc.template_version` is immutable once activated and an issued document keeps the version it rendered with. Template source runs in a sandboxed engine: no script execution, no remote includes. Editing a template is an audited administrator action that needs no deployment. Every user-facing label goes through the translation layer.
12. **Private documents are reached by signed, expiring URL**, each issue logged to `platform.file_access_log`. Public links carry a signed token; a UUIDv7 in a URL is never the only secret.
13. **Smoke and test data never consume real numbers.** The test branch (`is_test`) has its own series and is excluded from statutory reports.
14. **Compliance hook.** Whether the revenue authority requires electronic invoice certification, and whether a provisional offline receipt is acceptable, are compliance questions tracked with their dates in `docs/security/COMPLIANCE.md` and `docs/ASSUMPTIONS.md`. Keep the pipeline able to add certification (certified fields, certification reference) without reworking rendering.

## Correct and incorrect

```ts
// RIGHT: number allocated first inside the unit of work; render requested through the outbox
await uow.run({ isolation: "serializable", series: [seriesFor("INVOICE", branchId, postingDate)] }, async (tx) => {
  const documentNo = await numbering.allocate(tx, series.id, billingDocumentId);    // first write
  const lines = await tax.rowsFor(tx, draft);                                       // stored per line and levy
  await billing.issue(tx, { id: billingDocumentId, documentNo, lines, occurredAt }); // totals = sums of lines
  await outbox.publish(tx, { type: "bil.InvoiceIssued", /* named amounts, levy list */ });
});                                                                                 // the worker renders and archives after commit
```

```ts
// WRONG: a sequence with gaps, a number formatted in code, rendering inside the transaction, tax in the template
const n = await db.execute(sql`SELECT nextval('invoice_seq')`);
const documentNo = `INV-${new Date().getFullYear()}-${n}`;
const pdf = await pdfRenderer.render(template, { total: lines.reduce((a, l) => a + l.price * l.qty, 0) * 1.15 });
await s3.put(`invoices/${documentNo}.pdf`, pdf);       // external call inside the business transaction
```

Reprint, correct versus incorrect:

```ts
// RIGHT
const archived = await archive.get(billingDocumentId);                 // immutable bytes
await reprintLog.append(tx, { billingDocumentId, copyNo: next, channel: "THERMAL", actorId });
return overlay(archived.bytes, `Reprint ${next}`);
// WRONG: return renderInvoice(currentCustomerData)  // changes the figures, the address, maybe the number
```

## Test expectations

Gap-free numbering under concurrency (50 concurrent issuers on one series produce a dense sequence; a rolled-back allocation leaves no gap); issuing a document whose lines include a fourth levy shows four levy lines with no code change; reprint bytes equal the archived bytes plus the marker and no new number exists; an issued document rejects update outside its listed columns; 500 offline sales each receive exactly one official number; a credit note above the uncredited amount is refused. Use hakorem-tests.
