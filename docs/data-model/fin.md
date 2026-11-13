# Table dictionary: `fin`

Owner: FIN module. Chart of accounts, journal, posting rules, periods, fixed assets (ADR-0003). Conventions are in `docs/DATA_MODEL.md`.

## Triggers

| Trigger | Purpose |
| --- | --- |
| `fin.assert_balanced()`, a deferred constraint trigger on `fin.journal_line` | At commit, for every entry touched: sum of `D` amounts equals sum of `C` amounts, and the entry has at least two lines. This is the constraint that no journal may post unbalanced |
| `fin.assert_period_open()` on insert of `fin.journal_entry` | Rejects an entry whose `posting_date` is in a period that is not `OPEN` |
| `fin.assert_line_valid()` on insert of `fin.journal_line` | The account is postable; `subledger_party_id` is present exactly when the account has a `subledger_kind`, and the party is of that kind |

---

### `fin.account` · MASTER

The chart of accounts. Seeded as listed in ADR-0003.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `code` | `text` | NOT NULL, UNIQUE, CHECK matches `^[1-6][0-9]{3}$` | First digit gives the class |
| `name` | `text` | NOT NULL | |
| `type` | `text` | NOT NULL, CHECK in (`ASSET`, `LIABILITY`, `EQUITY`, `INCOME`, `COST_OF_SALES`, `EXPENSE`) | Statement placement |
| `normal_side` | `char(1)` | NOT NULL, CHECK in (`D`, `C`) | Sign convention for reports |
| `parent_id` | `uuid` | NULL, FK `fin.account` | Roll-up |
| `is_postable` | `boolean` | NOT NULL | Header accounts take no lines |
| `subledger_kind` | `text` | NULL, CHECK in (`CUSTOMER`, `SUPPLIER`, `INVESTOR`, `TAX_LEVY`, `REGISTER`, `DRIVER`, `BANK_ACCOUNT`, `PROVIDER`) | Control account breakdown |
| `cash_flow_category` | `text` | NULL, CHECK in (`OPERATING`, `INVESTING`, `FINANCING`) | Cash flow statement |
| `status` | `text` | NOT NULL, CHECK in (`ACTIVE`, `CLOSED`) | A closed account takes no new lines |

Standard columns: `MASTER`. An account with lines is never soft-deleted.

### `fin.bank_account` · MASTER

The business's own bank accounts and mobile money wallets. Published key.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `kind` | `text` | NOT NULL, CHECK in (`BANK`, `MOBILE_MONEY`) | |
| `name` | `text` | NOT NULL | "GCB current account", "MTN MoMo merchant" |
| `institution` | `text` | NOT NULL | |
| `account_no_enc` | `bytea` | NOT NULL | Encrypted |
| `account_no_last4` | `text` | NOT NULL | For display and matching |
| `gl_account_id` | `uuid` | NOT NULL, FK `fin.account` | 1100 or 1110 |
| `branch_id` | `uuid` | NULL, FK `mdm.branch` | |
| `is_active` | `boolean` | NOT NULL DEFAULT `true` | |

Standard columns: `MASTER`.

### `fin.subledger_party` · MASTER

Registry of parties that appear on control accounts, so that a journal line's subledger reference is a real foreign key without FIN referencing higher modules.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `kind` | `text` | NOT NULL, same values as `fin.account.subledger_kind` | |
| `ref_id` | `uuid` | NOT NULL | The party's id in its owning module (customer, supplier, investor, levy, register, driver principal, bank account, provider) |
| `display_name` | `text` | NOT NULL | Snapshot for statements |
| `created_at` | `timestamptz` | NOT NULL DEFAULT `now()` | |

- UNIQUE (`kind`, `ref_id`). Created by the posting handler the first time a party is posted to. Never deleted.

### `fin.accounting_period` · DOCUMENT

Published key.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `fiscal_year` | `integer` | NOT NULL | |
| `period_no` | `integer` | NOT NULL, CHECK between 1 and 12 | Monthly periods |
| `start_date` | `date` | NOT NULL | |
| `end_date` | `date` | NOT NULL, CHECK `>= start_date` | |
| `status` | `text` | NOT NULL, CHECK in (`FUTURE`, `OPEN`, `LOCKED`, `CLOSED`) | `LOCKED` blocks posting but can be reopened by the Owner; `CLOSED` is final |
| `locked_at` | `timestamptz` | NULL | |
| `locked_by` | `uuid` | NULL, FK `iam.principal` | |
| `closed_at` | `timestamptz` | NULL | |
| `closed_by` | `uuid` | NULL, FK `iam.principal` | |
| `version` | `integer` | NOT NULL DEFAULT 1 | Posting transactions read this row; lock and close write it (ADR-0005) |

- UNIQUE (`fiscal_year`, `period_no`). EXCLUDE: date ranges do not overlap.
- Trigger: `CLOSED` never changes.

### `fin.posting_event_type` · LOOKUP

Catalogue of events the ledger posts from. The boot assertion checks every row has a handler and rules.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `code` | `text` | PK | The event type, for example `inv.StockIssuedForSale` |
| `owner_module` | `text` | NOT NULL | |
| `description` | `text` | NOT NULL | |
| `amount_keys` | `text[]` | NOT NULL | The named amounts the event carries |

### `fin.posting_rule` · MASTER

How one named amount of one event becomes a journal line. Effective-dated; a change needs approval.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `event_code` | `text` | NOT NULL, FK `fin.posting_event_type` | |
| `amount_key` | `text` | NOT NULL | Which amount of the event |
| `side` | `char(1)` | NOT NULL, CHECK in (`D`, `C`) | |
| `account_id` | `uuid` | NULL, FK `fin.account` | A fixed account |
| `determinant_type` | `text` | NULL | Or: look the account up in `fin.account_determination` by this determinant |
| `determinant_role` | `text` | NULL | Which role of the determinant, for example `INVENTORY`, `SALES`, `COST_OF_SALES` |
| `subledger_from` | `text` | NULL | Which field of the event names the subledger party |
| `valid_from` | `date` | NOT NULL | |
| `valid_to` | `date` | NULL | |
| `approval_request_id` | `uuid` | NOT NULL, FK `iam.approval_request` | Maker-checker |

Standard columns: `MASTER`.

- CHECK: exactly one of `account_id`, `determinant_type` is set.
- EXCLUDE: for one (`event_code`, `amount_key`, `side`), validity ranges do not overlap.

### `fin.account_determination` · MASTER

Maps a determinant value to an account.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `determinant_type` | `text` | NOT NULL, CHECK in (`GL_GROUP`, `PAYMENT_METHOD_KIND`, `TAX_LEVY`, `LOSS_GROUP`, `EXPENSE_CATEGORY`, `ASSET_CATEGORY`) | |
| `determinant_key` | `text` | NOT NULL | For example `MEAT`, `MOBILE_MONEY`, a levy code or `*` for the default |
| `role` | `text` | NOT NULL | `INVENTORY`, `SALES`, `COST_OF_SALES`, `TENDER`, `OUTPUT`, `INPUT`, `LOSS`, `EXPENSE` |
| `account_id` | `uuid` | NOT NULL, FK `fin.account` | |
| `valid_from` | `date` | NOT NULL | |
| `valid_to` | `date` | NULL | |

Standard columns: `MASTER`.

- EXCLUDE: for one (`determinant_type`, `determinant_key`, `role`), validity ranges do not overlap.
- A levy with no row of its own uses the `*` row, which points at the control account 2100 or 1400 (ADR-0020).

### `fin.journal_entry` · LEDGER

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK, FK `platform.business_document` | A journal is itself a numbered document |
| `entry_no` | `text` | NOT NULL, UNIQUE | Gap-free, from the journal series |
| `posting_date` | `date` | NOT NULL | Business date in Africa/Accra |
| `period_id` | `uuid` | NOT NULL, FK `fin.accounting_period` | |
| `branch_id` | `uuid` | NOT NULL, FK `mdm.branch` | |
| `kind` | `text` | NOT NULL, CHECK in (`AUTO`, `MANUAL`, `OPENING`, `CLOSING`, `REVERSAL`) | |
| `event_code` | `text` | NULL, FK `fin.posting_event_type`; required for `AUTO` | Which event produced it |
| `event_id` | `uuid` | NULL, UNIQUE | The outbox message id of that event. A replayed event collides here |
| `source_document_id` | `uuid` | NOT NULL, FK `platform.business_document` | The business document behind it |
| `posting_group_id` | `uuid` | NOT NULL | Ties the entries of one business operation together |
| `description` | `text` | NOT NULL | |
| `currency` | `char(3)` | NOT NULL DEFAULT `'GHS'`, CHECK `= 'GHS'` | |
| `reverses_entry_id` | `uuid` | NULL, UNIQUE, FK `fin.journal_entry` | A correction |
| `occurred_at` | `timestamptz` | NOT NULL | When the business event happened |

Standard columns: `LEDGER`.

- Indexes: (`period_id`, `posting_date`); (`source_document_id`); (`posting_group_id`).

### `fin.journal_line` · LEDGER

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `journal_entry_id` | `uuid` | NOT NULL, FK `fin.journal_entry` | |
| `line_no` | `integer` | NOT NULL, CHECK `> 0` | |
| `account_id` | `uuid` | NOT NULL, FK `fin.account` | |
| `side` | `char(1)` | NOT NULL, CHECK in (`D`, `C`) | |
| `amount_pesewas` | `pesewas` | NOT NULL, CHECK `> 0` | |
| `branch_id` | `uuid` | NOT NULL, FK `mdm.branch` | A dimension, so an inter-branch transfer balances within one entry |
| `subledger_party_id` | `uuid` | NULL, FK `fin.subledger_party` | Required exactly when the account has a subledger |
| `product_line` | `text` | NULL | Reporting dimension |
| `cost_object_id` | `uuid` | NULL | Stock unit, processing order or asset the amount relates to |
| `memo` | `text` | NULL | |
| `posting_date` | `date` | NOT NULL | Copied from the entry for index-only range scans |
| `recorded_at` | `timestamptz` | NOT NULL DEFAULT `now()` | |

- PK (`journal_entry_id`, `line_no`).
- Indexes: (`account_id`, `posting_date`); (`subledger_party_id`, `account_id`, `posting_date`).
- Not partitioned in version one (ADR-0003).

### `fin.manual_journal` · DOCUMENT

A journal entered by a person. Posted statuses: `POSTED`, `REJECTED`.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK, FK `platform.business_document` | |
| `posting_date` | `date` | NOT NULL | |
| `description` | `text` | NOT NULL | |
| `kind` | `text` | NOT NULL, CHECK in (`MANUAL`, `OPENING`) | The opening balance journal is entered this way |
| `approval_request_id` | `uuid` | NULL, FK `iam.approval_request`; required to post | Maker-checker |
| `journal_entry_id` | `uuid` | NULL, FK `fin.journal_entry` | Set when posted |

Standard columns: `DOCUMENT` (`status` in `DRAFT`, `PENDING_APPROVAL`, `POSTED`, `REJECTED`).

### `fin.manual_journal_line` · DOCUMENT

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `manual_journal_id` | `uuid` | NOT NULL, FK `fin.manual_journal` | |
| `line_no` | `integer` | NOT NULL | |
| `account_id` | `uuid` | NOT NULL, FK `fin.account` | |
| `side` | `char(1)` | NOT NULL, CHECK in (`D`, `C`) | |
| `amount_pesewas` | `pesewas` | NOT NULL, CHECK `> 0` | |
| `subledger_party_id` | `uuid` | NULL, FK `fin.subledger_party` | |
| `memo` | `text` | NULL | |

- UNIQUE (`manual_journal_id`, `line_no`). Frozen with its header.

### `fin.period_balance` · PROJECTION

Totals per period, account, branch and subledger party. Computed when a period is locked and refreshed nightly for open periods. Trial balance is these rows plus lines since.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `period_id` | `uuid` | NOT NULL, FK `fin.accounting_period` | |
| `account_id` | `uuid` | NOT NULL, FK `fin.account` | |
| `branch_id` | `uuid` | NOT NULL, FK `mdm.branch` | |
| `subledger_party_id` | `uuid` | NULL, FK `fin.subledger_party` | |
| `debit_total_pesewas` | `pesewas` | NOT NULL | |
| `credit_total_pesewas` | `pesewas` | NOT NULL | |
| `computed_at` | `timestamptz` | NOT NULL | Shown on reports |

- UNIQUE NULLS NOT DISTINCT (`period_id`, `account_id`, `branch_id`, `subledger_party_id`).

### `fin.fixed_asset` · MASTER

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `asset_no` | `text` | NOT NULL, UNIQUE | |
| `name` | `text` | NOT NULL | |
| `category` | `text` | NOT NULL, CHECK in (`VEHICLE`, `COLD_ROOM`, `HOUSING`, `EQUIPMENT`) | Ledger determinant |
| `branch_id` | `uuid` | NOT NULL, FK `mdm.branch` | |
| `acquired_on` | `date` | NOT NULL | |
| `cost_pesewas` | `pesewas` | NOT NULL | |
| `residual_pesewas` | `pesewas` | NOT NULL DEFAULT 0, CHECK `<= cost_pesewas` | |
| `useful_life_months` | `integer` | NOT NULL, CHECK `> 0` | |
| `method` | `text` | NOT NULL DEFAULT `'STRAIGHT_LINE'`, CHECK in (`STRAIGHT_LINE`) | |
| `accumulated_pesewas` | `pesewas` | NOT NULL DEFAULT 0 | Maintained by trigger from depreciation lines |
| `status` | `text` | NOT NULL, CHECK in (`IN_USE`, `FULLY_DEPRECIATED`, `DISPOSED`) | |
| `disposed_on` | `date` | NULL | |

Standard columns: `MASTER`.

### `fin.depreciation_run` · DOCUMENT

Posted status: `POSTED`.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK, FK `platform.business_document` | |
| `period_id` | `uuid` | NOT NULL, UNIQUE, FK `fin.accounting_period` | One run per period |
| `total_pesewas` | `pesewas` | NOT NULL | |
| `journal_entry_id` | `uuid` | NULL, FK `fin.journal_entry` | |

Standard columns: `DOCUMENT` (`status` in `DRAFT`, `POSTED`).

### `fin.depreciation_line` · LEDGER

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `depreciation_run_id` | `uuid` | NOT NULL, FK `fin.depreciation_run` | |
| `fixed_asset_id` | `uuid` | NOT NULL, FK `fin.fixed_asset` | |
| `amount_pesewas` | `pesewas` | NOT NULL | The final period takes the remainder, so the schedule sums exactly to cost minus residual |
| `recorded_at` | `timestamptz` | NOT NULL DEFAULT `now()` | |

- PK (`depreciation_run_id`, `fixed_asset_id`).
