# B08 continued 2c: the template preview, the remittance advice and the decision on sends

Date: 2026-11-16 · Branch `b08c2c-statements-remittance`, from `main` (`0c54254`) · PR #58 · Status: **gate passed for what was built; the phase split before customer statements (A-206).** The remainder is **B08 continued 2d** (customer statements), opened before B9a. `sendBillingDocument` and `sendStatement` move to B11 (ADR-0062).

Run as a fresh agent inside the 2026-11-15 overnight session: the parent session cannot issue /clear or /compact, so each phase starts in a new context that reads only this handoff from disk.

## Assumptions made this session (in `docs/ASSUMPTIONS.md`, dated 2026-11-16)

| ID | What | Who confirms |
| --- | --- | --- |
| A-204 | **Preview, remittance advice and sends as built (ADR-0062).** (a) `previewTemplateVersion` answers the specimen inline (`TemplatePreviewResult`: `pdfBase64` or `escPosBase64`; `url`, `expiresAt` null) instead of the planned signed link, marked `SPECIMEN PREVIEW - NOT A VALID DOCUMENT` first and last, renders any version with the data given or its sample data (422 `PREVIEW_DATA_REQUIRED` with neither) and writes nothing, not even audit. (b) The remittance advice is its own business document (`REMITTANCE_ADVICE`, PUR's, unnumbered), requested by PUR through `Documents.requestRenderIn` in the transaction that marks the payment paid and publishes `pur.SupplierRemittanceReady` (unchanged), not by a DOC subscriber, so the outbox carries no supplier name or invoice lines; `remittance_document_id` set once by `pur.remittance-link`. (c) `sendBillingDocument` and `sendStatement` wait for B11: delivery is NTF's, only an SMS adapter exists, and an event published before NTF registers its consumer gets no delivery row, so a 202 now would be untrue. | Owner (a, c), Accountant (b) |
| A-205 | **Supplier payments carry no number.** `payment_no` has never been allocated (`paymentNo` null everywhere); the advice prints the payment's id until a session allocates it at mark-paid through `platform.allocate_number`. **Named for the parent to schedule** (small PUR change). | Accountant |
| A-206 | **B08 continued 2c split before customer statements (ADR-0026 Amendments).** Statements are WHL's (`whl.statement`, layer 10): a new module, and a decision on where the figures come from (WHL imports no FIN today; an opening balance journal against a customer is on 1200 but on no billing document). They are **B08 continued 2d** (`b08c2d-customer-statements`), before B9a; B9a reads 2d's report. | Owner |

Still open, proceeded on as stated: A-033, A-034, A-062, A-182 to A-203.

Phase, scope and gate, as confirmed at the start:
1. **Phase:** B08 continued 2c (`b08c2c-statements-remittance`, from `main` at `0c54254`).
2. **Scope:** customer statements, DOC's remittance advice from `pur.SupplierRemittanceReady` with PUR's `remittance_document_id`, `previewTemplateVersion`, and the decision on `sendBillingDocument`/`sendStatement`.
3. **Gate:** a statement ties to the customer's documents and the ledger's 1200 and is archived once; a remittance advice is archived once from the event and linked from the payment; a preview renders without archiving or numbering; every statement and send write refuses the wrong role.

**Why the split.** The preview, the remittance advice and the send decision belong to DOC and PUR, which exist. Statements are the first piece of WHL, a module that does not exist yet (schema, permissions, series, template, store, service, controller, seed), and their figures need an ADR. Starting a module that could not reach its gate in what was left of this context would have handed the next session a half-built module, so the session stopped at the module boundary, green.

## Contract changes

**1.41.0, minor, with one LOUD line** (`docs/CONTRACT_CHANGELOG.md`). `previewTemplateVersion` moves into code and **answers `TemplatePreviewResult` instead of the planned `SignedUrl`** (it was never implemented, so no client has read a real answer; a screen built on the planned shape reads the bytes instead of following a link). New schema `TemplatePreviewResult`; new error code `PREVIEW_DATA_REQUIRED` (422). `remittanceDocumentId` on `SupplierPayment` and `SupplierRemittance` (already nullable) is now set seconds after a payment is paid; `markSupplierPaymentPaid`'s example answers it null, as the call does. **No existing shape changed:** nothing removed, renamed or retyped, nothing a client sends made required; the versioning check against `main` passes. 371 operations from code, 264 planned; `contract:generate`, Redocly clean.

## Built

| Area | What |
| --- | --- |
| Migrations | 0156 (`platform.document_type` `REMITTANCE_ADVICE`, PUR's, unnumbered); 0157 (the built-in A4 remittance advice template, version 1 active, with sample data); 0158 (expand: `pur.supplier_payment.remittance_document_id` to DOC's published `doc.archived_document`, unique where set; `ck_supplier_payment_remittance_document`: only a PAID payment names an advice, once, never changed or cleared; the PAID freeze lists the link). Each rolls back (proved by `bil/archive-link-rollback`, which now walks 0158 to 0155 back and applies them again). |
| Kernel | `formatCedis` moved from BIL's domain (BIL re-exports it), with its spec. |
| DOC | `Templates.preview` and the route `POST /template-versions/{id}/preview`; `renderPreview` with `PREVIEW_MARKER`; `PreviewDataRequiredError`; `RenderRequest.causationId`. |
| PUR | `remittanceRenderData` (pure); `recordRemittance` registers the advice and calls `Documents.requestRenderIn` after publishing `pur.SupplierRemittanceReady`, naming it as the cause; the consumer `pur.remittance-link`; `remittanceDocumentId` read into both views. PUR imports DOC (lower layer). |
| Docs | ADR-0062 and its index row; A-204 to A-206; ADR-0026 amendment; openers (2c marked, **2d inserted**, B9a reads 2d, B11 builds the sends); DOC and PUR cards; `doc.md`, `pur.md`; `API.md` (DOC and PUR, the error code); changelog; SRS traceability for FR-PUR-013; `docs/runbooks/document-rendering.md`. |

## The gate, proved by running it

`test/integration/doc/preview-remittance.integration.spec.ts` (real PostgreSQL, object storage, the worker's dispatcher and scanner passes):

1. **A preview renders without archiving or numbering anything.** An A4 preview with data: a PDF with the marker exactly twice and the data printed; eight counts (archive rows, render jobs, stored files, number allocations, business documents, outbox messages, audit events, idempotency keys) identical before and after; the same data gives the same bytes. A draft previews with its own sample data and stays DRAFT; the counter receipt's thermal version answers ESC/POS (`ESC @` first) with the marker; the seeded remittance template previews from its sample data; no data at all is 422 `PREVIEW_DATA_REQUIRED`, an unknown version 404, an unknown field 400; the counts are still unchanged. **Passed.**
2. **A supplier remittance advice is rendered from the remittance data and archived once, linked from the payment.** The seeded Kpone transport invoice (GHS 150.00 less the seeded GHS 15.00 credit) paid in cash, 13,500 pesewas, approved by the Manager: in the paying transaction the advice is registered (`REMITTANCE_ADVICE`, PUR, the branch) and its render job QUEUED with the advice template, the `doc.RenderRequested` message caused by the `pur.SupplierRemittanceReady` message; nothing archived until the worker runs. After it: exactly one archive row, `REMITTANCE_ADVICE`, no number, its stored bytes hashing to the recorded SHA-256, printing `Total paid GHS 135.00` and the line `GHS 150.00`, `GHS 15.00`, `GHS 135.00`, `GHS 0.00`, no specimen marker; the payment and its remittance name the archive. A replay of `markSupplierPaymentPaid` (same key), a repeat (422) and a redelivery of every render and archive message add nothing (one archive row, one job, one remittance); changing or clearing the link is HK004 for hk_app and the superuser, and an unpaid payment naming an advice is HK004. **Passed.**
3. **Every write and read built refuses the wrong role.** The preview is 403 for the Cashier, Sales, Storekeeper, Farm hand and Driver (no bytes returned); the advice's archive entry and its download are 403 for the same five and 200 for the Owner, Manager and Accountant; the handler walk (`iam/authorisation`) refuses a user with no grant on `previewTemplateVersion`. **Passed.**
4. **Statements (moved to B08 continued 2d) and sends (moved to B11)**: not built here, by decision (A-204 c, A-206).

## Mutation checks (run, then removed; never committed)

| Mutation | Went red |
| --- | --- |
| M1 `trg_supplier_payment_remittance_guard` removed from 0158 | "makes no second advice on a replay, a repeat or a redelivery, and the link never changes" |
| M2 the authorisation in `Templates.preview` removed | "refuses the preview to every role without doc.template.read…" |

## Security review (hakorem-security-review checklist, by hand)

Boundaries: back office (staff session), the worker, object storage, the database. **Preview:** a new way to produce a document-looking PDF with arbitrary figures (an insider forging an invoice): mitigated by the specimen marker printed first and last whatever the data, by `doc.template.read` (Owner, Manager, Accountant) checked in the application layer, by returning bytes only to the caller and storing nothing, and by a body checked against the sandbox at save. A preview is not audited (a read); listed for B12's exception report only if the owner wants preview volume watched. **Remittance advice:** no supplier name, payee or invoice line in any outbox payload (the render data travels in the render job, CONFIDENTIAL); the archive entry is served only to `doc.document.read` at its branch, by a five-minute signed link once scanned; the payment's link is set once by the worker and frozen by the database. **Sends:** none built, so no new message path. No finding open.

## Decisions

- **ADR-0062 (Proposed):** the preview inline as a marked specimen; the remittance advice requested by PUR in its paying transaction and archived by DOC; sends wait for NTF. It adds to ADR-0010, ADR-0011, ADR-0044 and ADR-0061 without changing their decisions. No ADR conflict; no stop.

## Deferred

- **B08 continued 2d (A-206):** customer statements in a new WHL module (`listStatements`, `createStatement`, `getStatement`).
- **B11 (ADR-0062):** `sendBillingDocument`, `sendStatement` and the remittance advice to the supplier, through NTF, with a test that a send reaches only the document's own customer or supplier.
- **To schedule (A-205):** supplier payment numbers.

## Contract requests

The frontend's `main` was fetched on 2026-11-16 (`035f736`, the same commit 2b read); it lists CR-001 to CR-026 and nothing new.
- **CR-005 (empty list examples) and CR-023 (the seeded role matrix):** scheduled by the owner in **B09x** after B9a; not done here.
- **CR-022:** points 1 to 4 answered (1.31.0, 1.40.0). **CR-026:** implemented in 1.40.0. **CR-025:** answered by B06r. **CR-024:** closed by the owner. **CR-013:** unchanged (the invoices tile needs payments, B9a).
- **CR-001 to CR-004, CR-006 to CR-012, CR-014 to CR-021:** answered in earlier phases; nothing new is asked.

## Tests (this machine, 2026-11-16)

| Layer | Result |
| --- | --- |
| Unit | **1,260 passed** (new: `packages/kernel/src/cedis.spec.ts` 9, three `remittanceRenderData` cases in `src/modules/pur/domain/remittance.spec.ts`) |
| Integration | New `doc/preview-remittance` 6. Lists extended on purpose: the handler walk's route list and its no-grant body (`previewTemplateVersion`); `bil/archive-link-rollback` now rolls 0158 to 0155 back in order. The affected suites (iam/authorisation, pur, doc, bil: 16 files, 160 tests) passed before the full run. |
| Coverage, merged (`pnpm test:coverage`) | **2,497 passed** (1,260 unit, 1,237 integration), 206 files, exit 0. Statements 93.87 percent, branches 83.54 percent (gate 80). Every 100 percent gate held. |
| Contract | **89 passed** (new: the preview's `TemplatePreviewResult` and its refusal in `b8/documents-archive`; drift counts 371 and 264; one request schema mapped) |
| Lint, typecheck, Redocly, `contract:generate`, versioning against `main` | Clean |
| End to end | CI only |

**Test first, honestly:** the render data's unit cases and the integration spec were written before the code ran against them, and failed first on real faults: the remittance amount (the seeded credit note leaves 13,500 owed, not 15,000), a PDF string escaping parentheses, payments having no number (A-205), and the PAID freeze refusing the link (fixed in 0158). The rollback proof failed on a real fault in 0157's down step (the template's version was not moved), fixed before commit. No flaky test seen; nothing skipped, loosened or retried.

## Gate

**Passed for what was built:** a supplier remittance advice rendered from the remittance data fixed with `pur.SupplierRemittanceReady` and archived once, linked from the payment; a template preview renders without archiving or numbering anything; every preview and archive read refuses the wrong role. **Split:** customer statements are B08 continued 2d (A-206); the sends are B11 (ADR-0062).

## Notes for the frontend track

- 1.41.0: the template editor's preview reads `pdfBase64` (A4) or `escPosBase64` (thermal) from `previewTemplateVersion`; there is no link to follow. Send `data` to preview with your own figures, or `{}` to use the version's sample data; 422 `PREVIEW_DATA_REQUIRED` means there is none.
- A paid supplier payment shows `remittanceDocumentId` null for a few seconds, then the archived advice (`getArchivedDocument`, `downloadArchivedDocument`). Supplier payments have no number yet (A-205).
- Statements arrive in B08 continued 2d; "send by email or WhatsApp" buttons wait for B11.

## CI

- **Green, the code head `2293405`** (every commit of the phase but this report): run **43868676462 (push)** and run **43868721196 (pull_request**, the one that compares the contract with `main`), both completed, success. No red run on this branch; nothing was re-run.
- The runs on the final head (this report's commit) are named in the session's closing message: a commit cannot name its own runs. The pull request (#58) is merged with a merge commit only once every run on its head is green.

## Next session

B08 continued 2d, copied from `docs/prompts/session-openers.md`.

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B08c2c-statements-remittance.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md): implement what is
reasonable, record in the report what you declined and why, never edit that file and never open frontend source.
For this phase, read FR-WHL-009 and the DOC requirement block of docs/SRS.md (nothing else from the SRS),
docs/data-model/whl.md (`whl.statement`), doc.md and bil.md, the WHL, BIL, DOC and FIN cards in
docs/MODULE_BOUNDARIES.md, and ADR-0010, ADR-0011, ADR-0015, ADR-0056, ADR-0060, ADR-0061 and ADR-0062. Read A-200,
A-204 and A-206 in docs/ASSUMPTIONS.md. Load hakorem-module, hakorem-migration, hakorem-ledger, hakorem-money,
hakorem-documents, hakorem-endpoint and hakorem-tests. Use docs/prompts/module-build-prompt.md as the recipe.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B08 continued 2d only, on branch b08c2d-customer-statements, branched from main: the WHL module with
customer statements only (`whl.statement`, the `STATEMENT` document type and its series, the permissions
`whl.statement.read` and `whl.statement.create` and their grants, listStatements, createStatement and getStatement,
the A4 statement template with sample data, rendered and archived through Documents.requestRenderIn and linked by a
consumer of doc.DocumentArchived). Decide with an ADR where the figures come from: WHL's card imports no FIN today,
and an opening balance entered by manual journal against a customer is on 1200 but on no billing document, so the
recommended reading is the customer's 1200 activity by subledger party through FIN's door, each line named by its
source document, which also brings in B9a's payments without a change. Write the statement arithmetic test first,
including FR-WHL-009's case (opening 100,000, invoices 250,000, credit note 20,000, payment 150,000, closing 180,000)
and a customer in credit. sendStatement stays planned for B11 (ADR-0062). Extend the seed with one statement.
Stop at the gate, write docs/sessions/B08c2d-customer-statements.md, and merge into main when every run on the pull
request is green. End the report with B09a's opening message (ADR-0026 verification).
```
