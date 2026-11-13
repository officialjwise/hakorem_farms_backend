# Table dictionary: `pur`

Owner: PUR module. Supplier terms, requisitions, purchase orders, supplier invoices with three-way match, supplier payments and performance. Goods receipts are inventory's (`inv.goods_receipt`). Conventions are in `docs/DATA_MODEL.md`.

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

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `supplier_id` | `uuid` | NOT NULL, FK `mdm.supplier` | |
| `category_id` | `uuid` | NOT NULL, FK `mdm.category` | Categories supplied |

- PK (`supplier_id`, `category_id`).

### `pur.supplier_document` · MASTER

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

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `supplier_payment_id` | `uuid` | NOT NULL, FK `pur.supplier_payment` | |
| `supplier_invoice_id` | `uuid` | NOT NULL, FK `pur.supplier_invoice` | |
| `amount_pesewas` | `pesewas` | NOT NULL, CHECK `> 0` | |

Standard columns: `LEDGER`.

- Trigger: the invoice's `match_status` is `MATCHED` or `NOT_REQUIRED` (three-way match blocks payment); allocations of a payment do not exceed its amount; allocations to an invoice do not exceed its unpaid amount. Maintains `paid_pesewas`.

### `pur.supplier_score` · PROJECTION

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
