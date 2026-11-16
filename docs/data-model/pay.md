# Table dictionary: `pay`

Owner: PAY module. Payments, allocations, online provider transactions and webhooks, refunds, store credit, settlement and bank reconciliation (ADR-0014, ADR-0021). Conventions are in `docs/DATA_MODEL.md`.

**As built in B9a (migration 0160, A-208):** `pay.payment` and `pay.payment_allocation` only. `pay.payment` adds `register_code` (text, `^[A-Z0-9]{1,10}$`) beside `register_ref`, so the till's subledger party on 1000 is named without reading POS, and holds `ck_payment_verified` (no mobile money or card CLEARED without a provider callback or lookup, no UNVERIFIED tender CLEARED), `ck_payment_cash_holder` (cash lands in a till or with a driver) and `trg_payment_guard` (written PENDING or CLEARED; PENDING to CLEARED or FAILED, CLEARED to REVERSED; once cleared only the allocated and refunded amounts change). The allocation trigger keeps `allocated_pesewas` within the amount less refunds (`ck_payment_allocation_cap`); what a document has outstanding is held by BIL's `bil.apply_settlement` through `Billing.settleIn` (A-200), so `pay.invoice_settlement` is not built. The other tables follow in B09a continued (A-209).

**As built in B09a continued (migrations 0166 to 0168, A-210, ADR-0063):** `pay.payment` adds `payer_phone_masked` (`+233 24 *** *876`; the full number is never stored) and two triggers: `trg_payment_provider_insert` (a mobile money or card payment is written PENDING) and `trg_payment_provider_confirmed` (it becomes CLEARED only when its charge SUCCEEDED with `confirmed_pesewas` equal to its amount). `pay.provider_transaction` adds `network`, `awaited_until` (the window the order waits, 15 minutes), `released_at` (the order stopped waiting), `last_checked_at`, `branch_id`, `version` and `created_*`/`updated_*`, with `trg_provider_transaction_guard` (INITIATED to PENDING, SUCCEEDED, FAILED or ABANDONED; PENDING to the last three; a settled attempt and what was asked for never change) and `uq_provider_transaction_charge` (one charge per payment). `pay.webhook_event` stores only the provider's fields PAY reads; `event_id` and `event_type` are null for an unsigned or unreadable body; outcomes add `REJECTED_MALFORMED`, `REPLAYED` and `DEFERRED_LOOKUP`; `uq_webhook_event_reference` holds (`provider`, `event_id`) unique among signed events that reached processing (`ACCEPTED`, `REJECTED_AMOUNT`, `IGNORED_UNKNOWN_REFERENCE`, `DEFERRED_LOOKUP`), the event id being `<event>:<reference>`; it adds `payment_id` and `correlation_id`. `pay.refund` adds `note`, `external_reference`, `attempts`, `next_attempt_at`, `paid_by` and `provider_status`; `trg_refund_cap` keeps `pay.payment.refunded_pesewas` (every refund not rejected) so that refunds never exceed the amount less what is allocated; `trg_refund_guard` holds the status machine; `ck_refund_paid_by` refuses a payout recorded by the maker. `pay.reconciliation_break` adds `refund_id`, `provider`, `reference`, `version` and the standard columns; `branch_id` is null for a reference no branch is known for; kinds add `PROVIDER_AMOUNT_DIFFERS`, `PROVIDER_REFERENCE_UNKNOWN` and `PROVIDER_PAYMENT_MISSING`; one open break per payment, refund or unknown reference and kind. New: `pay.provider_sweep` (LEDGER), one row per run of the provider sweep with the window of the provider's transaction list it read. Store credit, settlement reports, bank statements and their lines follow in B09a continued 1b (A-211).

**As built in B09a continued 1b (migrations 0172 and 0173, A-212, ADR-0064):** `pay.payment` adds `clearance_ref` (the subject of a cleared cheque's `pay.ChequeCleared` entry, so a reversal mirrors it too) and `ck_payment_bank_account` (a cheque or a bank transfer names its bank account), `ck_payment_store_credit_customer`, `ck_payment_cheque_clearance` and `ck_payment_reversal_row` (a reversing payment is written REVERSED, once per original, mirroring its method, amount, customer and branch, after the original is REVERSED or FAILED); `trg_payment_guard` now also refuses a payment becoming REVERSED or FAILED with anything still allocated or refunded, so a reversal or a bounce always reopens what it settled. New: `pay.payment_reversal` (DOCUMENT): one reversal asked for per payment at a time (`uq_payment_reversal_open`), its reason (domain `PAYMENT_REVERSAL`) and note, PENDING_APPROVAL to APPROVED with its reversing payment or REJECTED, then frozen; the approval is IAM's `PAYMENT_REVERSAL` with the payment as subject. `pay.store_credit_entry` as below plus `branch_id` and `uq_store_credit_entry_source` (one entry per source document and direction); `pay.store_credit_balance` is written only by `trg_store_credit_apply` (SECURITY DEFINER), which takes the balance row's lock and refuses a redemption beyond it (`ck_store_credit_balance`). The published view `pay.pub_reconciliation_break` (every break of every kind, its facts without its details) is read by RPT for the daily exception report (B12). `pay.invoice_settlement` stays unbuilt (A-208 (f)): open items are read from BIL through `Billing.openItemsIn`. Settlement reports and bank statements follow in B09a continued 1c (A-213).

**As built in B09a continued 1c (migrations 0176, 0180 and 0181, A-214, ADR-0065):** `pay.store_credit_entry` refuses an `ISSUE` for a customer MDM holds no phone for (`ck_store_credit_entry_customer_phone`, through MDM's published `mdm.customer_has_phone`; the owner, 2026-11-16). `pay.settlement_report` adds `currency`, `file_sha256` (`uq_settlement_report_file`), `matched_at`/`matched_by`, `branch_id`, `version` and the standard columns, `file_id` NOT NULL, `trg_settlement_report_guard` (IMPORTED, then POSTED or HAS_BREAKS once, then frozen; `MATCHED` is never set). `pay.settlement_line` adds `line_no`, `provider` (`uq_settlement_line_reference`: a provider reference is settled once ever), `match_reason`, `branch_id` and the standard columns; `match_status` starts `UNMATCHED`; `uq_settlement_line_payment`; `trg_settlement_line_guard` matches a line only to a cleared payment of the same provider, reference and amount. `pay.bank_statement` adds `currency`, `file_sha256` (`uq_bank_statement_file`), `ex_bank_statement_period` (no two statements of an account overlap), `branch_id`, `version` and the standard columns, `file_id` NOT NULL; `trg_bank_statement_guard`. `pay.bank_statement_line` adds `line_no`, `bank_account_id`, `balance_pesewas`, `matched_payment_id` (`uq_bank_statement_line_payment`), `matched_by`/`matched_at`, `branch_id` and the standard columns; `uq_bank_statement_line_entry`; `trg_bank_statement_line_guard` (matched once, to a pending transfer into the same account for the same amount, or to an entry). `pay.payment` adds `trg_payment_transfer_cleared` (a bank transfer becomes CLEARED only when a line names it). `pay.reconciliation_break` adds `settlement_line_id` and `bank_statement_line_id` (one open break per line and kind) and `trg_reconciliation_break_resolved` (resolved only through an approved `pay.break_resolution` by someone other than its maker; a failed refund's break excepted, ADR-0063); `pay.pub_reconciliation_break` adds the two line columns. New: `pay.break_resolution` (DOCUMENT, a `BREAK_RESOLUTION` business document): one asked for per break at a time, its note and `posting` (`NONE` or `UNIDENTIFIED_RECEIPT`), PENDING_APPROVAL to APPROVED or REJECTED, then frozen, `ck_break_resolution_checker`. The refund against a credit note follows in B09a continued 1d (A-215).

---

### `pay.payment` · DOCUMENT

One tender received, or reversed. Posted statuses: `CLEARED`, `FAILED`, `REVERSED`. Published key.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK, FK `platform.business_document` | Client-generated for offline counter sales |
| `payment_no` | `text` | NULL, UNIQUE | |
| `payment_method_id` | `uuid` | NOT NULL, FK `mdm.payment_method` | |
| `method_kind` | `text` | NOT NULL | Snapshot; ledger determinant |
| `amount_pesewas` | `pesewas` | NOT NULL, CHECK `> 0` | |
| `currency` | `char(3)` | NOT NULL DEFAULT `'GHS'`, CHECK `= 'GHS'` | |
| `customer_id` | `uuid` | NULL, FK `mdm.customer` | Null for a walk-in or unidentified receipt |
| `order_document_id` | `uuid` | NULL, FK `platform.business_document` | The order it was taken for |
| `shift_document_id` | `uuid` | NULL, FK `platform.business_document` | The POS shift that took it |
| `register_ref` | `uuid` | NULL | The till, for the cash subledger |
| `driver_id` | `uuid` | NULL, FK `iam.principal` | For cash on delivery |
| `bank_account_id` | `uuid` | NULL, FK `fin.bank_account` | Where a transfer or direct mobile money receipt landed |
| `provider` | `text` | NULL | For example `PAYSTACK` |
| `provider_reference` | `text` | NULL, UNIQUE | A replay collides here |
| `external_reference` | `text` | NULL | Bank reference, cheque number, mobile money transaction id |
| `verification` | `text` | NOT NULL, CHECK in (`NOT_REQUIRED`, `PROVIDER_CALLBACK`, `PROVIDER_LOOKUP`, `UNVERIFIED`) | How it was confirmed. `UNVERIFIED` is allowed only for the offline setting in ADR-0027 and goes to the unmatched queue |
| `cheque_due_on` | `date` | NULL | Cheque clearing |
| `allocated_pesewas` | `pesewas` | NOT NULL DEFAULT 0, CHECK `<= amount_pesewas` | Maintained by trigger from allocations |
| `refunded_pesewas` | `pesewas` | NOT NULL DEFAULT 0, CHECK `<= amount_pesewas` | Maintained by trigger from refunds |
| `received_at` | `timestamptz` | NOT NULL | When the customer paid |
| `cleared_at` | `timestamptz` | NULL | |
| `reverses_payment_id` | `uuid` | NULL, UNIQUE, FK `pay.payment` | |
| `failure_reason` | `text` | NULL | |

Standard columns: `DOCUMENT` (`status` in `PENDING`, `CLEARED`, `FAILED`, `REVERSED`).

- CHECK: a method requiring provider verification cannot be `CLEARED` with `verification = 'NOT_REQUIRED'`.
- After `CLEARED`, only `allocated_pesewas`, `refunded_pesewas` and `status` (to `REVERSED`) may change.

### `pay.payment_allocation` · LEDGER

A payment applied to a billing document.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `payment_id` | `uuid` | NOT NULL, FK `pay.payment` | |
| `billing_document_id` | `uuid` | NOT NULL, FK `bil.billing_document` | |
| `amount_pesewas` | `pesewas` | NOT NULL, CHECK `> 0` | |
| `direction` | `text` | NOT NULL DEFAULT `'APPLY'`, CHECK in (`APPLY`, `UNAPPLY`) | Unallocation is a new row |
| `reverses_allocation_id` | `uuid` | NULL, UNIQUE, FK `pay.payment_allocation` | |

Standard columns: `LEDGER`.

- Trigger: allocations of a payment do not exceed its amount less refunds; allocations to a document do not exceed its outstanding amount. Maintains `pay.payment.allocated_pesewas` and `pay.invoice_settlement`.

### `pay.provider_transaction` · DOCUMENT

One attempt to collect through the provider port.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `payment_id` | `uuid` | NOT NULL, FK `pay.payment` | |
| `provider` | `text` | NOT NULL | |
| `reference` | `text` | NOT NULL | Our reference sent to the provider |
| `kind` | `text` | NOT NULL, CHECK in (`CHARGE`, `AUTHORISE`, `CAPTURE`, `REFUND`) | Pre-authorisation where supported (ADR-0021) |
| `channel` | `text` | NULL, CHECK in (`MOBILE_MONEY`, `CARD`, `BANK`) | |
| `requested_pesewas` | `pesewas` | NOT NULL | |
| `confirmed_pesewas` | `pesewas` | NULL | Amount the provider's API confirmed; must equal requested to clear |
| `status` | `text` | NOT NULL, CHECK in (`INITIATED`, `PENDING`, `SUCCEEDED`, `FAILED`, `ABANDONED`) | |
| `provider_status` | `text` | NULL | Raw status |
| `fee_pesewas` | `pesewas` | NULL | Provider fee, once known |
| `verified_at` | `timestamptz` | NULL | When re-verified against the provider |
| `created_at` | `timestamptz` | NOT NULL DEFAULT `now()` | |
| `updated_at` | `timestamptz` | NOT NULL | |

- UNIQUE (`provider`, `reference`). No card number, expiry or security code is ever stored.

### `pay.webhook_event` · LEDGER

Every webhook received, accepted or not. The rejection log.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `provider` | `text` | NOT NULL | |
| `event_id` | `text` | NOT NULL | The provider's event id |
| `event_type` | `text` | NOT NULL | |
| `signature_valid` | `boolean` | NOT NULL | |
| `within_time_window` | `boolean` | NOT NULL | |
| `payload_hash` | `bytea` | NOT NULL | |
| `payload` | `jsonb` | NOT NULL | Scrubbed of card and personal detail |
| `reference` | `text` | NULL | Our reference, if present |
| `outcome` | `text` | NOT NULL, CHECK in (`ACCEPTED`, `REJECTED_SIGNATURE`, `REJECTED_STALE`, `REJECTED_AMOUNT`, `IGNORED_UNKNOWN_REFERENCE`, `IGNORED_EVENT_TYPE`) | |
| `source_ip` | `inet` | NULL | |
| `received_at` | `timestamptz` | NOT NULL DEFAULT `now()` | |

- UNIQUE (`provider`, `event_id`) where `signature_valid`: a replayed event collides and is acknowledged without effect. Rows with an invalid signature are kept without the uniqueness guarantee, so a forger cannot block a genuine event id.
- `actor_id` is the system principal for the webhook endpoint.

### `pay.refund` · DOCUMENT

Posted statuses: `PAID`, `FAILED`, `REJECTED`. Published key.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK, FK `platform.business_document` | |
| `refund_no` | `text` | NULL, UNIQUE | |
| `original_payment_id` | `uuid` | NOT NULL, FK `pay.payment` | The documented link back |
| `amount_pesewas` | `pesewas` | NOT NULL, CHECK `> 0` | |
| `destination` | `text` | NOT NULL, CHECK in (`ORIGINAL_METHOD`, `STORE_CREDIT`, `CASH`) | |
| `reason_code` | `text` | NOT NULL, FK `mdm.reason_code` | |
| `credit_note_id` | `uuid` | NULL, FK `bil.billing_document` | The credit note that justifies it |
| `is_automatic` | `boolean` | NOT NULL DEFAULT `false` | A catch-weight adjustment below the automatic limit |
| `approval_request_id` | `uuid` | NULL, FK `iam.approval_request` | Required unless automatic |
| `provider_reference` | `text` | NULL, UNIQUE | |
| `paid_at` | `timestamptz` | NULL | |
| `failure_reason` | `text` | NULL | A failed refund stays visible until retried or settled another way |

Standard columns: `DOCUMENT` (`status` in `REQUESTED`, `PENDING_APPROVAL`, `APPROVED`, `PROCESSING`, `PAID`, `FAILED`, `REJECTED`).

- Trigger: total refunds of a payment do not exceed its amount. CHECK: `PAID` requires `is_automatic` or `approval_request_id`.

### `pay.store_credit_entry` · LEDGER

Store credit issued, redeemed and expired.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `customer_id` | `uuid` | NOT NULL, FK `mdm.customer` | |
| `direction` | `text` | NOT NULL, CHECK in (`ISSUE`, `REDEEM`, `EXPIRE`) | |
| `amount_pesewas` | `pesewas` | NOT NULL, CHECK `> 0` | |
| `source_document_id` | `uuid` | NOT NULL, FK `platform.business_document` | The refund that issued it or the payment that redeemed it |

Standard columns: `LEDGER`.

### `pay.store_credit_balance` · PROJECTION

Current store credit per customer.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `customer_id` | `uuid` | PK, FK `mdm.customer` | |
| `balance_pesewas` | `pesewas` | NOT NULL | Maintained by trigger; a redemption beyond the balance is rejected |
| `updated_at` | `timestamptz` | NOT NULL | |

### `pay.invoice_settlement` · PROJECTION

What is outstanding on each billing document. "Paid" lives here, so invoices stay immutable.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `billing_document_id` | `uuid` | PK, FK `bil.billing_document` | |
| `customer_id` | `uuid` | NULL, FK `mdm.customer` | |
| `branch_id` | `uuid` | NOT NULL, FK `mdm.branch` | |
| `gross_pesewas` | `pesewas` | NOT NULL | |
| `credited_pesewas` | `pesewas` | NOT NULL DEFAULT 0 | |
| `allocated_pesewas` | `pesewas` | NOT NULL DEFAULT 0 | |
| `outstanding_pesewas` | `pesewas` | NOT NULL | Gross less credited less allocated |
| `due_date` | `date` | NULL | Ageing |
| `settled_at` | `timestamptz` | NULL | When outstanding reached zero |

- Maintained by triggers on allocations and by transactional subscribers to billing events. `pay.pub_open_item` is a view over this table.

### `pay.settlement_report` · DOCUMENT

A provider settlement file imported for reconciliation.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK, FK `platform.business_document` | |
| `provider` | `text` | NOT NULL | |
| `settlement_ref` | `text` | NOT NULL | |
| `settled_on` | `date` | NOT NULL | |
| `bank_account_id` | `uuid` | NOT NULL, FK `fin.bank_account` | Where the provider paid out |
| `gross_pesewas` | `pesewas` | NOT NULL | |
| `fee_pesewas` | `pesewas` | NOT NULL | |
| `net_pesewas` | `pesewas` | NOT NULL, CHECK `gross_pesewas - fee_pesewas = net_pesewas` | |
| `file_id` | `uuid` | NULL, FK `platform.stored_file` | |

Standard columns: `DOCUMENT` (`status` in `IMPORTED`, `MATCHED`, `POSTED`, `HAS_BREAKS`). UNIQUE (`provider`, `settlement_ref`).

### `pay.settlement_line` · DOCUMENT

One transaction within a provider settlement.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `settlement_report_id` | `uuid` | NOT NULL, FK `pay.settlement_report` | |
| `provider_reference` | `text` | NOT NULL | |
| `amount_pesewas` | `pesewas` | NOT NULL | |
| `fee_pesewas` | `pesewas` | NOT NULL DEFAULT 0 | |
| `matched_payment_id` | `uuid` | NULL, FK `pay.payment` | |
| `match_status` | `text` | NOT NULL, CHECK in (`MATCHED`, `AMOUNT_DIFFERS`, `NOT_FOUND`) | |

### `pay.bank_statement` · DOCUMENT

An imported bank or mobile money statement.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK, FK `platform.business_document` | |
| `bank_account_id` | `uuid` | NOT NULL, FK `fin.bank_account` | |
| `period_start` | `date` | NOT NULL | |
| `period_end` | `date` | NOT NULL | |
| `opening_pesewas` | `pesewas` | NOT NULL | |
| `closing_pesewas` | `pesewas` | NOT NULL | |
| `file_id` | `uuid` | NULL, FK `platform.stored_file` | |

Standard columns: `DOCUMENT` (`status` in `IMPORTED`, `RECONCILED`, `HAS_BREAKS`).

### `pay.bank_statement_line` · DOCUMENT

One line of a statement, and what it matched.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `bank_statement_id` | `uuid` | NOT NULL, FK `pay.bank_statement` | |
| `value_date` | `date` | NOT NULL | |
| `direction` | `text` | NOT NULL, CHECK in (`IN`, `OUT`) | |
| `amount_pesewas` | `pesewas` | NOT NULL | |
| `narration` | `text` | NULL | |
| `bank_reference` | `text` | NULL | |
| `matched_journal_entry_ref` | `uuid` | NULL | The ledger entry it was matched to; read through FIN's interface |
| `match_status` | `text` | NOT NULL, CHECK in (`MATCHED`, `UNMATCHED`) | |

### `pay.reconciliation_break` · DOCUMENT

The exception queue. Reconciliation never corrects; it raises one of these.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `branch_id` | `uuid` | NOT NULL, FK `mdm.branch` | |
| `kind` | `text` | NOT NULL, CHECK in (`UNMATCHED_PAYMENT`, `UNVERIFIED_PAYMENT`, `SETTLEMENT_AMOUNT_DIFFERS`, `SETTLEMENT_NOT_FOUND`, `BANK_LINE_UNMATCHED`, `LEDGER_CASH_DIFFERS`, `REFUND_FAILED`) | |
| `payment_id` | `uuid` | NULL, FK `pay.payment` | |
| `source_document_id` | `uuid` | NULL, FK `platform.business_document` | Settlement report or statement |
| `amount_pesewas` | `pesewas` | NULL | Size of the difference |
| `details` | `jsonb` | NOT NULL | The offending records |
| `raised_at` | `timestamptz` | NOT NULL DEFAULT `now()` | |
| `status` | `text` | NOT NULL DEFAULT `'OPEN'`, CHECK in (`OPEN`, `RESOLVED`) | |
| `resolved_by` | `uuid` | NULL, FK `iam.principal` | |
| `resolved_at` | `timestamptz` | NULL | |
| `resolution_note` | `text` | NULL | |
