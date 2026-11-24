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
**Built in B09b continued 1c (migration 0250, A-276):**
- **`pos.held_sale`** · WORK, as below, with `shift_id` (FK `pos.shift`, the shift it was held on), `branch_id`, `held_gross_pesewas` (what the lines came to at the prices in force when held), `status` (`HELD`, `RECALLED`, `LAPSED`), `recalled_at`, `recalled_by`, `lapsed_at` and `lapse_reason` (`SHIFT_CLOSED`, `SHIFT_FORCE_CLOSED`); `held_at` and `expires_at` (twelve hours later) have no default, the application writes them from its clock. `payload` is an object with a `lines` array, at most 32 KB (`ck_held_sale_payload`); `label` 1 to 120 characters. `ck_held_sale_steps`: each status with exactly its fields, a recall before `expires_at`. `pos.held_sale_guard` (HK010, HK004): held only on an OPEN shift of its till by that shift's cashier (`ck_held_sale_open_shift`); what was held never changes; HELD becomes RECALLED (on its shift while OPEN, by its cashier: `ck_held_sale_recall`) or LAPSED, and then never changes. DELETE is granted as for any WORK table, for a purge of recalled or lapsed holds; a HELD one is never deleted (HK004). `trg_shift_held_sales_lapsed` on `pos.shift` (`ck_shift_held_sales_lapsed`): a shift leaves OPEN only once none of its sales is HELD.
**B09b continued 2 (A-277):** no table or column; the offline pack is a read and its issue an audit event (`ISSUE_OFFLINE_PACK`).
**Built in B09b continued 2b (migration 0256, A-278):**
- **`pos.sale_sync`** · LEDGER, as below, with `branch_id`; `payload_hash` is the 32 bytes the till sent (`ck_sale_sync_hash`); `order_document_id` (FK `platform.business_document`, the order, which is the client sale id), `order_no`, `receipt_no` and `gross_pesewas` on every row but a refused one, with `rejection_rule` exactly on a refused one (`ck_sale_sync_fields`); `exceptions` (a JSON array of `{kind, summary}`, what the till was told) with `exception_count` its length, zero exactly on `APPLIED` (`ck_sale_sync_applied`); the flags `posted_late_reason` (`PERIOD_LOCKED`, `SHIFT_CLOSED`, `AFTER_FORCE_CLOSE`) with `posting_date`, `clock_verdict` (`AHEAD_OF_SERVER`, `BEFORE_SHIFT_OPENED`) and `too_old`; `received_at`, `recorded_at`, `actor_id` (the session's principal). The row is written once with its final outcome (no `PENDING` step). `pos.sale_sync_guard` (HK010): the shift is of the till the device is enrolled on (`ck_sale_sync_device_shift`), an applied row names its own sale as its order (`ck_sale_sync_order`), a `DUPLICATE` answers an applied row of the same sale and hash (`ck_sale_sync_duplicate`). Insert only (`platform.reject_change`).
- **`pos.shift.last_device_counter`** is raised by each applied sale while the shift is not CLOSED; the gaps are computed from every received counter.
**Built in B09b continued 2c (migration 0262, A-279):**
- **`pos.cash_movement_sync`** · LEDGER (new): every cash movement a till sends in a sync batch, once per submission: `device_id`, `shift_id` (the batch's), `branch_id`, `client_movement_id`, `kind`, `amount_pesewas`, `client_occurred_at`, `outcome` (`APPLIED`, `DUPLICATE`, `REJECTED`), `reason` (exactly on a refusal), `cash_movement_id` (the movement applied or duplicated), `answers_id` (a later submission names the row that decided it), `clock_verdict` (`AHEAD_OF_SERVER`, `BEFORE_SHIFT_OPENED`), `received_at`, `recorded_at`, `actor_id` (the session's principal). `uq_cash_movement_sync_decided`: one deciding row (APPLIED or first REJECTED) per client id. `ck_cash_movement_sync_fields`. `pos.cash_movement_sync_guard` (HK010): the shift is of the device's till, an APPLIED row is its own movement on the batch's shift of its kind and amount, a DUPLICATE names that movement, an answer answers a deciding row of the same client id. Insert only (`platform.reject_change`).
- **`pos.shift.opened_at`** of a shift a till opened offline is the till's `openedAt` (A-279 (b)); its float's `pos.cash_movement.occurred_at` is the same. A movement from the queue is recorded with `actor_id` the shift's cashier.

**Built in B09b continued 3 (migrations 0270 and 0271, A-280, ADR-0080):**
- **`pos.till_pin`** · LEDGER (new): each verifier a person set, by version: `principal_id`, `version` (`uq_till_pin_version`, each the next, `ck_till_pin_version` HK010), `algorithm` (`PBKDF2-SHA256` only), `iterations` (600,000 to 10,000,000), `salt` (16 to 64 bytes, never used twice, `uq_till_pin_salt`), `hash` (32 bytes), `set_at`, `recorded_at`, `actor_id` (always the person, `ck_till_pin_own`). Insert only; a newer version replaces it. Data category DC-43.
- **`pos.till_pin_event`** · LEDGER (new): each PIN try a till reports, once by its client id (PK): `register_id`, `device_id` (of that till, `ck_till_pin_event_device`), `branch_id`, `principal_id` and `pin_version` (FK to `pos.till_pin`), `outcome` (`FAILED`, `SUCCEEDED`), `purpose` (`UNLOCK`, `APPROVAL`, `WITNESS`, `SIGN_OUT`), `occurred_at` (the till's), `received_at`, `recorded_at`, `actor_id`. `pos.till_pin_wrong_tries` counts a version's `FAILED` tries by a moment; `pos.till_pin_in_force` holds a version neither replaced nor at five wrong tries by then.
- **`pos.till_sign_out`** · LEDGER (new): a locked cashier signed out by a supervisor's PIN, once by its client id: `register_id`, `device_id`, `branch_id`, `shift_id` (nullable), `cashier_id`, `supervisor_id` and `supervisor_pin_version` (FK to `pos.till_pin`), the times and `actor_id`. Never by the cashier (`ck_till_sign_out_checker`); `pos.till_sign_out_guard` (HK010): a supervisor of the branch (`ck_till_sign_out_supervisor`), the cashier's newest PIN locked (`ck_till_sign_out_locked`), the supervisor's version in force (`ck_till_sign_out_supervisor_pin`).
- **`pos.cash_movement.witness_pin_version`** (integer, nullable, FK with `witness_id` to `pos.till_pin`): from this migration a witnessed drop names the witness's PIN version in force when it was made (`pos.cash_movement_witness_pin_guard`: `ck_cash_movement_witness_pin_required`, `ck_cash_movement_witness_pin_in_force`); rows before keep null.

**Built in B09b continued 3b (migration 0280, A-281, ADR-0077 Amendments):**
- **`pos.cash_movement.late_entry`** (boolean, default false): a queued drop, pay-out or pay-in recorded on a shift that had stopped taking entries. `ck_cash_movement_late_kind` (never a float); `pos.cash_movement_guard` takes a late movement only on a shift no longer OPEN and only as its own cashier's (`ck_cash_movement_late_entry`, `ck_cash_movement_own_shift`), every other movement by the OPEN rule unchanged. A shift's movement totals for its close leave late entries out.
- **`pos.shift_late_entry`** · LEDGER (new): one row per late entry: `shift_id`, `branch_id`, `source_kind` (`SALE_CASH`, `CASH_DROP`, `PAY_OUT`, `PAY_IN`), `payment_id` and `order_document_id` (a sale's cash, FK `platform.business_document`) or `cash_movement_id` (`ck_shift_late_entry_source`), `amount_pesewas` (above zero), `expected_effect` (`RAISES` for a sale's cash and a pay-in, `LOWERS` for a drop and a pay-out, `ck_shift_late_entry_effect`), `adjustment_direction` (`SHORT` when it raises, `OVER` when it lowers, `ck_shift_late_entry_direction`), `shift_state` (`CLOSING`, `CLOSED`, `FORCE_CLOSED`), `severity` (`REVIEW`, `URGENT`), `occurred_at` (the till's), `recorded_at`, `actor_id` (the session that synced it). One per payment and one per movement (`uq_shift_late_entry_payment`, `uq_shift_late_entry_movement`). `pos.shift_late_entry_guard` (HK010): the shift no longer OPEN and in the state recorded, of the branch (`ck_shift_late_entry_shift`); its movement a late one on that shift of its kind and amount (`ck_shift_late_entry_movement`). A sale's cash names its payment (a registered document); that the payment is a late entry of this shift PAY's trigger holds, since POS reads no PAY table. Insert only (`platform.reject_change`). Its post-close adjustment is ◆ `pos.ShiftLateEntryPosted`, posting once per row (FIN's `uq_journal_entry_pos_late_entry`, migration 0281).

**Built in B09b continued 4 (migration 0292, A-284, ADR-0083):**
- **`pos.receipt_link`** · LEDGER (new): the receipt link a till made for a synced sale. `order_document_id` (FK `platform.business_document`, the sale), `branch_id`, `shift_id`, `device_id`, `source` (`TILL` only; the receipt SMS's links are kept apart, in `pos.receipt_message_link`, B11 continued 12), `token_hash` (the SHA-256 of the till's token, 32 bytes, `uq_receipt_link_token`; the token itself is never stored), `issued_at` (the sale's time), `expires_at` (exactly twelve months later in UTC, `ck_receipt_link_expiry`), `tenders` (the till's tenders as it took them: method, amount, what was handed over, unverified), `change_pesewas`, `recorded_at`, `actor_id`. One per sale (`uq_receipt_link_sale`). `pos.receipt_link_guard` (HK010): the shift is of the till the device is enrolled on (`ck_receipt_link_device_shift`) and the sale is applied on it (`ck_receipt_link_synced`). Insert only.
- **`pos.receipt_message_link`** · LEDGER (B11 continued 12, migration 0340, ADR-0084, A-349): a receipt link sent by message. `receipt_link_id` (FK `pos.receipt_link`, the sale's till link), `order_document_id` (the sale), `token_hash` (SHA-256 of an `rcp_` token made by NTF's sending worker through `ReceiptLinks.issueMessageLinkIn`, 32 bytes, `uq_receipt_message_link_token`), `expires_at`, `recorded_at`, `actor_id`. `pos.receipt_message_link_guard` (HK010): the till link is the sale's (`ck_receipt_message_link_sale`), it expires with it (`ck_receipt_message_link_expiry`), and its hash is no till link's (`ck_receipt_message_link_distinct`). It reads only while its till link is live and unrevoked, so revoking the till link revokes it. Insert only; one per send.
- **`pos.receipt_link_revocation`** · LEDGER (new): a link revoked, once (PK `receipt_link_id`), with `reason` (1 to 500 characters), `revoked_at`, `recorded_at`, `actor_id`. A revoked link reads nothing. Its operation is B09b continued 4b's. Insert only.
- **`pos.receipt_token_refusal`** · LEDGER (new): a synced sale whose token was refused, once (PK `order_document_id`): `token_hash`, `reason` (`TOKEN_ALREADY_BOUND` naming `bound_order_document_id`, or `TOKEN_IS_AN_IDENTIFIER`, `ck_receipt_token_refusal_fields`), `branch_id`, `shift_id`, `device_id`, `cashier_id`, `needs_server_link` (always true: B11's receipt SMS sends a fresh server-made link), `recorded_at`, `actor_id`. `pos.receipt_token_refusal_guard` (HK010): the cashier's shift on the device's till (`ck_receipt_token_refusal_device_shift`), the sale applied on it (`ck_receipt_token_refusal_synced`), the bound sale holding a link of that hash (`ck_receipt_token_refusal_bound`), the refused sale holding none (`ck_receipt_token_refusal_unlinked`). Insert only.
- Data category: the token hashes DC-43 (Restricted, as every token verifier), the tenders and change DC-22 (Confidential); no customer detail.

**Built in B09b continued 4b (migration 0297, A-285):**
- **`pos.receipt_link_revocation_guard`** (HK010) on `pos.receipt_link_revocation`: the actor holds `pos.shift.close.approve` at the link's branch at the application clock's instant (`ck_receipt_link_revocation_supervisor`). Written by `revokeReceiptLink`. No table or column changes.
- An invoice paid at the till (`payInvoiceAtTill`) writes no POS table: it is a PAY payment on the shift (`pay.payment.shift_document_id`), counted by `Payments.shiftTotalsIn` at the close. A business buyer's name and TIN are BIL's (`bil.billing_document`); POS stores neither.

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
