# Table dictionary: `platform`

Owner: `src/platform`. Mechanisms only, no business rules (ADR-0009). Conventions, type shorthand and the standard columns for each table class are defined in `docs/DATA_MODEL.md`; a line reading "Standard columns: `LEDGER`" means those columns are present in addition to the ones listed.

## Domains

| Domain | Definition | Used for |
| --- | --- | --- |
| `platform.pesewas` | `BIGINT CHECK (VALUE >= 0 AND VALUE <= 9007199254740991)` | Every monetary amount (ADR-0001) |
| `platform.qty` | `NUMERIC(14,3) CHECK (VALUE >= 0)` | Quantities in a unit of measure |
| `platform.kg` | `NUMERIC(10,3) CHECK (VALUE >= 0)` | Weights in kilograms |
| `platform.percent` | `NUMERIC(7,4) CHECK (VALUE >= 0 AND VALUE <= 100)` | Rates and percentages |

## Functions

| Function | Purpose |
| --- | --- |
| `platform.allocate_number(series_id uuid, document_id uuid) RETURNS text` | Increments the series, inserts the allocation row and returns the formatted number, inside the caller's transaction (ADR-0015) |
| `platform.reject_change() RETURNS trigger` | Raises an error. Attached `BEFORE UPDATE OR DELETE` and `BEFORE TRUNCATE` to every `LEDGER` table in every schema |
| `platform.freeze_posted() RETURNS trigger` | Generic document freeze: once `status` is in the table's posted set, rejects changes outside the column list given as trigger arguments (ADR-0012). The first argument is the comma-separated posted statuses, the rest the columns that may still change. SQLSTATE HK004 |
| `platform.audit_event_content_hash(e) RETURNS bytea` | SHA-256 of an audit event's canonical bytes, independent of session settings; used by the insert trigger and the verifier (ADR-0006) |
| `platform.touch_version() RETURNS trigger` | On update of a `MASTER` or `DOCUMENT` row, requires `NEW.version = OLD.version + 1` and sets `updated_at` |

---

### `platform.document_type` · LOOKUP

The kinds of business document that exist, and which module owns each.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `code` | `text` | PK | Stable identifier, for example `SALES_ORDER`, `INVOICE`, `GOODS_RECEIPT` |
| `owner_module` | `text` | NOT NULL | Which module to ask for the document's detail |
| `name` | `text` | NOT NULL | Display name |
| `is_numbered` | `boolean` | NOT NULL | Whether documents of this type take a number from a series |
| `series_prefix` | `text` | NULL; required when `is_numbered` | Default prefix, for example `INV` |

### `platform.business_document` · LEDGER

Registry with one row per business document of any kind, so that any table can reference "the document that caused this" with a real foreign key (ADR-0011).

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | Same value as the owning module's primary key for the document |
| `doc_type` | `text` | NOT NULL, FK `platform.document_type` | Tells a reader where the detail lives |
| `owner_module` | `text` | NOT NULL | Denormalised from the type for cheap filtering |
| `branch_id` | `uuid` | NOT NULL, FK `mdm.branch` | Scoping without a call to the owner |
| `created_at` | `timestamptz` | NOT NULL DEFAULT `now()` | When registered |
| `actor_id` | `uuid` | NOT NULL, FK `iam.principal` | Who registered it (LEDGER standard column) |

- Inserted by the owning module in the same transaction as its own row. Never updated or deleted.

### `platform.number_series` · PROJECTION

The row-locked counter for one series of document numbers. `next_value` is derivable from the allocations and is written only by `platform.allocate_number`.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `doc_type` | `text` | NOT NULL, FK `platform.document_type` | Series are per document type |
| `fiscal_year` | `integer` | NOT NULL, CHECK between 2020 and 2100 | Series restart each year, as the brief requires |
| `branch_id` | `uuid` | NOT NULL, FK `mdm.branch` | A branch contends only with itself (ADR-0005) |
| `sub_scope` | `text` | NOT NULL DEFAULT `''` | Register code for receipts; empty otherwise |
| `prefix` | `text` | NOT NULL | Printed prefix |
| `padding` | `integer` | NOT NULL DEFAULT 6, CHECK between 4 and 10 | Zero padding of the sequence |
| `next_value` | `bigint` | NOT NULL DEFAULT 1, CHECK `> 0` | The next number to issue |
| `created_at` | `timestamptz` | NOT NULL DEFAULT `now()` | |

- UNIQUE (`doc_type`, `fiscal_year`, `branch_id`, `sub_scope`).
- The application role has `SELECT` only. Prefix and padding are changed through an audited administration function before the first allocation in a year.

### `platform.number_allocation` · LEDGER

Evidence that every issued number belongs to exactly one document.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `series_id` | `uuid` | NOT NULL, FK `platform.number_series` | |
| `value` | `bigint` | NOT NULL, CHECK `> 0` | The sequence value |
| `document_id` | `uuid` | NOT NULL, FK `platform.business_document` | The document that took it |
| `formatted` | `text` | NOT NULL, UNIQUE | The number as printed |
| `allocated_at` | `timestamptz` | NOT NULL DEFAULT `now()` | |

- PK (`series_id`, `value`). UNIQUE (`series_id`, `document_id`): a document takes one number per series.
- Nightly check: per series, `count(*) = next_value - 1` and `max(value) = count(*)`.

### `platform.idempotency_key` · WORK

One row per state-changing request, so a retry returns the first result (ADR-0014).

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `scope` | `text` | NOT NULL | Principal and operation, so keys cannot collide across users or endpoints |
| `key` | `text` | NOT NULL | The client's `Idempotency-Key`, or a client-generated record id |
| `principal_id` | `uuid` | NOT NULL, FK `iam.principal` | Who sent it |
| `request_hash` | `bytea` | NOT NULL | Detects the same key reused with a different request |
| `status` | `text` | NOT NULL, CHECK in (`IN_PROGRESS`, `COMPLETED`) | |
| `response_status` | `integer` | NULL | Stored HTTP status |
| `response_body` | `jsonb` | NULL | Stored response, returned on replay |
| `created_at` | `timestamptz` | NOT NULL DEFAULT `now()` | |
| `expires_at` | `timestamptz` | NOT NULL | Purge time, at least 72 hours after creation |

- UNIQUE (`scope`, `key`). Index on `expires_at` for the purge job.

### `platform.outbox_message` · LEDGER

Every domain event, written in the transaction that caused it (ADR-0010).

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | Event id, UUIDv7 |
| `event_type` | `text` | NOT NULL | `<module>.<Name>` |
| `event_version` | `integer` | NOT NULL DEFAULT 1 | Contract version |
| `subject_type` | `text` | NOT NULL | Aggregate type |
| `subject_id` | `uuid` | NOT NULL | Aggregate id; ordering key for delivery |
| `branch_id` | `uuid` | NULL, FK `mdm.branch` | Scoping for subscribers |
| `actor_id` | `uuid` | NOT NULL, FK `iam.principal` | Who caused it |
| `correlation_id` | `uuid` | NOT NULL | Ties the event to the request |
| `causation_id` | `uuid` | NULL | The event that caused this one |
| `payload` | `jsonb` | NOT NULL | Event data; no secrets |
| `occurred_at` | `timestamptz` | NOT NULL | Business time |
| `recorded_at` | `timestamptz` | NOT NULL DEFAULT `now()` | Store time |

- Index (`subject_id`, `id`) for ordered delivery per subject.

### `platform.outbox_delivery` · WORK

Delivery state per message and consumer. `DEAD` rows are the dead letter queue.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `message_id` | `uuid` | NOT NULL, FK `platform.outbox_message` | |
| `consumer` | `text` | NOT NULL | Subscriber name |
| `subject_id` | `uuid` | NOT NULL | Copied from the message, so ordered delivery per subject reads one table (B3) |
| `status` | `text` | NOT NULL, CHECK in (`PENDING`, `DELIVERED`, `FAILED`, `DEAD`) | |
| `attempts` | `integer` | NOT NULL DEFAULT 0 | For backoff |
| `next_attempt_at` | `timestamptz` | NULL | When to retry |
| `last_error` | `text` | NULL | Scrubbed error summary |
| `delivered_at` | `timestamptz` | NULL | |

- PK (`message_id`, `consumer`). Partial index on (`next_attempt_at`) where status is `PENDING` or `FAILED`. The health endpoint reads backlog and oldest pending from here.

### `platform.inbox_message` · LEDGER

Makes asynchronous consumers idempotent.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `consumer` | `text` | NOT NULL | |
| `message_id` | `uuid` | NOT NULL | The outbox message handled |
| `processed_at` | `timestamptz` | NOT NULL DEFAULT `now()` | |

Standard columns: `LEDGER` (`actor_id` is the dispatcher's SYSTEM principal).

- PK (`consumer`, `message_id`), inserted in the same transaction as the consumer's effect.

### `platform.setting` · MASTER

Typed settings, feature flags, the business profile and thresholds, editable without a deployment. Edited only through the AUD module's audited administration.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `key` | `text` | NOT NULL | Dotted name, for example `tax.registered`, `cap.retention_rate` |
| `branch_id` | `uuid` | NULL, FK `mdm.branch` | Null for a global value; set for a branch override |
| `value` | `jsonb` | NOT NULL | The value |
| `value_type` | `text` | NOT NULL, CHECK in (`BOOLEAN`, `INTEGER`, `PESEWAS`, `PERCENT`, `TEXT`, `JSON`) | Validation on write |
| `valid_from` | `timestamptz` | NOT NULL DEFAULT `now()` | Settings with legal effect are effective-dated |
| `description` | `text` | NOT NULL | Shown in administration |

Standard columns: `MASTER`.

- UNIQUE NULLS NOT DISTINCT (`key`, `branch_id`, `valid_from`) among live rows. Secrets are never stored here.

### `platform.stored_file` · MASTER

Metadata for every object in object storage. Content is immutable; only scan status and soft-delete columns change.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `bucket` | `text` | NOT NULL | Public media and private documents are separate buckets and origins |
| `object_key` | `text` | NOT NULL, UNIQUE | Random key; never the original name |
| `original_name` | `text` | NOT NULL | For download only |
| `content_type` | `text` | NOT NULL | Determined by content sniffing, not extension |
| `size_bytes` | `bigint` | NOT NULL, CHECK `> 0` | Enforces the size cap |
| `sha256` | `bytea` | NOT NULL | Integrity, and proof an archived document is unchanged |
| `classification` | `text` | NOT NULL, CHECK in (`PUBLIC`, `INTERNAL`, `CONFIDENTIAL`, `RESTRICTED`) | Drives signed URL rules |
| `scan_status` | `text` | NOT NULL, CHECK in (`PENDING`, `CLEAN`, `INFECTED`, `FAILED`) | A file is not served until `CLEAN` |
| `owner_module` | `text` | NOT NULL | Who to ask about it |

Standard columns: `MASTER`.

### `platform.stored_file_variant` · PROJECTION

Resized and compressed renditions of an image, produced by a worker.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `file_id` | `uuid` | NOT NULL, FK `platform.stored_file` | The original |
| `variant` | `text` | NOT NULL | For example `thumb`, `card`, `full` |
| `object_key` | `text` | NOT NULL, UNIQUE | |
| `content_type` | `text` | NOT NULL | Usually a modern compressed format |
| `width` | `integer` | NOT NULL | For responsive markup |
| `height` | `integer` | NOT NULL | |
| `size_bytes` | `bigint` | NOT NULL | Page weight budgeting |

- PK (`file_id`, `variant`).

### `platform.file_access_log` · LEDGER

Every signed URL issued for a private file.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `file_id` | `uuid` | NOT NULL, FK `platform.stored_file` | |
| `purpose` | `text` | NOT NULL | Why access was granted |
| `url_expires_at` | `timestamptz` | NOT NULL | Signed URLs always expire |
| `ip` | `inet` | NULL | |

Standard columns: `LEDGER`.

### `platform.audit_event` · LEDGER

The audit log (ADR-0006). Written in the business transaction.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `occurred_at` | `timestamptz` | NOT NULL | When the action happened |
| `recorded_at` | `timestamptz` | NOT NULL DEFAULT `now()` | When stored |
| `actor_id` | `uuid` | NULL, FK `iam.principal` | Null only for a failed login by an unknown account |
| `session_id` | `uuid` | NULL | The session used |
| `ip` | `inet` | NULL | |
| `user_agent` | `text` | NULL | |
| `correlation_id` | `uuid` | NOT NULL | Links to logs and traces |
| `branch_id` | `uuid` | NULL, FK `mdm.branch` | |
| `module` | `text` | NOT NULL | Which module acted |
| `action` | `text` | NOT NULL | `CREATE`, `UPDATE`, `DELETE`, `LOGIN`, `LOGIN_FAILED`, `LOGOUT`, `PERMISSION_CHANGE`, `PRICE_OVERRIDE`, `APPROVAL`, `EXPORT`, `DECRYPT`, `SETTING_CHANGE` and others |
| `entity_type` | `text` | NOT NULL | What was acted on |
| `entity_id` | `uuid` | NULL | Which one |
| `before` | `bytea` | NULL | Canonical JSON before the change; personal fields encrypted, secrets redacted (ADR-0022) |
| `after` | `bytea` | NULL | Canonical JSON after |
| `metadata` | `jsonb` | NULL | Row counts for exports, reason codes, approval ids |
| `subject_key_id` | `uuid` | NULL, FK `platform.subject_key` | The key that encrypted personal fields |
| `txid` | `xid8` | NOT NULL, set by trigger | Sealing order |
| `content_hash` | `bytea` | NOT NULL, set by trigger | SHA-256 of the row's canonical bytes |

- Index (`entity_type`, `entity_id`, `occurred_at`); index (`actor_id`, `occurred_at`); index (`txid`, `id`).
- Readable only by Owner and Accountant, through the AUD module.

### `platform.audit_chain` · LEDGER

The hash chain, one row per audit event, written only by the sealer.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `seq` | `bigint` | PK | Gap-free position in the chain |
| `audit_event_id` | `uuid` | NOT NULL, UNIQUE, FK `platform.audit_event` | The event sealed |
| `prev_hash` | `bytea` | NOT NULL | Hash of the previous row; 32 zero bytes for the first |
| `chain_hash` | `bytea` | NOT NULL | `sha256(prev_hash || content_hash || seq)` |
| `sealed_at` | `timestamptz` | NOT NULL DEFAULT `now()` | |

Standard columns: `LEDGER`, `actor_id` defaulting to the sealer's SYSTEM principal. Class comment `class=LEDGER;writer=hk_sealer`: `hk_app` and `hk_worker` hold SELECT only (ADR-0034).

### `platform.audit_anchor` · LEDGER

Signed copies of the chain head, also stored off the server.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `seq` | `bigint` | NOT NULL, FK `platform.audit_chain` | The head anchored |
| `chain_hash` | `bytea` | NOT NULL | Copy of the head hash |
| `signature` | `bytea` | NOT NULL | Made with a key not in the database |
| `signing_key_id` | `text` | NOT NULL | Which key |
| `storage_uri` | `text` | NOT NULL | Off-box location of the copy |
| `reason` | `text` | NOT NULL, CHECK in (`DAILY`, `SHIFT_CLOSE`, `MANUAL`) | |
| `anchored_at` | `timestamptz` | NOT NULL DEFAULT `now()` | |

Standard columns: `LEDGER`, as `platform.audit_chain`, and written by `hk_sealer` only. The copy is a JSON document under `anchors/YYYY/MM/DD/` in the anchor bucket, with seven years of object lock.

### `platform.subject_key` · MASTER

One wrapped encryption key per data subject (ADR-0022). Destroying it erases the subject's personal data from immutable records.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `subject_type` | `text` | NOT NULL, CHECK in (`CUSTOMER`, `SUPPLIER`, `INVESTOR`, `STAFF`) | |
| `subject_id` | `uuid` | NOT NULL | The subject's id in its owning module |
| `wrapped_key` | `bytea` | NULL | The key, wrapped by the key-encryption key; null once destroyed |
| `kek_version` | `integer` | NOT NULL | Which key-encryption key wrapped it |
| `created_at` | `timestamptz` | NOT NULL DEFAULT `now()` | |
| `destroyed_at` | `timestamptz` | NULL | |
| `destroyed_by` | `uuid` | NULL, FK `iam.principal` | |
| `destroy_reason` | `text` | NULL | The deletion request |

- UNIQUE (`subject_type`, `subject_id`). CHECK: `wrapped_key` is null exactly when `destroyed_at` is set.
- Trigger: once `destroyed_at` is set the row cannot change. Never soft-deleted.

### `platform.job_run` · LEDGER

Outcome of every scheduled job, read by the health endpoint for "last successful reconciliation".

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `job_name` | `text` | NOT NULL | For example `stock-balance-recompute`, `trial-balance-check`, `audit-verify` |
| `started_at` | `timestamptz` | NOT NULL | |
| `finished_at` | `timestamptz` | NOT NULL | |
| `outcome` | `text` | NOT NULL, CHECK in (`SUCCESS`, `DRIFT`, `FAILED`) | `DRIFT` means the check ran and found a difference |
| `summary` | `jsonb` | NOT NULL | Counts and the offending record ids |

Standard columns: `LEDGER`.

- Index (`job_name`, `finished_at` DESC). Jobs from B3: `audit-verify`, `idempotency-purge`.
