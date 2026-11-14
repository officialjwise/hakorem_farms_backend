# Table dictionary: `cap`

Owner: CAP module. Investors, capital and units, profit distribution, loans and grants (ADR-0028). Conventions are in `docs/DATA_MODEL.md`.

---

### `cap.investor` · MASTER

The investor register.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | The investor subledger party in the ledger |
| `investor_no` | `text` | NOT NULL, UNIQUE | Tie-break key for allocations |
| `kind` | `text` | NOT NULL, CHECK in (`INDIVIDUAL`, `ENTITY`) | |
| `legal_name` | `text` | NOT NULL | Confidential |
| `phone_e164` | `text` | NULL | |
| `email` | `text` | NULL | |
| `principal_id` | `uuid` | NULL, UNIQUE, FK `iam.principal` | Portal login; the ownership rule keys on this |
| `id_number_enc` | `bytea` | NULL | Identity number, encrypted (restricted) |
| `payout_method` | `text` | NULL, CHECK in (`BANK`, `MOBILE_MONEY`) | |
| `payout_details_enc` | `bytea` | NULL | Encrypted (restricted) |
| `payout_last4` | `text` | NULL | |
| `agreement_file_id` | `uuid` | NULL, FK `platform.stored_file` | The investment agreement |
| `joined_on` | `date` | NOT NULL | |
| `status` | `text` | NOT NULL, CHECK in (`ACTIVE`, `EXITED`) | |

Standard columns: `MASTER`.

### `cap.investor_document` · MASTER

Documents held for an investor.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `investor_id` | `uuid` | NOT NULL, FK `cap.investor` | |
| `kind` | `text` | NOT NULL | Agreement, identification, statement |
| `file_id` | `uuid` | NOT NULL, FK `platform.stored_file` | |

Standard columns: `MASTER`.

### `cap.capital_transaction` · LEDGER

Contributions and withdrawals, each issuing or redeeming units. Registered as a business document.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK, FK `platform.business_document` | |
| `transaction_no` | `text` | NOT NULL, UNIQUE | |
| `investor_id` | `uuid` | NOT NULL, FK `cap.investor` | |
| `branch_id` | `uuid` | NOT NULL, FK `mdm.branch` | |
| `kind` | `text` | NOT NULL, CHECK in (`CONTRIBUTION`, `WITHDRAWAL`) | |
| `amount_pesewas` | `pesewas` | NOT NULL, CHECK `> 0` | |
| `value_date` | `date` | NOT NULL | The effective date of the units: the contribution day counts, the withdrawal day does not (ADR-0028) |
| `unit_price_pesewas` | `pesewas` | NOT NULL, CHECK `> 0` | Price per unit at this transaction; default GHS 1.00 |
| `units` | `numeric(18,4)` | NOT NULL, CHECK `> 0` | Units issued or redeemed |
| `bank_account_id` | `uuid` | NOT NULL, FK `fin.bank_account` | Where the money arrived or left |
| `external_reference` | `text` | NULL | Bank reference |
| `approval_request_id` | `uuid` | NULL, FK `iam.approval_request`; required for `WITHDRAWAL` | |
| `reverses_transaction_id` | `uuid` | NULL, UNIQUE, FK `cap.capital_transaction` | |

Standard columns: `LEDGER`.

- Trigger: a withdrawal cannot redeem more units than the investor holds on its value date. Maintains `cap.unit_holding`.
- Index (`investor_id`, `value_date`).

### `cap.unit_holding` · PROJECTION

Current units per investor. Percentages are computed from these on request; they are never stored.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `investor_id` | `uuid` | PK, FK `cap.investor` | |
| `units` | `numeric(18,4)` | NOT NULL, CHECK `>= 0` | |
| `contributed_pesewas` | `pesewas` | NOT NULL | Total paid in |
| `withdrawn_pesewas` | `pesewas` | NOT NULL | Total withdrawn |
| `updated_at` | `timestamptz` | NOT NULL | |

### `cap.distribution_run` · DOCUMENT

A profit distribution for a period. Posted statuses: `POSTED`, `PAID`, `REJECTED`.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK, FK `platform.business_document` | |
| `run_no` | `text` | NULL, UNIQUE | |
| `period_start` | `date` | NOT NULL | Inclusive |
| `period_end` | `date` | NOT NULL, CHECK `>= period_start` | Inclusive |
| `days_in_period` | `integer` | NOT NULL, CHECK `= period_end - period_start + 1` | Actual days |
| `net_profit_pesewas` | `pesewas` | NOT NULL | Read from the ledger; zero if the period made a loss |
| `is_loss` | `boolean` | NOT NULL DEFAULT `false` | A loss period allocates nothing |
| `retention_rate_percent` | `percent` | NOT NULL | Snapshot of the owner's setting |
| `retained_pesewas` | `pesewas` | NOT NULL | `half_up(net_profit × rate)` |
| `distributable_pesewas` | `pesewas` | NOT NULL, CHECK `= net_profit_pesewas - retained_pesewas` | |
| `allocation_method` | `text` | NOT NULL DEFAULT `'UNIT_DAYS'`, CHECK `= 'UNIT_DAYS'` | States the rule the run used |
| `day_count_convention` | `text` | NOT NULL | The convention as text, for the record |
| `total_unit_days` | `numeric(24,4)` | NULL | Sum of the lines' weights |
| `withholding_rate_percent` | `percent` | NOT NULL DEFAULT 0 | Pending the accountant |
| `approval_request_id` | `uuid` | NULL, FK `iam.approval_request`; required to post | Different user, with step-up |
| `schedule_document_id` | `uuid` | NULL, FK `doc.archived_document` | The distribution schedule as approved |
| `posted_journal_ref` | `uuid` | NULL | The declaring journal entry |

Standard columns: `DOCUMENT` (`status` in `DRAFT`, `PENDING_APPROVAL`, `APPROVED`, `POSTED`, `PAID`, `REJECTED`).

- EXCLUDE: periods of runs that are not `REJECTED` do not overlap. Profit is distributed once.
- Deferred trigger before leaving `DRAFT`: the sum of `cap.distribution_line.allocated_pesewas` equals `distributable_pesewas`. No pesewa is created or lost.

### `cap.distribution_line` · DOCUMENT

One investor's share of a run. Frozen when the run is approved, except the paid columns.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `distribution_run_id` | `uuid` | NOT NULL, FK `cap.distribution_run` | |
| `investor_id` | `uuid` | NOT NULL, FK `cap.investor` | |
| `unit_days` | `numeric(24,4)` | NOT NULL, CHECK `>= 0` | The weight: units multiplied by days held |
| `allocated_pesewas` | `pesewas` | NOT NULL | From `allocate`, largest remainder |
| `received_extra_pesewa` | `boolean` | NOT NULL DEFAULT `false` | Whether a leftover pesewa landed here, so the schedule can show its working |
| `withheld_pesewas` | `pesewas` | NOT NULL DEFAULT 0 | |
| `net_payable_pesewas` | `pesewas` | NOT NULL, CHECK `= allocated_pesewas - withheld_pesewas` | |
| `paid_pesewas` | `pesewas` | NOT NULL DEFAULT 0, CHECK `<= net_payable_pesewas` | Maintained from payments |

- UNIQUE (`distribution_run_id`, `investor_id`).

### `cap.distribution_payment` · LEDGER

Money actually paid to an investor against a distribution line.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `distribution_line_id` | `uuid` | NOT NULL, FK `cap.distribution_line` | |
| `amount_pesewas` | `pesewas` | NOT NULL, CHECK `> 0` | |
| `bank_account_id` | `uuid` | NOT NULL, FK `fin.bank_account` | |
| `external_reference` | `text` | NULL, UNIQUE | Bank or mobile money reference |
| `paid_at` | `timestamptz` | NOT NULL | |

Standard columns: `LEDGER`.

### `cap.financing` · DOCUMENT

A loan or grant: capital that is debt, or a gift, rather than equity. Posted statuses: `SETTLED`, `CANCELLED`.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK, FK `platform.business_document` | |
| `financing_no` | `text` | NULL, UNIQUE | |
| `kind` | `text` | NOT NULL, CHECK in (`LOAN`, `GRANT`) | |
| `lender_investor_id` | `uuid` | NULL, FK `cap.investor` | When the lender is also registered as an investor |
| `lender_name` | `text` | NOT NULL | |
| `principal_pesewas` | `pesewas` | NOT NULL, CHECK `> 0` | |
| `annual_rate_percent` | `percent` | NOT NULL DEFAULT 0 | |
| `interest_basis` | `text` | NOT NULL DEFAULT `'ACTUAL_365'`, CHECK in (`ACTUAL_365`, `FLAT`) | |
| `start_date` | `date` | NOT NULL | |
| `term_months` | `integer` | NULL | |
| `outstanding_pesewas` | `pesewas` | NOT NULL | Maintained from repayments |
| `agreement_file_id` | `uuid` | NULL, FK `platform.stored_file` | |

Standard columns: `DOCUMENT` (`status` in `DRAFT`, `ACTIVE`, `SETTLED`, `CANCELLED`).

### `cap.financing_schedule_line` · DOCUMENT

Repayment schedule of a loan.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `financing_id` | `uuid` | NOT NULL, FK `cap.financing` | |
| `instalment_no` | `integer` | NOT NULL | |
| `due_date` | `date` | NOT NULL | |
| `principal_due_pesewas` | `pesewas` | NOT NULL | The last instalment takes the remainder, so the schedule sums to the principal |
| `interest_due_pesewas` | `pesewas` | NOT NULL | |
| `paid_pesewas` | `pesewas` | NOT NULL DEFAULT 0 | |

- PK (`financing_id`, `instalment_no`).

### `cap.financing_repayment` · LEDGER

A repayment of principal and interest.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `financing_id` | `uuid` | NOT NULL, FK `cap.financing` | |
| `principal_pesewas` | `pesewas` | NOT NULL | |
| `interest_pesewas` | `pesewas` | NOT NULL | |
| `bank_account_id` | `uuid` | NOT NULL, FK `fin.bank_account` | |
| `external_reference` | `text` | NULL | |
| `paid_at` | `timestamptz` | NOT NULL | |

Standard columns: `LEDGER`.

Return on investment, payback period and internal rate of return are computed on request from capital transactions and distribution payments. They are not stored.
