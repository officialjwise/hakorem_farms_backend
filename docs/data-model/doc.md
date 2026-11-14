# Table dictionary: `doc`

Owner: DOC module. Document templates, rendering and the immutable archive. File storage, signed URLs, access logging and image variants are platform mechanisms (`platform.stored_file`), used by this module and directly by others (ADR-0009). Conventions are in `docs/DATA_MODEL.md`.

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

Standard columns: `MASTER`. UNIQUE (`doc_type`, `output`) among live rows.

### `doc.template_version` · DOCUMENT

Immutable once activated. Published key: an issued document keeps the version it was rendered with.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `template_id` | `uuid` | NOT NULL, FK `doc.template` | |
| `version_no` | `integer` | NOT NULL, CHECK `> 0` | |
| `body` | `text` | NOT NULL | Sandboxed template source; no script execution, no remote includes |
| `sample_data` | `jsonb` | NULL | For the administrator's preview |
| `status` | `text` | NOT NULL, CHECK in (`DRAFT`, `ACTIVE`, `RETIRED`) | |
| `activated_at` | `timestamptz` | NULL | |
| `activated_by` | `uuid` | NULL, FK `iam.principal` | |
| `created_at` | `timestamptz` | NOT NULL DEFAULT `now()` | |
| `created_by` | `uuid` | NOT NULL, FK `iam.principal` | |

- UNIQUE (`template_id`, `version_no`).

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
| `revision` | `integer` | NOT NULL DEFAULT 1 | A quote version or a signed delivery note produces a new revision; an invoice has exactly one |

Standard columns: `LEDGER`.

- UNIQUE (`business_document_id`, `revision`).
- A reprint serves this row's file with a marker overlaid at print time and logs to `bil.reprint_log`. It never creates a row here.

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
| `created_at` | `timestamptz` | NOT NULL DEFAULT `now()` | |
