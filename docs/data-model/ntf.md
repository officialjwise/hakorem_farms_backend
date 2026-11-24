# Table dictionary: `ntf`

Owner: NTF module. Templates, preferences, opt-outs and the log of every message. NTF only subscribes to events; no module calls it (ADR-0009). Conventions are in `docs/DATA_MODEL.md`.

**Built (B11 continued 10, migration 0335, ADR-0096, A-374):** `ntf.template`, `ntf.message`, `ntf.message_attempt` and `ntf.provider_report`. `ntf.trigger_rule`, `ntf.preference`, `ntf.opt_out` and `ntf.in_app_notification` are B11 continued 11's.

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
| `activated_at`, `activated_by` | `timestamptz`, `uuid` | NULL, both or neither; FK `iam.principal` | Who made the version active (B11 continued 10) |

Standard columns: `MASTER`. Partial UNIQUE (`code`, `channel`, `locale`) where `status = 'ACTIVE'`; UNIQUE (`code`, `channel`, `locale`, `version_no`). CHECK `activated_by <> created_by` (`ck_template_maker_checker`: a version is never activated by its drafter, abuse case 57); `ntf.template_guard()`: a version's text never changes, DRAFT -> ACTIVE -> RETIRED or DRAFT -> RETIRED, its activation once.

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
| `source_event_type` | `text` | NOT NULL | Its event type (B11 continued 10) |
| `sales_order_id` | `uuid` | NULL, FK `ord.sales_order` | The order whose own contact the message goes to (B11 continued 10) |
| `branch_id` | `uuid` | NULL, FK `mdm.branch` | |
| `template_id` | `uuid` | NOT NULL, FK `ntf.template` | The version used |
| `channel` | `text` | NOT NULL | |
| `category` | `text` | NOT NULL | |
| `customer_id` | `uuid` | NULL, FK `mdm.customer` | |
| `principal_id` | `uuid` | NULL, FK `iam.principal` | |
| `recipient_kind` | `text` | NOT NULL, CHECK in (`CUSTOMER`, `STAFF`, `INVESTOR`, `CONTACT`) | `CUSTOMER` needs `customer_id` |
| `address_masked` | `text` | NOT NULL | `+23324*****56` (FR-NTF-007); empty when there was no number |
| `address_hash` | `bytea` | NULL, 32 bytes | HMAC-SHA256 of the number under a key derived from the lookup key, for the hourly limit per recipient (abuse case 58). **No address is stored** (ADR-0096, A-374 (b)): the planned `address_enc` is not built; the number is read from the record's own module when queued and when sent |
| `rendered_body` | `text` | NULL | Kept for transactional messages; personal detail limited to what was sent |
| `status` | `text` | NOT NULL, CHECK in (`QUEUED`, `DEFERRED_QUIET_HOURS`, `SENT`, `DELIVERED`, `FAILED`, `SUPPRESSED`) | |
| `suppressed_reason` | `text` | NULL, CHECK in (`NO_ADDRESS`, `RATE_LIMITED`, `OPTED_OUT`, `PREFERENCE_OFF`); set exactly when `SUPPRESSED` | |
| `failure_reason` | `text` | NULL | The last failure, scrubbed |
| `failed_at` | `timestamptz` | NULL; set when `FAILED` | |
| `attempts` | `integer` | NOT NULL DEFAULT 0 | |
| `send_after` | `timestamptz` | NULL | Quiet hours delay, never drop; a retry's backoff |
| `claimed_until`, `claim_token` | `timestamptz`, `uuid` | NULL, both or neither | A sender's lease on the message while it sends (ADR-0096) |
| `provider_message_ref` | `text` | NULL | For delivery tracking |
| `sent_at` | `timestamptz` | NULL | |
| `delivered_at` | `timestamptz` | NULL | |
| `created_at` | `timestamptz` | NOT NULL | Written from the application clock (ADR-0067) |

Standard columns: `DOCUMENT` (`version`, `created_by`, `updated_at`, `updated_by`).

- Index (`status`, `send_after`); (`address_hash`, `created_at`); (`created_at` DESC, `id` DESC) for the log.
- `ntf.message_guard()`: written `QUEUED` or `SUPPRESSED`, never tried; what a message is (its event, order, template, channel, recipient and text) never changes; attempts never fall; `QUEUED` -> `SENT`, `FAILED`, `SUPPRESSED`; `SENT` -> `DELIVERED`, `FAILED`; `FAILED` -> `QUEUED` (a manager's retry); `DELIVERED` and `SUPPRESSED` final. A delivery report moves only the status.

### `ntf.message_attempt` · LEDGER

Each attempt to send a message.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `message_id` | `uuid` | NOT NULL, FK `ntf.message` | |
| `attempt_no` | `integer` | NOT NULL | |
| `outcome` | `text` | NOT NULL, CHECK in (`ACCEPTED`, `TEMPORARY_FAILURE`, `PERMANENT_FAILURE`) | |
| `provider_response` | `text` | NULL | Scrubbed |
| `attempted_at` | `timestamptz` | NOT NULL | |

Standard columns: `LEDGER`.

- PK (`message_id`, `attempt_no`).

### `ntf.provider_report` · LEDGER

Every request to the messaging webhook, accepted or not (B11 continued 10, FR-NTF-007, abuse case 57).

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `provider` | `text` | NOT NULL | `GENERIC_HTTP` |
| `report_key` | `text` | NULL | The provider's report id; set unless rejected or ignored |
| `outcome` | `text` | NOT NULL, CHECK in (`APPLIED`, `NO_CHANGE`, `UNKNOWN_MESSAGE`, `IGNORED`, `REPLAYED`, `REJECTED_SIGNATURE`, `REJECTED_MALFORMED`) | |
| `message_id` | `uuid` | NULL, FK `ntf.message` | |
| `reported_status` | `text` | NULL, CHECK in (`DELIVERED`, `FAILED`) | |
| `payload_hash` | `bytea` | NOT NULL | SHA-256 of the raw body; the body itself is not kept |
| `source_ip` | `text` | NULL | |
| `received_at` | `timestamptz` | NOT NULL | |

Standard columns: `LEDGER`. Partial UNIQUE (`provider`, `report_key`) where `outcome` in (`APPLIED`, `NO_CHANGE`, `UNKNOWN_MESSAGE`): a report is applied once; a second delivery is logged `REPLAYED`.

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
