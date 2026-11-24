# Table dictionary: `doc`

Owner: DOC module. Document templates, rendering and the immutable archive (built in B08 continued 2b, migration 0152, ADR-0061; B08 continued 2c adds the remittance advice template, migration 0157, ADR-0062). File storage, signed URLs, access logging and image variants are platform mechanisms (`platform.stored_file`), used by this module and directly by others (ADR-0009). Conventions are in `docs/DATA_MODEL.md`.

---

### `doc.template` · MASTER

A branded template per document type, editable by an administrator without a deployment.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `doc_type` | `text` | NOT NULL, FK `platform.document_type` | Invoice, receipt, quote, delivery note, statement, distribution schedule, remittance advice, shift report |
| `output` | `text` | NOT NULL, CHECK in (`PDF_A4`, `THERMAL_80MM`, `THERMAL_58MM`) | HTML to PDF, or ESC/POS |
| `name` | `text` | NOT NULL | |
| `active_version_id` | `uuid` | NULL, FK `doc.template_version` | |

Standard columns: `MASTER`. UNIQUE (`doc_type`, `output`) among live rows (`uq_template_type_output`). The active version is an ACTIVE version of this template (`ck_template_active_version`, deferred). Seeded: version 1 of the A4 template of each billing document type and the counter receipt's 80 mm thermal template, written and activated by the SYSTEM principal; from 0157 also the supplier remittance advice's A4 template (`REMITTANCE_ADVICE`), with sample data for the preview; from 0241 the customer statement's A4 template (`STATEMENT`, B08 continued 2d), with sample data.

### `doc.template_version` · DOCUMENT

Immutable once activated. Published key: an issued document keeps the version it was rendered with.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `template_id` | `uuid` | NOT NULL, FK `doc.template` | |
| `version_no` | `integer` | NOT NULL, CHECK `> 0` | |
| `body` | `text` | NOT NULL | Sandboxed template source; no script execution, no remote includes |
| `sample_data` | `jsonb` | NULL | For the administrator's preview: `previewTemplateVersion` renders it when the request gives no data (ADR-0062); a preview writes nothing |
| `status` | `text` | NOT NULL, CHECK in (`DRAFT`, `ACTIVE`, `RETIRED`) | |
| `activated_at` | `timestamptz` | NULL | |
| `activated_by` | `uuid` | NULL, FK `iam.principal` | |
| `created_at` | `timestamptz` | NOT NULL DEFAULT `now()` | |
| `created_by` | `uuid` | NOT NULL, FK `iam.principal` | |

- UNIQUE (`template_id`, `version_no`); at most one ACTIVE version per template (`uq_template_version_active`).
- Also `version`, `updated_at`, `updated_by`. A body, its sample data, template and number never change; status moves only DRAFT to ACTIVE (with `activated_at` and `activated_by`, once) and ACTIVE to RETIRED (`ck_template_version_frozen`, HK004). A body is checked against the sandbox at save (FR-DOC-004, ADR-0061).

### `doc.archived_document` · LEDGER

The immutable archive: every quote, invoice, receipt, credit note, delivery note, statement and distribution schedule as rendered. Published key.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `business_document_id` | `uuid` | NOT NULL, FK `platform.business_document` | What it is a rendering of |
| `doc_type` | `text` | NOT NULL, FK `platform.document_type` | |
| `document_no` | `text` | NULL | As printed |
| `branch_id` | `uuid` | NOT NULL, FK `mdm.branch` | |
| `template_version_id` | `uuid` | NOT NULL, FK `doc.template_version` | Reproducibility |
| `file_id` | `uuid` | NOT NULL, FK `platform.stored_file` | The bytes |
| `sha256` | `bytea` | NOT NULL | Equals the billing document's `content_hash` |
| `render_data` | `jsonb` | NOT NULL | The exact data rendered, so the document can be verified |
| `thermal_template_version_id` | `uuid` | NULL, FK `doc.template_version` | The thermal template version, for a document type that has one (the counter receipt) (A-202) |
| `thermal_file_id` | `uuid` | NULL, FK `platform.stored_file` | The ESC/POS bytes |
| `thermal_sha256` | `bytea` | NULL | Their SHA-256; the three thermal columns are set together (`ck_archived_document_thermal`) |
| `revision` | `integer` | NOT NULL DEFAULT 1 | A quote version or a signed delivery note produces a new revision; an invoice has exactly one (`ck_archived_document_revision`: only `QUOTE` and `DELIVERY_NOTE` take a revision above 1) |

Standard columns: `LEDGER`.

- UNIQUE (`business_document_id`, `revision`). `platform.reject_change()` refuses UPDATE, DELETE and TRUNCATE for every role. The files are stored files of use `ARCHIVE`, served only once scanned CLEAN.
- A reprint serves this row's file with a marker overlaid at print time and logs to `bil.reprint_log`. It never creates a row here.

### `doc.document_link` · LEDGER

A document sent by message (B11 continued 13, ADR-0099, migration 0342): the hash of a `doc_` token NTF's sending worker asked DOC for at one attempt, and the one archived rendering it opens. Read by `getSharedDocument` by the token alone.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `archived_document_id` | `uuid` | NOT NULL, FK `doc.archived_document` | The rendering it opens, the latest of its business document when made |
| `token_hash` | `bytea` | NOT NULL, 32 bytes, UNIQUE (`uq_document_link_token`) | SHA-256 of the token; never the token (DC-43) |
| `expires_at` | `timestamptz` | NOT NULL | More than nothing and at most thirty days after `recorded_at` (`ck_document_link_expiry`, A-288 (b)) |

Standard columns: `LEDGER` (`recorded_at`, `actor_id`, written from the application's clock). `platform.reject_change()` refuses UPDATE, DELETE and TRUNCATE. `hk_app` and `hk_worker` select and insert. A message sent again gets another row.

### `doc.render_job` · WORK

Rendering runs in the worker, outside the business transaction (ADR-0010).

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `business_document_id` | `uuid` | NOT NULL, FK `platform.business_document` | |
| `source_event_ref` | `uuid` | NOT NULL, UNIQUE | The outbox message that requested it: rendered once |
| `template_version_id` | `uuid` | NOT NULL, FK `doc.template_version` | |
| `render_data` | `jsonb` | NOT NULL | |
| `status` | `text` | NOT NULL, CHECK in (`QUEUED`, `RENDERING`, `DONE`, `FAILED`) | |
| `attempts` | `integer` | NOT NULL DEFAULT 0 | |
| `last_error` | `text` | NULL | |
| `archived_document_id` | `uuid` | NULL, FK `doc.archived_document` | |
| `thermal_template_version_id` | `uuid` | NULL, FK `doc.template_version` | |
| `created_at` | `timestamptz` | NOT NULL DEFAULT `now()` | |
| `updated_at` | `timestamptz` | NOT NULL DEFAULT `now()` | |

- DONE exactly when it names its archived document (`ck_render_job_done`). Written QUEUED in the issuing transaction by `Documents.requestRenderIn`, with the template versions active then; the worker's consumer `doc.render` renders it once per requesting message; a failed attempt is recorded FAILED with its error and retried by the outbox.
