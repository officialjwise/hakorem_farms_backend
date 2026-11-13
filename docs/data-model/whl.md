# Table dictionary: `whl`

Owner: WHL module. Business accounts, credit control, standing orders, statements, ageing and dunning. Conventions are in `docs/DATA_MODEL.md`.

---

### `whl.business_account` · MASTER

Credit terms for a customer whose identity is `mdm.customer`.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `customer_id` | `uuid` | PK, FK `mdm.customer` | |
| `credit_limit_pesewas` | `pesewas` | NOT NULL DEFAULT 0 | |
| `payment_terms_days` | `integer` | NOT NULL DEFAULT 0, CHECK `>= 0` | Invoice due date |
| `account_manager_id` | `uuid` | NULL, FK `iam.principal` | |
| `overdue_hold_days` | `integer` | NOT NULL DEFAULT 30, CHECK `> 0` | Days overdue after which the account is held automatically |
| `status` | `text` | NOT NULL, CHECK in (`ACTIVE`, `ON_HOLD`, `CLOSED`) | |
| `hold_reason` | `text` | NULL | |
| `held_at` | `timestamptz` | NULL | |
| `exposure_pesewas` | `pesewas` | NOT NULL DEFAULT 0 | Outstanding invoices plus confirmed unbilled orders; maintained by subscribers |

Standard columns: `MASTER`. A change to the credit limit is audited and needs approval above a configured amount.

### `whl.credit_override` · LEDGER

An approved exception to the credit limit or an account hold.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `customer_id` | `uuid` | NOT NULL, FK `mdm.customer` | |
| `order_id` | `uuid` | NOT NULL, FK `ord.sales_order` | |
| `limit_pesewas` | `pesewas` | NOT NULL | The limit at the time |
| `exposure_pesewas` | `pesewas` | NOT NULL | Exposure including this order |
| `approval_request_id` | `uuid` | NOT NULL, FK `iam.approval_request` | Audited override |

Standard columns: `LEDGER`.

### `whl.standing_order` · DOCUMENT

A recurring order. Posted statuses: `ENDED`, `CANCELLED`.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK, FK `platform.business_document` | |
| `customer_id` | `uuid` | NOT NULL, FK `mdm.customer` | |
| `frequency` | `text` | NOT NULL, CHECK in (`WEEKLY`, `FORTNIGHTLY`, `MONTHLY`) | |
| `weekday` | `integer` | NULL, CHECK between 1 and 7 | |
| `day_of_month` | `integer` | NULL, CHECK between 1 and 28 | |
| `starts_on` | `date` | NOT NULL | |
| `ends_on` | `date` | NULL | |
| `next_run_on` | `date` | NULL | |
| `delivery_address_id` | `uuid` | NULL, FK `mdm.customer_address` | |

Standard columns: `DOCUMENT` (`status` in `ACTIVE`, `PAUSED`, `ENDED`, `CANCELLED`).

### `whl.standing_order_line` · DOCUMENT

Products on a standing order.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `standing_order_id` | `uuid` | NOT NULL, FK `whl.standing_order` | |
| `line_no` | `integer` | NOT NULL | |
| `product_id` | `uuid` | NOT NULL, FK `mdm.product` | |
| `qty` | `qty` | NOT NULL, CHECK `> 0` | Priced by the engine each time it runs |

- UNIQUE (`standing_order_id`, `line_no`).

### `whl.standing_order_run` · LEDGER

Each scheduled run of a standing order.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `standing_order_id` | `uuid` | NOT NULL, FK `whl.standing_order` | |
| `run_date` | `date` | NOT NULL | |
| `order_id` | `uuid` | NULL, FK `ord.sales_order` | The order created |
| `outcome` | `text` | NOT NULL, CHECK in (`CREATED`, `SKIPPED_ON_HOLD`, `SKIPPED_NO_PRICE`, `FAILED`) | |
| `recorded_at` | `timestamptz` | NOT NULL DEFAULT `now()` | |

- PK (`standing_order_id`, `run_date`): a run happens once per date.

### `whl.statement` · DOCUMENT

A customer statement for a period. Posted status: `ISSUED`.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK, FK `platform.business_document` | |
| `statement_no` | `text` | NULL, UNIQUE | |
| `customer_id` | `uuid` | NOT NULL, FK `mdm.customer` | |
| `period_start` | `date` | NOT NULL | |
| `period_end` | `date` | NOT NULL | |
| `opening_pesewas` | `pesewas` | NOT NULL | |
| `invoiced_pesewas` | `pesewas` | NOT NULL | |
| `paid_pesewas` | `pesewas` | NOT NULL | |
| `credited_pesewas` | `pesewas` | NOT NULL | |
| `closing_pesewas` | `pesewas` | NOT NULL | |
| `archived_document_id` | `uuid` | NULL, FK `doc.archived_document` | |

Standard columns: `DOCUMENT` (`status` in `DRAFT`, `ISSUED`). A customer in credit is shown with a closing balance of zero and the credit as an unallocated deposit line.

### `whl.dunning_policy` · MASTER

The reminder levels and when each fires.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `level` | `integer` | NOT NULL, UNIQUE, CHECK `> 0` | |
| `days_overdue` | `integer` | NOT NULL, CHECK `> 0` | When this level fires |
| `channels` | `text[]` | NOT NULL | SMS, email |
| `template_code` | `text` | NOT NULL | The notification template to use |

Standard columns: `MASTER`.

### `whl.dunning_notice` · LEDGER

Reminders sent, per invoice and level.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `customer_id` | `uuid` | NOT NULL, FK `mdm.customer` | |
| `billing_document_id` | `uuid` | NOT NULL, FK `bil.billing_document` | |
| `level` | `integer` | NOT NULL | |
| `outstanding_pesewas` | `pesewas` | NOT NULL | At the time of the notice |

Standard columns: `LEDGER`. UNIQUE (`billing_document_id`, `level`): each level is sent once per invoice.

### `whl.ageing_snapshot` · PROJECTION

Receivables by age bucket per customer, as at a date.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `customer_id` | `uuid` | NOT NULL, FK `mdm.customer` | |
| `as_of_date` | `date` | NOT NULL | |
| `current_pesewas` | `pesewas` | NOT NULL | Not yet due |
| `days_1_30_pesewas` | `pesewas` | NOT NULL | |
| `days_31_60_pesewas` | `pesewas` | NOT NULL | |
| `days_61_90_pesewas` | `pesewas` | NOT NULL | |
| `days_over_90_pesewas` | `pesewas` | NOT NULL | |
| `computed_at` | `timestamptz` | NOT NULL | |

- PK (`customer_id`, `as_of_date`). Computed from `pay.pub_open_item`. The live ageing report computes the same buckets for any date on request.
