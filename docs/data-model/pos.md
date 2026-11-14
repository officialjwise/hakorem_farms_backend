# Table dictionary: `pos`

Owner: POS module. Registers, device enrolment, shifts, cash movements, held sales and the offline sync log. A counter sale itself is an `ord.sales_order` on channel `POS` (ADR-0026, ADR-0027). Conventions are in `docs/DATA_MODEL.md`.

---

### `pos.register` · MASTER

A till.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `branch_id` | `uuid` | NOT NULL, FK `mdm.branch` | |
| `location_id` | `uuid` | NOT NULL, FK `mdm.location` | The sellable location it sells from |
| `code` | `text` | NOT NULL, CHECK matches `^[A-Z0-9]{1,4}$` | Appears in receipt numbers |
| `name` | `text` | NOT NULL | |
| `status` | `text` | NOT NULL, CHECK in (`ACTIVE`, `RETIRED`) | |

Standard columns: `MASTER`. UNIQUE (`branch_id`, `code`).

### `pos.device_enrolment` · MASTER

A device allowed to run a register offline.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | Device id |
| `register_id` | `uuid` | NOT NULL, FK `pos.register` | |
| `device_label` | `text` | NOT NULL | |
| `credential_hash` | `bytea` | NOT NULL | Device credential, stored hashed |
| `enrolled_by` | `uuid` | NOT NULL, FK `iam.principal` | A manager |
| `enrolled_at` | `timestamptz` | NOT NULL DEFAULT `now()` | |
| `last_sync_at` | `timestamptz` | NULL | Health and offline age |
| `revoked_at` | `timestamptz` | NULL | A lost device is revoked |

Standard columns: `MASTER`.

### `pos.shift` · DOCUMENT

One cashier's session on one register. Posted status: `CLOSED`. Registered as a business document so payments and orders can reference it.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK, FK `platform.business_document` | Client-generated if opened offline |
| `shift_no` | `text` | NULL, UNIQUE | |
| `register_id` | `uuid` | NOT NULL, FK `pos.register` | |
| `cashier_id` | `uuid` | NOT NULL, FK `iam.principal` | |
| `shift_seq` | `integer` | NOT NULL | Sequence on the register; printed in offline provisional references |
| `opened_at` | `timestamptz` | NOT NULL | |
| `opening_float_pesewas` | `pesewas` | NOT NULL | |
| `closed_at` | `timestamptz` | NULL | |
| `declared_cash_pesewas` | `pesewas` | NULL | Counted by the cashier, blind |
| `expected_cash_pesewas` | `pesewas` | NULL | Computed at close; never returned to the cashier before the declaration is stored |
| `over_short_pesewas` | `pesewas` | NULL | Absolute difference |
| `over_short_direction` | `text` | NULL, CHECK in (`OVER`, `SHORT`, `EXACT`) | |
| `close_approved_by` | `uuid` | NULL, FK `iam.principal`, CHECK `<> cashier_id` | Supervisor sign-off of the count |
| `last_device_counter` | `integer` | NOT NULL DEFAULT 0 | Highest offline counter synced, for gap detection |
| `force_closed` | `boolean` | NOT NULL DEFAULT `false` | Closed by a manager while the device was offline |

Standard columns: `DOCUMENT` (`status` in `OPEN`, `CLOSING`, `CLOSED`).

- UNIQUE (`register_id`, `shift_seq`).
- Partial UNIQUE (`register_id`) where `status <> 'CLOSED'`: one open shift per register.
- Partial UNIQUE (`cashier_id`) where `status <> 'CLOSED'`: one open shift per cashier.

### `pos.cash_movement` · LEDGER

Cash into and out of the till other than sales.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `shift_id` | `uuid` | NOT NULL, FK `pos.shift` | |
| `kind` | `text` | NOT NULL, CHECK in (`FLOAT_IN`, `CASH_DROP`, `PAY_OUT`, `PAY_IN`) | |
| `amount_pesewas` | `pesewas` | NOT NULL, CHECK `> 0` | |
| `reason_code` | `text` | NULL, FK `mdm.reason_code`; required for `PAY_OUT` and `PAY_IN` | |
| `note` | `text` | NULL | |
| `witness_id` | `uuid` | NULL, FK `iam.principal` | Who received a cash drop |
| `occurred_at` | `timestamptz` | NOT NULL | |

Standard columns: `LEDGER`.

### `pos.shift_tender_count` · DOCUMENT

Declared and expected totals per payment method at close. Frozen with the shift.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `shift_id` | `uuid` | NOT NULL, FK `pos.shift` | |
| `payment_method_id` | `uuid` | NOT NULL, FK `mdm.payment_method` | |
| `declared_pesewas` | `pesewas` | NOT NULL | |
| `expected_pesewas` | `pesewas` | NULL | From cleared payments of the shift |
| `variance_pesewas` | `pesewas` | NULL | |
| `variance_direction` | `text` | NULL, CHECK in (`OVER`, `SHORT`, `EXACT`) | |

- PK (`shift_id`, `payment_method_id`).

### `pos.shift_report` · LEDGER

X and Z reports as generated.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `shift_id` | `uuid` | NOT NULL, FK `pos.shift` | |
| `kind` | `text` | NOT NULL, CHECK in (`X`, `Z`) | X is a mid-shift reading, Z is the close |
| `totals` | `jsonb` | NOT NULL | Sales by method, voids, overrides, refunds, cash movements |
| `archived_document_id` | `uuid` | NULL, FK `doc.archived_document` | The printed report |

Standard columns: `LEDGER`. Partial UNIQUE (`shift_id`) where `kind = 'Z'`.

### `pos.held_sale` · WORK

A parked sale, recalled later.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `register_id` | `uuid` | NOT NULL, FK `pos.register` | |
| `held_by` | `uuid` | NOT NULL, FK `iam.principal` | |
| `label` | `text` | NULL | Customer name or note |
| `payload` | `jsonb` | NOT NULL | Lines as entered; prices are re-resolved on recall |
| `held_at` | `timestamptz` | NOT NULL DEFAULT `now()` | |
| `expires_at` | `timestamptz` | NOT NULL | Held sales lapse at shift close |

### `pos.sale_sync` · LEDGER

Every offline sale submission, including duplicates.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `device_id` | `uuid` | NOT NULL, FK `pos.device_enrolment` | |
| `shift_id` | `uuid` | NOT NULL, FK `pos.shift` | |
| `client_sale_id` | `uuid` | NOT NULL | The sale's UUIDv7, which is the order id |
| `device_counter` | `integer` | NOT NULL, CHECK `> 0` | Gap-free per shift on the device |
| `provisional_ref` | `text` | NOT NULL | As printed |
| `client_occurred_at` | `timestamptz` | NOT NULL | The device's time of sale |
| `payload_hash` | `bytea` | NOT NULL | Detects the same id with different content |
| `outcome` | `text` | NOT NULL, CHECK in (`APPLIED`, `APPLIED_WITH_EXCEPTION`, `DUPLICATE`, `REJECTED_INTEGRITY`) | |
| `exception_count` | `integer` | NOT NULL DEFAULT 0 | |
| `received_at` | `timestamptz` | NOT NULL DEFAULT `now()` | |

- Partial UNIQUE (`client_sale_id`) where outcome is `APPLIED` or `APPLIED_WITH_EXCEPTION`: a sale is applied exactly once.
- Partial UNIQUE (`shift_id`, `device_counter`) on the same condition.
