# Table dictionary: `inv`

Owner: INV module. The stock movement ledger, tracked stock units, balances, valuation, reservations, holds and the stock documents (ADR-0002, ADR-0018, ADR-0019). Conventions are in `docs/DATA_MODEL.md`.

## Triggers and published views

| Object | Purpose |
| --- | --- |
| `inv.apply_movement()` on `AFTER INSERT` of `inv.stock_movement` | The seven steps in ADR-0002: lock the unit, check and move a serial unit's location, check holds, update balances, enforce non-negative stock or raise an exception, protect reserved stock, apply value to the cost pool |
| `inv.apply_reservation()` on `AFTER INSERT OR UPDATE` of `inv.stock_reservation` | Maintains `stock_balance.reserved_qty` and refuses reserved above on-hand |
| `inv.pub_stock_on_hand` (view) | Product, stock unit, location, branch, on-hand, reserved, available (nothing of a unit under a hold in force at `platform.app_now()`, the application clock's instant, 0186, ADR-0067) |
| `inv.pub_stock_value` (view) | Product, stock unit, branch, quantity, value |
| `inv.pub_movement` (view) | Movements with type, product, locations, quantity, weight, value, document and time; no actor detail |
| `inv.protect_expired()` on `BEFORE INSERT` of `inv.stock_movement` | A movement type `blocked_when_expired` (sale, offline sale) of a lot whose `expires_on` is before the movement's Africa/Accra date is refused (HK010 `ck_stock_expired`, migration 0064, A-134 (j)) |
| `inv.pub_reorder_level` (view) | Each live reorder rule with on hand, reserved, held and available stock over the branch's physical stock locations (or the rule's one location; in transit and sites left out), and `at_or_below_reorder_point` and `below_minimum`; a hold is in force at `platform.app_now()` (0186, ADR-0067). Read by RPT's low stock tile (B05x, ADR-0011) and by `StockAlerts` |
| `inv.line_uom_guard()` on `BEFORE INSERT OR UPDATE` of `inv.goods_receipt_line` and `inv.stock_transfer_line` | A line entered in another unit (a crate) carries base quantities that are exactly its entered quantities converted by the product's live conversion, asked of MDM's published `mdm.uom_to_base` (HK010 `ck_line_uom_conversion`, migration 0217, B09e continued) |
| `inv.require_received_date()` on `BEFORE INSERT` of `inv.stock_movement` | A `RECEIPT_PURCHASE` of a stock unit, other than a reversal, needs the unit's `received_at` (HK010 `ck_stock_unit_received`, migration 0218) |
| `inv.reorder_rule_uom_guard()` on `BEFORE INSERT OR UPDATE` of `inv.reorder_rule` | A rule counted in a selling unit stores levels that are exactly its entered levels converted by the live conversion, and its unit never changes (HK010 `ck_reorder_rule_uom_conversion`, migration 0219) |
| `inv.pub_goods_receipt` (view) | Each goods receipt's kind, status, branch, location, supplier, `received_at`, `posted_at`, value at cost (the sum of its lines) and line count. Read by RPT's purchases tile (B05x, migration 0068) |

---

### `inv.movement_type` · LOOKUP

Behaviour of each kind of movement.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `code` | `text` | PK | See the seeded list below |
| `name` | `text` | NOT NULL | |
| `is_value_only` | `boolean` | NOT NULL | Quantity must be zero; adds cost to a unit |
| `allows_negative` | `boolean` | NOT NULL | May take a physical balance below zero, raising an exception |
| `negative_anywhere` | `boolean` | NOT NULL DEFAULT false, `ck_movement_type_negative_anywhere` (only with `allows_negative`) | At any physical location, not only one that allows negative: `SALE_ISSUE_OFFLINE` and `NEGATIVE_TRUE_UP` only (migration 0286, ADR-0081) |
| `blocked_by_hold` | `boolean` | NOT NULL | Rejected while the stock unit is under hold |
| `requires_reason` | `boolean` | NOT NULL | `reason_code` mandatory |
| `requires_stock_unit` | `boolean` | NOT NULL | Only tracked stock may use it |
| `blocked_when_expired` | `boolean` | NOT NULL DEFAULT false | Refused for a lot past its expiry date; `SALE_ISSUE` and `SALE_ISSUE_OFFLINE` (migration 0064, FR-INV-016) |
| `posting_event` | `text` | NULL | The event published for the ledger (ADR-0003); null if none |

Seeded: `RECEIPT_PURCHASE`, `RECEIPT_HARVEST`, `BIRTH`, `OPENING_BALANCE`, `TRANSFER_INTERNAL`, `TRANSFER_DISPATCH`, `TRANSFER_RECEIPT`, `SALE_ISSUE`, `SALE_ISSUE_OFFLINE` (allows negative), `SALE_RETURN`, `PROCESS_CONSUME`, `PROCESS_OUTPUT`, `FEED_ISSUE`, `MEDICATION_ISSUE`, `COST_CAPITALISE` (value only), `MORTALITY`, `CULL`, `ADJUST_GAIN`, `ADJUST_LOSS`, `STOCKTAKE_GAIN`, `STOCKTAKE_LOSS`, `SUPPLIER_RETURN`. `SALE_ISSUE`, `SALE_ISSUE_OFFLINE`, `PROCESS_CONSUME` and `TRANSFER_DISPATCH` are blocked by hold. Migration 0286 adds `NEGATIVE_TRUE_UP_IN` (the nil lift before an arrival into a pool owing stock sold ahead of receipt) and `NEGATIVE_TRUE_UP` (its pool-valued issue after the arrival), made only by `Stock.postIn`'s true-up and named by their settlement (ADR-0081).

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
| `received_at` | `timestamptz` | NULL; set once by the goods receipt that registers the unit | When its delivery arrived: oldest first orders by expiry, then by this (B09e continued, migration 0218, A-265). Null for a processing output or an animal born on the farm |
| `storage_temp_class` | `text` | NULL, CHECK in (`AMBIENT`, `CHILLED`, `FROZEN`) | Cold chain requirement |
| `supplier_id` | `uuid` | NULL, FK `mdm.supplier` | Backward trace for purchased stock |
| `source_document_id` | `uuid` | NOT NULL, FK `platform.business_document` | The receipt, birth record or processing order that created it |
| `grade_id` | `uuid` | NULL, FK `mdm.grade` | Pricing input for an animal |
| `last_weight_kg` | `kg` | NULL | Latest recorded weight, for the weight band |
| `last_weighed_at` | `timestamptz` | NULL | |

Standard columns: `MASTER`. Never soft-deleted once it has a movement.

- Partial UNIQUE (`product_id`, `identifier`) where status is `ACTIVE`.
- The application role may update only `grade_id`, `last_weight_kg`, `last_weighed_at`, `expires_on`.
- `ix_stock_unit_received` (`product_id`, `expires_on`, `received_at`, `id`) over live ACTIVE units: the order a pick reads (0218). A `RECEIPT_PURCHASE` of a unit with no `received_at` is refused (`ck_stock_unit_received`).
- Sort indexes (migration 0121, CR-019, ADR-0054), over live rows: `ix_stock_unit_sort_identifier` (`branch_id`, `lower(identifier)`, `id`); `ix_stock_unit_sort_expiry` and `ix_stock_unit_sort_expiry_desc` (`branch_id`, `expires_on IS NULL`, `COALESCE(expires_on, 'epoch')` and `id` ascending, and descending), so a unit with no expiry comes last both ways.

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
| `returns_movement_id` | `uuid` | NULL, FK `inv.stock_movement` (B09a continued 2d, migration 0199) | The sale issue a `SALE_RETURN` takes back. Required on every `SALE_RETURN` that is not a reversal; from where the issue went, same product, unit and branch, never beyond what the issue issued less its returns not reversed, under the issue's row lock (`ck_stock_sale_return`). The trigger sets its value to `half_up(V x (p+q)/Q) - half_up(V x p/Q)` and its cost element to the issue's (ADR-0068) |
| `occurred_at` | `timestamptz` | NOT NULL | When it physically happened |

Standard columns: `LEDGER` (`recorded_at`, `actor_id`).

- CHECK: (`weight_kg` IS NULL) = (`weight_source` IS NULL).
- CHECK: `qty_base > 0 OR value_pesewas > 0` (a movement moves something).
- Trigger checks against `movement_type`: value-only implies `qty_base = 0`; `requires_reason`; `requires_stock_unit`.
- Indexes: (`product_id`, `occurred_at`); (`stock_unit_id`, `occurred_at`); (`source_document_id`); (`to_location_id`, `product_id`); (`from_location_id`, `product_id`).
- Sort indexes (migration 0121, CR-019, ADR-0054): `ix_stock_movement_sort_occurred` (`branch_id`, `occurred_at`, `id`), `ix_stock_movement_sort_value` (`branch_id`, `value_pesewas`, `id`).
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
- Sort index (migration 0121, CR-019, ADR-0054): `ix_stock_balance_sort_on_hand` (`branch_id`, `on_hand_qty`, the line's key `location_id|product_id|stock_unit_id` as text `COLLATE "C"`). The key is the tie-breaker, and the order `listStockOnHand` answers in without a sort.

### `inv.cost_pool` · PROJECTION

Value of stock: per stock unit, or per untracked product and branch. Written only by the movement trigger.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `product_id` | `uuid` | NOT NULL, FK `mdm.product` | |
| `stock_unit_id` | `uuid` | NULL, FK `inv.stock_unit` | Null for a weighted-average pool |
| `branch_id` | `uuid` | NOT NULL, FK `mdm.branch` | |
| `qty` | `numeric(14,3)` | NOT NULL | Signed for the allowed-negative case |
| `value_pesewas` | `pesewas` | NOT NULL | Never negative |
| `anchor_qty` | `numeric(14,3)` | NULL; with `anchor_value_pesewas` (`ck_cost_pool_anchor`) | A bought lot's delivery quantity Q0 (B09e, ADR-0075, migration 0214); null for every other pool |
| `anchor_value_pesewas` | `bigint` | NULL, `>= 0` | The delivery's value V0 |
| `updated_at` | `timestamptz` | NOT NULL | |

- UNIQUE NULLS NOT DISTINCT (`product_id`, `stock_unit_id`, `branch_id`).
- CHECK: `qty <> 0 OR value_pesewas = 0`. A pool with no quantity has no value.
- A bought lot (ADR-0075): `trg_stock_movement_pool_anchor` sets the anchor to what the pool holds after a `RECEIPT_PURCHASE` of a lot (not a reversal). `trg_stock_movement_delivery_cost` values an issue of `q` from a physical location, with `p = anchor_qty - qty`, at `half_up(V0 x (p + q) / Q0) - half_up(V0 x p / Q0)`, so a whole crate always carries its price and the delivery sums exactly. A pool off its delivery's schedule (after a value-only addition, a gain, a return or an earlier reversal) is anchored again at what it holds, at the next issue. Every other pool keeps ADR-0018's `half_up(V x q / Q)`.

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
- `inv.check_reservation_place` (BEFORE INSERT, migration 0060): only at a physical location other than in-transit (HK010 `ck_stock_reservation_place`), never of a unit under a hold in force at `platform.app_now()` (`ck_stock_reservation_held`; 0186, ADR-0067). `released_reason` takes up to 500 characters. Ended by `Reservations` and the `reservation-expiry` job (A-144).

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
| `release_reason_code` | `text` | NULL, FK `mdm.reason_code` | From the `HOLD_RELEASE` list |
| `note` | `text` | NULL | Why a person placed it (migration 0057, A-142) |
| `release_note` | `text` | NULL; required with `released_at` (`ck_stock_hold_release_noted`) | What the release found (migration 0057, A-142) |
| `created_at` | `timestamptz` | NOT NULL DEFAULT `now()` | |
| `created_by` | `uuid` | NOT NULL, FK `iam.principal` | |

- Only the four release columns may ever be updated, once. A `WITHDRAWAL` hold cannot be released early. The person who releases a hold is not the one who placed it (`ck_stock_hold_releaser`, B05 continued 3).
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
| `resolution_kind` | `text` | NULL, CHECK in (`WRITE_OFF`, `FOUND`, `ADJUSTED`, `NO_CORRECTION`); set exactly when resolved | How it was settled (migration 0060, A-144) |

- Only the resolution columns and `status` may be updated, once.
- **A held transfer variance** (ADR-0048, migration 0060): a `TRANSFER_VARIANCE` with no `movement_id` holds its quantity in the in-transit location until resolved, only as `WRITE_OFF` (its adjustment) or `FOUND` (its transfer) with the resolution document (`ck_stock_exception_held_resolution`). The movement trigger `inv.protect_in_transit` refuses a movement that would take an in-transit balance below what open variances hold (HK010 `ck_stock_held`) and any movement type blocked by hold leaving in-transit (`ck_stock_in_transit`); a resolution marks its exception resolved before it posts. Index `ix_stock_exception_held`.

### `inv.negative_stock_cost` · LEDGER

B09b continued 3c (migration 0286, ADR-0081, A-283): what an offline sale's `SALE_ISSUE_OFFLINE` issued beyond what the branch's cost pool held, valued at the last known cost. Written only by `trg_stock_movement_negative_cost` (AFTER INSERT, after `trg_stock_movement_apply`), never by hand (`ck_negative_stock_cost`, `pg_trigger_depth`). Insert-only (`platform.reject_change`).

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK, `gen_random_uuid()` | Trigger-created |
| `movement_id` | `uuid` | NOT NULL, UNIQUE, FK `inv.stock_movement` | The offline sale's issue |
| `product_id`, `stock_unit_id`, `branch_id`, `location_id` | `uuid` | the pool and the place | |
| `uncovered_qty` | `qty` | NOT NULL, `> 0` | The quantity the pool did not hold |
| `cost_known` | `boolean` | NOT NULL | False when no cost was ever known: valued at nil, raised URGENT |
| `basis_movement_id`, `basis_qty`, `basis_value_pesewas` | | all null exactly when `cost_known` is false (`ck_negative_stock_cost_basis`) | The pool's average when it covered part, else the latest earlier uncovered row's basis or valued movement not itself short |
| `value_pesewas` | `pesewas` | NOT NULL, `ck_negative_stock_cost_value`: half-up of basis value x uncovered / basis quantity, once | Posted by ◆ `inv.NegativeStockCosted` (Dr cost of sales, Cr 1335) |
| `recorded_at`, `actor_id` | | the movement's | |

### `inv.negative_stock_settlement` · LEDGER

B09b continued 3c (migration 0286): what a true-up on arrival settled of each uncovered row. Written by `inv.settle_negative_stock(lift, arrival, true_up, actor)`, oldest row first. The arrival's quantity settles up to what is still uncovered, the true-up's value is split by cumulative half-up on quantity, and each row's last known value is cleared by cumulative half-up on its own uncovered quantity. Insert-only.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `cost_id` | `uuid` | NOT NULL, FK `inv.negative_stock_cost`; UNIQUE with `true_up_movement_id` | |
| `lift_movement_id`, `arrival_movement_id`, `true_up_movement_id` | `uuid` | NOT NULL, FK `inv.stock_movement` | The `NEGATIVE_TRUE_UP_IN`, the arrival, the `NEGATIVE_TRUE_UP` |
| `qty` | `qty` | NOT NULL, `> 0`; the sum per cost row never above `uncovered_qty` (`ck_negative_stock_settled`) | |
| `cleared_value_pesewas` | `pesewas` | NOT NULL, cumulative half-up (`ck_negative_true_up`) | Leaves 1335 |
| `true_up_value_pesewas` | `pesewas` | NOT NULL; the sum per true-up equals its movement's value | Leaves inventory |
| `recorded_at`, `actor_id` | | | |

- `trg_stock_movement_true_up_named` (DEFERRABLE INITIALLY DEFERRED): a `NEGATIVE_TRUE_UP_IN` or `NEGATIVE_TRUE_UP` movement commits only when named by its settlement rows, with the lift and the issue equal and the lift at nil (`ck_negative_true_up`).

### `inv.count_task` · WORK

B09b continued 3c (migration 0286, A-283 (f)): a count of a product (and unit) at a location, raised by `trg_stock_exception_count_task` with the `NEGATIVE_STOCK` of an offline sale (its movement a `SALE_ISSUE_OFFLINE`, or none). Columns: `id`, `branch_id`, `location_id`, `product_id`, `stock_unit_id`, `stock_exception_id` (the first exception), `status` (`OPEN`, `DONE`), `raised_at` (the exception's), `done_at`, `done_by` (`ck_count_task_done`). One open per product, unit and location (`uq_count_task_open`, NULLS NOT DISTINCT). No read or close operation yet (BL-104).

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
| `cancel_reason` | `text` | NULL; set exactly when `CANCELLED` | Why a draft was set aside (A-136) |

Standard columns: `DOCUMENT` (`status` in `DRAFT`, `POSTED`, `CANCELLED`), with `posted_at` and `posted_by` set exactly when `POSTED`. Built in migration 0047: `POSTED` and `CANCELLED` are final and frozen (`platform.freeze_posted`, HK004); a purchase names its supplier and nothing else does (`ck_goods_receipt_supplier`). A receipt of kind `OPENING` is written only by the `OPENING_STOCK` import sheet (one per location, posted in the import's transaction as `OPENING_BALANCE` movements from the branch's OPENING location); `createGoodsReceipt` refuses the kind (A-136, A-147, ADR-0050).

### `inv.goods_receipt_line` · DOCUMENT

Frozen with its header. Published key (three-way match).

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `goods_receipt_id` | `uuid` | NOT NULL, FK `inv.goods_receipt` | |
| `line_no` | `integer` | NOT NULL | |
| `product_id` | `uuid` | NOT NULL, FK `mdm.product` | |
| `order_line_ref` | `uuid` | NULL | The purchase order line |
| `qty_received` | `qty` | NOT NULL, CHECK `> 0` | In the product's base unit: what the receipt movement brings in |
| `qty_rejected` | `qty` | NOT NULL DEFAULT 0 | Supplier quality score; in the base unit |
| `uom` | `text` | NULL, FK `mdm.uom` | The unit the line was entered in when it is not the base unit (a crate, B09e continued, migration 0217); null for the base unit |
| `qty_received_uom`, `qty_rejected_uom` | `qty` | NULL; set exactly with `uom` (`ck_goods_receipt_line_uom`) | The quantities as entered, in `uom`; the base quantities are exactly these converted (`ck_line_uom_conversion`) |
| `rejection_reason_code` | `text` | NULL, FK `mdm.reason_code`; set exactly when `qty_rejected > 0` (`ck_goods_receipt_line_rejection`) | Why the rejected quantity was turned away, a `GOODS_RECEIPT_REJECTION` reason (the domain is the handler's rule; B09e continued 2, migration 0221, A-269) |
| `rejection_note` | `text` | NULL; 1 to 500 characters, only beside a reason (`ck_goods_receipt_line_rejection_note`) | Required by the handler when the reason has `requires_note` |
| `weight_kg` | `kg` | NULL | |
| `weight_source` | `text` | NULL | |
| `value_pesewas` | `pesewas` | NOT NULL | Cost of the accepted quantity: as typed, or, for a line naming its order line with no value typed, PUR's value at the order price for the accepted base quantity through the `OrderLineValuation` port, rounded half-up once (B09u, CR-040, ADR-0086, A-302) |
| `stock_unit_id` | `uuid` | NULL, FK `inv.stock_unit` | The lot created or the animal registered |
| `batch_no` | `text` | NULL | Supplier batch |
| `expires_on` | `date` | NULL | |

- UNIQUE (`goods_receipt_id`, `line_no`). Lines change only while their receipt is a `DRAFT` (`inv.goods_receipt_part_guard`, HK004); a draft's lines are replaced through `inv.clear_draft_goods_receipt_lines`, a `SECURITY DEFINER` function, because `hk_app` holds no DELETE on a DOCUMENT table.

### `inv.goods_receipt_animal` · DOCUMENT

One animal of a serialised receipt line: its tag and what the livestock register takes from the arrival (B6). Added in B05 continued (A-136); frozen with its receipt.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `goods_receipt_line_id` | `uuid` | NOT NULL, FK `inv.goods_receipt_line` | |
| `seq_no` | `integer` | NOT NULL, CHECK `> 0` | Order on the line; the value split follows it |
| `tag_no` | `text` | NOT NULL | Becomes the stock unit's identifier |
| `sex` | `text` | NOT NULL, CHECK in (`MALE`, `FEMALE`, `UNKNOWN`) | |
| `breed` | `text` | NULL | |
| `weight_kg` | `kg` | NULL, with `weight_source` | Arrival weight; the unit's `last_weight_kg` |
| `weight_source` | `text` | NULL, CHECK in (`SCALE`, `MANUAL`, `ESTIMATE`) | |
| `date_of_birth` | `date` | NULL | |
| `purpose` | `text` | NOT NULL, CHECK in (`GROWING`, `BREEDING`) | Capitalised or expensed upkeep (ADR-0018) |
| `stock_unit_id` | `uuid` | NULL, FK `inv.stock_unit` | Set on posting |

- UNIQUE (`goods_receipt_line_id`, `seq_no`); UNIQUE (`goods_receipt_line_id`, `tag_no`).

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
| `in_transit_location_id` | `uuid` | NULL, FK `mdm.location`; set with `dispatched_at` | The source branch's in-transit location the stock waits in (B05 continued 2, A-139) |
| `cancel_reason` | `text` | NULL; set exactly when `CANCELLED` | Why a draft was set aside (A-139) |

Standard columns: `DOCUMENT` (`status` in `DRAFT`, `DISPATCHED`, `RECEIVED`, `CANCELLED`). Built in migration 0051: a transfer starts `DRAFT` and moves only `DRAFT` to `DISPATCHED` or `CANCELLED`, then `DISPATCHED` to `RECEIVED` (`inv.document_status_guard`, HK004); `RECEIVED` and `CANCELLED` are frozen, and a `DISPATCHED` transfer changes only to be received.

### `inv.stock_transfer_line` · DOCUMENT

What a transfer carries, dispatched and received.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `stock_transfer_id` | `uuid` | NOT NULL, FK `inv.stock_transfer` | |
| `line_no` | `integer` | NOT NULL | |
| `product_id` | `uuid` | NOT NULL, FK `mdm.product` | |
| `stock_unit_id` | `uuid` | NULL, FK `inv.stock_unit` | |
| `qty_dispatched` | `qty` | NOT NULL, CHECK `> 0` | In the product's base unit, as `qty_received` and `variance_qty` are |
| `uom`, `qty_dispatched_uom` | `text`, `qty` | NULL, set together (`ck_stock_transfer_line_uom`); `uom` FK `mdm.uom` | The unit the line was entered in when it is not the base unit, and the quantity as entered (B09e continued, migration 0217, `ck_line_uom_conversion`) |
| `qty_received` | `qty` | NULL | |
| `variance_qty` | `qty` | NULL | Shortfall on receipt, with a reason; held in transit by its exception from migration 0060 (ADR-0048), posted as a loss before it |
| `variance_reason_code` | `text` | NULL, FK `mdm.reason_code` | |
| `dispatch_movement_id`, `receipt_movement_id`, `variance_movement_id` | `uuid` | NULL, FK `inv.stock_movement` | The movements the line caused (B05 continued 2) |

- UNIQUE (`stock_transfer_id`, `line_no`). CHECK when received: `qty_received + variance_qty = qty_dispatched`; a variance above zero has its reason, and a variance movement only with a variance (from migration 0060 a variance has none: it is held). Lines are written while the transfer is a `DRAFT`; once dispatched only the receipt columns may be filled, once, from null (`inv.stock_document_part_guard`, HK004).

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
| `approval_threshold_pesewas` | `pesewas` | NULL; set when judged | The `STOCK_WRITE_OFF` threshold it was judged against, read through IAM's `Approvals.judgeIn` (A-139) |
| `approval_request_id` | `uuid` | NULL, FK `iam.approval_request` | Required above the threshold |
| `exception_id` | `uuid` | NULL, FK `inv.stock_exception` | The exception this resolves |

Standard columns: `DOCUMENT` (`status` in `DRAFT`, `PENDING_APPROVAL`, `POSTED`, `REJECTED`).

- CHECK `ck_stock_adjustment_approved`: status `POSTED` with `total_value_pesewas` at or above `approval_threshold_pesewas` requires `approval_request_id`. The threshold is copied onto the row when the adjustment is submitted, so the check reads no other schema's table (A-139; the earlier wording, a posting function reading `iam.approval_policy`, would have widened ADR-0047). Statuses move `DRAFT` to `PENDING_APPROVAL` or `POSTED`, and `PENDING_APPROVAL` to `POSTED` or `REJECTED`; `POSTED` and `REJECTED` are frozen, a pending adjustment changes only to be decided.

### `inv.stock_adjustment_line` · DOCUMENT

One gain or loss within an adjustment.

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
| `weight_source` | `text` | NULL, with `weight_kg`; CHECK in (`SCALE`, `MANUAL`, `ESTIMATE`) | `MANUAL` for a typed weight (A-139) |
| `value_pesewas` | `pesewas` | NOT NULL | From the cost pool: a loss at what the pool gives up, a gain at its average |
| `movement_id` | `uuid` | NULL, UNIQUE, FK `inv.stock_movement` | Set on posting |

- UNIQUE (`stock_adjustment_id`, `line_no`). Lines change while the adjustment is a `DRAFT`; while it is pending only `movement_id` is filled, once (`inv.stock_document_part_guard`, HK004).

### `inv.stock_reversal` · DOCUMENT

The request to reverse one movement and, once posted, the reversing movement, which names it as its source document (FR-INV-004; added in B05 continued 2, A-139). Document type `STOCK_REVERSAL`, not numbered.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK, FK `platform.business_document` | |
| `movement_id` | `uuid` | NOT NULL, FK `inv.stock_movement` | The movement reversed |
| `reason_code` | `text` | NOT NULL, FK `mdm.reason_code` | From the stock adjustment list |
| `note` | `text` | NOT NULL | |
| `value_pesewas` | `pesewas` | NOT NULL | The original's value, judged against the threshold |
| `approval_threshold_pesewas` | `pesewas` | NOT NULL | The `STOCK_REVERSAL` threshold it was judged against |
| `approval_request_id` | `uuid` | NULL, FK `iam.approval_request`; required unless posted at once | |
| `reversal_movement_id` | `uuid` | NULL, UNIQUE, FK `inv.stock_movement`; set exactly when `POSTED` | |

Standard columns: `DOCUMENT` (`status` in `PENDING_APPROVAL`, `POSTED`, `REJECTED`), with `posted_at` and `posted_by`. Partial UNIQUE (`movement_id`) where status is not `REJECTED`. CHECK `ck_stock_reversal_approved`: posted at or above its threshold only with an approval. `POSTED` and `REJECTED` are frozen.

### `inv.stock_take` · DOCUMENT

A cycle count or full stock take of one location (FR-INV-013, FR-INV-014). Posted statuses: `POSTED`, `CANCELLED`. Built in migration 0054 (B05 continued 3, A-141).

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK, FK `platform.business_document` | |
| `stock_take_no` | `text` | NULL, UNIQUE | Null until numbering (B8) |
| `location_id` | `uuid` | NOT NULL, FK `mdm.location` | Scope of the count |
| `scope` | `text` | NOT NULL, CHECK in (`FULL`, `CYCLE`) | A cycle count lists its products in `inv.stock_take_product` |
| `snapshot_at` | `timestamptz` | NULL; set exactly when counting starts | When expected quantities were frozen |
| `counted_by` | `uuid` | NULL, FK `iam.principal` | The first to record a count |
| `gain_value_pesewas`, `loss_value_pesewas` | `pesewas` | NULL; set at review | The variance report's two totals, as the contract shows them |
| `variance_value_pesewas` | `pesewas` | NULL; CHECK equals gain plus loss | Compared with the threshold |
| `approval_threshold_pesewas` | `pesewas` | NULL; set when judged | The `STOCK_WRITE_OFF` threshold, read through IAM's `Approvals.judgeIn` (as A-139) |
| `approval_request_id` | `uuid` | NULL, FK `iam.approval_request` | Required at or above the threshold |
| `cancel_reason` | `text` | NULL; set exactly when `CANCELLED` | |

Standard columns: `DOCUMENT` (`status` in `DRAFT`, `COUNTING`, `REVIEW`, `PENDING_APPROVAL`, `POSTED`, `CANCELLED`), with `posted_at` and `posted_by` set exactly when `POSTED`. Statuses move `DRAFT` to `COUNTING` or `CANCELLED`, `COUNTING` to `REVIEW` or `CANCELLED`, `REVIEW` to `POSTED`, `PENDING_APPROVAL` or `CANCELLED`, and `PENDING_APPROVAL` to `POSTED` or `CANCELLED` (`inv.document_status_guard`); `POSTED` and `CANCELLED` are frozen, and a pending take changes only to be decided. CHECK `ck_stock_take_approved`: posted at or above its threshold only with an approval. Trigger `inv.stock_take_overlap`: a take starts counting only when no take of its location whose scope shares a product (a `FULL` take shares every one) is counting, in review or pending; it takes an advisory lock on the location first, so the rule holds at any isolation level (HK010 `ck_stock_take_overlap`).

### `inv.stock_take_product` · DOCUMENT

The products a cycle count covers. Added in B05 continued 3 (A-141).

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `stock_take_id` | `uuid` | NOT NULL, FK `inv.stock_take` | |
| `product_id` | `uuid` | NOT NULL, FK `mdm.product` | |

PK (`stock_take_id`, `product_id`). Written while the take is a `DRAFT` (`inv.stock_take_part_guard`, HK004).

### `inv.stock_take_line` · DOCUMENT

Expected and counted quantity for one item in a stock take.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `stock_take_id` | `uuid` | NOT NULL, FK `inv.stock_take` | |
| `product_id` | `uuid` | NOT NULL, FK `mdm.product` | |
| `stock_unit_id` | `uuid` | NULL, FK `inv.stock_unit` | A lot; animals are not counted here (A-141) |
| `expected_qty` | `numeric(14,3)` | NOT NULL | From the balance at snapshot; signed |
| `counted_qty` | `qty` | NULL | Entered blind: nobody reads expected while counting |
| `recount_qty` | `qty` | NULL; only with `counted_qty` | Second count where the first disagreed; final |
| `counted_weight_kg` | `kg` | NULL, with `counted_weight_source` | |
| `counted_weight_source` | `text` | NULL, CHECK in (`SCALE`, `MANUAL`, `ESTIMATE`) | `MANUAL` for a typed weight (A-141) |
| `variance_qty` | `numeric(14,3)` | NULL; CHECK equals the final count less expected | Signed |
| `variance_value_pesewas` | `pesewas` | NULL, with `variance_qty` | From the cost pool |
| `movement_id` | `uuid` | NULL, UNIQUE, FK `inv.stock_movement`; only for a non-zero variance | The gain or loss posted |

- UNIQUE NULLS NOT DISTINCT (`stock_take_id`, `product_id`, `stock_unit_id`). Lines are written while the take is a `DRAFT`; while `COUNTING` only the counts change; in `REVIEW` only the recount (once), the variance and the movement (once); while `PENDING_APPROVAL` only the movement (once) (`inv.stock_take_part_guard`, HK004).

### `inv.reorder_rule` · MASTER

Minimum, reorder point and maximum levels, and expiry alert lead time (FR-INV-015, FR-INV-016; migration 0064, A-147).

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `product_id` | `uuid` | NOT NULL, FK `mdm.product` | |
| `branch_id` | `uuid` | NOT NULL, FK `mdm.branch` | |
| `location_id` | `uuid` | NULL, FK `mdm.location` | Null for the whole branch; otherwise one physical stock location of it (not in transit, not a site) |
| `min_qty` | `qty` | NOT NULL, CHECK `>= 0` | Minimum level: a `BELOW_MINIMUM` alert under it |
| `reorder_point_qty` | `qty` | NOT NULL, CHECK `>= min_qty` | Low-stock alert fires at or below it |
| `max_qty` | `qty` | NOT NULL, CHECK `>= reorder_point_qty` and `> 0` | Maximum level; the suggested reorder reaches it |
| `uom` | `text` | NULL, FK `mdm.uom`; never changes | The unit the levels were entered in when it is not the base unit (a reorder point of 30 crates, B09e continued, migration 0219, A-267); the three levels above stay in the base unit |
| `min_qty_uom`, `reorder_point_qty_uom`, `max_qty_uom` | `qty` | NULL; set exactly with `uom` (`ck_reorder_rule_uom`) | The levels as entered; the base levels are exactly these converted (`ck_reorder_rule_uom_conversion`) |
| `expiry_alert_days` | `integer` | NULL, CHECK 1 to 365 | Days before expiry to alert; null takes the default of 3 |

Standard columns: `MASTER`. UNIQUE NULLS NOT DISTINCT (`product_id`, `branch_id`, `location_id`) among live rows (`uq_reorder_rule`). Its product, branch and location never change (`inv.reorder_rule_guard`, HK010 `ck_reorder_rule_change`).

### `inv.stock_alert` · DOCUMENT

An alert raised once per crossing and cleared once (FR-INV-015, FR-INV-016; migration 0064, an addition to the B0 dictionary, A-147). Raised in the transaction of the movement, reservation or hold that crossed a level (`StockAlerts.evaluateIn`, called by `Stock.postIn`, `Reservations` and `StockHolds`) and by the daily `stock-alerts` job; each raise publishes `inv.StockAlertRaised`.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `kind` | `text` | NOT NULL, CHECK in (`LOW_STOCK`, `BELOW_MINIMUM`, `EXPIRING`, `EXPIRED`) | |
| `branch_id` | `uuid` | NOT NULL, FK `mdm.branch` | |
| `product_id` | `uuid` | NOT NULL, FK `mdm.product` | |
| `location_id` | `uuid` | NULL, FK `mdm.location` | The rule's location, or where the lot stands |
| `stock_unit_id` | `uuid` | NULL, FK `inv.stock_unit` | The lot, for an expiry alert |
| `reorder_rule_id` | `uuid` | NULL, FK `inv.reorder_rule` | The rule, for a level alert |
| `qty` | `numeric(14,3)` | NOT NULL | Available (level) or on hand (expiry) when raised |
| `threshold_qty` | `qty` | NULL | The level crossed |
| `suggested_qty` | `qty` | NULL | What reached the maximum when raised |
| `expires_on` | `date` | NULL | The lot's expiry |
| `status` | `text` | NOT NULL, CHECK in (`OPEN`, `CLEARED`) | |
| `raised_at` | `timestamptz` | NOT NULL | |
| `cleared_at` | `timestamptz` | NULL; set exactly when `CLEARED` | |

Standard columns: `DOCUMENT` (no posting step). `ck_stock_alert_shape`: a level alert names its rule and threshold and no lot; an expiry alert names its lot, location and date. At most one OPEN alert of a kind per rule (`uq_stock_alert_open_rule`) and per lot and location (`uq_stock_alert_open_lot`). Raised OPEN, cleared once, nothing else changes (`inv.stock_alert_guard`, HK010 `ck_stock_alert_change`).

### `inv.temperature_reading` · LEDGER

Cold chain log (FR-INV-007, FR-INV-008; migration 0064, A-147). A reading outside the location's range quarantines its lots.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | Client-generated on an offline queue, so a resubmission is stored once |
| `location_id` | `uuid` | NOT NULL, FK `mdm.location` | Cold room or vehicle |
| `branch_id` | `uuid` | NOT NULL, FK `mdm.branch` | The location's branch, for scoping |
| `reading_c` | `numeric(4,1)` | NOT NULL | Degrees Celsius |
| `range_min_c`, `range_max_c` | `numeric(4,1)` | NOT NULL, CHECK min `<` max | The location's range when recorded, read through MDM's `MasterDataRefs` and copied, so ADR-0047 is not widened |
| `measured_at` | `timestamptz` | NOT NULL | No more than five minutes ahead of the server (checked in `ColdChain`) |
| `source` | `text` | NOT NULL, CHECK in (`MANUAL`, `SENSOR`) | |
| `is_excursion` | `boolean` | NOT NULL, CHECK `= (reading_c < range_min_c OR reading_c > range_max_c)` (`ck_temperature_reading_excursion`) | Outside the range it was judged by |
| `excursion_document_id` | `uuid` | NULL, FK `platform.business_document`; set exactly for an excursion | The `TEMPERATURE_EXCURSION` document its holds and exceptions name (migration 0063) |
| `exception_id` | `uuid` | NULL, FK `inv.stock_exception`; only on an excursion | The first exception raised; one per stock line in the location |

Standard columns: `LEDGER` (`recorded_at`, `actor_id`).

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
