# Table dictionary: `api`

Owner: API module. Integrations, outbound webhooks and accounting export. API keys themselves are `iam.api_credential`; the versioned REST contract is `contract/openapi.yaml`. Conventions are in `docs/DATA_MODEL.md`.

---

### `api.integration` · MASTER

A third-party system allowed to call the API or receive webhooks.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `name` | `text` | NOT NULL, UNIQUE among live rows | |
| `principal_id` | `uuid` | NOT NULL, UNIQUE, FK `iam.principal` | Its identity; scopes are role grants on this principal |
| `owner_contact` | `text` | NOT NULL | Who to call about it |
| `purpose` | `text` | NOT NULL | |
| `status` | `text` | NOT NULL, CHECK in (`ACTIVE`, `SUSPENDED`) | |

Standard columns: `MASTER`.

### `api.webhook_endpoint` · MASTER

A URL an integration receives events at.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `integration_id` | `uuid` | NOT NULL, FK `api.integration` | |
| `url` | `text` | NOT NULL, CHECK starts with `https://` | Private and loopback addresses are refused at save and at send |
| `secret_enc` | `bytea` | NOT NULL | Signing secret, encrypted |
| `event_types` | `text[]` | NOT NULL | Subscribed events |
| `status` | `text` | NOT NULL, CHECK in (`ACTIVE`, `PAUSED`, `DISABLED_FAILING`) | Disabled automatically after sustained failure |

Standard columns: `MASTER`.

### `api.webhook_delivery` · WORK

One delivery of one event to one endpoint. `DEAD` rows are the dead letter queue.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | Sent as the delivery id header, so the receiver can deduplicate |
| `endpoint_id` | `uuid` | NOT NULL, FK `api.webhook_endpoint` | |
| `outbox_message_ref` | `uuid` | NOT NULL | The event |
| `event_type` | `text` | NOT NULL | |
| `payload_hash` | `bytea` | NOT NULL | What was signed |
| `status` | `text` | NOT NULL, CHECK in (`PENDING`, `DELIVERED`, `FAILED`, `DEAD`) | |
| `attempts` | `integer` | NOT NULL DEFAULT 0 | |
| `next_attempt_at` | `timestamptz` | NULL | Exponential backoff |
| `last_response_status` | `integer` | NULL | |
| `last_error` | `text` | NULL | |
| `delivered_at` | `timestamptz` | NULL | |
| `created_at` | `timestamptz` | NOT NULL DEFAULT `now()` | |

- UNIQUE (`endpoint_id`, `outbox_message_ref`).

### `api.accounting_export` · LEDGER

An export of journals to an external accounting package, through the accounting export port.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `branch_id` | `uuid` | NULL, FK `mdm.branch` | |
| `period_ref` | `uuid` | NOT NULL | The accounting period |
| `format` | `text` | NOT NULL | The adapter used |
| `entries_count` | `integer` | NOT NULL | Audited row count |
| `file_id` | `uuid` | NOT NULL, FK `platform.stored_file` | |
| `content_hash` | `bytea` | NOT NULL | |

Standard columns: `LEDGER`.
