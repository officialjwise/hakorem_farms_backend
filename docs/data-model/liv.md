# Table dictionary: `liv`

Owner: LIV module. The animal register, weights, health, breeding, mortality and feed.

**Built in B06 continued (migration 0076, A-158):** `liv.animal`, `liv.weight_record`, `liv.health_event`, `liv.health_cost_allocation` (an addition, below), `liv.mortality_record`, `liv.ration`, `liv.feed_consumption` and `liv.feed_cost_allocation`. `liv.batch` and `liv.breeding_record`, and the animal's `batch_id` and `breeding_record_id`, are B06 continued 2's. Additions to the tables below: `branch_id`, `product_id` and `exit_value_pesewas` (the cost the closing movement carried out, set exactly when the status is not ALIVE) on an animal; `branch_id` on a weight record; `branch_id`, `holds_placed`, `medication_value_pesewas` and `issue_movement_id` on a health event, which must name exactly one of its stock unit and its pen; `location_id`, `threshold_pesewas` (the policy's threshold when submitted) and the DOCUMENT columns on a mortality record; `from_location_id` and the DOCUMENT columns on a feed consumption. An animal's status may also return to ALIVE from any closed status, on a customer return or the reversal of the closing movement. **Built in B06 continued 2 (migration 0080, A-159):** `liv.batch`, `liv.breeding_record`, the animal's `batch_id` and `breeding_record_id` (an expand: nullable), and two additions, `liv.animal_move` and `liv.gestation_period` (below). Additions to the tables below: `branch_id`, `location_id` (where the batch started) and `closed_at`, `closed_by`, `close_reason` on a batch, whose `stock_unit_id` is set for every batch built so far (BL-055); `branch_id`, `stillbirths`, `fail_reason` and the DOCUMENT columns on a breeding record. The animal's tag and parentage are now fixed by `liv.animal_guard` too, and the sex of a dam. Stock quantities, locations and cost are inventory's; this module holds the biological record and shares identity with the stock unit (ADR-0002, ADR-0018, ADR-0019). Conventions are in `docs/DATA_MODEL.md`.

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

- Built (0080): `liv.batch_guard` freezes the number, species, branch, lot, start, initial head and starting location, moves status only ACTIVE to CLOSED with the close columns all set, and freezes a closed batch. Closing needs no head left on the lot (checked by `Batches`, since the head is inventory's).

### `liv.animal_move` · LEDGER

Built in B06 continued 2 (A-159), an addition. One move of an animal between pens of its branch (FR-LIV-003), registered as a business document (`ANIMAL_MOVE`) that its TRANSFER_INTERNAL movement cites: `id`, `stock_unit_id` (FK `liv.animal`), `branch_id`, `from_location_id`, `to_location_id` (different), `movement_id` (FK `inv.stock_movement`), `note`, `occurred_at`. Standard columns: `LEDGER`. Index (`stock_unit_id`, `occurred_at`) for the timeline.

### `liv.gestation_period` · LOOKUP

Built in B06 continued 2 (A-159), an addition. Gestation days per species code (FR-LIV-010, SA-19: goat 150, sheep 147, pig 114, rabbit 31), changed only by migration. A species with a row is a breeding species. Keyed by code because species are seed data, not migration rows.

### `liv.weight_record` · LEDGER

Weights captured over time, for growth tracking.

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

- Built (0080): `liv.breeding_record_guard` moves status MATED to CONFIRMED, BORN or FAILED and CONFIRMED to BORN or FAILED, fixes the dam, sire, mating date and branch, and checks the dam is a FEMALE animal and the sire a MALE one; `platform.freeze_posted('BORN,FAILED')`; `ck_breeding_record_born` (a BORN record has its date, litter, live births and stillbirths, which sum to the litter, born no earlier than the mating) and `ck_breeding_record_failed` (a FAILED record has its reason).

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

- CHECK: `status = 'POSTED'` with `value_pesewas` at or above the policy threshold requires both `photo_file_id` and `approval_request_id`. The posting function supplies the threshold comparison. As built (`ck_mortality_record_approved`), the threshold is snapshotted on the row as `threshold_pesewas` when the record is submitted, so the database compares the two itself; the photograph is checked as a CLEAN EVIDENCE file by `platform.require_clean_file`. **Built in B06r (migration 0113, A-175, ADR-0053):** additions `confirmation_required` (the reporter may not post a write-off, so the record posts only on an approval; `ck_mortality_record_confirmed`), `returned_reason` (`EVIDENCE_INFECTED`, `EVIDENCE_UNSCANNABLE`, set exactly when the status is the new `RETURNED`) and `photo_sha256` (the photograph's exact bytes' SHA-256, copied from the file store by the application at report; null on records before 0113). An approved record is never posted by its reporter (`ck_mortality_record_checker`). Status `RETURNED` follows only `PENDING_APPROVAL` and is frozen; the photograph and its hash never change. The photograph is checked by `platform.require_clean_file` when the record becomes POSTED, no longer at report, so a report may carry a photograph still PENDING its scan.

### `liv.health_cost_allocation` · LEDGER

Built in B06 continued (A-158). How one health event's cost (medication issued plus any veterinary service charged) was spread across the units treated, as `liv.feed_cost_allocation` is for feed: `health_event_id`, `stock_unit_id`, `head_days`, `amount_pesewas`, `treatment` (`CAPITALISED`, `EXPENSED`), `movement_id` (the VETERINARY value-only movement, when capitalised). PK (`health_event_id`, `stock_unit_id`).

- Deferred trigger (`ck_health_event_spread`): the amounts for one event sum exactly to its `cost_pesewas`.

### `liv.ration` · MASTER

A feeding standard: how much of which feed per head per day.

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
