# Table dictionary: `pos`

Owner: POS module. Registers, device enrolment, shifts, cash movements, held sales and the offline sync log. A counter sale itself is an `ord.sales_order` on channel `POS` (ADR-0026, ADR-0027). Conventions are in `docs/DATA_MODEL.md`.

**Built in B9b (migration 0226, A-273):** `pos.register`, `pos.shift`, `pos.cash_movement`, `pos.shift_tender_count` and `pos.shift_report`, as below, with these differences from the plan:
- **`pos.register`** carries the MASTER standard columns; `uq_register_code` is (`branch_id`, `code`) among live registers.
- **`pos.shift`:** `shift_no` is NOT NULL (allocated at open, `SHF-<year>-<branch>-<n>`); `declared_at` is added; `expected_cash_pesewas` is stored only at the sign-off (a CLOSING shift's expected figure is computed when read); `currency`, the DOCUMENT standard columns and `posted_at`/`posted_by` (set at the sign-off). Checks: `ck_shift_steps` (OPEN, CLOSING and CLOSED each with exactly their fields), `ck_shift_over_short` (over or short is exactly `abs(declared - expected)` with its direction), `ck_shift_close_checker`, `ck_shift_posted`. `pos.shift_guard` (HK004, HK010): opens OPEN, never force-closed, with counter 0; the opening facts never change; the declared count never changes; OPEN to CLOSING to CLOSED only. Frozen once CLOSED (`platform.freeze_posted`).
- **`pos.cash_movement`:** `recorded_at` and `actor_id` (LEDGER); `reason_code` is required for every kind but `FLOAT_IN` (`ck_cash_movement_reason`); a witness exactly on a drop and never its recorder (`ck_cash_movement_witness`); one `FLOAT_IN` per shift (`uq_cash_movement_float`); `pos.cash_movement_guard` (HK010) refuses a movement on a shift that is not OPEN and a drop witnessed by the shift's cashier.
- **`pos.shift_tender_count`:** `created_at`/`created_by`; `ck_shift_tender_count_variance` as for the shift; `pos.shift_tender_count_guard` (HK004, HK010): inserted blind while the shift is CLOSING, its expected figure set once at the sign-off, the declared figure never changed.
- **`pos.shift_report`:** `recorded_at` and `actor_id`; only the Z report is stored (an X report is a reading, A-273 (j)).
**Built in B09b continued (migrations 0231 and 0235, A-274):**
- **`pos.cash_movement.unwitnessed`** (boolean, default false): a drop taken while no supervisor was signed in at the branch (the owner on A-273 (d)). `ck_cash_movement_witness` now holds a drop witnessed or unwitnessed, never both nor neither, and nothing but a drop either.
- **`pos.device_enrolment`** as below, with `revoked_by`, `revoke_reason`, `branch_id` and the MASTER standard columns; `credential_hash` is the SHA-256 of the credential (`ck_device_enrolment_hash`, 32 bytes), unique (`uq_device_enrolment_credential`); `ck_device_enrolment_revoked`; `pos.device_enrolment_guard` (HK004, HK010): a device is enrolled live and never synced, what it was enrolled as never changes, and a revoked device stays revoked and syncs nothing.
**Built in B09b continued 1b (migration 0245, A-275, ADR-0078):**
- **`pos.shift.force_close_reason`** (text, 1 to 500 characters), set exactly on a force-closed shift (`ck_shift_force_close_reason`). `ck_shift_steps` gains the force-closed CLOSED step (no declaration; expected cash, closed time and `close_approved_by`, the force-closer, set) and refuses `force_closed` on every other step; `ck_shift_over_short` allows no over or short until both figures exist; `pos.shift_guard` lets OPEN become CLOSED only by a force close, and the flag and its reason change only in that step. `ck_shift_close_checker` holds that the force-closer is never the cashier.
- **`pos.shift_late_count`** · LEDGER (new): the count of a force-closed shift's drawer, one per shift (PK `shift_id`): `declared_cash_pesewas`, `expected_cash_pesewas` (the shift's frozen figure, `ck_shift_late_count_expected`), `over_short_pesewas` and `over_short_direction` (`ck_shift_late_count_over_short`), `reason`, `counted_at`, `recorded_at`, `actor_id`. `pos.shift_late_count_guard` (HK010): only a force-closed shift (`ck_shift_late_count_forced`), never by its cashier (`ck_shift_late_count_not_cashier`) nor its force-closer (`ck_shift_late_count_not_closer`), by a holder of `pos.shift.close.approve` at its branch (`ck_shift_late_count_supervisor`).
**Built in B09b continued 1c (migration 0247, A-276):**
- **`pos.held_sale`** · WORK, as below, with `shift_id` (FK `pos.shift`, the shift it was held on), `branch_id`, `held_gross_pesewas` (what the lines came to at the prices in force when held), `status` (`HELD`, `RECALLED`, `LAPSED`), `recalled_at`, `recalled_by`, `lapsed_at` and `lapse_reason` (`SHIFT_CLOSED`, `SHIFT_FORCE_CLOSED`); `held_at` and `expires_at` (twelve hours later) have no default, the application writes them from its clock. `payload` is an object with a `lines` array, at most 32 KB (`ck_held_sale_payload`); `label` 1 to 120 characters. `ck_held_sale_steps`: each status with exactly its fields, a recall before `expires_at`. `pos.held_sale_guard` (HK010, HK004): held only on an OPEN shift of its till by that shift's cashier (`ck_held_sale_open_shift`); what was held never changes; HELD becomes RECALLED (on its shift while OPEN, by its cashier: `ck_held_sale_recall`) or LAPSED, and then never changes. DELETE is granted as for any WORK table, for a purge of recalled or lapsed holds; a HELD one is never deleted (HK004). `trg_shift_held_sales_lapsed` on `pos.shift` (`ck_shift_held_sales_lapsed`): a shift leaves OPEN only once none of its sales is HELD.
- **Not yet built:** `pos.sale_sync` (B09b continued 2).

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
