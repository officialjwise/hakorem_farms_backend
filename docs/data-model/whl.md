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

A customer statement for a period at one branch (FR-WHL-009). Posted status: `ISSUED`. Built in B08 continued 2d (migration 0242, ADR-0085, A-300): the figures are the customer's trade receivables (1200 against its `CUSTOMER` subledger party at the branch), read through FIN's `Journals.customerReceivablesIn` in the producing transaction.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK, FK `platform.business_document` | Registered as a `STATEMENT` document, owned by WHL (0240) |
| `statement_no` | `text` | NULL, UNIQUE; set exactly when `ISSUED` | `STM-<YEAR>-<BRANCH>-<SEQUENCE>`, from the `STATEMENT` series of the issue date's year |
| `customer_id` | `uuid` | NOT NULL, FK `mdm.customer` | |
| `period_start` | `date` | NOT NULL | |
| `period_end` | `date` | NOT NULL, CHECK `>= period_start` | Today at the latest, at most 366 days on (checked by the application) |
| `opening_pesewas` | `pesewas` | NOT NULL | Owed by the customer before the period; zero when in credit |
| `opening_credit_pesewas` | `pesewas` | NOT NULL | Held for the customer before the period; zero when owing (`ck_statement_opening`: one of the two is zero) |
| `invoiced_pesewas` | `pesewas` | NOT NULL | Invoices, receipts to the customer and debit notes |
| `paid_pesewas` | `pesewas` | NOT NULL | Payments |
| `credited_pesewas` | `pesewas` | NOT NULL | Credit notes |
| `other_charges_pesewas` | `pesewas` | NOT NULL | Refunds paid, payments reversed or allocations taken off, journals debited |
| `other_credits_pesewas` | `pesewas` | NOT NULL | Journals credited |
| `closing_pesewas` | `pesewas` | NOT NULL | Owed by the customer at the end; zero when in credit |
| `closing_credit_pesewas` | `pesewas` | NOT NULL | Held for the customer at the end (`ck_statement_closing`) |
| `issue_date` | `date` | NULL; set exactly when `ISSUED` | Business date in Africa/Accra |
| `archived_document_id` | `uuid` | NULL, FK `doc.archived_document`, UNIQUE where set | The archived rendering, set once by WHL's `whl.statement-archive-link` after DOC archives it |
| `currency` | `char(3)` | NOT NULL DEFAULT `'GHS'`, CHECK `= 'GHS'` | |

Standard columns: `DOCUMENT` (`status` in `DRAFT`, `ISSUED`; `posted_at`, `posted_by` set exactly when `ISSUED`).

- `ck_statement_balances`: opening less opening credit, plus invoiced and other charges, less credited, paid and other credits, equals closing less closing credit, exactly.
- `ck_statement_issued`: an `ISSUED` statement has its number, issue date and posting columns; a `DRAFT` has none. `ck_statement_archive`: only an issued statement is archived.
- UNIQUE (`customer_id`, `branch_id`, `period_start`, `period_end`) WHERE `status = 'ISSUED'` (`uq_statement_issued_period`): asking for the same period again answers the first.
- `whl.statement_guard` (HK004 `ck_statement_frozen`): written once; afterwards only `archived_document_id` is set, once, from null.
- Deferred `whl.statement_check` (HK010) at commit, on the header and on every line: the totals are the lines' sums by kind, one brought-forward line comes first, every running balance follows from the opening and the last is the closing (`ck_statement_totals`); an issued statement's number is the one `platform.allocate_number` gave it (`ck_statement_number`).
- Indexes: (`branch_id`, `id`); (`customer_id`, `period_end`).
- A customer in credit is shown with a closing balance of zero and the credit beside it (`closing_credit_pesewas`), each line's running balance marked `C` (A-300 (c)).

### `whl.statement_line` · LEDGER

The lines of a statement as produced: the brought-forward line first, then each 1200 line in ledger order (posting date, journal number, line). Insert-only (`platform.reject_change()`). Built in B08 continued 2d.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `statement_id` | `uuid` | NOT NULL, FK `whl.statement` | |
| `line_no` | `integer` | NOT NULL, CHECK `> 0` | From 1 |
| `line_date` | `date` | NOT NULL | The posting date; the period's first day for the brought-forward line |
| `kind` | `text` | NOT NULL, CHECK in (`OPENING`, `INVOICE`, `PAYMENT`, `CREDIT_NOTE`, `DEBIT_NOTE`, `REFUND`, `PAYMENT_REVERSAL`, `ADJUSTMENT`) | By the event that posted it and its side (ADR-0085) |
| `reference` | `text` | NOT NULL, 1 to 120 characters | The source document's number, or `Payment` or `Journal` and the journal's number |
| `debit_pesewas` | `pesewas` | NOT NULL | |
| `credit_pesewas` | `pesewas` | NOT NULL | |
| `balance_pesewas` | `pesewas` | NOT NULL | The running balance after the line |
| `balance_side` | `char(1)` | NOT NULL, CHECK in (`D`, `C`); `D` when the balance is zero | Who owes whom |
| `source_document_id` | `uuid` | NULL, FK `platform.business_document`; null exactly on the brought-forward line | |

Standard columns: `LEDGER`. PK (`statement_id`, `line_no`). `ck_statement_line_amounts`: the brought-forward line moves nothing; every other line is one debit or one credit. `ck_statement_line_direction`: invoices, debit notes, refunds and reversals are debits, credit notes and payments credits.

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
