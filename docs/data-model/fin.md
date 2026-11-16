# Table dictionary: `fin`

Owner: FIN module. Chart of accounts, journal, posting rules, periods, fixed assets (ADR-0003). Conventions are in `docs/DATA_MODEL.md`.

Built in B8 (migration 0123, ADR-0056): `account`, `subledger_party`, `accounting_period`, `posting_event_type`, `posting_rule`, `account_determination`, `journal_entry`, `journal_line`. A trigger refusal is SQLSTATE HK012 with the rule as its constraint name (`ck_journal_lines`, `ck_journal_balanced`, `ck_journal_period`, `ck_journal_period_open`, `ck_journal_line_entry`, `ck_journal_line_account`, `ck_journal_line_subledger`, `ck_account_change`, `ck_period_change`). B08 continued (A-188, A-189) adds `written_xact_id` on `journal_entry` (migration 0124: an entry written inside a savepoint keeps its own lines), the period lifecycle and close order on `accounting_period` and the table `period_reopen` (0126). B08 continued 1b (migration 0130, A-190, A-191) adds `manual_journal`, `manual_journal_line` and `posting_rule_change`, the `ENTERED` determinant on `posting_rule`, `approval_request_id` on `account_determination` and `ck_journal_entry_manual` on `journal_entry`. `bank_account` follows in B08 continued 1b2 (A-192); `period_balance`, `fixed_asset`, `depreciation_run` and `depreciation_line` in B08 continued 1c.

## Triggers

| Trigger | Purpose |
| --- | --- |
| `fin.assert_balanced()`, a deferred constraint trigger on `fin.journal_line` | At commit, for every entry touched: sum of `D` amounts equals sum of `C` amounts, and the entry has at least two lines. This is the constraint that no journal may post unbalanced |
| `fin.assert_period_open()` on insert of `fin.journal_entry` | Rejects an entry whose `posting_date` is in a period that is not `OPEN` |
| `fin.record_written_xact()` on insert of `fin.journal_entry` | Sets `written_xact_id` to the top-level transaction (`pg_current_xact_id()`), whatever the writer supplies (migration 0124) |
| `fin.assert_line_valid()` on insert of `fin.journal_line` | The account is postable; `subledger_party_id` is present exactly when the account has a `subledger_kind`, and the party is of that kind; the line is written in the top-level transaction that wrote its entry (compared on `written_xact_id`, so an entry written inside a savepoint keeps its own lines; migration 0124) and carries the entry's posting date |
| `fin.account_guard()` on update of `fin.account` | An account with lines keeps its code, type, normal side and subledger kind and is never archived |
| `fin.manual_journal_line_guard()` on insert of `fin.manual_journal_line` | A line is written only while its journal is a `DRAFT`, under the journal's current `revision` (`ck_manual_journal_line_draft`, 0130) |
| `fin.manual_journal_posted_guard()` on update of `fin.manual_journal` | A journal becomes `POSTED` only with the entry posted for it: its own source document, its kind and posting date, and the lines of its current revision exactly, in order, by account, side, amount and party (`ck_manual_journal_entry`, 0130) |
| `fin.accounting_period_guard()` on update of `fin.accounting_period` | A `CLOSED` period never changes; no period changes its dates (`ck_period_change`). From 0126: a status moves only `FUTURE` to `OPEN`, `OPEN` to `LOCKED`, `LOCKED` to `OPEN` or `CLOSED`, a locked or closed period names who locked it and an open one nobody (`ck_period_transition`), and a period becomes `CLOSED` only once every earlier period is (`ck_period_close_order`) |

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
- Trigger: `CLOSED` never changes; the transitions and the close order above (0126). Lock and close are `lockAccountingPeriod` and `closeAccountingPeriod`; a reopen is asked for and approved through `fin.period_reopen` (A-188).

### `fin.period_reopen` · DOCUMENT

A request to reopen one locked period (FR-FIN-010, A-188), the subject of its `PERIOD_REOPEN` approval. Added in B08 continued (0126). Posted statuses: `POSTED` (the period was reopened), `REJECTED`.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK, FK `platform.business_document` (doc type `PERIOD_REOPEN`) | The approval's subject |
| `period_id` | `uuid` | NOT NULL, FK `fin.accounting_period` | |
| `branch_id` | `uuid` | NOT NULL, FK `mdm.branch` | The head office branch, where the approval policy is read |
| `reason` | `text` | NOT NULL, 1 to 500 characters | Why the Owner asks |
| `status` | `text` | NOT NULL, CHECK in (`PENDING_APPROVAL`, `POSTED`, `REJECTED`) | |
| `approval_request_id` | `uuid` | NOT NULL, FK `iam.approval_request` | Maker-checker |
| `decided_at`, `decided_by` | `timestamptz`, `uuid` | NULL; set exactly when no longer pending (`ck_period_reopen_decided`) | Who let it happen or refused it |

Standard columns: `DOCUMENT` (`version`, `created_*`, `updated_*`), frozen once decided (`platform.freeze_posted`). UNIQUE (`period_id`) WHERE pending (`uq_period_reopen_pending`): one request waits per period.

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
| `determinant_type` | `text` | NULL, CHECK in the determination types or `ENTERED` | Or: look the account up in `fin.account_determination` by this determinant; `ENTERED` takes the account each amount names, and only `fin.ManualJournalApproved` posts so (`ck_posting_rule_entered`, 0130, A-190) |
| `determinant_role` | `text` | NULL | Which role of the determinant, for example `INVENTORY`, `SALES`, `COST_OF_SALES` |
| `subledger_from` | `text` | NULL | Which field of the event names the subledger party |
| `valid_from` | `date` | NOT NULL | |
| `valid_to` | `date` | NULL | Exclusive: the rule is in force on `[valid_from, valid_to)`. A change end-dates the rule it replaces (A-191) |
| `approval_request_id` | `uuid` | NULL, FK `iam.approval_request` | Maker-checker. NULL only for a rule seeded by migration, created by the System principal (`ck_posting_rule_approved`, A-182) |

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
| `role` | `text` | NOT NULL, CHECK in the list | `INVENTORY`, `SALES`, `COST_OF_SALES`, `TENDER`, `PAYOUT` (a supplier payment's source account, B8), `OUTPUT`, `INPUT`, `LOSS`, `EXPENSE` |
| `account_id` | `uuid` | NOT NULL, FK `fin.account` | |
| `valid_from` | `date` | NOT NULL | |
| `valid_to` | `date` | NULL | |
| `approval_request_id` | `uuid` | NULL, FK `iam.approval_request` | Maker-checker. NULL only for a row seeded by the System principal (`ck_account_determination_approved`, 0130, A-191) |

Standard columns: `MASTER`.

- EXCLUDE: for one (`determinant_type`, `determinant_key`, `role`), validity ranges do not overlap.
- A levy with no row of its own uses the `*` row, which points at the control account 2100 or 1400 (ADR-0020).

### `fin.journal_entry` · LEDGER

Header of a posted journal. Insert-only.

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
| `event_subject_id` | `uuid` | NULL | What the event is about (a movement, an invoice, a payment), so a correcting event finds the entry it reverses (B8, ADR-0056). Indexed |
| `source_document_id` | `uuid` | NOT NULL, FK `platform.business_document` | The business document behind it |
| `posting_group_id` | `uuid` | NOT NULL | Ties the entries of one business operation together |
| `description` | `text` | NOT NULL | |
| `currency` | `char(3)` | NOT NULL DEFAULT `'GHS'`, CHECK `= 'GHS'` | |
| `reverses_entry_id` | `uuid` | NULL, UNIQUE, FK `fin.journal_entry` | A correction |
| `occurred_at` | `timestamptz` | NOT NULL | When the business event happened |
| `written_xact_id` | `xid8` | NULL; set by trigger | The top-level transaction that wrote the entry, so the line trigger admits lines only from it (B08 continued, migration 0124). NULL on entries written before 0124, which no transaction matches |

Standard columns: `LEDGER`.

- Indexes: (`period_id`, `posting_date`); (`source_document_id`); (`posting_group_id`); (`posting_date`, `id`) for the journal search (0130).
- CHECK `ck_journal_entry_manual` (0130): a `MANUAL` or `OPENING` entry has `event_code` `fin.ManualJournalApproved` and an `event_id`, so it is only ever posted from an approved manual journal (A-190).

### `fin.journal_line` · LEDGER

A debit or credit line of a journal. Insert-only.

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

A journal entered by a person (FR-FIN-008, A-190), held at the head office branch. It posts nothing until a different person approves its `MANUAL_JOURNAL` request; the approval publishes `fin.ManualJournalApproved` and the ledger posts it as one entry of its kind. Posted statuses: `POSTED`, `REJECTED`. Built in B08 continued 1b (0130).

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK, FK `platform.business_document` (doc type `MANUAL_JOURNAL`) | The approval's subject and the entry's source document |
| `kind` | `text` | NOT NULL, CHECK in (`MANUAL`, `OPENING`) | The opening balance journal is entered this way (A-005) |
| `posting_date` | `date` | NOT NULL | Posted on this date or not at all |
| `description` | `text` | NOT NULL, 1 to 300 characters | Becomes the entry's description |
| `branch_id` | `uuid` | NOT NULL, FK `mdm.branch` | The head office, where the approval policy is read |
| `status` | `text` | NOT NULL, CHECK in (`DRAFT`, `PENDING_APPROVAL`, `POSTED`, `REJECTED`) | |
| `revision` | `integer` | NOT NULL DEFAULT 1, CHECK `> 0` | The set of lines in force; a change to the lines writes the next revision |
| `approval_request_id` | `uuid` | NULL, FK `iam.approval_request`; set exactly when no longer a draft | Maker-checker |
| `journal_entry_id` | `uuid` | NULL, UNIQUE, FK `fin.journal_entry`; set exactly when posted | The entry posted for it |
| `decided_at`, `decided_by` | `timestamptz`, `uuid` | NULL; set exactly when posted or rejected | |

Standard columns: `DOCUMENT` (`version`, `created_*`, `updated_*`). `ck_manual_journal_posted` ties the status to the approval, the entry and the decision. A pending journal changes only in its decision (`platform.freeze_posted('PENDING_APPROVAL', ...)`); a decided one never. UNIQUE (`kind`) WHERE `kind = 'OPENING'` and pending or posted (`uq_manual_journal_opening`): one opening balance journal ever. Index (`status`, `id`).

### `fin.manual_journal_line` · DOCUMENT

The lines of one revision of a manual journal. Insert only: a line is never updated or deleted (`platform.reject_change()`), and is written only while its journal is a draft, under its current revision (`ck_manual_journal_line_draft`).

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `manual_journal_id` | `uuid` | NOT NULL, FK `fin.manual_journal` | |
| `revision` | `integer` | NOT NULL, CHECK `> 0` | |
| `line_no` | `integer` | NOT NULL, CHECK `> 0` | Becomes the journal line's number |
| `account_id` | `uuid` | NOT NULL, FK `fin.account` | |
| `side` | `char(1)` | NOT NULL, CHECK in (`D`, `C`) | |
| `amount_pesewas` | `pesewas` | NOT NULL, CHECK `> 0` | |
| `subledger_party_id` | `uuid` | NULL, FK `fin.subledger_party` | Exactly when the account has a subledger (checked by the application, and by the journal line trigger when posted) |
| `memo` | `text` | NULL, at most 300 characters | |
| `created_at`, `created_by` | `timestamptz`, `uuid` | NOT NULL | |

- UNIQUE (`manual_journal_id`, `revision`, `line_no`).

### `fin.posting_rule_change` · DOCUMENT

A change to one posting rule or one account determination, the subject of its `POSTING_RULE_CHANGE` approval (FR-FIN-005, A-191). Built in B08 continued 1b (0130). Posted statuses: `POSTED` (applied), `REJECTED`.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK, FK `platform.business_document` (doc type `POSTING_RULE_CHANGE`) | |
| `branch_id` | `uuid` | NOT NULL, FK `mdm.branch` | The head office |
| `target` | `text` | NOT NULL, CHECK in (`RULE`, `DETERMINATION`) | |
| `event_code`, `amount_key`, `side` | `text`, `text`, `char(1)` | Set exactly for a rule | The rule replaced |
| `account_id` | `uuid` | NULL, FK `fin.account` | A rule's fixed account, or the account a determination maps to |
| `determinant_type`, `determinant_role` | `text` | NULL, CHECK in the lists | A rule's determinant, or a determination's type and role |
| `determinant_key` | `text` | Set exactly for a determination | |
| `subledger_from` | `text` | NULL | A rule's note of which field names the party |
| `valid_from` | `date` | NOT NULL | Asked for |
| `status` | `text` | NOT NULL, CHECK in (`PENDING_APPROVAL`, `POSTED`, `REJECTED`) | |
| `approval_request_id` | `uuid` | NOT NULL, FK `iam.approval_request` | |
| `effective_from` | `date` | Set exactly when posted, not before `valid_from` | The later of `valid_from` and the approval day |
| `posting_rule_id`, `account_determination_id` | `uuid` | FK; the one of its target set exactly when posted | What it created |
| `decided_at`, `decided_by` | `timestamptz`, `uuid` | Set exactly when decided | |

Standard columns: `DOCUMENT`, frozen once decided. `ck_posting_rule_change_shape` and `ck_posting_rule_change_decided` hold the shape. One pending change per rule (`uq_posting_rule_change_rule_pending`) and per determination key and role (`uq_posting_rule_change_determination_pending`).

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

The fixed asset register.

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

Depreciation charged to one asset in one run.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `depreciation_run_id` | `uuid` | NOT NULL, FK `fin.depreciation_run` | |
| `fixed_asset_id` | `uuid` | NOT NULL, FK `fin.fixed_asset` | |
| `amount_pesewas` | `pesewas` | NOT NULL | The final period takes the remainder, so the schedule sums exactly to cost minus residual |
| `recorded_at` | `timestamptz` | NOT NULL DEFAULT `now()` | |

- PK (`depreciation_run_id`, `fixed_asset_id`).
