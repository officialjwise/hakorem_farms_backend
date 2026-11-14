# Table dictionary: `rpt`

Owner: RPT module. The reporting schema: fact tables fed by events, report definitions, schedules and the record of every run and export (ADR-0023). Nothing here is a figure of record. Conventions are in `docs/DATA_MODEL.md`.

Fact tables hold ids from other modules as plain `_ref` columns without foreign keys, apart from the three universal keys. They are projections: they can be dropped and rebuilt, and a foreign key would only obstruct that.

---

### `rpt.report_definition` · LOOKUP

The reports that exist and who may run and export them.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `code` | `text` | PK | For example `DAILY_SALES_BY_CHANNEL`, `STOCK_ON_HAND`, `AGEING`, `EXCEPTIONS_DAILY` |
| `name` | `text` | NOT NULL | |
| `category` | `text` | NOT NULL, CHECK in (`OWNER`, `OPERATIONAL`, `FINANCIAL`, `EXCEPTION`) | |
| `permission_code` | `text` | NOT NULL | Who may run it |
| `export_permission_code` | `text` | NOT NULL | Export is a separate permission |
| `parameters` | `jsonb` | NOT NULL | Parameter schema |
| `is_bulk` | `boolean` | NOT NULL DEFAULT `false` | Export needs step-up authentication |

### `rpt.report_schedule` · MASTER

Reports delivered on a schedule.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `report_code` | `text` | NOT NULL, FK `rpt.report_definition` | |
| `branch_id` | `uuid` | NULL, FK `mdm.branch` | |
| `parameters` | `jsonb` | NOT NULL | |
| `cron` | `text` | NOT NULL | Schedule in Africa/Accra |
| `format` | `text` | NOT NULL, CHECK in (`PDF`, `XLSX`) | |
| `recipient_principal_ids` | `uuid[]` | NOT NULL | Recipients must hold the report's permission when it runs |
| `is_active` | `boolean` | NOT NULL DEFAULT `true` | |

Standard columns: `MASTER`.

### `rpt.report_run` · LEDGER

Every run and export.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `report_code` | `text` | NOT NULL, FK `rpt.report_definition` | |
| `schedule_id` | `uuid` | NULL, FK `rpt.report_schedule` | |
| `branch_id` | `uuid` | NULL, FK `mdm.branch` | |
| `parameters` | `jsonb` | NOT NULL | |
| `format` | `text` | NOT NULL, CHECK in (`SCREEN`, `PDF`, `XLSX`) | |
| `row_count` | `integer` | NOT NULL | Audited with every export |
| `file_id` | `uuid` | NULL, FK `platform.stored_file` | |
| `duration_ms` | `integer` | NOT NULL | |
| `data_as_of` | `timestamptz` | NOT NULL | Projection time shown on the report |

Standard columns: `LEDGER`.

### `rpt.projection_checkpoint` · WORK

Where each projector has read up to.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `projector` | `text` | PK | |
| `last_message_id` | `uuid` | NULL | Position in the outbox |
| `last_processed_at` | `timestamptz` | NULL | Lag, for the health endpoint |
| `rebuilt_at` | `timestamptz` | NULL | |

### `rpt.sales_fact` · PROJECTION

One row per billed line, with the payment and channel context the daily sales reports need.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `billing_line_ref` | `uuid` | PK | |
| `document_ref` | `uuid` | NOT NULL | |
| `document_kind` | `text` | NOT NULL | Credit notes carry `is_credit` |
| `is_credit` | `boolean` | NOT NULL | |
| `sale_date` | `date` | NOT NULL | Africa/Accra |
| `sale_hour` | `integer` | NOT NULL | Trading pattern |
| `branch_id` | `uuid` | NOT NULL, FK `mdm.branch` | |
| `channel` | `text` | NOT NULL | |
| `cashier_ref` | `uuid` | NULL | Sales by cashier |
| `shift_ref` | `uuid` | NULL | |
| `customer_ref` | `uuid` | NULL | |
| `product_ref` | `uuid` | NOT NULL | |
| `product_line` | `text` | NOT NULL | |
| `qty` | `numeric(14,3)` | NOT NULL | |
| `weight_kg` | `numeric(12,3)` | NULL | |
| `net_pesewas` | `pesewas` | NOT NULL | |
| `tax_pesewas` | `pesewas` | NOT NULL | |
| `gross_pesewas` | `pesewas` | NOT NULL | |
| `is_test_branch` | `boolean` | NOT NULL | Excluded from statutory reports |

- Indexes on (`sale_date`, `branch_id`), (`product_ref`, `sale_date`).

### `rpt.payment_fact` · PROJECTION

One row per payment, for sales by payment method.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `payment_ref` | `uuid` | PK | |
| `received_date` | `date` | NOT NULL | |
| `branch_id` | `uuid` | NOT NULL, FK `mdm.branch` | |
| `method_kind` | `text` | NOT NULL | Sales by payment method |
| `channel` | `text` | NULL | |
| `cashier_ref` | `uuid` | NULL | |
| `shift_ref` | `uuid` | NULL | |
| `status` | `text` | NOT NULL | |
| `amount_pesewas` | `pesewas` | NOT NULL | |
| `refunded_pesewas` | `pesewas` | NOT NULL DEFAULT 0 | |

### `rpt.stock_position_fact` · PROJECTION

Daily stock position for the dashboard, ageing stock and expiring lots.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `as_of_date` | `date` | NOT NULL | |
| `branch_id` | `uuid` | NOT NULL, FK `mdm.branch` | |
| `location_id` | `uuid` | NOT NULL, FK `mdm.location` | |
| `product_ref` | `uuid` | NOT NULL | |
| `stock_unit_ref` | `uuid` | NULL | |
| `on_hand_qty` | `numeric(14,3)` | NOT NULL | |
| `on_hand_weight_kg` | `numeric(12,3)` | NOT NULL | |
| `value_pesewas` | `pesewas` | NOT NULL | |
| `age_days` | `integer` | NULL | Since production or receipt |
| `days_to_expiry` | `integer` | NULL | |

- UNIQUE NULLS NOT DISTINCT (`as_of_date`, `location_id`, `product_ref`, `stock_unit_ref`).

### `rpt.receivable_fact` · PROJECTION

One row per open or settled invoice.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `document_ref` | `uuid` | PK | |
| `branch_id` | `uuid` | NOT NULL, FK `mdm.branch` | |
| `customer_ref` | `uuid` | NULL | |
| `issue_date` | `date` | NOT NULL | |
| `due_date` | `date` | NULL | |
| `gross_pesewas` | `pesewas` | NOT NULL | |
| `outstanding_pesewas` | `pesewas` | NOT NULL | Dashboard: outstanding receivables |

### `rpt.livestock_fact` · PROJECTION

Per pen and day: head count, mortality and feed, for mortality rate and feed conversion.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `fact_date` | `date` | NOT NULL | |
| `branch_id` | `uuid` | NOT NULL, FK `mdm.branch` | |
| `location_id` | `uuid` | NOT NULL, FK `mdm.location` | The pen |
| `species_ref` | `uuid` | NOT NULL | |
| `head_count` | `integer` | NOT NULL | |
| `deaths` | `integer` | NOT NULL DEFAULT 0 | |
| `culls` | `integer` | NOT NULL DEFAULT 0 | |
| `feed_qty` | `numeric(14,3)` | NOT NULL DEFAULT 0 | |
| `weight_gain_kg` | `numeric(12,3)` | NULL | Feed conversion is feed over gain |

- PK (`fact_date`, `location_id`, `species_ref`).

### `rpt.delivery_fact` · PROJECTION

One row per delivery, for delivery performance.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `delivery_ref` | `uuid` | PK | |
| `branch_id` | `uuid` | NOT NULL, FK `mdm.branch` | |
| `driver_ref` | `uuid` | NULL | |
| `zone_ref` | `uuid` | NOT NULL | |
| `scheduled_date` | `date` | NOT NULL | |
| `delivered_at` | `timestamptz` | NULL | |
| `on_time` | `boolean` | NULL | Within the slot |
| `attempts` | `integer` | NOT NULL | |
| `outcome` | `text` | NOT NULL | |
| `cod_due_pesewas` | `pesewas` | NOT NULL DEFAULT 0 | |
| `cod_collected_pesewas` | `pesewas` | NOT NULL DEFAULT 0 | Driver variance |

### `rpt.quote_fact` · PROJECTION

One row per quote, for the pipeline and win rate.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `quote_ref` | `uuid` | PK | |
| `branch_id` | `uuid` | NOT NULL, FK `mdm.branch` | |
| `salesperson_ref` | `uuid` | NOT NULL | |
| `product_line` | `text` | NULL | |
| `issued_on` | `date` | NULL | |
| `outcome` | `text` | NOT NULL | Issued, accepted, declined, expired, converted |
| `gross_pesewas` | `pesewas` | NOT NULL | |

### `rpt.exception_item` · PROJECTION

The daily exception report: one row per thing a manager must look at. This is the detection side of the threat model's abuse cases.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `event_ref` | `uuid` | NOT NULL, UNIQUE | The outbox message that raised it |
| `exception_date` | `date` | NOT NULL | |
| `branch_id` | `uuid` | NOT NULL, FK `mdm.branch` | |
| `kind` | `text` | NOT NULL, CHECK in (`SALE_VOID`, `PRICE_OVERRIDE`, `REFUND`, `MORTALITY`, `STOCK_ADJUSTMENT`, `STOCK_EXCEPTION`, `UNMATCHED_PAYMENT`, `WEBHOOK_REJECTED`, `DRIVER_VARIANCE`, `SHIFT_OVER_SHORT`, `DEVICE_COUNTER_GAP`, `AUTHORISATION_FAILURE`, `BULK_EXPORT`, `CREDIT_OVERRIDE`, `AUDIT_INTEGRITY`, `RECONCILIATION_BREAK`, `PAYOUT_DETAIL_CHANGE`, `PERMISSION_CHANGE`, `YIELD_VARIANCE`, `SYNC_REJECTED`, `LATE_POSTING`) | One kind per detection in the threat model |
| `abuse_cases` | `integer[]` | NOT NULL DEFAULT `'{}'` | Numbers of the threat model's abuse cases this item helps detect. B13 asserts every case appears on at least one kind |
| `severity` | `text` | NOT NULL, CHECK in (`INFO`, `REVIEW`, `URGENT`) | |
| `actor_ref` | `uuid` | NULL | Who did it |
| `subject_document_ref` | `uuid` | NULL | The sale, adjustment or payment |
| `amount_pesewas` | `pesewas` | NULL | |
| `summary` | `text` | NOT NULL | Enough detail to act on |
| `details` | `jsonb` | NOT NULL | |

- Indexes on (`exception_date`, `branch_id`), (`kind`, `actor_ref`, `exception_date`) for rate-by-user reports.
