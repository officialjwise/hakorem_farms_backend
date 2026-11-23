# Table dictionary: `ord`

Owner: ORD module. The single order record for every channel, sale posting, fulfilment and returns (ADR-0004, ADR-0021, ADR-0026, ADR-0027). The core tables are built in B9a; fulfilment tables in B11. Conventions are in `docs/DATA_MODEL.md`.

**As built in B9a (migration 0163, A-208):** `ord.sales_order`, `ord.sales_order_line` and `ord.order_status_history`, with the state machine (`trg_sales_order_guard`: written PLACED, listed edges only, COMPLETED frozen but for the void, CANCELLED and VOIDED frozen), `ck_sales_order_pos_shift`, `ck_sales_order_completed` (a completed order has its billing document and final total), the line checks of this dictionary (band, price source, agreed price outside the band flagged, variance with its direction and reason, weight with its source), `trg_sales_order_line_guard` (one named animal to a serialised line; lines frozen once the order is posted) and the deferred `trg_sales_order_check` (the number is its allocation; past PLACED every flagged line has its approval; every line of a COMPLETED order has its movement or exception, so a `NON_STOCK` product is not sold on an order line). Not yet: `ord.sales_order_adjustment`, `delivery_id` (B11's expand migration), fulfilments and returns.

**B09a continued 2b (A-224):** no table changes. A staff order is written `PLACED` with `OPEN` lines and moves to `CONFIRMED` with `credit_check` set; its reservations are held by the order (`inv.stock_reservation.holder_document_id`, no expiry), and `reservation_id` names the reservation of a line held by exactly one. The permissions are migrations 0188 and 0189.

**B09a continued 2c (A-226, migration 0194):** `ord.sales_order` adds `voided_by` and `voided_at` with `ck_sales_order_void_checker` (a VOIDED order names who voided it and when, never the one who posted it nor its salesperson), and the guard lets a COMPLETED order change only its status, `void_approval_request_id`, `voided_by` and `voided_at`. A cancellation writes `cancel_reason_code` and `posted_at`/`posted_by`, and turns every OPEN line CANCELLED. `ord.order_void` (below) holds each void asked for. The permissions are migrations 0190 and 0191.

**B09a continued 2d (A-228, ADR-0068, migrations 0195 to 0200):** `ord.order_return` and `ord.order_return_line` as below. A return is written `REQUESTED` against a `COMPLETED` sale and its own receipt, numbered from its `ORDER_RETURN` series (`ck_order_return_number`); submitted by its maker only (`ck_order_return_submitted`); decided by someone else (`ck_order_return_decided`); frozen once decided, what was asked never changing (`ck_order_return_transition`, HK004). `trg_order_return_line_guard` holds `ck_order_return_line_cap` under the sold line's row lock. The stock that comes back names its sale issue (`inv.stock_movement.returns_movement_id`, `docs/data-model/inv.md`). The permissions are migrations 0196 and 0197.


**B09a continued 2e (A-230, ADR-0069, migrations 0201 to 0203):** `ord.sales_order_line` adds `variance_approved_by` and `variance_approved_at` (`ck_sales_order_line_approved`: both or neither, and only on a flagged line naming its request; `ck_sales_order_line_flagged`: a line names an override request only when its price needs one). Once a line names its `PRICE_OVERRIDE` request, its pricing record and then its approver never change (`ck_sales_order_line_priced`, in `trg_sales_order_line_guard`). `ck_sales_order_settled_lines` now requires, past `PLACED` and not `CANCELLED`, every flagged line to name its request and its approver, who is neither the order's `created_by` nor its `salesperson_id`. `ord.sales_order` adds `proforma_document_id` (FK `bil.billing_document`, unique, written once: `ck_sales_order_proforma`). The permissions are migrations 0201 and 0202.

**B09a continued 2f (A-232, ADR-0070, migration 0204):** an online order is written by `OnlineOrders.placeIn` from SHP's checkout: channel `ONLINE`, no `customer_id` (guest), `contact_name` and `contact_phone_e164`, `source_document_id` the checkout, `delivery_address_snapshot`, `delivery_zone_id` and `delivery_fee_pesewas` as the checkout took them, `estimated_total_pesewas` and `maximum_total_pesewas` the checkout's, no `salesperson_id`; a catch-weight line writes `estimated_weight_kg` and `tolerance_percent`. `uq_sales_order_online_source` (partial unique on `source_document_id` where `channel = 'ONLINE'`) holds one online order per checkout and is the point read of the order's in-transaction handlers. Confirmed, its lines are held by the reservations handed over from the checkout (`reservation_id` where one reservation holds the line). No permission is added.

**B09a continued 2g (A-234, migration 0206):** ORD publishes its completed sales for RPT (ADR-0011, ADR-0023): `ord.pub_completed_sale` (`order_id`, `branch_id`, `channel`, `completed_at`, `business_date` = `completed_at` in Africa/Accra, `gross_pesewas` = `final_total_pesewas`; `COMPLETED` orders only, so a VOIDED or cancelled order is not a sale) and `ord.pub_completed_sale_line` (`order_id`, `line_id`, `branch_id`, `channel`, `completed_at`, `business_date`, `product_id`, `sold_qty` and `sold_uom`, the weighed kilograms in `KG` for a line priced per kilogram and else `qty_fulfilled` in the line's unit, `gross_pesewas` = `final_line_total_pesewas`), granted to `hk_app`, `hk_worker` and `hk_report`. Neither reads the clock. Index `ix_sales_order_completed` (`branch_id`, `completed_at`) where `COMPLETED`. A change to either view is a contract change for RPT.
**B11 (A-332 to A-336, ADR-0091, migrations 0293 to 0296):** `ord.fulfilment`, `ord.pick_list_line`, `ord.fulfilment_line` and `ord.order_consent` as below. A pick list (`FULFILMENT`, `PCK-…` from its own series, `ck_fulfilment_number`) is written `PICK_LIST` of a `CONFIRMED` or `PICKING` order of its own branch (`ck_fulfilment_order`) and moves `PICK_LIST`, `PICKING`, `PACKED`, then `DISPATCHED` or `COLLECTED`, or is `CANCELLED` before it is packed (`ck_fulfilment_transition`, HK004). Its lines (`ord.pick_list_line`) never ask more of an order line than it ordered, over pick lists not cancelled, under the order line's row lock (`ck_pick_list_line_cap`). A pick (`ord.fulfilment_line`, its client id the key) is of an open line of its own open pick list and the picks not withdrawn never come to more than the line asks (`ck_fulfilment_line_cap`); it is never changed or removed, only withdrawn while its pick list is open or given its movement at dispatch. A pick moves no stock (ADR-0091): `stock_movement_id` is written at dispatch (B11 continued). While a line is picked, `qty_fulfilled`, `fulfilled_weight_kg`, `weight_source` (its least trusted pack) and `final_line_total_pesewas` (`half_up(price x weighed kg)` once over the line) carry its picks; dispatch fixes them. A substitute line names the line it replaces (`substituted_for_line_id`), which becomes `SUBSTITUTED`. The permissions are migrations 0295 and 0296.

### `ord.pick_list_line` · DOCUMENT

What a pick list asks of one order line (B11).

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `fulfilment_id` | `uuid` | NOT NULL, FK `ord.fulfilment` | |
| `sales_order_line_id` | `uuid` | NOT NULL, FK `ord.sales_order_line`; one per pick list (`uq_pick_list_line`) | The order line |
| `line_no` | `integer` | NOT NULL, UNIQUE per pick list | |
| `qty_to_pick` | `qty` | NOT NULL, CHECK `> 0`; with the other open lines of pick lists not cancelled, never above `qty_ordered` (`ck_pick_list_line_cap`) | In the order line's unit |
| `status` | `text` | NOT NULL, CHECK in (`OPEN`, `CANCELLED`); only `OPEN` to `CANCELLED` | Cancelled when its order line is substituted or cancelled |

Standard columns: `created_*`, `updated_*`.

### `ord.order_consent` · DOCUMENT

What an order asks its customer, and the answer (B11, FR-ORD-010, FR-ORD-013, CR-054, ADR-0091).

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `sales_order_id`, `sales_order_line_id` | `uuid` | NOT NULL, FK; the line of its own order | |
| `kind` | `text` | NOT NULL, CHECK in (`HIGHER_TOTAL`, `SUBSTITUTION`, `SHORT_PICK`); each with its own fields (`ck_order_consent_shape`) | |
| `status` | `text` | NOT NULL, CHECK in (`PENDING`, `ACCEPTED`, `REFUSED`, `WITHDRAWN`); one `PENDING` per order (`uq_order_consent_pending`) | |
| `proposed_product_id`, `proposed_stock_unit_id`, `proposed_qty`, `proposed_uom` | | NULL; a substitute's product, animal, quantity and unit, or a short pick's quantity in the line's unit | |
| `price_list_entry_id`, `price_basis`, `resolved_unit_price_pesewas`, `floor_unit_price_pesewas`, `ceiling_unit_price_pesewas`, `proposed_line_total_pesewas` | | NULL; a substitute's pricing record as the engine gave it when proposed | The substitute line is written at it |
| `weighed_weight_kg`, `weighed_total_pesewas` | `kg`, `pesewas` | NULL; a higher total's weighed figures | |
| `note` | `text` | NULL | What was put to the customer |
| `asked_at` | `timestamptz` | NOT NULL | From the application's clock |
| `answered_by`, `answered_at`, `method`, `answer_note` | | NULL while `PENDING`; `method` in (`PHONE`, `IN_PERSON`, `WHATSAPP`, `SIGNED_LINK`, `CUSTOMER_ACCOUNT`, `SYSTEM`); `SYSTEM` only for `WITHDRAWN`; staff by phone, in person or WhatsApp never `created_by` (`ck_order_consent_answered`) | |
| `substitute_line_id` | `uuid` | NULL, UNIQUE, FK `ord.sales_order_line`; only on an accepted substitution, written once | |

Standard columns: `DOCUMENT` (`branch_id`, `version`, `created_*`, `updated_*`). Once answered, only `substitute_line_id` is written, once (`ck_order_consent_transition`, HK004).

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
| `proforma_document_id` | `uuid` | NULL, UNIQUE, FK `bil.billing_document`; written once | The order's proforma (issueProforma, B09a continued 2e) |
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

### `ord.order_void` · DOCUMENT

One void asked for of a completed sale (B09a continued 2c, A-226). Written `PENDING_APPROVAL` with its `SALE_VOID` approval; then `APPROVED` with its credit note, or `REJECTED`; then frozen (`trg_order_void_guard`, `ck_order_void_transition`).

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `sales_order_id` | `uuid` | NOT NULL, FK `ord.sales_order`; one not REJECTED per order (`uq_order_void_open`) | The sale |
| `reason_code` | `text` | NOT NULL, FK `mdm.reason_code` | A `VOID` reason |
| `note` | `text` | NULL | |
| `status` | `text` | NOT NULL, CHECK in (`PENDING_APPROVAL`, `APPROVED`, `REJECTED`) | |
| `approval_request_id` | `uuid` | NOT NULL, UNIQUE, FK `iam.approval_request` | The supervisor's approval |
| `credit_note_id` | `uuid` | NULL, UNIQUE, FK `bil.billing_document`; set exactly when APPROVED | The credit note crediting the receipt in full |
| `decided_by`, `decided_at` | `uuid`, `timestamptz` | NULL until decided; `decided_by` never `created_by` (`ck_order_void_decided`) | |

Standard columns: `DOCUMENT` (`branch_id`, `version`, `created_*`, `updated_*`).

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
| `variance_approval_request_id` | `uuid` | NULL, FK `iam.approval_request`; only on a flagged line | The `PRICE_OVERRIDE` approval asked for |
| `variance_approved_by`, `variance_approved_at` | `uuid`, `timestamptz` | NULL until approved; never the order's writer nor its salesperson; fixed once written | Who approved and when (B09a continued 2e) |
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
- CHECK: `variance_requires_approval` implies `variance_approval_request_id` and `variance_approved_by` (neither the order's writer nor its salesperson) once the order is past `PLACED` and not `CANCELLED`. For an offline sale synced with an override beyond the limit, the approval is requested after the fact and the line is listed as an exception until decided.
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

Every status change of an order.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `sales_order_id` | `uuid` | NOT NULL, FK `ord.sales_order` | |
| `from_status` | `text` | NULL | |
| `to_status` | `text` | NOT NULL | |
| `reason` | `text` | NULL | |
| `occurred_at` | `timestamptz` | NOT NULL | |

Standard columns: `LEDGER`.

### `ord.order_tracking_token` · LEDGER

**As built in B09q continued (migration 0213, ADR-0074, A-256).** One row per tracking link ever issued for an online order: at placement, and again for each replay of the placement. Only the token's hash is stored; the token itself is answered once and kept nowhere.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `sales_order_id` | `uuid` | NOT NULL, FK `ord.sales_order`; an ONLINE order only (`ck_order_tracking_token_online`, trigger) | |
| `token_hash` | `bytea` | NOT NULL, 32 bytes (`ck_order_tracking_token_hash`), UNIQUE (`uq_order_tracking_token_hash`) | SHA-256 of the token's text; `trackOrder` looks the order up by it |
| `recorded_at` | `timestamptz` | NOT NULL | When the link was made, from the application's clock (ADR-0067) |
| `expires_at` | `timestamptz` | NOT NULL; after `recorded_at` and at most thirty days after it (`ck_order_tracking_token_expiry`) | The link reads nothing from then on |
| `actor_id` | `uuid` | NOT NULL, FK `iam.principal` | The storefront principal for a guest's placement |

Standard columns: `LEDGER` (never updated, deleted or truncated: `platform.reject_change()`). Index `ix_order_tracking_token_order` on `sales_order_id`.

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
| `package_count` | `integer` | NULL, CHECK `> 0`; set exactly when packed | |
| `cancel_reason`, `cancelled_by`, `cancelled_at` | | NULL; set exactly when `CANCELLED` (B11) | |

Standard columns: `DOCUMENT` (`status` in `PICK_LIST`, `PICKING`, `PACKED`, `DISPATCHED`, `COLLECTED`, `CANCELLED`). As built (B11): `fulfilment_no` NOT NULL (allocated when made); `picker_id` and `picked_at` set from the first pick.

### `ord.fulfilment_line` · DOCUMENT

What was picked for an order line, with weight.

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
| `stock_movement_id` | `uuid` | NULL, UNIQUE, FK `inv.stock_movement`; written at dispatch, never on a withdrawn pick | Shop floor or cold room to vehicle or customer |
| `pick_list_line_id` | `uuid` | NOT NULL, FK `ord.pick_list_line` (B11) | What the pick is against |
| `line_no` | `integer` | NOT NULL, CHECK `> 0`, UNIQUE per pick list (B11) | The order it was recorded in; picks are answered in it, never by their client ids |
| `qty_base` | `qty` | NOT NULL, CHECK `> 0` (B11) | In the product's base unit: a catch-weight pack's weighed kilograms |
| `withdrawn_at`, `withdrawn_by` | | NULL; both or neither (B11) | A pick taken back (a pack swapped); kept, never counted again |
| `recorded_at` | `timestamptz` | NOT NULL (B11) | From the application's clock |

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
| `refund_destination` | `text` | NOT NULL, CHECK in (`ORIGINAL_METHOD`, `STORE_CREDIT`, `CASH`) | Where the refund goes, judged by PAY when it is asked for |
| `note` | `text` | NULL | Required where the reason asks for one |
| `credit_note_id` | `uuid` | NULL, UNIQUE, FK `bil.billing_document`; set exactly when COMPLETED | The credit note, made by the return's maker under its approval |
| `refund_id` | `uuid` | NULL, UNIQUE, FK `pay.refund`; only when COMPLETED | The refund against the credit note, when the sale owed money back |
| `exchange_order_id` | `uuid` | NULL, FK `ord.sales_order`; NULL until exchanges are built (B9b) | The replacement sale |
| `approval_request_id` | `uuid` | NULL, UNIQUE, FK `iam.approval_request`; set at submission | The `RETURN` approval |
| `submitted_by`, `submitted_at` | `uuid`, `timestamptz` | NULL until submitted; `submitted_by` is `created_by` | |
| `decided_by`, `decided_at` | `uuid`, `timestamptz` | NULL until decided; never `created_by` | |

`return_no` is NOT NULL as built (allocated when the return is made). Standard columns: `DOCUMENT` (`status` in `REQUESTED`, `PENDING_APPROVAL`, `COMPLETED`, `REJECTED`).

### `ord.order_return_line` · DOCUMENT

The lines and quantities being returned.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `order_return_id` | `uuid` | NOT NULL, FK `ord.order_return` | |
| `sales_order_line_id` | `uuid` | NOT NULL, FK `ord.sales_order_line` | |
| `line_no` | `integer` | NOT NULL, UNIQUE per return | |
| `qty` | `qty` | NOT NULL, CHECK `> 0` | |
| `weight_kg` | `kg` | NULL | |
| `disposition` | `text` | NOT NULL, CHECK in (`RESTOCK`, `RETURNS_HOLD`, `WRITE_OFF`) | Where the goods go |
| `refund_pesewas` | `pesewas` | NOT NULL DEFAULT 0 | What the line's credit carries: BIL's preview when made, the credit note's figure once completed |
| `stock_movement_id` | `uuid` | NULL, UNIQUE, FK `inv.stock_movement`; NULL for `WRITE_OFF` | The `SALE_RETURN` |

- UNIQUE (`order_return_id`, `sales_order_line_id`).
- Trigger (`ck_order_return_line_cap`): what returns not `REJECTED` hold of a sold line never exceeds its `qty_fulfilled`, under the sold line's row lock; the line is of the return's own sale; lines are written while the return is `REQUESTED`, and afterwards only `refund_pesewas` and `stock_movement_id`, while it is open.
