# Table dictionary: `pur`

Owner: PUR module. Supplier terms, requisitions, purchase orders, supplier invoices with three-way match, supplier payments and performance. Goods receipts are inventory's (`inv.goods_receipt`). Conventions are in `docs/DATA_MODEL.md`.

**As built in B7 (migration 0094, A-164):** `purchase_order`, `purchase_order_line`, `supplier_invoice`, `supplier_invoice_line`, `supplier_invoice_line_tax`, `supplier_payment` and `supplier_payment_allocation`. The rest of the schema (profiles, categories, documents, requisitions, scores) arrives with B07 continued. Differences from the dictionary below, each recorded in A-164:

- `purchase_order` adds `tax_scheme_version_id` (the scheme the lines were taxed by), `approval_threshold_pesewas` (the threshold judged on submit, so `ck_purchase_order_approved` holds the approval rule on the row), `sent_by`, `close_reason`, `cancel_reason`, `posted_at`/`posted_by` (approval); the status `SENT` sits between `APPROVED` and `PARTIALLY_RECEIVED`.
- `purchase_order_line` adds `uom` (the unit bought by), `qty_ordered_base` (by MDM's exact conversion), `tax_category_id` and `tax_pesewas`; `qty_ordered` and `unit_price_pesewas` are in `uom`. **`qty_invoiced` is not stored:** it is derived from the base quantities of matched, approved and paid invoices. `ck_purchase_order_line_net` (line net = round(qty x price)) and `ck_purchase_order_line_tolerance` (received within ordered plus tolerance) are checks.
- `supplier_invoice` adds `stated_gross_pesewas`, `matched_at`, `cancel_reason`, `posted_at`/`posted_by`; the unique number per supplier is a partial index among invoices not cancelled. A deferred trigger holds net, tax and gross to the lines and levy rows, and `paid_pesewas` to the allocations of PAID payments.
- `supplier_invoice_line` adds `uom`, `qty_base` and `match_reasons text[]`; `supplier_invoice_line_tax` adds `levy_name`, `calculated_amount_pesewas` (beside the amount charged) and `calc_order`.
- `supplier_payment` has no `bank_account_id` or `remittance_document_id` yet: both arrive with their target tables in B8 (`docs/DATA_MODEL.md`, Migrations).
- `supplier_payment_allocation` is written when the payment is prepared; allocations of a `REJECTED` or `CANCELLED` payment stop counting. `paid_pesewas` moves by trigger when the payment becomes `PAID`.


**As built in B07 continued (migrations 0097 to 0099 and 0104, A-166, A-170):** `supplier_profile`, `supplier_payout_change` (new), `supplier_document`, `purchase_requisition` and `purchase_requisition_line`, and `supplier_payment.payout_change_id`. Credit notes, the approved variance, remittance data and scores arrive with B07 continued 1b (A-167). Differences from the dictionary below:

- `supplier_profile` holds no payout columns: `payout_change_id` points at the approved `supplier_payout_change` in force (`pur.supplier_profile_payout_guard`, HK010), and `payout_method`, the masked form and the ciphertext live on that change. It adds the MASTER `deleted_*` columns. A profile opens in the transaction that registers the supplier (`mdm.SupplierRegistered`).
- **`supplier_payout_change` · DOCUMENT** (new): `supplier_id`, `payout_method`, `payout_details_enc` (AES-256-GCM under the supplier's subject key, bound to the row; bank and mobile money only), `payout_masked`, the terms asked for with it (`payment_terms_days`, `lead_time_days`, `notes`, applied with the details), `approval_request_id` (NOT NULL), `decision_reason`, standard DOCUMENT columns (`posted_*` is the decision). Inserted `PENDING_APPROVAL`, decided once, content frozen (HK004); one pending per supplier (`uq_supplier_payout_change_pending`); `ck_supplier_payout_change_checker` refuses an approval by its maker.
- `supplier_category` is not built: categories supplied are MDM's (`mdm.supplier` categories, FR-MDM-007).
- `supplier_document` adds `version` and the MASTER audit and `deleted_*` columns; one stored file is filed once (`uq_supplier_document_file`).
- `purchase_requisition` adds `location_id` (where the goods are wanted), `reject_reason`, `posted_*`; `ck_purchase_requisition_converted` (CONVERTED if and only if `purchase_order_id`), `ck_purchase_requisition_rejected`, a status guard and a line guard (lines change only while DRAFT, HK004).
- `supplier_payment.payout_first_use` (migration 0104, A-170): set by the database on insert for the first live payment to a supplier since the approved payout change in force was decided; never changes (HK004); `ck_supplier_payment_first_use` holds that such a payment is approved by a second person.
- `supplier_payment.payout_change_id`: the approved details a bank or mobile money payment pays, fixed when it is prepared from the details then in force (`pur.supplier_payment_payee_guard`, HK010), never changed (HK004); null for cash and cheques.


**As built in B07 continued 1b (migrations 0107 and 0108, A-172 to A-174):** credit notes, the approved variance, the remittance data and the receipt facts scores read. Differences from the dictionary below:

- `supplier_invoice` adds `credited_pesewas` (the gross of approved credit notes against an invoice, kept by `pur.supplier_credit_note_applied` and checked at commit by `ck_supplier_invoice_credited`), `approval_request_id` (a credit note's SUPPLIER_CREDIT_NOTE approval, or an invoice's SUPPLIER_INVOICE_VARIANCE approval, waiting or decided), `variance_reason` and `return_reason_code` (a `RETURN` reason for goods a credit sends back). `match_status` gains `VARIANCE_APPROVED`. `paid_pesewas + credited_pesewas` never exceeds the gross and an invoice is PAID once a payment was made and the two reach it. A credit note goes DRAFT to APPROVED (or CANCELLED), is never matched, paid or credited, and is approved by someone other than whoever entered it (`ck_supplier_invoice_credit_approved`); `ck_supplier_credit_note_cap` (deferred) holds its invoice's live credits and live payments within the gross. A VARIANCE_APPROVED invoice names its request and reason and was approved by someone other than whoever entered it (`ck_supplier_invoice_variance`); `pur.supplier_invoice_variance_cover` allows it only when every mismatched line fails on price or a levy.
- `supplier_invoice_line` adds `return_location_id` (FK `mdm.location`) and `return_stock_unit_id` (FK `inv.stock_unit`): where goods sent back leave from; INV's SUPPLIER_RETURN movement names the credit note as its source document and the line as its source line.
- `supplier_payment_allocation_guard` allocates only what live credits and payments leave, to an invoice MATCHED, NOT_REQUIRED or VARIANCE_APPROVED.
- **`supplier_remittance` · LEDGER** (new, instead of `supplier_payment.remittance_document_id` for now): one row per PAID payment (`uq_supplier_remittance_payment`), written in the transaction that marks it paid, its supplier, method, amount, time and reference held to the payment's by `pur.supplier_remittance_guard`, with the invoices paid as a `lines` snapshot (gross, credited, amount, outstanding after). The rendered document's `remittance_document_id` follows in B8.
- **`supplier_receipt_line` · LEDGER** (new): each goods receipt line from a supplier as `inv.GoodsReceiptPosted` told PUR, with accepted and rejected base quantities, the business day received and the day promised. Supplier scores are computed from it, approved invoice lines and approved credit returns when asked; `supplier_score` is not built (BL-060).

---

### `pur.supplier_profile` · MASTER

Commercial terms for a supplier whose identity is `mdm.supplier`.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `supplier_id` | `uuid` | PK, FK `mdm.supplier` | |
| `payment_terms_days` | `integer` | NOT NULL DEFAULT 0, CHECK `>= 0` | Due date calculation |
| `payout_method` | `text` | NULL, CHECK in (`BANK`, `MOBILE_MONEY`, `CASH`, `CHEQUE`) | |
| `payout_details_enc` | `bytea` | NULL | Bank or mobile money details, encrypted (restricted) |
| `payout_last4` | `text` | NULL | For display |
| `lead_time_days` | `integer` | NULL | Expected lead time, for scoring |
| `notes` | `text` | NULL | |

Standard columns: `MASTER`. A change to payout details needs approval by a different user and is audited.

### `pur.supplier_category` · MASTER

The categories a supplier supplies.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `supplier_id` | `uuid` | NOT NULL, FK `mdm.supplier` | |
| `category_id` | `uuid` | NOT NULL, FK `mdm.category` | Categories supplied |

- PK (`supplier_id`, `category_id`).

### `pur.supplier_document` · MASTER

Documents held for a supplier.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `supplier_id` | `uuid` | NOT NULL, FK `mdm.supplier` | |
| `kind` | `text` | NOT NULL | Registration, contract, health certificate |
| `file_id` | `uuid` | NOT NULL, FK `platform.stored_file` | |
| `expires_on` | `date` | NULL | Expiry reminder |

Standard columns: `MASTER`.

### `pur.purchase_requisition` · DOCUMENT

Posted statuses: `CONVERTED`, `REJECTED`, `CANCELLED`.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK, FK `platform.business_document` | |
| `requisition_no` | `text` | NULL, UNIQUE | |
| `requested_by` | `uuid` | NOT NULL, FK `iam.principal` | |
| `needed_by` | `date` | NULL | |
| `justification` | `text` | NULL | |
| `purchase_order_id` | `uuid` | NULL, FK `pur.purchase_order` | Set on conversion |

Standard columns: `DOCUMENT` (`status` in `DRAFT`, `SUBMITTED`, `CONVERTED`, `REJECTED`, `CANCELLED`).

### `pur.purchase_requisition_line` · DOCUMENT

Lines of a requisition.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `requisition_id` | `uuid` | NOT NULL, FK `pur.purchase_requisition` | |
| `line_no` | `integer` | NOT NULL | |
| `product_id` | `uuid` | NOT NULL, FK `mdm.product` | |
| `qty` | `qty` | NOT NULL, CHECK `> 0` | |
| `note` | `text` | NULL | |

- UNIQUE (`requisition_id`, `line_no`).

### `pur.purchase_order` · DOCUMENT

Posted statuses: `APPROVED`, `PARTIALLY_RECEIVED`, `RECEIVED`, `CLOSED`, `CANCELLED`.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK, FK `platform.business_document` | |
| `order_no` | `text` | NULL, UNIQUE | |
| `supplier_id` | `uuid` | NOT NULL, FK `mdm.supplier` | |
| `deliver_to_location_id` | `uuid` | NOT NULL, FK `mdm.location` | |
| `order_date` | `date` | NOT NULL | |
| `expected_on` | `date` | NULL | Lead time scoring |
| `currency` | `char(3)` | NOT NULL DEFAULT `'GHS'`, CHECK `= 'GHS'` | |
| `tax_inclusive` | `boolean` | NOT NULL DEFAULT `false` | |
| `net_pesewas` | `pesewas` | NOT NULL DEFAULT 0 | Sum of lines |
| `tax_pesewas` | `pesewas` | NOT NULL DEFAULT 0 | |
| `gross_pesewas` | `pesewas` | NOT NULL DEFAULT 0 | Compared with approval limits |
| `approval_request_id` | `uuid` | NULL, FK `iam.approval_request` | Required above the requester's limit |
| `sent_at` | `timestamptz` | NULL | |

Standard columns: `DOCUMENT` (`status` in `DRAFT`, `PENDING_APPROVAL`, `APPROVED`, `PARTIALLY_RECEIVED`, `RECEIVED`, `CLOSED`, `CANCELLED`).

### `pur.purchase_order_line` · DOCUMENT

Lines of a purchase order, with received and invoiced progress.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | Referenced by `inv.goods_receipt_line.order_line_ref` |
| `purchase_order_id` | `uuid` | NOT NULL, FK `pur.purchase_order` | |
| `line_no` | `integer` | NOT NULL | |
| `product_id` | `uuid` | NOT NULL, FK `mdm.product` | |
| `description` | `text` | NULL | |
| `qty_ordered` | `qty` | NOT NULL, CHECK `> 0` | |
| `unit_price_pesewas` | `pesewas` | NOT NULL | Per base unit |
| `line_net_pesewas` | `pesewas` | NOT NULL | |
| `qty_received` | `qty` | NOT NULL DEFAULT 0 | Maintained from goods receipts, for partial receipt |
| `qty_invoiced` | `qty` | NOT NULL DEFAULT 0 | Maintained from matched invoices |
| `over_receipt_tolerance_percent` | `percent` | NOT NULL DEFAULT 0 | |
| `expense_category` | `text` | NULL | For non-stock lines; ledger determinant |

- UNIQUE (`purchase_order_id`, `line_no`). After approval only `qty_received` and `qty_invoiced` may change.

### `pur.supplier_invoice` · DOCUMENT

A supplier's invoice or credit note. Posted statuses: `MATCHED`, `APPROVED`, `PAID`, `CANCELLED`.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK, FK `platform.business_document` | |
| `kind` | `text` | NOT NULL, CHECK in (`INVOICE`, `CREDIT_NOTE`) | |
| `supplier_id` | `uuid` | NOT NULL, FK `mdm.supplier` | |
| `supplier_invoice_no` | `text` | NOT NULL | The supplier's own number |
| `invoice_date` | `date` | NOT NULL | Tax date |
| `due_date` | `date` | NOT NULL | Payment scheduling |
| `purchase_order_id` | `uuid` | NULL, FK `pur.purchase_order` | Null for an expense invoice with no order |
| `original_invoice_id` | `uuid` | NULL, FK `pur.supplier_invoice`; required for `CREDIT_NOTE` | |
| `currency` | `char(3)` | NOT NULL DEFAULT `'GHS'`, CHECK `= 'GHS'` | |
| `net_pesewas` | `pesewas` | NOT NULL | |
| `tax_pesewas` | `pesewas` | NOT NULL | |
| `gross_pesewas` | `pesewas` | NOT NULL | |
| `paid_pesewas` | `pesewas` | NOT NULL DEFAULT 0, CHECK `<= gross_pesewas` | Maintained by trigger from allocations |
| `match_status` | `text` | NOT NULL, CHECK in (`UNMATCHED`, `MATCHED`, `MISMATCH`, `NOT_REQUIRED`) | Three-way match result |
| `file_id` | `uuid` | NULL, FK `platform.stored_file` | Scan of the invoice |
| `tax_scheme_version_id` | `uuid` | NOT NULL, FK `mdm.tax_scheme_version` | |

Standard columns: `DOCUMENT` (`status` in `DRAFT`, `MATCHED`, `MISMATCH`, `APPROVED`, `PAID`, `CANCELLED`).

- UNIQUE (`supplier_id`, `supplier_invoice_no`): the same invoice cannot be entered twice.

### `pur.supplier_invoice_line` · DOCUMENT

Lines of a supplier invoice, with the three-way match result.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `supplier_invoice_id` | `uuid` | NOT NULL, FK `pur.supplier_invoice` | |
| `line_no` | `integer` | NOT NULL | |
| `product_id` | `uuid` | NULL, FK `mdm.product` | Null for a pure expense line |
| `description` | `text` | NOT NULL | |
| `purchase_order_line_id` | `uuid` | NULL, FK `pur.purchase_order_line` | |
| `goods_receipt_line_id` | `uuid` | NULL, FK `inv.goods_receipt_line` | |
| `qty` | `qty` | NOT NULL, CHECK `> 0` | |
| `unit_price_pesewas` | `pesewas` | NOT NULL | |
| `line_net_pesewas` | `pesewas` | NOT NULL | |
| `tax_category_id` | `uuid` | NOT NULL, FK `mdm.tax_category` | |
| `expense_category` | `text` | NULL | |
| `qty_variance` | `numeric(14,3)` | NULL | Invoiced minus received; signed |
| `price_variance_pesewas` | `pesewas` | NULL | Absolute difference from the order price |
| `price_variance_direction` | `text` | NULL, CHECK in (`OVER`, `UNDER`) | |
| `match_status` | `text` | NOT NULL, CHECK in (`UNMATCHED`, `MATCHED`, `MISMATCH`, `NOT_REQUIRED`) | Per-line result |

- UNIQUE (`supplier_invoice_id`, `line_no`).

### `pur.supplier_invoice_line_tax` · DOCUMENT

Levy rows for a supplier invoice line (ADR-0020). Snapshots.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `supplier_invoice_line_id` | `uuid` | NOT NULL, FK `pur.supplier_invoice_line` | |
| `levy_id` | `uuid` | NOT NULL, FK `mdm.tax_levy` | |
| `levy_code` | `text` | NOT NULL | As at the invoice date |
| `treatment` | `text` | NOT NULL | |
| `rate_percent` | `percent` | NOT NULL | |
| `base_pesewas` | `pesewas` | NOT NULL | |
| `amount_pesewas` | `pesewas` | NOT NULL | As charged by the supplier; a difference from the calculated amount is flagged |
| `is_reclaimable` | `boolean` | NOT NULL | Decides recoverable account or cost |

- PK (`supplier_invoice_line_id`, `levy_id`).

### `pur.supplier_payment` · DOCUMENT

An outgoing payment to a supplier. Posted statuses: `PAID`, `REJECTED`, `CANCELLED`.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK, FK `platform.business_document` | |
| `payment_no` | `text` | NULL, UNIQUE | Remittance advice number |
| `supplier_id` | `uuid` | NOT NULL, FK `mdm.supplier` | |
| `method` | `text` | NOT NULL, CHECK in (`BANK`, `MOBILE_MONEY`, `CASH`, `CHEQUE`) | |
| `bank_account_id` | `uuid` | NULL, FK `fin.bank_account`; required unless `CASH` | Where the money leaves from |
| `amount_pesewas` | `pesewas` | NOT NULL, CHECK `> 0` | |
| `scheduled_for` | `date` | NULL | Payment scheduling |
| `paid_at` | `timestamptz` | NULL | |
| `external_reference` | `text` | NULL | Bank or mobile money reference |
| `approval_request_id` | `uuid` | NULL, FK `iam.approval_request`; required to become `PAID` | Maker and checker differ |
| `remittance_document_id` | `uuid` | NULL, FK `doc.archived_document` | Remittance advice |

Standard columns: `DOCUMENT` (`status` in `DRAFT`, `PENDING_APPROVAL`, `APPROVED`, `PAID`, `REJECTED`, `CANCELLED`).

### `pur.supplier_payment_allocation` · LEDGER

A supplier payment applied to an invoice.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `supplier_payment_id` | `uuid` | NOT NULL, FK `pur.supplier_payment` | |
| `supplier_invoice_id` | `uuid` | NOT NULL, FK `pur.supplier_invoice` | |
| `amount_pesewas` | `pesewas` | NOT NULL, CHECK `> 0` | |

Standard columns: `LEDGER`.

- Trigger: the invoice's `match_status` is `MATCHED` or `NOT_REQUIRED` (three-way match blocks payment); allocations of a payment do not exceed its amount; allocations to an invoice do not exceed its unpaid amount. Maintains `paid_pesewas`.

### `pur.supplier_score` · PROJECTION

Supplier performance per period.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `supplier_id` | `uuid` | NOT NULL, FK `mdm.supplier` | |
| `period_start` | `date` | NOT NULL | |
| `period_end` | `date` | NOT NULL | |
| `orders_count` | `integer` | NOT NULL | |
| `on_time_percent` | `percent` | NULL | Lead time |
| `rejection_percent` | `percent` | NULL | Quality: rejected over received |
| `price_variance_percent` | `percent` | NULL | Invoice against order price |
| `score` | `percent` | NULL | Weighted overall score |
| `computed_at` | `timestamptz` | NOT NULL | |

- PK (`supplier_id`, `period_start`).
