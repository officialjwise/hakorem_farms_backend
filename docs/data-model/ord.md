# Table dictionary: `ord`

Owner: ORD module. The single order record for every channel, sale posting, fulfilment and returns (ADR-0004, ADR-0021, ADR-0026, ADR-0027). The core tables are built in B9a; fulfilment tables in B11. Conventions are in `docs/DATA_MODEL.md`.

---

### `ord.sales_order` · DOCUMENT

Posted statuses: `COMPLETED`, `CANCELLED`, `VOIDED`. The state machine is in `docs/DOMAIN_MODEL.md` section 7. Published key.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK, FK `platform.business_document` | Client-generated for offline counter sales |
| `order_no` | `text` | NULL, UNIQUE | Allocated when placed on the server |
| `channel` | `text` | NOT NULL, CHECK in (`POS`, `ONLINE`, `WHOLESALE`, `QUOTE`) | |
| `customer_id` | `uuid` | NULL, FK `mdm.customer` | Null for a walk-in sale |
| `contact_name` | `text` | NULL | Guest checkout |
| `contact_phone_e164` | `text` | NULL | Receipt and delivery messages |
| `status` | `text` | NOT NULL, CHECK in (`PLACED`, `CONFIRMED`, `PICKING`, `AWAITING_CUSTOMER`, `PACKED`, `READY_FOR_COLLECTION`, `DISPATCHED`, `DELIVERED`, `DELIVERY_FAILED`, `RETURNED`, `COMPLETED`, `CANCELLED`, `VOIDED`) | |
| `payment_terms` | `text` | NOT NULL, CHECK in (`IMMEDIATE`, `PREPAID`, `COD`, `CREDIT`) | |
| `fulfilment_mode` | `text` | NOT NULL, CHECK in (`COUNTER`, `COLLECTION`, `DELIVERY`) | |
| `source_document_id` | `uuid` | NULL, FK `platform.business_document` | The accepted quote, standing order or checkout it came from |
| `parent_order_id` | `uuid` | NULL, FK `ord.sales_order` | For a backorder split from another order |
| `shift_document_id` | `uuid` | NULL, FK `platform.business_document`; required for `POS` | The shift that made the sale |
| `salesperson_id` | `uuid` | NULL, FK `iam.principal` | Win rate and margin by salesperson |
| `delivery_address_id` | `uuid` | NULL, FK `mdm.customer_address` | |
| `delivery_address_snapshot` | `jsonb` | NULL | As at order time |
| `delivery_zone_id` | `uuid` | NULL, FK `mdm.delivery_zone` | |
| `delivery_fee_pesewas` | `pesewas` | NOT NULL DEFAULT 0 | |
| `delivery_id` | `uuid` | NULL, FK `del.delivery` | Set when scheduled |
| `currency` | `char(3)` | NOT NULL DEFAULT `'GHS'`, CHECK `= 'GHS'` | |
| `tax_inclusive` | `boolean` | NOT NULL | |
| `estimated_total_pesewas` | `pesewas` | NOT NULL | Shown at checkout |
| `maximum_total_pesewas` | `pesewas` | NOT NULL, CHECK `>= estimated_total_pesewas` | Estimate plus tolerance: the most the customer can be charged without consent |
| `final_total_pesewas` | `pesewas` | NULL | After weighing; equals the billing document |
| `billing_document_id` | `uuid` | NULL, FK `bil.billing_document` | Invoice or receipt |
| `credit_check` | `text` | NULL, CHECK in (`PASSED`, `OVERRIDDEN`, `NOT_REQUIRED`) | Result of the confirmation policy |
| `customer_consent` | `jsonb` | NULL | Consent to a higher total or a substitution: what, when, how obtained |
| `cancel_reason_code` | `text` | NULL, FK `mdm.reason_code` | |
| `void_approval_request_id` | `uuid` | NULL, FK `iam.approval_request`; required for `VOIDED` | Supervisor approval |
| `is_offline` | `boolean` | NOT NULL DEFAULT `false` | Made while the device was offline |
| `placed_at` | `timestamptz` | NOT NULL | `occurred_at` of the sale; the device's time for an offline sale |
| `completed_at` | `timestamptz` | NULL | |
| `recorded_at` | `timestamptz` | NOT NULL DEFAULT `now()` | When the server stored it |
| `notes` | `text` | NULL | |

Standard columns: `DOCUMENT`.

- Indexes: (`customer_id`, `placed_at`); (`status`, `branch_id`); (`shift_document_id`).

### `ord.sales_order_line` · DOCUMENT

Carries the full pricing record the brief requires on every sale line. Published key.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `sales_order_id` | `uuid` | NOT NULL, FK `ord.sales_order` | |
| `line_no` | `integer` | NOT NULL | |
| `product_id` | `uuid` | NOT NULL, FK `mdm.product` | |
| `stock_unit_id` | `uuid` | NULL, FK `inv.stock_unit` | The animal sold, or the lot picked |
| `qty_ordered` | `qty` | NOT NULL, CHECK `> 0` | Head, packs or units |
| `uom` | `text` | NOT NULL, FK `mdm.uom` | |
| `estimated_weight_kg` | `kg` | NULL | Catch-weight estimate |
| `tolerance_percent` | `percent` | NULL | Snapshot from the product |
| `qty_fulfilled` | `qty` | NOT NULL DEFAULT 0 | |
| `fulfilled_weight_kg` | `kg` | NULL | Weighed |
| `weight_source` | `text` | NULL, CHECK in (`SCALE`, `MANUAL`, `ESTIMATE`) | |
| `qty_backordered` | `qty` | NOT NULL DEFAULT 0 | |
| `price_source` | `text` | NOT NULL, CHECK in (`ENGINE`, `QUOTE`, `MANUAL_APPROVED`) | Where the price came from |
| `price_basis` | `text` | NOT NULL, CHECK in (`PER_HEAD`, `PER_KG`, `PER_UNIT`) | |
| `price_list_entry_id` | `uuid` | NULL, FK `mdm.price_list_entry`; required for `ENGINE` | The rule that produced the price |
| `quote_line_ref` | `uuid` | NULL; required for `QUOTE` | The quote line |
| `resolved_unit_price_pesewas` | `pesewas` | NOT NULL | List price resolved |
| `floor_unit_price_pesewas` | `pesewas` | NOT NULL | |
| `ceiling_unit_price_pesewas` | `pesewas` | NOT NULL | |
| `agreed_unit_price_pesewas` | `pesewas` | NOT NULL | What the customer pays |
| `variance_pesewas` | `pesewas` | NOT NULL DEFAULT 0 | Absolute difference, extended over the quantity |
| `variance_direction` | `text` | NULL, CHECK in (`BELOW`, `ABOVE`) | |
| `variance_reason_code` | `text` | NULL, FK `mdm.reason_code`; required when there is a variance | Mandatory reason |
| `variance_requires_approval` | `boolean` | NOT NULL DEFAULT `false` | Outside the band or beyond the role limit |
| `variance_approval_request_id` | `uuid` | NULL, FK `iam.approval_request` | Who approved |
| `discount_pesewas` | `pesewas` | NOT NULL DEFAULT 0 | Promotions |
| `estimated_line_total_pesewas` | `pesewas` | NOT NULL | |
| `final_line_total_pesewas` | `pesewas` | NULL | On weighed quantity |
| `reservation_id` | `uuid` | NULL, FK `inv.stock_reservation` | |
| `stock_movement_id` | `uuid` | NULL, FK `inv.stock_movement` | The issue |
| `stock_exception_id` | `uuid` | NULL, FK `inv.stock_exception` | In place of a movement after an offline conflict (ADR-0027) |
| `substituted_for_line_id` | `uuid` | NULL, FK `ord.sales_order_line` | This line replaces another, with consent |
| `line_status` | `text` | NOT NULL, CHECK in (`OPEN`, `FULFILLED`, `PARTIAL`, `BACKORDERED`, `SUBSTITUTED`, `CANCELLED`, `RETURNED`) | |

- UNIQUE (`sales_order_id`, `line_no`).
- CHECK: `floor_unit_price_pesewas <= resolved_unit_price_pesewas <= ceiling_unit_price_pesewas`.
- CHECK: `variance_requires_approval` implies `variance_approval_request_id IS NOT NULL` once the order is past `PLACED`. For an offline sale synced with an override beyond the limit, the approval is requested after the fact and the line is listed as an exception until decided.
- CHECK: when the order is `COMPLETED`, a product line with stock has `stock_movement_id` or `stock_exception_id`.
- Trigger: a line for a serialised product has `stock_unit_id` set and `qty_ordered = 1`.

### `ord.sales_order_adjustment` · DOCUMENT

Promotions and coupons applied, recorded separately from the price.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `sales_order_id` | `uuid` | NOT NULL, FK `ord.sales_order` | |
| `sales_order_line_id` | `uuid` | NULL, FK `ord.sales_order_line` | Null for an order-level adjustment |
| `promotion_id` | `uuid` | NOT NULL, FK `mdm.promotion` | |
| `coupon_id` | `uuid` | NULL, FK `mdm.coupon` | |
| `amount_pesewas` | `pesewas` | NOT NULL, CHECK `> 0` | Discount given |

### `ord.order_status_history` · LEDGER

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `sales_order_id` | `uuid` | NOT NULL, FK `ord.sales_order` | |
| `from_status` | `text` | NULL | |
| `to_status` | `text` | NOT NULL | |
| `reason` | `text` | NULL | |
| `occurred_at` | `timestamptz` | NOT NULL | |

Standard columns: `LEDGER`.

### `ord.fulfilment` · DOCUMENT

A pick, pack and dispatch of all or part of an order. Built in B11. Posted statuses: `DISPATCHED`, `COLLECTED`, `CANCELLED`.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK, FK `platform.business_document` | |
| `fulfilment_no` | `text` | NULL, UNIQUE | Pick list number |
| `sales_order_id` | `uuid` | NOT NULL, FK `ord.sales_order` | |
| `pick_location_id` | `uuid` | NOT NULL, FK `mdm.location` | |
| `picker_id` | `uuid` | NULL, FK `iam.principal` | |
| `picked_at` | `timestamptz` | NULL | |
| `packed_at` | `timestamptz` | NULL | |
| `dispatched_at` | `timestamptz` | NULL | |
| `package_count` | `integer` | NULL | |

Standard columns: `DOCUMENT` (`status` in `PICK_LIST`, `PICKING`, `PACKED`, `DISPATCHED`, `COLLECTED`, `CANCELLED`).

### `ord.fulfilment_line` · DOCUMENT

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | May be generated on the picking device |
| `fulfilment_id` | `uuid` | NOT NULL, FK `ord.fulfilment` | |
| `sales_order_line_id` | `uuid` | NOT NULL, FK `ord.sales_order_line` | |
| `stock_unit_id` | `uuid` | NULL, FK `inv.stock_unit` | The lot or animal picked |
| `pack_barcode` | `text` | NULL | The pack scanned |
| `qty` | `qty` | NOT NULL, CHECK `> 0` | |
| `weight_kg` | `kg` | NULL | Weight at pick |
| `weight_source` | `text` | NULL, CHECK in (`SCALE`, `MANUAL`, `ESTIMATE`) | |
| `stock_movement_id` | `uuid` | NULL, FK `inv.stock_movement` | Shop floor or cold room to vehicle or customer |

### `ord.order_return` · DOCUMENT

A return or exchange against an original order. Posted statuses: `COMPLETED`, `REJECTED`.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK, FK `platform.business_document` | |
| `return_no` | `text` | NULL, UNIQUE | |
| `sales_order_id` | `uuid` | NOT NULL, FK `ord.sales_order` | The original sale |
| `original_billing_document_id` | `uuid` | NOT NULL, FK `bil.billing_document` | The original receipt |
| `kind` | `text` | NOT NULL, CHECK in (`RETURN`, `EXCHANGE`) | |
| `reason_code` | `text` | NOT NULL, FK `mdm.reason_code` | |
| `credit_note_id` | `uuid` | NULL, FK `bil.billing_document` | |
| `refund_id` | `uuid` | NULL, FK `pay.refund` | |
| `exchange_order_id` | `uuid` | NULL, FK `ord.sales_order` | The replacement sale |
| `approval_request_id` | `uuid` | NULL, FK `iam.approval_request` | |

Standard columns: `DOCUMENT` (`status` in `REQUESTED`, `PENDING_APPROVAL`, `COMPLETED`, `REJECTED`).

### `ord.order_return_line` · DOCUMENT

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `order_return_id` | `uuid` | NOT NULL, FK `ord.order_return` | |
| `sales_order_line_id` | `uuid` | NOT NULL, FK `ord.sales_order_line` | |
| `qty` | `qty` | NOT NULL, CHECK `> 0` | |
| `weight_kg` | `kg` | NULL | |
| `disposition` | `text` | NOT NULL, CHECK in (`RESTOCK`, `RETURNS_HOLD`, `WRITE_OFF`) | Where the goods go |
| `stock_movement_id` | `uuid` | NULL, FK `inv.stock_movement` | |

- Trigger: total returned against an order line does not exceed what was fulfilled.
