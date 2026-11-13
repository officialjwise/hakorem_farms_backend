# Table dictionary: `bil`

Owner: BIL module. Invoices, receipts, proformas, credit notes and debit notes, with levy rows and reprints (ADR-0015, ADR-0020). Rendering, templates and the archive are the DOC module's. Conventions are in `docs/DATA_MODEL.md`.

---

### `bil.billing_document` · DOCUMENT

Posted statuses: `ISSUED`. An issued document is immutable; it is corrected by a credit or debit note. Published key.

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
| `due_date` | `date` | NULL | For credit sales |
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
| `reason_code` | `text` | NULL, FK `mdm.reason_code`; required for credit and debit notes | |
| `content_hash` | `bytea` | NULL; required when `ISSUED` | Hash of the rendered document: tamper evidence |
| `archived_document_id` | `uuid` | NULL, FK `doc.archived_document` | The stored PDF |
| `issued_at` | `timestamptz` | NULL | |
| `occurred_at` | `timestamptz` | NULL | When the sale happened, if earlier than issue (offline) |

Standard columns: `DOCUMENT` (`status` in `DRAFT`, `ISSUED`).

- After `ISSUED`, only `credited_pesewas`, `archived_document_id`, `content_hash` (set once) and the certification columns may change.
- Deferred trigger on issue: header totals equal the sums of lines; `net_pesewas + tax_pesewas = gross_pesewas`.
- Trigger on a credit note: the original is `ISSUED`, and the note does not exceed the original's uncredited amount.
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
- CHECK: `line_net_pesewas + line_tax_pesewas = line_gross_pesewas`.

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

Every reprint or resend. A reprint is the archived bytes with a marker, never a new document.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `billing_document_id` | `uuid` | NOT NULL, FK `bil.billing_document` | |
| `copy_no` | `integer` | NOT NULL, CHECK `> 0` | Printed in the marker: "Reprint 2" |
| `channel` | `text` | NOT NULL, CHECK in (`THERMAL`, `PDF`, `SMS`, `WHATSAPP`, `EMAIL`) | |

Standard columns: `LEDGER`. UNIQUE (`billing_document_id`, `copy_no`).

### `bil.pub_document` · view

Published for costing and reporting: document id, kind, number, branch, customer, issue date, net, tax, gross, credited, order reference. No names or addresses.
