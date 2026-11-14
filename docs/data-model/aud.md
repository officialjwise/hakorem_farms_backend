# Table dictionary: `aud`

Owner: AUD module. Retention policy and data-subject requests. The audit trail tables (`platform.audit_event`, `platform.audit_chain`, `platform.audit_anchor`, `platform.subject_key`) are platform mechanisms and are documented in `docs/data-model/platform.md`; this module provides authorised viewing of them and audited administration of `platform.setting` and `platform.number_series` (ADR-0009). Conventions are in `docs/DATA_MODEL.md`.

---

### `aud.retention_policy` · MASTER

How long each category of data is kept and what happens afterwards.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `data_category` | `text` | NOT NULL, UNIQUE among live rows | For example `FINANCIAL_DOCUMENT`, `AUDIT_EVENT`, `CUSTOMER_PROFILE`, `CART`, `IDEMPOTENCY_KEY`, `NOTIFICATION_BODY`, `SESSION` |
| `classification` | `text` | NOT NULL, CHECK in (`PUBLIC`, `INTERNAL`, `CONFIDENTIAL`, `RESTRICTED`) | |
| `retain_months` | `integer` | NOT NULL, CHECK `> 0` | |
| `action_after` | `text` | NOT NULL, CHECK in (`PURGE`, `ANONYMISE`, `ARCHIVE_OFFLINE`, `KEEP`) | |
| `legal_basis` | `text` | NOT NULL | Why that period: statute, contract, operational need |
| `blocks_deletion_request` | `boolean` | NOT NULL | Whether a statutory duty overrides a deletion request for this category |

Standard columns: `MASTER`.

### `aud.retention_run` · LEDGER

Record of each run of a retention policy.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `retention_policy_id` | `uuid` | NOT NULL, FK `aud.retention_policy` | |
| `cutoff` | `timestamptz` | NOT NULL | Rows older than this were processed |
| `rows_affected` | `integer` | NOT NULL | |
| `action_taken` | `text` | NOT NULL | |

Standard columns: `LEDGER`.

### `aud.data_subject_request` · DOCUMENT

A customer's request to export or delete their data. Posted statuses: `COMPLETED`, `REJECTED`.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK, FK `platform.business_document` | |
| `request_no` | `text` | NULL, UNIQUE | |
| `kind` | `text` | NOT NULL, CHECK in (`EXPORT`, `DELETION`, `CORRECTION`) | |
| `subject_type` | `text` | NOT NULL, CHECK in (`CUSTOMER`, `SUPPLIER`, `INVESTOR`, `STAFF`) | |
| `subject_id` | `uuid` | NOT NULL | |
| `received_at` | `timestamptz` | NOT NULL | The statutory clock starts here |
| `received_via` | `text` | NOT NULL | Storefront account, email, in person |
| `identity_verified_by` | `uuid` | NULL, FK `iam.principal` | Who confirmed the requester is the subject |
| `due_by` | `date` | NOT NULL | |
| `approval_request_id` | `uuid` | NULL, FK `iam.approval_request`; required to complete a `DELETION` | Maker-checker |
| `retained_categories` | `text[]` | NULL | What could not be deleted because of a statutory duty, told to the subject |
| `export_file_id` | `uuid` | NULL, FK `platform.stored_file` | For an export |
| `subject_key_destroyed_at` | `timestamptz` | NULL | When the per-subject key was destroyed (ADR-0022) |
| `completed_at` | `timestamptz` | NULL | |
| `rejection_reason` | `text` | NULL | |

Standard columns: `DOCUMENT` (`status` in `RECEIVED`, `VERIFYING`, `PENDING_APPROVAL`, `IN_PROGRESS`, `COMPLETED`, `REJECTED`).
