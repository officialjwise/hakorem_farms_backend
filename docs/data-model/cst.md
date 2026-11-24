# Table dictionary: `cst`

Owner: CST module. Overhead allocation and profitability projections. The value of stock is inventory's; nothing here is a cost of record (ADR-0018). Conventions are in `docs/DATA_MODEL.md`. As built in B12 continued 2 (migration 0368, ADR-0102, A-387): the projections are written only by CST's `SECURITY DEFINER` refresh functions over published views, so the asynchronous consumer and a rebuild run the same statements; the application roles only read them.

---

### `cst.overhead_allocation_run` · DOCUMENT

Spreads a period's labour or overhead across stock units. Posted status: `POSTED`.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK, FK `platform.business_document` (`OVERHEAD_ALLOCATION`) | The source document of the value-only movements |
| `branch_id` | `uuid` | NOT NULL, FK `mdm.branch` | The pen's branch, or the branch named |
| `period_start` | `date` | NOT NULL | |
| `period_end` | `date` | NOT NULL, CHECK `>= period_start` | No later than today (application) |
| `cost_element` | `text` | NOT NULL, CHECK in (`LABOUR`, `OVERHEAD`) | |
| `basis` | `text` | NOT NULL, CHECK in (`HEAD_DAYS`, `WEIGHT_GAIN`, `EQUAL`) | The allocation weight; `WEIGHT_GAIN` refused for now (BL-128) |
| `scope_location_id` | `uuid` | NULL, FK `mdm.location` | A pen, or null for the branch |
| `total_pesewas` | `pesewas` | NOT NULL, CHECK `> 0` | Amount to allocate, entered by the Accountant from the period's expense accounts |
| `posted_at`, `posted_by` | `timestamptz`, `uuid` | NULL, FK `iam.principal`; set together with `POSTED` | The checker |

Standard columns: `DOCUMENT` (`status` in `DRAFT`, `POSTED`; `version`, `created_*`, `updated_*`). The planned `approval_request_id` is not built: the checker posts the run directly, with step-up (A-387 (b)).

- Created as a `DRAFT` and posted once; nothing else of it ever changes (`ck_overhead_allocation_frozen`, HK004). No delete.
- `ck_overhead_allocation_checker`: `posted_by` is never `created_by`.
- `uq_overhead_allocation_posted`: one `POSTED` run per branch, cost element, scope and period.
- Deferred constraint trigger at commit: the lines sum exactly to `total_pesewas`, and a posted run has a movement for every capitalised share above nothing (HK010, `ck_overhead_allocation_allocated`).

### `cst.overhead_allocation_line` · DOCUMENT

One stock unit's share of an allocation run.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `run_id` | `uuid` | NOT NULL, FK `cst.overhead_allocation_run` | |
| `stock_unit_id` | `uuid` | NOT NULL, FK `inv.stock_unit` | |
| `weight` | `bigint` | NOT NULL, CHECK `> 0` | Head-days, or one for `EQUAL` |
| `amount_pesewas` | `pesewas` | NOT NULL | From `allocate` |
| `treatment` | `text` | NOT NULL, CHECK in (`CAPITALISED`, `EXPENSED`) | Growing stock is capitalised; breeding or laying stock, or a unit no longer on hand, expensed (ADR-0018) |
| `movement_ref` | `uuid` | NULL, FK `inv.stock_movement`, UNIQUE; null for an expensed share | The value-only `OVERHEAD_CAPITALISE` movement posted through inventory |

- PK (`run_id`, `stock_unit_id`). Written with its draft run; only `movement_ref` is set, once, when the run is posted. No delete.

### `cst.cost_object_summary` · PROJECTION

Accumulated cost per stock unit and per processing order by element. Refreshed by `cst.refresh_unit_costs` (from `inv.pub_movement`) and `cst.put_processing_order_costs`. A pen and a batch are read as the sum of their units' rows.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `object_type` | `text` | NOT NULL, CHECK in (`STOCK_UNIT`, `PROCESSING_ORDER`) | |
| `object_id` | `uuid` | NOT NULL | |
| `branch_id` | `uuid` | NOT NULL, FK `mdm.branch` | A unit's latest movement's branch |
| `product_id` | `uuid` | NULL, FK `mdm.product` | A unit's product |
| `purchase_pesewas` … `processing_pesewas` | `bigint` | NOT NULL DEFAULT 0 | Signed: what the element added less any reversal of it |
| `total_pesewas` | `bigint` | NOT NULL, CHECK the sum of the six | |
| `refreshed_at` | `timestamptz` | NOT NULL | |

- PK (`object_type`, `object_id`).

### `cst.margin_fact` · PROJECTION

One row per billed line of sales (`REVENUE`, keyed by the billing line) and per sale-related cost of sales (`COST`, keyed by the movement, or by the negative stock cost or settlement), for margin by product, line, channel, customer, salesperson and branch. Refreshed by `cst.refresh_margin_revenue` (from `bil.pub_document_line`, `ord.pub_sale_order`, `mdm.pub_product`) and `cst.refresh_margin_cost` (from `inv.pub_movement`, `inv.pub_negative_stock_cost`, `ord.pub_sale_line`).

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `fact_ref` | `uuid` | PK | The billing line, the movement, or the negative stock row |
| `fact_kind` | `text` | NOT NULL, CHECK in (`REVENUE`, `COST`) | A revenue row carries no cost; a cost row no revenue or variance |
| `document_date` | `date` | NOT NULL | The billing document's issue date, or the movement's Africa/Accra date |
| `branch_id` | `uuid` | NOT NULL, FK `mdm.branch` | |
| `product_id` | `uuid` | NULL, FK `mdm.product` | Null for a charge or adjustment line |
| `product_line` | `text` | NOT NULL | The category's line; `BY_PRODUCT` for a charge (it posts to 4030) |
| `channel` | `text` | NOT NULL, CHECK in (`POS`, `ONLINE`, `WHOLESALE`, `QUOTE`, `NONE`) | The order's, `NONE` with no order |
| `customer_ref`, `salesperson_ref` | `uuid` | NULL | |
| `is_credit` | `boolean` | NOT NULL | A credit note's line, a return or a reversal of an issue reduces |
| `qty`, `weight_kg` | `numeric(14,3)`, `numeric(12,3)` | NULL | |
| `revenue_pesewas` | `pesewas` | NOT NULL | Net of levies |
| `cost_pesewas` | `pesewas` | NOT NULL | Value of the stock issue |
| `price_variance_pesewas` | `bigint` | NOT NULL DEFAULT 0 | Signed as BIL publishes it: above zero, agreed below resolved |
| `refreshed_at` | `timestamptz` | NOT NULL | |

- Indexes on (`document_date`, `branch_id`), (`product_id`), (`customer_ref`). Break-even and contribution are queries over this table and the ledger's operating expenses. Nightly, net revenue and cost of sales equal 4000 to 4030 less 4200, 4210 and 4220, and 5000 to 5030 (FR-CST-004).

### `cst.loss_fact` · PROJECTION

Shrinkage, mortality and wastage as their own figure, not buried in cost of sales. Refreshed by `cst.refresh_loss_facts` (from `inv.pub_movement`, `mdm.pub_product`, `mdm.pub_reason_code`).

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `movement_ref` | `uuid` | PK | The write-off movement, or its reversal |
| `occurred_on` | `date` | NOT NULL | Africa/Accra |
| `branch_id` | `uuid` | NOT NULL, FK `mdm.branch` | |
| `location_id` | `uuid` | NOT NULL, FK `mdm.location` | Where the stock left |
| `product_id` | `uuid` | NOT NULL, FK `mdm.product` | |
| `product_line` | `text` | NOT NULL | |
| `loss_group` | `text` | NOT NULL, CHECK in (`MORTALITY`, `SHRINKAGE`, `WASTAGE`) | The reason's loss group, `SHRINKAGE` when it has none, as the ledger posts it |
| `reason_code` | `text` | NULL | |
| `handler_ref` | `uuid` | NULL | Who recorded it |
| `is_reversal` | `boolean` | NOT NULL | A reversal takes a write-off back |
| `qty` | `numeric(14,3)` | NOT NULL | |
| `value_pesewas` | `pesewas` | NOT NULL | |
| `refreshed_at` | `timestamptz` | NOT NULL | |
