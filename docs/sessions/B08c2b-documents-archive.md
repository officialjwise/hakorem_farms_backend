# B08 continued 2b: document rendering, the immutable archive, reprints and templates

Date: 2026-11-16 · Branch `b08c2b-documents-archive`, from `main` (`b3b0db8`) · PR #56 · Status: **gate passed; the phase split before statements (A-203).** The remainder is **B08 continued 2c**, opened before B9a.

Run as a fresh agent inside the 2026-11-15 overnight session: the parent session cannot issue /clear or /compact, so each phase starts in a new context that reads only this handoff from disk.

## Assumptions made this session (in `docs/ASSUMPTIONS.md`, dated 2026-11-16)

| ID | What | Who confirms |
| --- | --- | --- |
| A-202 | **Rendering, the archive, reprints and templates as built (ADR-0061).** (a) PDF and ESC/POS come from writers in the repository, deterministic, printable ASCII only (the cedi sign prints `?`, amounts `GHS`); text, columns and rules only, so a template's logo and colours wait for a renderer that can draw them. (b) One archive row per document: the A4 PDF and, for a type with an active thermal template (the counter receipt), the ESC/POS beside it, each with its SHA-256; `content_hash` is the PDF's. Archived files are use `ARCHIVE`, PENDING until the malware scan passes them (ADR-0044 unchanged), so a reprint or download waits one scan round. (c) A reprint returns the marked bytes inline (`pdfBase64`, added to `ReprintResult`; `escPosBase64`), storing nothing; `downloadArchivedDocument` links the original only and refuses `reprint: true`. (d) Templates: read by the Owner, Manager, Accountant; drafted and activated by the Owner and the Manager, audited, no second approver. Archive read: Owner, Manager, Accountant. Reprint: Owner, Manager, Cashier. (e) The template version is the one active at issue, recorded with the render request. (f) The nightly `billing-numbering-audit` compares hashes in the database; stored bytes are re-hashed at every reprint. | Owner (a, c, d), Accountant (f) |
| A-203 | **B08 continued 2b split before statements (ADR-0026 Amendments).** B08 continued 2c builds customer statements, DOC's rendering of the supplier remittance advice (FR-PUR-013) with PUR's `remittance_document_id`, `previewTemplateVersion` (it needs a decision on returning a preview without serving an unscanned file) and `sendBillingDocument` (2c decides whether a queued send is honest before NTF exists in B11). B9a opens after 2c. | Owner |

Still open, proceeded on as stated: A-033, A-034, A-062, A-182 to A-201.

Phase, scope and gate, as confirmed at the start:
1. **Phase:** B08 continued 2b (`b08c2b-documents-archive`, from `main`), split at the statement sub-domain as the opener allows.
2. **Scope:** templates and versions (sandboxed), rendering after commit through the outbox (PDF and ESC/POS), `doc.archived_document` with its render job and reads, `archived_document_id` and `content_hash` set once, reprints with `bil.reprint_log`, the nightly numbering audit's hash and orphan check, and the seeded day archived.
3. **Gate:** every issued document of the seeded trading day is rendered after commit and archived exactly once with the SHA-256 of its stored bytes, the archive refusing change by trigger; a reprint returns the archived bytes with its marker, byte-identical apart from the marker, copies 1 and 2 and no new number; a template version keeps issued documents unchanged and a template with a script or remote include is refused at save; every DOC and reprint write refuses the wrong role.

## Contract changes

**1.40.0, minor** (`docs/CONTRACT_CHANGELOG.md`). Eleven planned operations into code: `listDocumentTemplates`, `getDocumentTemplate`, `listTemplateVersions`, `getTemplateVersion`, `createTemplateVersion`, `activateTemplateVersion`, `listArchivedDocuments`, `getArchivedDocument`, `downloadArchivedDocument`, `reprintBillingDocument`, `listBillingDocumentReprints`. **One field added:** `ReprintResult.pdfBase64` (string or null; required in the response, which breaks no client, ADR-0038). New error codes `TEMPLATE_BODY_INVALID`, `DOCUMENT_NOT_ARCHIVED`, `ARCHIVE_HASH_MISMATCH`. Example fixes: billing `contentHash` is plain hex; CR-026's subjects and thresholds. Descriptions: CR-022 points 3 and 4. **No existing shape changed:** nothing removed, renamed or retyped, nothing a client sends made required. 370 operations from code, 265 planned; `contract:generate`, Redocly clean.

## Built

| Area | What |
| --- | --- |
| Migrations | 0151 (stored file use `ARCHIVE`); 0152 (schema `doc`: `template` MASTER, `template_version` DOCUMENT with `ck_template_version_frozen` and one ACTIVE per template, `archived_document` LEDGER with `reject_change`, unique per document and revision, `ck_archived_document_revision`, `render_job` WORK; the six seeded templates); 0153, 0154 (`doc.template.read`, `doc.template.manage`, `doc.document.read`, `bil.document.reprint` and their grants); 0155 (expand: `bil.billing_document.archived_document_id`, relinked by hash when applied again after a rollback, `ck_billing_document_archive`, the guard letting it be set once; `bil.reprint_log` LEDGER with `ck_reprint_log_copy_no`). |
| Platform | `pdf-writer.ts` (`renderPdf`, `withReprintMarker`), `escpos-writer.ts` (`renderEscPos`, `escPosWithReprintMarker`), both under a new 100 percent gate; `UnitOfWork.runApart` (a worker's failure record that survives its rollback); `NumberSeries.allocationsOf`. |
| DOC | `domain/templates.ts` (check, render, layout; 100 percent gate); `Documents` (`requestRenderIn`, the `doc.render` consumer, `archivedIn`, `content` with the hash check, list, get, download); `Templates`; `PgDocStore`; two controllers; nine fragments; `doc.RenderRequested`, `doc.DocumentArchived`. |
| BIL | Every issued document requests its rendering in `issueDraft`; `domain/render-data.ts` (`formatCedis`, `renderDataOf`); the `bil.archive-link` consumer; `reprint`, `listReprints`; `archivedDocumentId`, `contentHash`, `reprintCount` filled; `BillingNumberingAudit` and the worker job `billing-numbering-audit` (02:20). |
| Seed | Unchanged: the seeded documents request their renders through `issueIn`; the worker archives them. |
| Docs | ADR-0061 and its index row; A-202, A-203; ADR-0026 amendment; openers (2c inserted, B9a reads 2c's report); `doc.md`, `bil.md`; DOC and BIL cards; `API.md` (two sections, three error codes); changelog; `OPERATIONS.md` job row; `docs/runbooks/document-rendering.md`. |

## The gate, proved by running it

1. **Rendered after commit and archived exactly once with the SHA-256 of its stored bytes; the archive refuses change.** `doc/document-archive`: an issued receipt has a QUEUED job and no archive until the worker runs; then exactly one row, its PDF and ESC/POS each hashing (from the bucket) to their recorded SHA-256, the billing document's `contentHash` equal; a further pass and a redelivery add nothing (job DONE, one attempt). UPDATE and DELETE refused for hk_app and the superuser (HK001), TRUNCATE refused, a second row for the document 23505, revision 2 of an invoice 23514; the hash and archive link cannot be changed or cleared (HK004). `doc/archive-completeness`: all five seeded documents (invoice, receipt, credit note, debit note, proforma) archived once, CLEAN, hash equal to the stored bytes and to the content hash; no stray archive; every job DONE.
2. **A renderer that throws leaves the document and its number intact and retries.** The same spec: a worker with a throwing renderer fails the delivery (FAILED, job FAILED, attempt 1, its error kept); the receipt stays ISSUED with its number and its journal entry, and shows `RENDERING`; after the backoff the working renderer archives it once (job DONE, attempts 2); the series moved by one only.
3. **Reprint: the archived bytes with the marker, copies 1 and 2, no new number.** Two PDF reprints: the archived bytes are a byte-for-byte prefix of each, the copies differ in one byte (`1` against `2`), the series is unchanged and the number exists once; an idempotent replay answers copy 1 again; the log lists 1 and 2 with who; copy 9 out of turn and a delete are refused by the database. A thermal reprint is the marker followed by the archived ESC/POS; an invoice has none (`NO_THERMAL_RENDITION`). **The hash holds:** a stored object overwritten with a forged amount is refused (422 `ARCHIVE_HASH_MISMATCH`), nothing logged as a reprint, an error logged.
4. **A template version keeps issued documents unchanged; a script or remote include is refused at save.** A script, a URL, `<img>` and an attribute are each 422 `TEMPLATE_BODY_INVALID` with the rule named and nothing written; version 2 drafted by the Manager and activated by the Owner (audited; a second activation 422 `INVALID_STATE_TRANSITION`) renders the next invoice with its footer, while the earlier invoice keeps its version, bytes and hash and its reprint still carries the version 1 footer; a version's body or status cannot be changed by SQL (HK004).
5. **Every DOC and reprint write refuses the wrong role.** Template writes refused (403) to the Accountant, Cashier, Sales, Storekeeper, Farm hand and Driver, nothing written; template reads refused to the five without the read; the archive and its download refused to the Cashier, Sales, Storekeeper, Farm hand and Driver; reprint refused to the Accountant, Sales, Storekeeper, Farm hand and Driver with nothing logged, allowed to the Owner, Manager and Cashier; the handler walk refuses a user with no grant on all eleven new operations.
6. **The numbering audit (FR-BIL-003).** `bil/numbering-audit`: five documents reported unarchived an hour after issue, then clean once archived; a debit note row deleted by hand as a superuser is one orphan allocation, a forged content hash is a hash mismatch, no gap, and the audit wrote nothing (fingerprint unchanged); it runs as SYSTEM only.

## Mutation checks (run, then removed; never committed)

| Mutation | Went red |
| --- | --- |
| M1 `trg_archived_document_immutable` removed from 0152 | "refuses any change to the archive, for every role…" |
| M2 the SHA-256 check in `Documents.content` disabled | "never serves a tampered archive…" |
| M3 `trg_reprint_log_guard` removed from 0155 | "prints copies 1 and 2 byte-identical but for the marker…" (copy 9 accepted) |

## Security review (hakorem-security-review checklist, by hand)

Boundaries: back office (staff session), the worker, object storage, the database. **Templates:** the sandbox is the grammar: a closed tag set with no attributes, no script, no URL, CSS import, `url()` or data URI, values escaped on insertion, checked at save and again at render, in linear time (a backtracking pattern found while testing took minutes on a 64 KiB body and was replaced; a test now proves five hostile 64 KiB bodies check quickly). Writing templates is the Owner's and the Manager's, audited before and after. **Archive:** insert-only for every role; files are `ARCHIVE` stored files, CONFIDENTIAL, served only once scanned CLEAN and only by a five-minute signed link logged with the user (FR-DOC-007), authorised at the document's branch. **Tamper evidence:** stored bytes re-hashed on every reprint, hashes compared nightly, orphans and gaps reported, nothing repaired. **Outbox:** no object storage call inside a business transaction; render data travels in the job row, not the event, so the event carries no customer name. **New abuse paths:** an insider editing a template to misstate a figure (mitigated: templates never compute, figures are formatted from stored integers, activation is audited and the issued bytes never change) and an insider replacing an archived object (detected: `ARCHIVE_HASH_MISMATCH` and the nightly audit). Neither is in THREAT_MODEL's list; B12's exception report should list `billing-numbering-audit` findings (named for B12). No finding open.

## Decisions

- **ADR-0061 (Proposed):** writers in the repository behind the port, rendering through the outbox, one archive row per document with both renditions, reprints as appended markers returned inline. It adds to ADR-0009, ADR-0010, ADR-0012 and ADR-0015 without changing their decisions; ADR-0044 is unchanged (archived files are scanned like any other). No ADR conflict; no stop.

## Deferred

- **B08 continued 2c (A-203):** statements (`listStatements`, `createStatement`, `getStatement`, `sendStatement`), the remittance advice from `pur.SupplierRemittanceReady` with PUR's `remittance_document_id`, `previewTemplateVersion`, `sendBillingDocument`.
- **B9a:** `issueProforma`; PAY's allocations into `bil.document_settlement`; the sale posting calling `Billing.issueIn` (rendering follows on its own).
- **B12:** the exception report lists the numbering audit's findings and hash mismatches.
- **Later (A-202 a):** a renderer with logos, colours and a wider character set, behind the same port.

## Contract requests

The frontend's `main` was fetched on 2026-11-16 (`035f736`); it lists CR-001 to CR-026.
- **CR-026 (approval examples):** **implemented**, examples and a description only (1.40.0).
- **CR-022 (a death's photograph):** points 1 and 2 were already answered in 1.31.0 (B06r: `EVIDENCE`, a `PENDING` file accepted, `PHOTO_NOT_USABLE`, `EVIDENCE_NOT_SCANNED`); **points 3 and 4 implemented** in `reportMortality`'s and `reportCareMortality`'s descriptions (1.40.0).
- **CR-023 (the seeded role matrix in the contract):** **named for the parent to schedule**: an `x-seeded-roles` extension or a full `listRoles` example must be generated from the IAM seed and checked in CI so it cannot drift; that is an IAM and contract-tooling task larger than this phase. The facts it asks to confirm are in migrations 0078, 0112 and the IAM grant migrations; the Farm hand holds `platform.file.upload.evidence`, not `platform.file.upload`.
- **CR-025:** answered by B06r (built). **CR-024:** closed by the owner. **CR-005:** still declined as a whole and named for the parent (examples across every list). **CR-013:** unchanged (the invoices tile needs payments, B9a).
- **CR-001 to CR-004, CR-006 to CR-012, CR-014 to CR-021:** answered in earlier phases; nothing new is asked.

## Tests (this machine, 2026-11-16)

| Layer | Result |
| --- | --- |
| Unit | **1,248 passed** (new: `pdf-writer.spec.ts` 11, `templates.spec.ts` 13, `render-data.spec.ts` 9) |
| Integration | The first full run had 4 failing tests and 1 failing suite, all lists to extend or a rule that changed on purpose: the handler walk's route list and its no-grant walk (two new request bodies), the cashier's permissions (`bil.document.reprint`), the BIL test that set a content hash alone (now refused without its archive: `ck_billing_document_archive`), and `platform/worker`, whose run loaded `worker-app.ts` while it was being edited. Fixed in the test files; the affected suites then passed (72 tests). New: `doc/document-archive` 11, `doc/archive-completeness` 1, `bil/numbering-audit` 3, `bil/archive-link-rollback` 1 (after CI's red run, below). |
| Coverage, merged (`pnpm test:coverage`) | **2,478 passed** (1,248 unit, 1,230 integration), 203 files, exit 0. Statements 93.85 percent, branches 83.50 percent (gate 80). Every 100 percent gate held, the two new ones included (`src/modules/doc/domain/templates.ts`, `src/platform/documents/*-writer.ts`); `bil/domain` still at 100. |
| Contract | **88 passed** (new `b8/documents-archive` 2; drift counts 370 and 265; three request schemas mapped) |
| Lint, typecheck, Redocly, `contract:generate --check` | Clean |
| End to end | CI only |

**Test first, honestly:** the writers and the template domain were written with their specs in the same sitting and the specs run against them; the integration tests were written before the code was run against them and failed first on real faults: a nested unit of work (the failure record joined the failing transaction; fixed with `runApart`, recording only before any row is written), a grant expectation (hk_app has no UPDATE on a LEDGER table, 42501, before the trigger), `max(bytea)` in a test query, and catastrophic backtracking in two template patterns (now bounded). No flaky test seen; nothing skipped, loosened or retried.

## Gate

**Passed:**
1. Every issued document of the seeded trading day rendered after commit and archived exactly once with the SHA-256 of its stored bytes, the archive refusing change by trigger: **passed.**
2. A reprint returns the archived bytes with its marker, byte-identical apart from the marker, copies 1 and 2, no new number: **passed** (and the hash check refuses a tampered archive).
3. A template version keeps issued documents unchanged; a script or remote include refused at save: **passed.**
4. Every DOC and reprint write refuses the wrong role: **passed.**

## Notes for the frontend track

- 1.40.0: template, archive and reprint screens can read the real API. Show a document with `archivedDocumentId` null as "rendering"; reprint answers 422 `DOCUMENT_NOT_ARCHIVED` until it is archived and scanned, usually seconds.
- A reprint comes back inline: `pdfBase64` for `PDF` (open or print it as a PDF), `escPosBase64` for `THERMAL` (send to the printer as is). `url` is null.
- A template body is refused with every broken rule in `details[].code`; show them against the editor. The preview arrives in 2c.

## CI

- **Red, recorded:** on `77c60c2` (the first push of this report) runs **43858169004 (push)** and **43858178266 (pull_request)** failed in one job, "setup script brings the stack up on a clean checkout", step "the last migration rolls back and applies again"; every other job was green. Cause, a real fault: after setup the worker had archived the seeded day, so rolling 0155 back kept the content hashes but dropped the link column, and applying it again violated `ck_billing_document_archive`. Reproduced locally first, then fixed in its own commit: 0155 relinks each hashed document to its archive by its hash before adding the check (and runs the deferred document check at once so the table can be altered); `bil/archive-link-rollback` proves the round trip over the archived seed. Nothing was re-run to turn red into green. (Runs 43857552111 and 43857597459 on `9d57ed2` were cancelled by the newer push.)
- The runs on the final head are listed in the session's closing message: a commit cannot name its own runs. The pull request is merged with a merge commit only once every run on its head is green.

## Next session

B08 continued 2c, copied from `docs/prompts/session-openers.md`.

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B08c2b-documents-archive.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md): implement what is
reasonable, record in the report what you declined and why, never edit that file and never open frontend source.
For this phase, read the BIL and DOC requirement blocks of docs/SRS.md and FR-PUR-013 (nothing else from the SRS),
docs/data-model/bil.md and doc.md, the BIL, DOC and PUR cards in docs/MODULE_BOUNDARIES.md, and ADR-0010, ADR-0044,
ADR-0060 and ADR-0061. Read A-174, A-202 and A-203 in docs/ASSUMPTIONS.md. Use docs/prompts/module-build-prompt.md
as the recipe. Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B08 continued 2c only, on branch b08c2c-statements-remittance: customer statements (listStatements,
createStatement, getStatement, sendStatement) rendered and archived through Documents.requestRenderIn as built in
2b; DOC's rendering of the supplier remittance advice from pur.SupplierRemittanceReady (FR-PUR-013) with PUR's
remittance_document_id; previewTemplateVersion (decide, with an ADR if it changes the planned shape, how a preview
reaches the administrator without serving an unscanned file, A-203); and sendBillingDocument through the outbox
(decide whether a queued send is honest before NTF exists in B11, or leave it to B11 with the reason).
If the phase does not fit, split at a sub-domain boundary and follow "If a session cannot finish".
Stop at the gate and write docs/sessions/B08c2c-statements-remittance.md. End the report with B09a's opening message
(ADR-0026 verification).
```
