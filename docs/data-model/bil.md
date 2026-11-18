# Table dictionary: `bil`

Owner: BIL module. Invoices, receipts, proformas, credit notes and debit notes, with levy rows and reprints (ADR-0015, ADR-0020). Rendering, templates and the archive are the DOC module's. Conventions are in `docs/DATA_MODEL.md`.

---

### `bil.billing_document` · DOCUMENT

Posted statuses: `ISSUED`. An issued document is immutable; it is corrected by a credit or debit note. Published key.

**Built in B09b continued 2b (migration 0257, A-278 (d)):** `synced_from_offline` (boolean, NOT NULL, default false): a receipt for a sale an offline till synced later, issued at the till's time (`issued_at` is its `occurred_at`), dated the day it happened or the first open date (`issue_date`). `ck_billing_document_offline`: only a RECEIPT with its `occurred_at`. Frozen with the rest of an issued document.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK, FK `platform.business_document` | |
| `kind` | `text` | NOT NULL, CHECK in (`PROFORMA`, `INVOICE`, `RECEIPT`, `CREDIT_NOTE`, `DEBIT_NOTE`) | `RECEIPT` is the document for a sale paid at once |
| `document_no` | `text` | NULL, UNIQUE; required when `ISSUED` | Gap-free official number |
| `provisional_ref` | `text` | NULL, UNIQUE | The reference printed by an offline device (ADR-0015) |
| `customer_id` | `uuid` | NULL, FK `mdm.customer` | Null for a walk-in sale |
| `customer_name` | `text` | NULL | Snapshot as printed |
| `customer_tin` | `text` | NULL | Snapshot as printed, where the customer supplied one |
| `billing_address` | `text` | NULL | Snapshot |
| `order_document_id` | `uuid` | NULL, FK `platform.business_document` | The order billed |
| `original_document_id` | `uuid` | NULL, FK `bil.billing_document`; required for credit and debit notes | The document corrected |
| `issue_date` | `date` | NULL | Tax date, Africa/Accra |
| `due_date` | `date` | NULL | For credit sales. Never before `issue_date` (`ck_billing_document_due`): a credit note is due on the later of its original's due date and its draft day, and a draft issued on a later day than its due date is due on its issue date (A-223) |
| `currency` | `char(3)` | NOT NULL DEFAULT `'GHS'`, CHECK `= 'GHS'` | |
| `tax_inclusive` | `boolean` | NOT NULL | How lines were priced |
| `tax_scheme_version_id` | `uuid` | NOT NULL, FK `mdm.tax_scheme_version` | The matrix used |
| `net_pesewas` | `pesewas` | NOT NULL DEFAULT 0 | Sum of line nets |
| `tax_pesewas` | `pesewas` | NOT NULL DEFAULT 0 | Sum of levy rows |
| `gross_pesewas` | `pesewas` | NOT NULL DEFAULT 0 | Sum of line gross amounts |
| `credited_pesewas` | `pesewas` | NOT NULL DEFAULT 0, CHECK `<= gross_pesewas` | Maintained by trigger from credit notes |
| `certified_tax_pesewas` | `pesewas` | NULL | Totals returned by an electronic invoicing service, if one applies (ADR-0020) |
| `certified_gross_pesewas` | `pesewas` | NULL | |
| `certification_ref` | `text` | NULL | The authority's reference |
| `reason_code` | `text` | NULL, FK `mdm.reason_code`; required for credit and debit notes | A `REFUND` or `RETURN` reason on a credit note, a `BILLING_ADJUSTMENT` one on a debit note (A-200) |
| `note` | `text` | NULL | The reason's note, where the reason requires one (B08 continued 2) |
| `approval_request_id` | `uuid` | NULL, FK `iam.approval_request` | The `CREDIT_NOTE` approval a credit note waits for (B08 continued 2) |
| `issued_by` | `uuid` | NULL, FK `iam.principal`; required when `ISSUED` | Who issued it, or who approved a credit note (B08 continued 2) |
| `content_hash` | `bytea` | NULL; set once, by the DOC module after it renders and archives the document | Hash of the rendered document: tamper evidence. Rendering happens after the issuing transaction commits (ADR-0010), so an issued document is briefly without its hash; the nightly numbering check reports any issued document still without one |
| `archived_document_id` | `uuid` | NULL, FK `doc.archived_document`, UNIQUE where set | The archived rendering. Added by B08 continued 2b's expand migration 0155; set once with `content_hash` by BIL's subscriber to `doc.DocumentArchived` (`ck_billing_document_archive`: both or neither) |
| `issued_at` | `timestamptz` | NULL | |
| `occurred_at` | `timestamptz` | NULL | When the sale happened, if earlier than issue (offline) |

Standard columns: `DOCUMENT` (`status` in `DRAFT`, `ISSUED`).

- After `ISSUED`, only `credited_pesewas`, `archived_document_id`, `content_hash` (set once) and the certification columns (set once) may change (`ck_billing_document_frozen`); a document is written `DRAFT` and issued once (`ck_billing_document_status`). Never deleted (no grant).
- Deferred trigger on issue: header totals equal the sums of lines, each line's tax the sum of its levy rows, at least one line (`ck_billing_document_totals`); the number is the one `platform.allocate_number` gave this document (`ck_billing_document_number`, through `platform.number_allocated`); `net_pesewas + tax_pesewas = gross_pesewas` (CHECK).
- Trigger on a credit note's issue: it raises the original's `credited_pesewas`, never past its gross (`ck_billing_document_credit_cap`); at commit the original's credited amount equals its issued credit notes. A note corrects an `ISSUED` invoice or receipt of its own branch and customer (`ck_billing_document_original`).
- Index: (`branch_id`, `issue_date`, `id`); (`original_document_id`).
- Indexes: (`customer_id`, `issue_date`); (`order_document_id`).

### `bil.billing_document_line` · DOCUMENT

Frozen with its header. Published key.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `billing_document_id` | `uuid` | NOT NULL, FK `bil.billing_document` | |
| `line_no` | `integer` | NOT NULL | |
| `line_kind` | `text` | NOT NULL, CHECK in (`PRODUCT`, `DELIVERY_FEE`, `ADJUSTMENT`) | |
| `product_id` | `uuid` | NULL, FK `mdm.product` | |
| `description` | `text` | NOT NULL | As printed |
| `stock_unit_id` | `uuid` | NULL, FK `inv.stock_unit` | Tag or lot, for traceability from the invoice |
| `stock_unit_identifier` | `text` | NULL; set exactly with `stock_unit_id` | The tag or lot number as the seller named it, so BIL never reads INV (B08 continued 2) |
| `stock_unit_tracking` | `text` | NULL, CHECK in (`SERIAL`, `LOT`); set exactly with `stock_unit_id` | |
| `credits_line_id` | `uuid` | NULL, FK `bil.billing_document_line` | On a credit note line: the original line it credits (B08 continued 2) |
| `order_line_ref` | `uuid` | NULL | The order line billed |
| `qty` | `qty` | NOT NULL | Billed quantity. For catch-weight lines, the weighed kilograms |
| `uom` | `text` | NOT NULL, FK `mdm.uom` | |
| `weight_kg` | `kg` | NULL | Weighed weight, printed |
| `unit_price_pesewas` | `pesewas` | NOT NULL | Agreed price per unit |
| `resolved_unit_price_pesewas` | `pesewas` | NOT NULL | What the engine or quote resolved, for the variance posting |
| `discount_pesewas` | `pesewas` | NOT NULL DEFAULT 0 | Promotion and allocated header discount |
| `tax_category_id` | `uuid` | NOT NULL, FK `mdm.tax_category` | |
| `line_net_pesewas` | `pesewas` | NOT NULL | |
| `line_tax_pesewas` | `pesewas` | NOT NULL | Sum of this line's levy rows |
| `line_gross_pesewas` | `pesewas` | NOT NULL | |
| `gl_group` | `text` | NOT NULL | Snapshot of the product's ledger group |

- UNIQUE (`billing_document_id`, `line_no`).
- CHECK: `line_net_pesewas + line_tax_pesewas = line_gross_pesewas`; a `PRODUCT` line exactly has a product.
- Written, changed or removed only while its document is `DRAFT` (`ck_billing_document_line_frozen`, also on the levy rows).

### `bil.billing_document_line_tax` · DOCUMENT

One row per line and levy, including levies at zero (ADR-0020). Snapshots that never change.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `billing_document_line_id` | `uuid` | NOT NULL, FK `bil.billing_document_line` | |
| `levy_id` | `uuid` | NOT NULL, FK `mdm.tax_levy` | |
| `levy_code` | `text` | NOT NULL | As printed |
| `levy_name` | `text` | NOT NULL | As printed |
| `treatment` | `text` | NOT NULL, CHECK in (`STANDARD`, `ZERO_RATED`, `EXEMPT`, `OUT_OF_SCOPE`) | |
| `rate_percent` | `percent` | NOT NULL | |
| `base_pesewas` | `pesewas` | NOT NULL | The levy's own base |
| `amount_pesewas` | `pesewas` | NOT NULL | |
| `calc_order` | `integer` | NOT NULL | Print and calculation order |

- PK (`billing_document_line_id`, `levy_id`).
- A new levy appears here as rows. No column, table or code in this module changes.

### `bil.reprint_log` · LEDGER

Built in B08 continued 2b (migration 0155, ADR-0061). A copy number is the next one of an issued, archived document (`ck_reprint_log_copy_no`, HK004); insert-only for every role.

Every reprint or resend. A reprint is the archived bytes with a marker, never a new document.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `billing_document_id` | `uuid` | NOT NULL, FK `bil.billing_document` | |
| `copy_no` | `integer` | NOT NULL, CHECK `> 0` | Printed in the marker: "Reprint 2" |
| `channel` | `text` | NOT NULL, CHECK in (`THERMAL`, `PDF`, `SMS`, `WHATSAPP`, `EMAIL`) | |

Standard columns: `LEDGER`. UNIQUE (`billing_document_id`, `copy_no`).

### `bil.document_settlement` · PROJECTION

What has been paid and credited on each issued document, so an invoice screen needs one request. As built in B08 continued 2 (A-200), a `SECURITY DEFINER` trigger writes the row at issue and moves `credited_pesewas` with each issued credit note; `allocated_pesewas` stays 0 until B9a adds the asynchronous subscriber to `pay.PaymentCleared`, `pay.DepositAllocated`, `pay.PaymentReversed` and `pay.RefundPaid`, a few seconds behind the payments ledger. The figure of record is `pay.invoice_settlement`; a nightly check compares the two. Added in B1 with the contract (field `settlement` on `BillingDocument`).

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `billing_document_id` | `uuid` | PK, FK `bil.billing_document` | |
| `allocated_pesewas` | `pesewas` | NOT NULL DEFAULT 0 | Payments applied |
| `credited_pesewas` | `pesewas` | NOT NULL DEFAULT 0 | Credit notes issued against it |
| `outstanding_pesewas` | `pesewas` | NOT NULL | Gross less allocated less credited |
| `payment_status` | `text` | NOT NULL, CHECK in (`UNPAID`, `PART_PAID`, `PAID`, `CREDITED`, `NOT_APPLICABLE`) | Shown on the document list |
| `settled_at` | `timestamptz` | NULL | When outstanding reached zero |
| `as_of` | `timestamptz` | NOT NULL | Time of the last event applied |

**As built in B09a continued 1d (migration 0182, A-216, ADR-0066):** `bil.document_settlement` adds `refunded_pesewas` (refunds asked for against the document's credit notes, or on a credit note against it, and not rejected) and `refundable_pesewas` (what an invoice or receipt owes back: its gross less credited less allocated plus refunded, when below zero; outstanding is that balance when above). A credit note beyond what is outstanding is therefore issued. `bil.apply_settlement` refuses an allocation to a document that owes the customer money. Published for PAY's refund triggers (ADR-0047): `bil.credit_note_refund(id, amount, HOLD | RELEASE)` under the credit note's row lock (`ck_credit_note_refund_cap`; executable only by its owner) and `bil.credit_note_facts(id)` (original, customer, branch, maker; read only).

An allocation reaches the row only through `bil.apply_settlement(document, amount, direction, at)` (0187), which `Billing.settleIn` calls with the application clock's instant: `settled_at` and `as_of` are that instant, never the database's `now()` (ADR-0067). The three-argument form remains for one release and delegates with `platform.app_now()`.

### `bil.pub_document` · view

Published for costing and reporting: issued documents only, with id, kind, number, branch, customer, issue date, due date, net, tax, gross, credited, allocated, outstanding, order and original document references. No names or addresses. RPT reads it for overdue receivables (B08 continued 2).
