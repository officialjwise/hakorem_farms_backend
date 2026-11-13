# Table dictionary: `cst`

Owner: CST module. Overhead allocation and profitability projections. The value of stock is inventory's; nothing here is a cost of record (ADR-0018). Conventions are in `docs/DATA_MODEL.md`.

---

### `cst.overhead_allocation_run` · DOCUMENT

Spreads a period's labour or overhead across stock units. Posted status: `POSTED`.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK, FK `platform.business_document` | The source document of the value-only movements |
| `period_start` | `date` | NOT NULL | |
| `period_end` | `date` | NOT NULL, CHECK `>= period_start` | |
| `cost_element` | `text` | NOT NULL, CHECK in (`LABOUR`, `OVERHEAD`) | |
| `basis` | `text` | NOT NULL, CHECK in (`HEAD_DAYS`, `WEIGHT_GAIN`, `EQUAL`) | The allocation weight |
| `scope_location_id` | `uuid` | NULL, FK `mdm.location` | A pen, or null for the branch |
| `total_pesewas` | `pesewas` | NOT NULL, CHECK `> 0` | Amount to allocate, taken from the ledger's expense accounts for the period |
| `approval_request_id` | `uuid` | NULL, FK `iam.approval_request` | |

Standard columns: `DOCUMENT` (`status` in `DRAFT`, `POSTED`).

- Deferred trigger on posting: lines sum exactly to `total_pesewas`.

### `cst.overhead_allocation_line` · DOCUMENT

One stock unit’s share of an allocation run.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `run_id` | `uuid` | NOT NULL, FK `cst.overhead_allocation_run` | |
| `stock_unit_id` | `uuid` | NOT NULL, FK `inv.stock_unit` | |
| `weight` | `bigint` | NOT NULL, CHECK `>= 0` | Integer allocation weight |
| `amount_pesewas` | `pesewas` | NOT NULL | From `allocate` |
| `movement_ref` | `uuid` | NULL | The value-only movement posted through inventory |

- PK (`run_id`, `stock_unit_id`).

### `cst.cost_object_summary` · PROJECTION

Accumulated cost per cost object by element. Rebuilt from inventory's published movements.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `object_type` | `text` | NOT NULL, CHECK in (`STOCK_UNIT`, `PEN`, `BATCH`, `PROCESSING_ORDER`) | |
| `object_id` | `uuid` | NOT NULL | |
| `branch_id` | `uuid` | NOT NULL, FK `mdm.branch` | |
| `purchase_pesewas` | `pesewas` | NOT NULL DEFAULT 0 | |
| `feed_pesewas` | `pesewas` | NOT NULL DEFAULT 0 | |
| `veterinary_pesewas` | `pesewas` | NOT NULL DEFAULT 0 | |
| `labour_pesewas` | `pesewas` | NOT NULL DEFAULT 0 | |
| `overhead_pesewas` | `pesewas` | NOT NULL DEFAULT 0 | |
| `processing_pesewas` | `pesewas` | NOT NULL DEFAULT 0 | |
| `total_pesewas` | `pesewas` | NOT NULL DEFAULT 0 | |
| `refreshed_at` | `timestamptz` | NOT NULL | |

- PK (`object_type`, `object_id`).

### `cst.margin_fact` · PROJECTION

One row per billed line, for margin by product, line, channel, customer, salesperson and branch.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `billing_line_ref` | `uuid` | PK | The billing document line |
| `document_date` | `date` | NOT NULL | |
| `branch_id` | `uuid` | NOT NULL, FK `mdm.branch` | |
| `product_id` | `uuid` | NOT NULL, FK `mdm.product` | |
| `product_line` | `text` | NOT NULL | |
| `channel` | `text` | NOT NULL | |
| `customer_ref` | `uuid` | NULL | |
| `salesperson_ref` | `uuid` | NULL | |
| `is_credit` | `boolean` | NOT NULL | A credit note line reduces revenue and cost |
| `qty` | `numeric(14,3)` | NOT NULL | |
| `weight_kg` | `numeric(12,3)` | NULL | |
| `revenue_pesewas` | `pesewas` | NOT NULL | Net of levies |
| `cost_pesewas` | `pesewas` | NOT NULL | Value of the stock issue |
| `price_variance_pesewas` | `pesewas` | NOT NULL DEFAULT 0 | Override or negotiation effect |

- Indexes on (`document_date`, `branch_id`), (`product_id`), (`customer_ref`). Break-even and contribution margin views are queries over this table and the ledger's fixed costs.

### `cst.loss_fact` · PROJECTION

Shrinkage, mortality and wastage as their own figure, not buried in cost of sales.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `movement_ref` | `uuid` | PK | The write-off movement |
| `occurred_on` | `date` | NOT NULL | |
| `branch_id` | `uuid` | NOT NULL, FK `mdm.branch` | |
| `location_id` | `uuid` | NOT NULL, FK `mdm.location` | |
| `product_id` | `uuid` | NOT NULL, FK `mdm.product` | |
| `loss_group` | `text` | NOT NULL, CHECK in (`MORTALITY`, `SHRINKAGE`, `WASTAGE`) | |
| `reason_code` | `text` | NOT NULL | |
| `handler_ref` | `uuid` | NULL | Who reported it: mortality rate by handler against the pen average |
| `qty` | `numeric(14,3)` | NOT NULL | |
| `value_pesewas` | `pesewas` | NOT NULL | |
