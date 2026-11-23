# Table dictionary: `del`

Owner: DEL module. Delivery slots, deliveries, routes, proof of delivery and driver cash. The module does not know orders: the caller supplies a snapshot (see `docs/MODULE_BOUNDARIES.md`). Conventions are in `docs/DATA_MODEL.md`.

---

### `del.delivery_slot` · MASTER

Published key.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `branch_id` | `uuid` | NOT NULL, FK `mdm.branch` | |
| `delivery_zone_id` | `uuid` | NOT NULL, FK `mdm.delivery_zone` | |
| `slot_date` | `date` | NOT NULL | |
| `starts_at` | `time` | NOT NULL | Africa/Accra |
| `ends_at` | `time` | NOT NULL, CHECK `> starts_at` | |
| `capacity` | `integer` | NOT NULL, CHECK `> 0` | |
| `booked` | `integer` | NOT NULL DEFAULT 0, CHECK `booked <= capacity` | Incremented under row lock when a delivery is scheduled |

Standard columns: `MASTER`. UNIQUE (`delivery_zone_id`, `slot_date`, `starts_at`).

### `del.delivery` · DOCUMENT

Posted statuses: `DELIVERED`, `RETURNED`, `CANCELLED`. Published key.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK, FK `platform.business_document` | |
| `delivery_no` | `text` | NULL, UNIQUE | Delivery note number |
| `order_document_id` | `uuid` | NOT NULL, FK `platform.business_document` | The order, by registry reference |
| `slot_id` | `uuid` | NULL, FK `del.delivery_slot` | |
| `delivery_zone_id` | `uuid` | NOT NULL, FK `mdm.delivery_zone` | |
| `recipient_name` | `text` | NOT NULL | Snapshot |
| `recipient_phone_e164` | `text` | NOT NULL | Snapshot |
| `address_snapshot` | `jsonb` | NOT NULL | Address, landmark, directions, coordinates |
| `contents_summary` | `jsonb` | NOT NULL | Items and weights for the driver and the delivery note |
| `driver_id` | `uuid` | NULL, FK `iam.principal` | |
| `vehicle_location_id` | `uuid` | NULL, FK `mdm.location` | The vehicle carrying the stock |
| `cod_due_pesewas` | `pesewas` | NOT NULL DEFAULT 0 | Cash to collect, set at dispatch |
| `cod_collected_pesewas` | `pesewas` | NULL | From proof of delivery |
| `attempt_count` | `integer` | NOT NULL DEFAULT 0 | |
| `dispatched_at` | `timestamptz` | NULL | |
| `delivered_at` | `timestamptz` | NULL | |
| `delivery_note_document_id` | `uuid` | NULL, FK `doc.archived_document` | Signed delivery note |

Standard columns: `DOCUMENT` (`status` in `SCHEDULED`, `ASSIGNED`, `OUT_FOR_DELIVERY`, `DELIVERED`, `FAILED`, `RETURNED`, `CANCELLED`).

- CHECK: `DELIVERED` requires a `del.proof_of_delivery` row (deferred trigger).
- Index (`driver_id`, `status`).

### `del.delivery_attempt` · LEDGER

Each attempt to deliver, successful or not.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | May be generated on the driver's device |
| `delivery_id` | `uuid` | NOT NULL, FK `del.delivery` | |
| `attempt_no` | `integer` | NOT NULL | |
| `outcome` | `text` | NOT NULL, CHECK in (`DELIVERED`, `FAILED`) | |
| `failure_reason_code` | `text` | NULL, FK `mdm.reason_code`; required for `FAILED` | |
| `next_action` | `text` | NULL, CHECK in (`REATTEMPT`, `RETURN_TO_STOCK`) | |
| `latitude` | `numeric(9,6)` | NULL | |
| `longitude` | `numeric(9,6)` | NULL | |
| `occurred_at` | `timestamptz` | NOT NULL | |

Standard columns: `LEDGER`. UNIQUE (`delivery_id`, `attempt_no`).

### `del.proof_of_delivery` · LEDGER

Evidence that a delivery was received: name, signature or photograph, position, cash collected.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | Generated on the driver's device; a retried upload collides |
| `delivery_id` | `uuid` | NOT NULL, UNIQUE, FK `del.delivery` | |
| `recipient_name` | `text` | NOT NULL | Who received it |
| `signature_file_id` | `uuid` | NULL, FK `platform.stored_file` | |
| `photo_file_id` | `uuid` | NULL, FK `platform.stored_file` | |
| `latitude` | `numeric(9,6)` | NULL | |
| `longitude` | `numeric(9,6)` | NULL | |
| `position_accuracy_m` | `integer` | NULL | |
| `cod_collected_pesewas` | `pesewas` | NOT NULL DEFAULT 0 | Recorded against the driver |
| `payment_id` | `uuid` | NULL, FK `pay.payment` | The cash-on-delivery payment recorded |
| `captured_at` | `timestamptz` | NOT NULL | Device time |

Standard columns: `LEDGER`.

- CHECK: at least one of `signature_file_id`, `photo_file_id` is present.

### `del.route` · DOCUMENT

A driver's list for a day.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `driver_id` | `uuid` | NOT NULL, FK `iam.principal` | |
| `route_date` | `date` | NOT NULL | |
| `vehicle_location_id` | `uuid` | NOT NULL, FK `mdm.location` | |

Standard columns: `DOCUMENT` (`status` in `PLANNED`, `IN_PROGRESS`, `COMPLETED`). UNIQUE (`driver_id`, `route_date`).

### `del.route_stop` · DOCUMENT

The deliveries on a route, in order.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `route_id` | `uuid` | NOT NULL, FK `del.route` | |
| `stop_no` | `integer` | NOT NULL | Order of visit |
| `delivery_id` | `uuid` | NOT NULL, UNIQUE, FK `del.delivery` | |

- PK (`route_id`, `stop_no`).

### `del.driver_cash_reconciliation` · DOCUMENT

End-of-day reconciliation of a driver's cash. Posted status: `POSTED`.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK, FK `platform.business_document` | |
| `driver_id` | `uuid` | NOT NULL, FK `iam.principal` | |
| `reconciliation_date` | `date` | NOT NULL | |
| `expected_pesewas` | `pesewas` | NOT NULL | Sum of cash collected on proofs of delivery that day |
| `declared_pesewas` | `pesewas` | NOT NULL | What the driver handed in |
| `variance_pesewas` | `pesewas` | NOT NULL | |
| `variance_direction` | `text` | NOT NULL, CHECK in (`OVER`, `SHORT`, `EXACT`) | Driver variance report |
| `received_by` | `uuid` | NOT NULL, FK `iam.principal`, CHECK `<> driver_id` | The driver cannot reconcile themselves |
| `note` | `text` | NULL | |

Standard columns: `DOCUMENT` (`status` in `DRAFT`, `POSTED`). UNIQUE (`driver_id`, `reconciliation_date`).

---

## As built (B07 continued 2, migration 0118; SA-13)

Only `del.delivery_slot` exists, as above, plus `ck_delivery_slot_capacity` (1 to 1,000), `uq_delivery_slot_start` as a partial unique index on live rows, and `ix_delivery_slot_start` on (`slot_date + starts_at`, `id`), the order of every slot list. `booked` stays 0 until B11 books deliveries under a row lock; `ck_delivery_slot_booked` already refuses a capacity below it. The other tables are B11's.

## As built (B11 continued, migrations 0299 and 0303; ADR-0092, A-337 to A-340)

- `del.delivery` as above, with these differences: `delivery_no` is NOT NULL, numbered at creation from the `DELIVERY`
  series (`DLN-2026-DDW-000001`, 0299); `billing_document_id` (FK `bil.billing_document`, the invoice or receipt the cash
  on delivery settles) and `customer_id` (FK `mdm.customer`, NULL for a guest) are added; `contents_summary` is a non-empty
  array of `{orderLineId, name, quantity, uom, weightKg}` (CR-055 point 1); `dispatched_at` is NOT NULL (a delivery is
  made at dispatch); `currency`, `posted_at` and `posted_by` are the DOCUMENT standard columns. Checks:
  `ck_delivery_assigned`, `ck_delivery_cod` (collected never above due, recorded exactly when DELIVERED),
  `ck_delivery_delivered`; the guard `ck_delivery_transition` (HK004: written SCHEDULED or ASSIGNED, the listed edges, the
  order, invoice, number, branch and cash due never changing, a finished delivery frozen); the deferred
  `ck_delivery_proof` (HK010: DELIVERED has its proof); `uq_delivery_order` (one live delivery per order). The slot stays
  NULL until booking (B11 continued 2).
- `del.delivery_attempt` as above, LEDGER (insert-only for every role), with `recorded_at` and `created_by`.
- `del.proof_of_delivery` as above, LEDGER, with `cod_variance_reason_code` (FK `mdm.reason_code`, a `COD_VARIANCE` reason)
  and `cod_variance_note`; `payment_id` unique. Checks: `ck_proof_evidence` (a signature or a photograph),
  `ck_proof_payment` (a payment exactly when cash was collected), `ck_proof_position`, and the guard `ck_proof_variance`
  (HK010: never above the delivery's cash due; less only with a `COD_VARIANCE` reason; a reason or note only when less).
- `del.route` and `del.route_stop` are B11 continued 3's (below).

## As built (B11 continued 2, migrations 0312 to 0314; CR-057, ADR-0092, A-345)

- `del.driver_cash_reconciliation` as above (a DOCUMENT registered as `DRIVER_CASH_RECONCILIATION`, 0312), with these
  differences: it is a hand-in at a till shift, written `POSTED` and frozen at once (`trg_driver_cash_frozen`), so
  `status` is `POSTED` only; `shift_document_id` (FK `platform.business_document`, the till shift counted into, whose
  cashier is `received_by`) and `till_payment_id` (FK `pay.payment`, unique, the cash payment onto that shift for what was
  counted; NULL exactly when nothing was) are added; `posted_at` and `posted_by` are NOT NULL; no UNIQUE (`driver_id`,
  `reconciliation_date`): a driver may hand in more than once a day, each collection still once (A-345 (c)). Checks:
  `ck_driver_cash_receiver` (never the driver, and the receiver wrote it), `ck_driver_cash_variance` (the variance and its
  direction exactly the difference), `ck_driver_cash_till_payment`, `ck_driver_cash_expected_positive`, and the deferred
  `ck_driver_cash_expected` (HK010: expected is exactly the sum of its collections).
- `del.driver_cash_handed_in` (LEDGER, insert-only): (`reconciliation_id`, `proof_id` FK `del.proof_of_delivery`,
  `amount_pesewas`), `proof_id` unique (`uq_driver_cash_handed_in_proof`: each collection handed in once, ever); the guard
  `ck_driver_cash_handed_in` (HK010: the proof's delivery was the driver's, at the reconciliation's branch, with exactly
  that cash collected).
- PAY's side (0313): the till payment names the driver in `pay.payment.received_from_driver_id` and settles nothing (see
  `docs/data-model/pay.md`).

## As built (B11 continued 3, migration 0318; FR-DEL-005, the owner's close rule of 2026-11-23, A-347)

- `del.route` as above (DOCUMENT, not registered in `platform.business_document`: a run is no business document), with
  `started_at` and `started_by` (set exactly when it has started, `ck_route_started`), `posted_at` and `posted_by` (exactly
  when `COMPLETED`, `ck_route_posted`) and the DOCUMENT standard columns; UNIQUE (`driver_id`, `route_date`) as above. The
  guard `ck_route_transition` (HK004): written `PLANNED`, moving `PLANNED` to `IN_PROGRESS` to `COMPLETED` only, its
  driver, date, vehicle and branch never changing, frozen once `COMPLETED`. The deferred `ck_route_closed` (HK010):
  `COMPLETED` only when every stop's delivery is `DELIVERED` or `RETURNED` and no proof on its stops with cash collected
  lacks a `del.driver_cash_handed_in` row.
- `del.route_stop` as above, with the DOCUMENT row columns `created_*` and `updated_*`; its primary key (`route_id`,
  `stop_no`) is checked at commit so a reorder may swap numbers; `uq_route_stop_delivery` keeps a delivery on one run. The
  guard `ck_route_stop` (HK010): written and renumbered only while its route is `PLANNED`, never moved to another route or
  delivery; the delivery `ASSIGNED`, to the route's driver, on its vehicle, at its branch. `hk_app` has no DELETE.
- `del.delivery` gains `on_the_way_at` (FR-DEL-007) and the guard `ck_delivery_route` (HK004): a delivery on a `PLANNED`
  run never moves to `OUT_FOR_DELIVERY`, `DELIVERED` or `FAILED`, and keeps its driver and vehicle while its run is live.
- `del.driver_cash_handed_in` gains `route_id` (FK `del.route`, NULL for a delivery on no run), set by the database from
  the proof's stop on insert (`trg_driver_cash_handed_in_route`), so a run's hand-ins are recorded against it (A-345 (g)).


## As built (B11 continued 4, migrations 0321 and 0322; FR-DEL-011, the owner's van rule of 2026-11-23, A-360)

- `del.delivery` `status` gains `WRITTEN_OFF`, a posted status (`ck_delivery_status`, `ck_delivery_delivered`); the guard
  `ck_delivery_transition` gains the edge `FAILED` to `WRITTEN_OFF` and freezes it. New columns, all set exactly when
  `WRITTEN_OFF` (`ck_delivery_written_off`): `written_off_reason_code` (FK `mdm.reason_code`: `UNACCOUNTED_ON_VAN`, new, or
  a `WASTAGE` reason), `written_off_value_pesewas` (the posted adjustment's value at cost), `written_off_at` and
  `write_off_document_id` (FK `platform.business_document`, INV's `STOCK_ADJUSTMENT` at the vehicle). Index
  `ix_delivery_written_off` (`branch_id`, `written_off_at`, `id`) for the driver variance report's goods line.
- `RETURNED` is reached by ORD's `returnDeliveryToStock` (the goods moved from the vehicle into the returns hold); the
  deferred `ck_route_closed` takes `DELIVERED`, `RETURNED` or `WRITTEN_OFF` as off the van.
