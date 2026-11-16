# ADR-0061: Document rendering and the archive as built: in-repository writers, rendering through the outbox, reprints as appended markers

- **Status:** Proposed
- **Date:** 2026-11-16
- **Session:** B08 continued 2b
- **Deciders:** backend track; the owner reviews the template permissions and the reprint channels (A-202)

## Context

The shared brief asks for server-side HTML to PDF for invoices, quotes and statements and ESC/POS for thermal receipts, "deterministic, archivable, reprintable". ADR-0009 puts a PDF renderer port in the platform and templates, rendering and the archive in DOC; ADR-0010 forbids an object storage write inside a business transaction; ADR-0012 makes the archive a LEDGER table; ADR-0015 makes each document carry the hash of its rendered content. FR-BIL-009 says a reprint is the archived bytes with a marker, FR-DOC-004 that templates render in a sandbox with no script and no remote include. Building it left open: which renderer writes the bytes, how a reprint can carry a marker without changing the archived bytes, how a thermal reprint is "the archived bytes" when the archive is a PDF, and how a render failure is kept away from the sale.

## Options considered

1. **A headless browser (Chromium through Puppeteer or Playwright, or a Gotenberg container) rendering HTML templates.** Faithful HTML and CSS, but a large new dependency or service, output that embeds dates and identifiers (so the same document gives different bytes), and a template language whose sandbox is the browser's, which is exactly what can run a script or fetch a remote file.
2. **A PDF library from npm (pdfkit, pdf-lib) and a template engine (Handlebars).** Smaller, but two new dependencies under the 14-day floor, Handlebars' history of prototype-access escapes, and still non-deterministic output unless configured.
3. **Writers in the repository: a deterministic PDF 1.4 writer over the two standard Helvetica faces and an ESC/POS writer, laid out from a closed, logic-less template language.** No new dependency (like the spreadsheet writer, ADR-0046); the same data always gives the same bytes; the sandbox is the grammar itself.

## Decision

Option 3, behind the port, so a browser renderer can replace the writers later without touching DOC's callers.

- **Writers (platform, `src/platform/documents/`).** `renderPdf` lays lines out on A4 pages with no creation date and no file identifier; `renderEscPos` writes 48 or 32 columns. Only printable ASCII is written (anything else prints as `?`), so no encoding table changes the bytes. Both are under a 100 percent coverage gate.
- **Templates (DOC domain).** `{{path}}`, `{{#each}}`, `{{#if}}` and nothing else; layout tags with no attributes (`header`, `footer`, `section`, `levies`, `h1`, `h2`, `p`, `small`, `row`, `cell`, `hr`). A script, any other tag, an attribute, a URL, a protocol-relative link, a CSS import or `url()`, a data URI, an unbalanced tag or block, or a body over 64 KiB is refused at save with every broken rule named, in linear time (bounded patterns only). Values are escaped on insertion. A version's body never changes (`ck_template_version_frozen`); at most one version per template is ACTIVE.
- **Rendering after commit.** The issuing transaction calls `Documents.requestRenderIn`, which records the template versions active at that moment in a render job and publishes `doc.RenderRequested`. DOC's asynchronous consumer `doc.render` renders the A4 PDF and, where the document type has an active thermal template (the receipt), the ESC/POS too, writes both to the private bucket, registers them as stored files of the new use `ARCHIVE` (PENDING until the malware scan passes them, ADR-0044 unchanged), inserts one `doc.archived_document` row with both SHA-256 values and publishes `doc.DocumentArchived`. BIL's consumer `bil.archive-link` sets `archived_document_id` and `content_hash` once, together. A render or storage failure records the attempt on the job (`UnitOfWork.runApart`, a WORK row only) and throws, so the outbox retries it with backoff; the sale, its number and its posting never depend on it.
- **One archive row per document.** It holds the PDF and, for a receipt, the thermal rendering: "exactly once" holds for every document (`uq_archived_document_revision`, `ck_archived_document_revision`).
- **Reprints.** A PDF reprint is the archived PDF followed by an incremental update that overlays "REPRINT n" on the first page: the archived bytes are a byte-for-byte prefix and two copies differ in the copy digit only. A thermal reprint is the marker followed by the archived ESC/POS bytes. The bytes are read outside any transaction, refused unless the scan has passed them and they hash to the archived SHA-256 (`ARCHIVE_HASH_MISMATCH`, logged as an error), then `bil.reprint_log` takes the next copy number under the document's lock (`ck_reprint_log_copy_no`). The marked bytes are returned inline (`pdfBase64`, `escPosBase64`), so a reprint stores nothing and never needs a second scan.

## Consequences

- No new dependency; determinism lets anyone recompute an archived document's hash from its bytes, and lets the gate prove "byte-identical apart from the marker".
- Layout is plain: text lines, columns and rules, no images or colours. A logo and colours (FR-DOC-004) wait for a renderer that can draw them; until then a template's branding is its text (A-202).
- Characters outside ASCII (the cedi sign, accented names) print as `?`; amounts print as `GHS`. A font with a wider repertoire is a later change of the writer only.
- `previewTemplateVersion`, statements and the remittance advice move to B08 continued 2c (A-203); `downloadArchivedDocument` serves the original only, and `reprint: true` there is refused.
- Binds: `docs/data-model/doc.md`, `bil.md`, `platform.md`; the DOC and BIL cards in `docs/MODULE_BOUNDARIES.md`; the `hakorem-documents` skill.

## Verification

- `src/platform/documents/pdf-writer.spec.ts`: the same lines give the same bytes; every xref entry points at its object; a reprint keeps the original as a prefix and two copies differ in one byte; the thermal marker precedes the original bytes.
- `src/modules/doc/domain/templates.spec.ts`: every refusal by name, a hostile 64 KiB body checked in linear time, escaping, layout.
- `test/integration/doc/document-archive.integration.spec.ts`: rendered after commit and archived once with the SHA-256 of the stored bytes; the archive refuses change for every role; a throwing renderer leaves the document and its number intact and the retry archives it once; reprint copies 1 and 2 with no new number; a tampered stored file is never served; a new template version changes the next invoice and no issued one; every write refuses the wrong role.
- `test/integration/doc/archive-completeness.integration.spec.ts`: every issued document of the seeded day archived exactly once.
