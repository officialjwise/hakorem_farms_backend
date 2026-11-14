# Table dictionary: `prc`

Owner: PRC module. Processing orders that turn live animals or carcasses into meat lots, offal and waste, with yield and exact cost allocation (ADR-0018). Conventions are in `docs/DATA_MODEL.md`.

---

### `prc.yield_standard` · MASTER

Expected yield, for the variance check.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `input_product_id` | `uuid` | NOT NULL, FK `mdm.product` | The animal product consumed |
| `output_product_id` | `uuid` | NOT NULL, FK `mdm.product` | A cut, offal or by-product |
| `expected_percent` | `percent` | NOT NULL | Output weight as a share of input live weight |
| `tolerance_percent` | `percent` | NOT NULL DEFAULT 5 | Outside this, the order is flagged |

Standard columns: `MASTER`. UNIQUE (`input_product_id`, `output_product_id`) among live rows.

### `prc.processing_order` · DOCUMENT

Posted statuses: `COMPLETED`, `CANCELLED`.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK, FK `platform.business_document` | |
| `order_no` | `text` | NULL, UNIQUE | Allocated on start |
| `location_id` | `uuid` | NOT NULL, FK `mdm.location` | Where processing happens |
| `output_location_id` | `uuid` | NOT NULL, FK `mdm.location` | Usually the cold room |
| `started_at` | `timestamptz` | NULL | |
| `completed_at` | `timestamptz` | NULL | |
| `input_weight_kg` | `kg` | NULL | Total live or carcass weight in |
| `output_weight_kg` | `kg` | NULL, CHECK `output_weight_kg <= input_weight_kg` | Saleable weight out |
| `waste_weight_kg` | `kg` | NULL | |
| `expected_yield_percent` | `percent` | NULL | From the standards |
| `actual_yield_percent` | `percent` | NULL | |
| `yield_variance_flag` | `boolean` | NOT NULL DEFAULT `false` | Needs investigation |
| `input_cost_pesewas` | `pesewas` | NULL | Sum of consumed units' pool values |
| `direct_cost_pesewas` | `pesewas` | NOT NULL DEFAULT 0 | Sum of `prc.processing_cost` |
| `total_cost_pesewas` | `pesewas` | NULL | Input plus direct |
| `reverses_order_id` | `uuid` | NULL, UNIQUE, FK `prc.processing_order` | A correction |

Standard columns: `DOCUMENT` (`status` in `PLANNED`, `IN_PROGRESS`, `COMPLETED`, `CANCELLED`).

- Deferred trigger on completion: the sum of `prc.processing_output.allocated_cost_pesewas` equals `total_cost_pesewas`, and `total_cost_pesewas = input_cost_pesewas + direct_cost_pesewas`.

### `prc.processing_input` · DOCUMENT

Frozen with its order.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `processing_order_id` | `uuid` | NOT NULL, FK `prc.processing_order` | |
| `stock_unit_id` | `uuid` | NOT NULL, FK `inv.stock_unit` | The animal or carcass lot consumed |
| `product_id` | `uuid` | NOT NULL, FK `mdm.product` | |
| `qty` | `qty` | NOT NULL, CHECK `> 0` | Head, or kilograms of a carcass lot |
| `weight_kg` | `kg` | NOT NULL | Weight at slaughter |
| `weight_source` | `text` | NOT NULL, CHECK in (`SCALE`, `MANUAL`, `ESTIMATE`) | |
| `cost_pesewas` | `pesewas` | NULL | Value carried by the consuming movement |
| `movement_id` | `uuid` | NULL, FK `inv.stock_movement` | |

- UNIQUE (`processing_order_id`, `stock_unit_id`).

### `prc.processing_output` · DOCUMENT

Frozen with its order.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `processing_order_id` | `uuid` | NOT NULL, FK `prc.processing_order` | |
| `line_no` | `integer` | NOT NULL | Stable key for allocation tie-breaks |
| `product_id` | `uuid` | NOT NULL, FK `mdm.product` | |
| `output_kind` | `text` | NOT NULL, CHECK in (`MEAT`, `OFFAL`, `BY_PRODUCT`, `WASTE`) | |
| `stock_unit_id` | `uuid` | NULL, FK `inv.stock_unit`; required unless `WASTE` | The lot created |
| `weight_kg` | `kg` | NOT NULL, CHECK `> 0` | |
| `weight_source` | `text` | NOT NULL | |
| `pack_count` | `integer` | NULL, CHECK `> 0` | |
| `reference_price_pesewas_per_kg` | `pesewas` | NOT NULL | Sale price snapshot used for relative sales value; zero for waste |
| `allocation_weight` | `bigint` | NOT NULL, CHECK `>= 0` | Grams multiplied by reference price |
| `allocated_cost_pesewas` | `pesewas` | NOT NULL DEFAULT 0 | From `allocate` |
| `movement_id` | `uuid` | NULL, FK `inv.stock_movement` | |

- UNIQUE (`processing_order_id`, `line_no`).
- CHECK: `output_kind = 'WASTE'` implies `allocation_weight = 0` and `allocated_cost_pesewas = 0`.

### `prc.processing_cost` · DOCUMENT

Direct costs of a processing run.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `processing_order_id` | `uuid` | NOT NULL, FK `prc.processing_order` | |
| `cost_kind` | `text` | NOT NULL, CHECK in (`LABOUR`, `CONSUMABLE`, `SERVICE`, `UTILITY`) | |
| `amount_pesewas` | `pesewas` | NOT NULL, CHECK `> 0` | |
| `description` | `text` | NOT NULL | |
| `created_at` | `timestamptz` | NOT NULL DEFAULT `now()` | |
| `created_by` | `uuid` | NOT NULL, FK `iam.principal` | |

### `prc.pack` · MASTER

A labelled, weighed pack within a meat lot.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `stock_unit_id` | `uuid` | NOT NULL, FK `inv.stock_unit` | The lot |
| `processing_output_id` | `uuid` | NOT NULL, FK `prc.processing_output` | |
| `pack_no` | `integer` | NOT NULL | |
| `weight_kg` | `kg` | NOT NULL, CHECK `> 0` | Printed on the label, read at picking |
| `barcode` | `text` | NOT NULL, UNIQUE | Carries lot and weight |
| `label_printed_at` | `timestamptz` | NULL | |
| `status` | `text` | NOT NULL, CHECK in (`IN_STOCK`, `PICKED`, `SOLD`, `WRITTEN_OFF`) | |

Standard columns: `MASTER`. UNIQUE (`stock_unit_id`, `pack_no`).
