# Table dictionary: `inv`

Owner: INV module. The stock movement ledger, tracked stock units, balances, valuation, reservations, holds and the stock documents (ADR-0002, ADR-0018, ADR-0019). Conventions are in `docs/DATA_MODEL.md`.

## Triggers and published views

| Object | Purpose |
| --- | --- |
| `inv.apply_movement()` on `AFTER INSERT` of `inv.stock_movement` | The seven steps in ADR-0002: lock the unit, check and move a serial unit's location, check holds, update balances, enforce non-negative stock or raise an exception, protect reserved stock, apply value to the cost pool |
| `inv.apply_reservation()` on `AFTER INSERT OR UPDATE` of `inv.stock_reservation` | Maintains `stock_balance.reserved_qty` and refuses reserved above on-hand |
| `inv.pub_stock_on_hand` (view) | Product, stock unit, location, branch, on-hand, reserved, available |
| `inv.pub_stock_value` (view) | Product, stock unit, branch, quantity, value |
| `inv.pub_movement` (view) | Movements with type, product, locations, quantity, weight, value, document and time; no actor detail |

---

### `inv.movement_type` · LOOKUP

Behaviour of each kind of movement.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `code` | `text` | PK | See the seeded list below |
| `name` | `text` | NOT NULL | |
| `is_value_only` | `boolean` | NOT NULL | Quantity must be zero; adds cost to a unit |
| `allows_negative` | `boolean` | NOT NULL | May take a physical balance below zero, raising an exception |
| `blocked_by_hold` | `boolean` | NOT NULL | Rejected while the stock unit is under hold |
| `requires_reason` | `boolean` | NOT NULL | `reason_code` mandatory |
| `requires_stock_unit` | `boolean` | NOT NULL | Only tracked stock may use it |
| `posting_event` | `text` | NULL | The event published for the ledger (ADR-0003); null if none |

Seeded: `RECEIPT_PURCHASE`, `RECEIPT_HARVEST`, `BIRTH`, `OPENING_BALANCE`, `TRANSFER_INTERNAL`, `TRANSFER_DISPATCH`, `TRANSFER_RECEIPT`, `SALE_ISSUE`, `SALE_ISSUE_OFFLINE` (allows negative), `SALE_RETURN`, `PROCESS_CONSUME`, `PROCESS_OUTPUT`, `FEED_ISSUE`, `MEDICATION_ISSUE`, `COST_CAPITALISE` (value only), `MORTALITY`, `CULL`, `ADJUST_GAIN`, `ADJUST_LOSS`, `STOCKTAKE_GAIN`, `STOCKTAKE_LOSS`, `SUPPLIER_RETURN`. `SALE_ISSUE`, `SALE_ISSUE_OFFLINE`, `PROCESS_CONSUME` and `TRANSFER_DISPATCH` are blocked by hold.

### `inv.stock_unit` · MASTER

One individually tracked thing: an animal (`SERIAL`) or a lot (`LOT`). Published key. `liv.animal` and `liv.batch` share this primary key.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `product_id` | `uuid` | NOT NULL, FK `mdm.product` | |
| `tracking` | `text` | NOT NULL, CHECK in (`SERIAL`, `LOT`) | |
| `branch_id` | `uuid` | NOT NULL, FK `mdm.branch` | Where its cost pool is held |
| `identifier` | `text` | NOT NULL | Tag number for an animal, batch number for a lot |
| `current_location_id` | `uuid` | NULL, FK `mdm.location`; required for `SERIAL` | The single place a serial unit is. Written only by the movement trigger |
| `status` | `text` | NOT NULL, CHECK in (`ACTIVE`, `SOLD`, `CONSUMED`, `WRITTEN_OFF`, `DEPLETED`) | Written only by the movement trigger |
| `produced_on` | `date` | NULL | Production, slaughter or lay date for a lot |
| `expires_on` | `date` | NULL | Expiring-stock alerts; sale after this date is blocked |
| `storage_temp_class` | `text` | NULL, CHECK in (`AMBIENT`, `CHILLED`, `FROZEN`) | Cold chain requirement |
| `supplier_id` | `uuid` | NULL, FK `mdm.supplier` | Backward trace for purchased stock |
| `source_document_id` | `uuid` | NOT NULL, FK `platform.business_document` | The receipt, birth record or processing order that created it |
| `grade_id` | `uuid` | NULL, FK `mdm.grade` | Pricing input for an animal |
| `last_weight_kg` | `kg` | NULL | Latest recorded weight, for the weight band |
| `last_weighed_at` | `timestamptz` | NULL | |

Standard columns: `MASTER`. Never soft-deleted once it has a movement.

- Partial UNIQUE (`product_id`, `identifier`) where status is `ACTIVE`.
- The application role may update only `grade_id`, `last_weight_kg`, `last_weighed_at`, `expires_on`.

### `inv.stock_unit_lineage` · LEDGER

Genealogy: which unit came from which. Gives forward and backward traceability from a sold meat lot to its animal and supplier.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `child_unit_id` | `uuid` | NOT NULL, FK `inv.stock_unit` | The output |
| `parent_unit_id` | `uuid` | NOT NULL, FK `inv.stock_unit`, CHECK `<> child_unit_id` | The input |
| `link_type` | `text` | NOT NULL, CHECK in (`PROCESSING`, `SPLIT`, `REPACK`, `BIRTH`) | |
| `source_document_id` | `uuid` | NOT NULL, FK `platform.business_document` | The processing order or birth record |

Standard columns: `LEDGER`. PK (`child_unit_id`, `parent_unit_id`). Index on `parent_unit_id` for forward trace.

### `inv.stock_movement` · LEDGER

The stock ledger. Published key.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `movement_type` | `text` | NOT NULL, FK `inv.movement_type` | |
| `product_id` | `uuid` | NOT NULL, FK `mdm.product` | |
| `stock_unit_id` | `uuid` | NULL, FK `inv.stock_unit` | Null only for untracked countables |
| `branch_id` | `uuid` | NOT NULL, FK `mdm.branch` | Scope of the actor and the source location |
| `from_location_id` | `uuid` | NOT NULL, FK `mdm.location` | Source |
| `to_location_id` | `uuid` | NOT NULL, FK `mdm.location`, CHECK `<> from_location_id` | Destination |
| `qty_base` | `qty` | NOT NULL | In the product's base unit; zero only for value-only types |
| `weight_kg` | `kg` | NULL | Captured weight |
| `weight_source` | `text` | NULL, CHECK in (`SCALE`, `MANUAL`, `ESTIMATE`) | Mandatory with weight |
| `pack_count` | `integer` | NULL, CHECK `>= 0` | Packs moved, for lots sold in packs |
| `value_pesewas` | `pesewas` | NOT NULL | Cost carried (ADR-0018) |
| `cost_element` | `text` | NULL, CHECK in (`PURCHASE`, `FEED`, `VETERINARY`, `LABOUR`, `OVERHEAD`, `PROCESSING`) | Required for receipts and value-only movements |
| `reason_code` | `text` | NULL, FK `mdm.reason_code` | Required where the type says so |
| `source_document_id` | `uuid` | NOT NULL, FK `platform.business_document` | What caused it |
| `source_line_ref` | `uuid` | NULL | The line within that document |
| `reservation_id` | `uuid` | NULL, FK `inv.stock_reservation` | The reservation this movement consumes |
| `reverses_movement_id` | `uuid` | NULL, UNIQUE, FK `inv.stock_movement` | A correction; a movement is reversed at most once |
| `occurred_at` | `timestamptz` | NOT NULL | When it physically happened |

Standard columns: `LEDGER` (`recorded_at`, `actor_id`).

- CHECK: (`weight_kg` IS NULL) = (`weight_source` IS NULL).
- CHECK: `qty_base > 0 OR value_pesewas > 0` (a movement moves something).
- Trigger checks against `movement_type`: value-only implies `qty_base = 0`; `requires_reason`; `requires_stock_unit`.
- Indexes: (`product_id`, `occurred_at`); (`stock_unit_id`, `occurred_at`); (`source_document_id`); (`to_location_id`, `product_id`); (`from_location_id`, `product_id`).
- Not partitioned in version one; about two million rows in year one.

### `inv.stock_balance` · PROJECTION

On-hand per product, stock unit and location. Written only by triggers.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `product_id` | `uuid` | NOT NULL, FK `mdm.product` | |
| `stock_unit_id` | `uuid` | NULL, FK `inv.stock_unit` | |
| `location_id` | `uuid` | NOT NULL, FK `mdm.location` | |
| `branch_id` | `uuid` | NOT NULL, FK `mdm.branch` | Denormalised for scoping |
| `on_hand_qty` | `numeric(14,3)` | NOT NULL | Signed: may be negative only at a virtual location or by an allowed type |
| `on_hand_weight_kg` | `numeric(12,3)` | NOT NULL DEFAULT 0 | |
| `pack_count` | `integer` | NOT NULL DEFAULT 0 | |
| `reserved_qty` | `qty` | NOT NULL DEFAULT 0 | |
| `updated_at` | `timestamptz` | NOT NULL | |

- UNIQUE NULLS NOT DISTINCT (`product_id`, `stock_unit_id`, `location_id`). This is the primary identity of the row.
- The non-negative and reserved rules are enforced in the trigger, because they depend on the location and movement type.

### `inv.cost_pool` · PROJECTION

Value of stock: per stock unit, or per untracked product and branch. Written only by the movement trigger.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `product_id` | `uuid` | NOT NULL, FK `mdm.product` | |
| `stock_unit_id` | `uuid` | NULL, FK `inv.stock_unit` | Null for a weighted-average pool |
| `branch_id` | `uuid` | NOT NULL, FK `mdm.branch` | |
| `qty` | `numeric(14,3)` | NOT NULL | Signed for the allowed-negative case |
| `value_pesewas` | `pesewas` | NOT NULL | Never negative |
| `updated_at` | `timestamptz` | NOT NULL | |

- UNIQUE NULLS NOT DISTINCT (`product_id`, `stock_unit_id`, `branch_id`).
- CHECK: `qty <> 0 OR value_pesewas = 0`. A pool with no quantity has no value.

### `inv.stock_reservation` · DOCUMENT

Stock promised to a document (ADR-0019). Posted statuses: `CONSUMED`, `RELEASED`, `EXPIRED`. Published key.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `product_id` | `uuid` | NOT NULL, FK `mdm.product` | |
| `stock_unit_id` | `uuid` | NULL, FK `inv.stock_unit` | A particular animal or lot |
| `location_id` | `uuid` | NOT NULL, FK `mdm.location` | |
| `qty` | `qty` | NOT NULL, CHECK `> 0` | |
| `is_exclusive` | `boolean` | NOT NULL | True for a serial unit |
| `holder_document_id` | `uuid` | NOT NULL, FK `platform.business_document` | Checkout, order or quote |
| `status` | `text` | NOT NULL, CHECK in (`ACTIVE`, `CONSUMED`, `RELEASED`, `EXPIRED`) | |
| `expires_at` | `timestamptz` | NULL | Timed release |
| `released_reason` | `text` | NULL | |

Standard columns: `DOCUMENT`.

- Partial UNIQUE (`stock_unit_id`) where `status = 'ACTIVE' AND is_exclusive`: one goat cannot be promised twice.
- Index (`expires_at`) where `status = 'ACTIVE'`, for the expiry job.

### `inv.stock_hold` · DOCUMENT

A block on moving a stock unit out. Published key.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `stock_unit_id` | `uuid` | NOT NULL, FK `inv.stock_unit` | |
| `kind` | `text` | NOT NULL, CHECK in (`WITHDRAWAL`, `QUARANTINE`, `INVESTIGATION`) | |
| `starts_at` | `timestamptz` | NOT NULL | |
| `ends_at` | `timestamptz` | NULL, CHECK `> starts_at` | Null is open-ended |
| `source_document_id` | `uuid` | NOT NULL, FK `platform.business_document` | The treatment or excursion that caused it |
| `released_at` | `timestamptz` | NULL | Early release |
| `released_by` | `uuid` | NULL, FK `iam.principal` | |
| `release_reason_code` | `text` | NULL, FK `mdm.reason_code` | |
| `created_at` | `timestamptz` | NOT NULL DEFAULT `now()` | |
| `created_by` | `uuid` | NOT NULL, FK `iam.principal` | |

- Only the three release columns may ever be updated, once. A `WITHDRAWAL` hold cannot be released early.
- Index (`stock_unit_id`) where `released_at IS NULL`.

### `inv.stock_exception` · DOCUMENT

A stock fact that needs a person: negative stock, an offline conflict, a temperature excursion, balance drift. Published key.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | `gen_random_uuid()` when raised by a trigger |
| `kind` | `text` | NOT NULL, CHECK in (`NEGATIVE_STOCK`, `SERIAL_CONFLICT`, `HOLD_CONFLICT`, `RESERVATION_CONFLICT`, `TEMPERATURE_EXCURSION`, `BALANCE_DRIFT`, `TRANSFER_VARIANCE`) | |
| `branch_id` | `uuid` | NOT NULL, FK `mdm.branch` | |
| `product_id` | `uuid` | NOT NULL, FK `mdm.product` | |
| `stock_unit_id` | `uuid` | NULL, FK `inv.stock_unit` | |
| `location_id` | `uuid` | NULL, FK `mdm.location` | |
| `movement_id` | `uuid` | NULL, FK `inv.stock_movement` | The movement that raised it, if one was posted |
| `source_document_id` | `uuid` | NULL, FK `platform.business_document` | The sale or document involved |
| `qty` | `numeric(14,3)` | NULL | Size of the problem |
| `details` | `jsonb` | NOT NULL | The two conflicting facts |
| `raised_at` | `timestamptz` | NOT NULL DEFAULT `now()` | |
| `status` | `text` | NOT NULL DEFAULT `'OPEN'`, CHECK in (`OPEN`, `RESOLVED`) | |
| `resolved_at` | `timestamptz` | NULL | |
| `resolved_by` | `uuid` | NULL, FK `iam.principal` | |
| `resolution_document_id` | `uuid` | NULL, FK `platform.business_document` | The adjustment that settled it |
| `resolution_note` | `text` | NULL | |

- Only the resolution columns and `status` may be updated, once.

### `inv.goods_receipt` · DOCUMENT

Stock received from a supplier, or from harvest or lay. Posted status: `POSTED`. Published key.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK, FK `platform.business_document` | |
| `receipt_no` | `text` | NULL, UNIQUE | Allocated on posting |
| `kind` | `text` | NOT NULL, CHECK in (`PURCHASE`, `HARVEST`, `OPENING`) | |
| `supplier_id` | `uuid` | NULL, FK `mdm.supplier`; required for `PURCHASE` | |
| `location_id` | `uuid` | NOT NULL, FK `mdm.location` | Where the stock lands |
| `order_document_id` | `uuid` | NULL, FK `platform.business_document` | The purchase order |
| `delivery_note_ref` | `text` | NULL | Supplier's delivery note |
| `received_at` | `timestamptz` | NOT NULL | |
| `notes` | `text` | NULL | |

Standard columns: `DOCUMENT` (`status` in `DRAFT`, `POSTED`, `CANCELLED`).

### `inv.goods_receipt_line` · DOCUMENT

Frozen with its header. Published key (three-way match).

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `goods_receipt_id` | `uuid` | NOT NULL, FK `inv.goods_receipt` | |
| `line_no` | `integer` | NOT NULL | |
| `product_id` | `uuid` | NOT NULL, FK `mdm.product` | |
| `order_line_ref` | `uuid` | NULL | The purchase order line |
| `qty_received` | `qty` | NOT NULL, CHECK `> 0` | |
| `qty_rejected` | `qty` | NOT NULL DEFAULT 0 | Supplier quality score |
| `weight_kg` | `kg` | NULL | |
| `weight_source` | `text` | NULL | |
| `value_pesewas` | `pesewas` | NOT NULL | Cost of the accepted quantity |
| `stock_unit_id` | `uuid` | NULL, FK `inv.stock_unit` | The lot created or the animal registered |
| `batch_no` | `text` | NULL | Supplier batch |
| `expires_on` | `date` | NULL | |

- UNIQUE (`goods_receipt_id`, `line_no`).

### `inv.stock_transfer` · DOCUMENT

Movement between locations with an in-transit stage. Posted statuses: `RECEIVED`, `CANCELLED`.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK, FK `platform.business_document` | |
| `transfer_no` | `text` | NULL, UNIQUE | |
| `from_location_id` | `uuid` | NOT NULL, FK `mdm.location` | |
| `to_location_id` | `uuid` | NOT NULL, FK `mdm.location`, CHECK `<> from_location_id` | |
| `to_branch_id` | `uuid` | NOT NULL, FK `mdm.branch` | Differs from `branch_id` for an inter-branch transfer |
| `dispatched_at` | `timestamptz` | NULL | |
| `dispatched_by` | `uuid` | NULL, FK `iam.principal` | |
| `received_at` | `timestamptz` | NULL | Receipt confirmation at destination |
| `received_by` | `uuid` | NULL, FK `iam.principal` | |

Standard columns: `DOCUMENT` (`status` in `DRAFT`, `DISPATCHED`, `RECEIVED`, `CANCELLED`).

### `inv.stock_transfer_line` · DOCUMENT

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `stock_transfer_id` | `uuid` | NOT NULL, FK `inv.stock_transfer` | |
| `line_no` | `integer` | NOT NULL | |
| `product_id` | `uuid` | NOT NULL, FK `mdm.product` | |
| `stock_unit_id` | `uuid` | NULL, FK `inv.stock_unit` | |
| `qty_dispatched` | `qty` | NOT NULL, CHECK `> 0` | |
| `qty_received` | `qty` | NULL | |
| `variance_qty` | `qty` | NULL | Shortfall on receipt, posted as a loss with a reason |
| `variance_reason_code` | `text` | NULL, FK `mdm.reason_code` | |

- UNIQUE (`stock_transfer_id`, `line_no`). CHECK when received: `qty_received + variance_qty = qty_dispatched`.

### `inv.stock_adjustment` · DOCUMENT

A manual gain or loss. Posted statuses: `POSTED`, `REJECTED`.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK, FK `platform.business_document` | |
| `adjustment_no` | `text` | NULL, UNIQUE | |
| `location_id` | `uuid` | NOT NULL, FK `mdm.location` | |
| `reason_code` | `text` | NOT NULL, FK `mdm.reason_code` | Mandatory, from the fixed list |
| `note` | `text` | NULL | |
| `total_value_pesewas` | `pesewas` | NOT NULL DEFAULT 0 | Compared with the approval threshold |
| `approval_request_id` | `uuid` | NULL, FK `iam.approval_request` | Required above the threshold |
| `exception_id` | `uuid` | NULL, FK `inv.stock_exception` | The exception this resolves |

Standard columns: `DOCUMENT` (`status` in `DRAFT`, `PENDING_APPROVAL`, `POSTED`, `REJECTED`).

- CHECK: status `POSTED` with `total_value_pesewas` at or above the policy threshold requires `approval_request_id`. The threshold comparison is done by the posting function, which reads `iam.approval_policy`.

### `inv.stock_adjustment_line` · DOCUMENT

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `stock_adjustment_id` | `uuid` | NOT NULL, FK `inv.stock_adjustment` | |
| `line_no` | `integer` | NOT NULL | |
| `product_id` | `uuid` | NOT NULL, FK `mdm.product` | |
| `stock_unit_id` | `uuid` | NULL, FK `inv.stock_unit` | |
| `direction` | `text` | NOT NULL, CHECK in (`GAIN`, `LOSS`) | |
| `qty` | `qty` | NOT NULL, CHECK `> 0` | |
| `weight_kg` | `kg` | NULL | |
| `value_pesewas` | `pesewas` | NOT NULL | |
| `movement_id` | `uuid` | NULL, FK `inv.stock_movement` | Set on posting |

- UNIQUE (`stock_adjustment_id`, `line_no`).

### `inv.stock_take` · DOCUMENT

A cycle count or full stock take. Posted statuses: `POSTED`, `CANCELLED`.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK, FK `platform.business_document` | |
| `stock_take_no` | `text` | NULL, UNIQUE | |
| `location_id` | `uuid` | NOT NULL, FK `mdm.location` | Scope of the count |
| `scope` | `text` | NOT NULL, CHECK in (`FULL`, `CYCLE`) | |
| `snapshot_at` | `timestamptz` | NULL | When expected quantities were frozen |
| `counted_by` | `uuid` | NULL, FK `iam.principal` | |
| `variance_value_pesewas` | `pesewas` | NULL | Absolute value of variances, for the threshold |
| `approval_request_id` | `uuid` | NULL, FK `iam.approval_request` | Required above the threshold |

Standard columns: `DOCUMENT` (`status` in `DRAFT`, `COUNTING`, `REVIEW`, `PENDING_APPROVAL`, `POSTED`, `CANCELLED`).

### `inv.stock_take_line` · DOCUMENT

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `stock_take_id` | `uuid` | NOT NULL, FK `inv.stock_take` | |
| `product_id` | `uuid` | NOT NULL, FK `mdm.product` | |
| `stock_unit_id` | `uuid` | NULL, FK `inv.stock_unit` | |
| `expected_qty` | `numeric(14,3)` | NOT NULL | From the balance at snapshot |
| `counted_qty` | `qty` | NULL | Entered blind: the counter does not see expected |
| `recount_qty` | `qty` | NULL | Second count where the first disagreed |
| `counted_weight_kg` | `kg` | NULL | |
| `variance_qty` | `numeric(14,3)` | NULL | Final count minus expected; signed |
| `variance_value_pesewas` | `pesewas` | NULL | |
| `movement_id` | `uuid` | NULL, FK `inv.stock_movement` | The gain or loss posted |

- UNIQUE NULLS NOT DISTINCT (`stock_take_id`, `product_id`, `stock_unit_id`).

### `inv.reorder_rule` · MASTER

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `product_id` | `uuid` | NOT NULL, FK `mdm.product` | |
| `branch_id` | `uuid` | NOT NULL, FK `mdm.branch` | |
| `location_id` | `uuid` | NULL, FK `mdm.location` | Null for the whole branch |
| `min_qty` | `qty` | NOT NULL | Minimum level |
| `reorder_point_qty` | `qty` | NOT NULL, CHECK `>= min_qty` | Low-stock alert fires here |
| `max_qty` | `qty` | NOT NULL, CHECK `>= reorder_point_qty` | Maximum level |
| `expiry_alert_days` | `integer` | NULL, CHECK `> 0` | Days before expiry to alert |

Standard columns: `MASTER`. UNIQUE NULLS NOT DISTINCT (`product_id`, `branch_id`, `location_id`) among live rows.

### `inv.temperature_reading` · LEDGER

Cold chain log. A reading outside the location's range quarantines its lots.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `location_id` | `uuid` | NOT NULL, FK `mdm.location` | Cold room or vehicle |
| `reading_c` | `numeric(4,1)` | NOT NULL | Degrees Celsius |
| `measured_at` | `timestamptz` | NOT NULL | |
| `source` | `text` | NOT NULL, CHECK in (`MANUAL`, `SENSOR`) | |
| `is_excursion` | `boolean` | NOT NULL | Outside the location's range |
| `exception_id` | `uuid` | NULL, FK `inv.stock_exception` | Raised for an excursion |

Standard columns: `LEDGER`.

### `inv.stock_balance_snapshot` · LEDGER

Month-end balances, for as-of reporting and five-year history.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `as_of_date` | `date` | NOT NULL | |
| `product_id` | `uuid` | NOT NULL, FK `mdm.product` | |
| `stock_unit_id` | `uuid` | NULL, FK `inv.stock_unit` | |
| `location_id` | `uuid` | NOT NULL, FK `mdm.location` | |
| `on_hand_qty` | `numeric(14,3)` | NOT NULL | |
| `on_hand_weight_kg` | `numeric(12,3)` | NOT NULL | |
| `value_pesewas` | `pesewas` | NOT NULL | Share of the pool value at that date |
| `recorded_at` | `timestamptz` | NOT NULL DEFAULT `now()` | |

- UNIQUE NULLS NOT DISTINCT (`as_of_date`, `product_id`, `stock_unit_id`, `location_id`). Written by the scheduled job's system principal.
