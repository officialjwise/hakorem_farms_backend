# Table dictionary: `liv`

Owner: LIV module. The animal register, weights, health, breeding, mortality and feed. Stock quantities, locations and cost are inventory's; this module holds the biological record and shares identity with the stock unit (ADR-0002, ADR-0018, ADR-0019). Conventions are in `docs/DATA_MODEL.md`.

---

### `liv.animal` · MASTER

One individual animal. Its current pen is `inv.stock_unit.current_location_id`; it is not duplicated here.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `stock_unit_id` | `uuid` | PK, FK `inv.stock_unit` | Shared identity with the serial stock unit |
| `tag_no` | `text` | NOT NULL | What people call the animal |
| `species_id` | `uuid` | NOT NULL, FK `mdm.species` | |
| `breed` | `text` | NULL | |
| `sex` | `text` | NOT NULL, CHECK in (`MALE`, `FEMALE`, `UNKNOWN`) | |
| `date_of_birth` | `date` | NULL | Known for animals born on the farm |
| `acquired_on` | `date` | NOT NULL | Birth or purchase date |
| `source` | `text` | NOT NULL, CHECK in (`PURCHASE`, `BIRTH`, `OPENING`) | |
| `supplier_id` | `uuid` | NULL, FK `mdm.supplier`; required for `PURCHASE` | Traceability |
| `acquisition_cost_pesewas` | `pesewas` | NOT NULL DEFAULT 0 | Purchase price; nil for a birth. The running cost is the stock unit's cost pool |
| `dam_id` | `uuid` | NULL, FK `liv.animal` | Mother |
| `sire_id` | `uuid` | NULL, FK `liv.animal` | Father |
| `breeding_record_id` | `uuid` | NULL, FK `liv.breeding_record` | The birth that produced it |
| `batch_id` | `uuid` | NULL, FK `liv.batch` | Group it is managed with |
| `purpose` | `text` | NOT NULL, CHECK in (`GROWING`, `BREEDING`) | Decides whether feed and veterinary cost is capitalised or expensed |
| `status` | `text` | NOT NULL, CHECK in (`ALIVE`, `SOLD`, `SLAUGHTERED`, `DEAD`, `CULLED`) | Follows the stock unit, updated in the same transaction |
| `status_changed_at` | `timestamptz` | NULL | |

Standard columns: `MASTER`. Never soft-deleted.

- Partial UNIQUE (`tag_no`) where `status = 'ALIVE'`.

### `liv.batch` · MASTER

A group managed together: a flock of broilers, a litter. For poultry the batch is itself the stock unit (a lot counted in head).

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `stock_unit_id` | `uuid` | NULL, UNIQUE, FK `inv.stock_unit` | Set when the batch is a lot-tracked flock; null when it only groups individual animals |
| `batch_no` | `text` | NOT NULL, UNIQUE | |
| `species_id` | `uuid` | NOT NULL, FK `mdm.species` | |
| `started_on` | `date` | NOT NULL | Hatch, birth or arrival |
| `initial_head` | `integer` | NOT NULL, CHECK `> 0` | Starting count, for mortality rate |
| `purpose` | `text` | NOT NULL, CHECK in (`GROWING`, `BREEDING`, `LAYING`) | |
| `status` | `text` | NOT NULL, CHECK in (`ACTIVE`, `CLOSED`) | |

Standard columns: `MASTER`.

### `liv.weight_record` · LEDGER

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | May be generated on the device |
| `stock_unit_id` | `uuid` | NOT NULL, FK `inv.stock_unit` | Animal, or flock for an average weight |
| `weight_kg` | `kg` | NOT NULL, CHECK `> 0` | |
| `weight_source` | `text` | NOT NULL, CHECK in (`SCALE`, `MANUAL`, `ESTIMATE`) | |
| `head_weighed` | `integer` | NOT NULL DEFAULT 1, CHECK `> 0` | Sample size for a flock average |
| `measured_at` | `timestamptz` | NOT NULL | |

Standard columns: `LEDGER`. Index (`stock_unit_id`, `measured_at`). Average daily gain is computed from consecutive rows.

### `liv.health_event` · LEDGER

Vaccinations, treatments and checks. Registered as a business document so that a withdrawal hold can cite it.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK, FK `platform.business_document` | |
| `kind` | `text` | NOT NULL, CHECK in (`VACCINATION`, `TREATMENT`, `CHECK`, `DEWORMING`) | |
| `stock_unit_id` | `uuid` | NULL, FK `inv.stock_unit` | The animal or flock treated |
| `location_id` | `uuid` | NULL, FK `mdm.location` | Or the whole pen |
| `product_id` | `uuid` | NULL, FK `mdm.product` | The medication or vaccine |
| `dose` | `text` | NULL | |
| `qty_used` | `qty` | NULL | Issued from medication stock |
| `withdrawal_days` | `integer` | NOT NULL DEFAULT 0, CHECK `>= 0` | Snapshot from the product |
| `withdrawal_ends_at` | `timestamptz` | NULL | |
| `stock_hold_id` | `uuid` | NULL, FK `inv.stock_hold`; required when `withdrawal_days > 0` | The block on sale |
| `cost_pesewas` | `pesewas` | NOT NULL DEFAULT 0 | Veterinary cost captured |
| `administered_by` | `text` | NULL | Vet's name |
| `notes` | `text` | NULL | |
| `occurred_at` | `timestamptz` | NOT NULL | |

Standard columns: `LEDGER`.

- CHECK: at least one of `stock_unit_id`, `location_id` is set.
- A pen-wide treatment places one hold per stock unit in the pen; `stock_hold_id` is then null here and each hold cites this event.

### `liv.breeding_record` · DOCUMENT

Posted statuses: `BORN`, `FAILED`.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK, FK `platform.business_document` | |
| `dam_id` | `uuid` | NOT NULL, FK `liv.animal` | |
| `sire_id` | `uuid` | NULL, FK `liv.animal` | |
| `mated_on` | `date` | NOT NULL | |
| `expected_birth_on` | `date` | NULL | |
| `actual_birth_on` | `date` | NULL | |
| `litter_size` | `integer` | NULL, CHECK `>= 0` | Total born |
| `live_births` | `integer` | NULL, CHECK `>= 0 AND live_births <= litter_size` | Each becomes an animal with `dam_id` set |
| `notes` | `text` | NULL | |

Standard columns: `DOCUMENT` (`status` in `MATED`, `CONFIRMED`, `BORN`, `FAILED`).

### `liv.mortality_record` · DOCUMENT

A death or cull. Posted statuses: `POSTED`, `REJECTED`.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK, FK `platform.business_document` | |
| `kind` | `text` | NOT NULL, CHECK in (`DEATH`, `CULL`) | |
| `stock_unit_id` | `uuid` | NOT NULL, FK `inv.stock_unit` | The animal, or the flock |
| `head` | `integer` | NOT NULL DEFAULT 1, CHECK `> 0` | Number lost from a flock |
| `reason_code` | `text` | NOT NULL, FK `mdm.reason_code` | From the fixed list |
| `found_at` | `timestamptz` | NOT NULL | |
| `reported_by` | `uuid` | NOT NULL, FK `iam.principal` | The handler, for mortality rate by handler |
| `photo_file_id` | `uuid` | NULL, FK `platform.stored_file` | Evidence |
| `value_pesewas` | `pesewas` | NOT NULL | Cost written off, from the cost pool |
| `approval_request_id` | `uuid` | NULL, FK `iam.approval_request` | Second approver above the threshold |
| `movement_id` | `uuid` | NULL, FK `inv.stock_movement` | The write-off |
| `disposal_note` | `text` | NULL | How the carcass was disposed of |

Standard columns: `DOCUMENT` (`status` in `REPORTED`, `PENDING_APPROVAL`, `POSTED`, `REJECTED`).

- CHECK: `status = 'POSTED'` with `value_pesewas` at or above the policy threshold requires both `photo_file_id` and `approval_request_id`. The posting function supplies the threshold comparison.

### `liv.ration` · MASTER

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `name` | `text` | NOT NULL | |
| `species_id` | `uuid` | NOT NULL, FK `mdm.species` | |
| `feed_product_id` | `uuid` | NOT NULL, FK `mdm.product` | |
| `qty_per_head_per_day` | `qty` | NOT NULL, CHECK `> 0` | In the feed's base unit |
| `stage` | `text` | NULL | Starter, grower, finisher |

Standard columns: `MASTER`.

### `liv.feed_consumption` · DOCUMENT

Feed issued to a pen on a date. Posted status: `POSTED`.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK, FK `platform.business_document` | |
| `location_id` | `uuid` | NOT NULL, FK `mdm.location` | The pen |
| `feed_product_id` | `uuid` | NOT NULL, FK `mdm.product` | |
| `qty` | `qty` | NOT NULL, CHECK `> 0` | |
| `consumed_on` | `date` | NOT NULL | |
| `ration_id` | `uuid` | NULL, FK `liv.ration` | |
| `value_pesewas` | `pesewas` | NULL | Value of the feed issued, from inventory |
| `issue_movement_id` | `uuid` | NULL, FK `inv.stock_movement` | The feed leaving the store |

Standard columns: `DOCUMENT` (`status` in `DRAFT`, `POSTED`).

### `liv.feed_cost_allocation` · LEDGER

How one feed consumption was spread across the stock units in the pen.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `feed_consumption_id` | `uuid` | NOT NULL, FK `liv.feed_consumption` | |
| `stock_unit_id` | `uuid` | NOT NULL, FK `inv.stock_unit` | |
| `head_days` | `integer` | NOT NULL, CHECK `> 0` | The allocation weight |
| `amount_pesewas` | `pesewas` | NOT NULL | From `allocate` |
| `treatment` | `text` | NOT NULL, CHECK in (`CAPITALISED`, `EXPENSED`) | By the animal's purpose |
| `movement_id` | `uuid` | NULL, FK `inv.stock_movement` | The value-only movement, when capitalised |

Standard columns: `LEDGER`. PK (`feed_consumption_id`, `stock_unit_id`).

- Deferred trigger: the amounts for one consumption sum exactly to its `value_pesewas`.
