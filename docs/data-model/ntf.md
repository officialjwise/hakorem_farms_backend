# Table dictionary: `ntf`

Owner: NTF module. Templates, preferences, opt-outs and the log of every message. NTF only subscribes to events; no module calls it (ADR-0009). Conventions are in `docs/DATA_MODEL.md`.

---

### `ntf.template` · MASTER

Message templates per channel and locale.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `code` | `text` | NOT NULL | For example `RECEIPT`, `QUOTE_ISSUED`, `ORDER_DISPATCHED`, `PAYMENT_REMINDER_1`, `LOW_STOCK` |
| `channel` | `text` | NOT NULL, CHECK in (`SMS`, `WHATSAPP`, `EMAIL`, `IN_APP`) | |
| `locale` | `text` | NOT NULL DEFAULT `'en-GH'` | English ships first; the column makes other languages data |
| `category` | `text` | NOT NULL, CHECK in (`TRANSACTIONAL`, `REMINDER`, `MARKETING`, `OPERATIONAL`) | Decides how preferences and quiet hours apply |
| `subject` | `text` | NULL | Email only |
| `body` | `text` | NOT NULL | With named placeholders |
| `provider_template_ref` | `text` | NULL | Pre-approved WhatsApp template name |
| `version_no` | `integer` | NOT NULL | |
| `status` | `text` | NOT NULL, CHECK in (`DRAFT`, `ACTIVE`, `RETIRED`) | |

Standard columns: `MASTER`. Partial UNIQUE (`code`, `channel`, `locale`) where `status = 'ACTIVE'`.

### `ntf.trigger_rule` · MASTER

Which event sends which template to whom.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `event_type` | `text` | NOT NULL | For example `bil.InvoiceIssued` |
| `template_code` | `text` | NOT NULL | |
| `recipient_kind` | `text` | NOT NULL, CHECK in (`CUSTOMER`, `CONTACT_ON_EVENT`, `ROLE`, `PRINCIPAL_ON_EVENT`) | Customer from the event, or staff holding a role at the branch |
| `recipient_role_code` | `text` | NULL | For `ROLE` |
| `channels` | `text[]` | NOT NULL | In order of preference |
| `is_active` | `boolean` | NOT NULL DEFAULT `true` | |

Standard columns: `MASTER`.

### `ntf.preference` · MASTER

Channel preferences and quiet hours per recipient.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `customer_id` | `uuid` | NULL, FK `mdm.customer` | |
| `principal_id` | `uuid` | NULL, FK `iam.principal` | Staff and investors |
| `category` | `text` | NOT NULL | |
| `channel` | `text` | NOT NULL | |
| `is_enabled` | `boolean` | NOT NULL | |
| `quiet_from` | `time` | NULL | Quiet hours, Africa/Accra |
| `quiet_to` | `time` | NULL | |

Standard columns: `MASTER`.

- CHECK: exactly one of `customer_id`, `principal_id` is set. UNIQUE NULLS NOT DISTINCT (`customer_id`, `principal_id`, `category`, `channel`) among live rows.

### `ntf.opt_out` · LEDGER

An opt-out received from a recipient, for example an SMS reply of STOP.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `address_hash` | `bytea` | NOT NULL | Keyed hash of the phone number or email, so an opt-out survives deletion of the customer record |
| `channel` | `text` | NOT NULL | |
| `direction` | `text` | NOT NULL, CHECK in (`OPT_OUT`, `OPT_IN`) | |
| `source` | `text` | NOT NULL | Reply keyword, preference screen, support |

Standard columns: `LEDGER`.

### `ntf.message` · DOCUMENT

Every message: what was sent to whom and when. Posted statuses: `SENT`, `DELIVERED`, `FAILED`, `SUPPRESSED`.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `idempotency_key` | `text` | NOT NULL, UNIQUE | Source event id, rule and recipient: sent at most once |
| `source_event_ref` | `uuid` | NOT NULL | The outbox message |
| `branch_id` | `uuid` | NULL, FK `mdm.branch` | |
| `template_id` | `uuid` | NOT NULL, FK `ntf.template` | The version used |
| `channel` | `text` | NOT NULL | |
| `category` | `text` | NOT NULL | |
| `customer_id` | `uuid` | NULL, FK `mdm.customer` | |
| `principal_id` | `uuid` | NULL, FK `iam.principal` | |
| `address_masked` | `text` | NOT NULL | Last three digits or masked email, for the log |
| `address_enc` | `bytea` | NOT NULL | The address used, encrypted |
| `rendered_body` | `text` | NULL | Kept for transactional messages; personal detail limited to what was sent |
| `status` | `text` | NOT NULL, CHECK in (`QUEUED`, `DEFERRED_QUIET_HOURS`, `SENT`, `DELIVERED`, `FAILED`, `SUPPRESSED`) | |
| `suppressed_reason` | `text` | NULL | Opted out, preference off |
| `attempts` | `integer` | NOT NULL DEFAULT 0 | |
| `send_after` | `timestamptz` | NULL | Quiet hours delay, never drop |
| `provider_message_ref` | `text` | NULL | For delivery tracking |
| `sent_at` | `timestamptz` | NULL | |
| `delivered_at` | `timestamptz` | NULL | |
| `created_at` | `timestamptz` | NOT NULL DEFAULT `now()` | |

- Index (`status`, `send_after`).

### `ntf.message_attempt` · LEDGER

Each attempt to send a message.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `message_id` | `uuid` | NOT NULL, FK `ntf.message` | |
| `attempt_no` | `integer` | NOT NULL | |
| `outcome` | `text` | NOT NULL, CHECK in (`ACCEPTED`, `TEMPORARY_FAILURE`, `PERMANENT_FAILURE`) | |
| `provider_response` | `text` | NULL | Scrubbed |
| `attempted_at` | `timestamptz` | NOT NULL DEFAULT `now()` | |

- PK (`message_id`, `attempt_no`).

### `ntf.in_app_notification` · WORK

Notifications shown inside the console.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `principal_id` | `uuid` | NOT NULL, FK `iam.principal` | |
| `message_id` | `uuid` | NOT NULL, FK `ntf.message` | |
| `title` | `text` | NOT NULL | |
| `body` | `text` | NOT NULL | |
| `link` | `text` | NULL | Where it takes the user |
| `read_at` | `timestamptz` | NULL | |
| `created_at` | `timestamptz` | NOT NULL DEFAULT `now()` | |
