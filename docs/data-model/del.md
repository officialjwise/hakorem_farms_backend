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
