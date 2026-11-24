# Table dictionary: `shp`

Owner: SHP module. Carts, checkout sessions and the storefront's listing read model. Orders, payments, reservations and promotions belong to other modules. Conventions are in `docs/DATA_MODEL.md`.

---

### `shp.cart` · WORK

A shopper's basket. Operational state, purged after a retention period.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `customer_id` | `uuid` | NULL, FK `mdm.customer` | Null for a guest |
| `guest_token_hash` | `bytea` | NULL | Identifies a guest's cart from a cookie |
| `branch_id` | `uuid` | NOT NULL, FK `mdm.branch` | The branch serving the shopper's zone |
| `contact_phone_e164` | `text` | NULL | For abandoned-cart recovery, with consent |
| `recovery_consent` | `boolean` | NOT NULL DEFAULT `false` | Whether recovery messages may be sent |
| `coupon_code` | `text` | NULL | Entered, validated at checkout |
| `status` | `text` | NOT NULL, CHECK in (`ACTIVE`, `CHECKOUT`, `CONVERTED`, `ABANDONED`, `EXPIRED`) | |
| `created_at` | `timestamptz` | NOT NULL DEFAULT `now()` | |
| `updated_at` | `timestamptz` | NOT NULL | Abandonment is measured from here |

- CHECK: at least one of `customer_id`, `guest_token_hash` is set.

### `shp.cart_line` · WORK

Products in a cart.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `cart_id` | `uuid` | NOT NULL, FK `shp.cart` | |
| `product_id` | `uuid` | NOT NULL, FK `mdm.product` | Must be `LISTED`; a `REQUEST_TO_BUY` product opens a request for quote instead |
| `qty` | `qty` | NOT NULL, CHECK `> 0` | |
| `displayed_unit_price_pesewas` | `pesewas` | NOT NULL | Price shown when added; re-resolved at checkout |
| `added_at` | `timestamptz` | NOT NULL DEFAULT `now()` | |

- UNIQUE (`cart_id`, `product_id`).

### `shp.checkout_session` · DOCUMENT

One attempt to check out a cart. Holds the reservations. Posted statuses: `COMPLETED`, `EXPIRED`, `CANCELLED`.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK, FK `platform.business_document` | The holder of the stock reservations |
| `cart_id` | `uuid` | NOT NULL, FK `shp.cart` | |
| `customer_id` | `uuid` | NULL, FK `mdm.customer` | |
| `contact_name` | `text` | NOT NULL | |
| `contact_phone_e164` | `text` | NOT NULL | |
| `delivery_address_id` | `uuid` | NULL, FK `mdm.customer_address` | |
| `address_snapshot` | `jsonb` | NULL | Guest address |
| `fulfilment_mode` | `text` | NOT NULL, CHECK in (`COLLECTION`, `DELIVERY`) | |
| `delivery_zone_id` | `uuid` | NULL, FK `mdm.delivery_zone` | |
| `delivery_slot_id` | `uuid` | NULL, FK `del.delivery_slot` | |
| `delivery_fee_pesewas` | `pesewas` | NOT NULL DEFAULT 0 | |
| `payment_terms` | `text` | NOT NULL, CHECK in (`PREPAID`, `COD`) | |
| `tax_inclusive` | `boolean` | NOT NULL | |
| `estimated_total_pesewas` | `pesewas` | NOT NULL | Clearly displayed |
| `maximum_total_pesewas` | `pesewas` | NOT NULL, CHECK `>= estimated_total_pesewas` | Estimate plus catch-weight tolerance |
| `difference_preference` | `text` | NOT NULL DEFAULT `'REFUND'`, CHECK in (`REFUND`, `STORE_CREDIT`) | What to do if the weighed total is lower (ADR-0021) |
| `price_changed` | `boolean` | NOT NULL DEFAULT `false` | A price changed since the cart; shown before payment |
| `reserved_until` | `timestamptz` | NOT NULL | Timed release |
| `order_id` | `uuid` | NULL, UNIQUE, FK `ord.sales_order` | Set when completed |

Standard columns: `DOCUMENT` (`status` in `STARTED`, `AWAITING_PAYMENT`, `COMPLETED`, `EXPIRED`, `CANCELLED`).

- Partial UNIQUE (`cart_id`) where status is `STARTED` or `AWAITING_PAYMENT`: one live checkout per cart.

### `shp.product_listing` · PROJECTION

The public catalogue as the storefront reads it: one row per listed product and branch, so a catalogue page needs one query and no joins.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `product_id` | `uuid` | NOT NULL, FK `mdm.product` | |
| `branch_id` | `uuid` | NOT NULL, FK `mdm.branch` | |
| `slug` | `text` | NOT NULL | |
| `name` | `text` | NOT NULL | |
| `category_path` | `text[]` | NOT NULL | Filtering and breadcrumbs |
| `product_line` | `text` | NOT NULL | |
| `online_mode` | `text` | NOT NULL | `LISTED` or `REQUEST_TO_BUY` |
| `price_from_pesewas` | `pesewas` | NULL | Lowest resolved online price; null when quote-only |
| `price_to_pesewas` | `pesewas` | NULL | Top of the band, for "from … to …" |
| `price_basis` | `text` | NULL | |
| `tax_inclusive` | `boolean` | NULL | |
| `availability` | `text` | NOT NULL, CHECK in (`IN_STOCK`, `LOW_STOCK`, `OUT_OF_STOCK`, `ON_REQUEST`) | Never an exact quantity |
| `main_image_file_id` | `uuid` | NULL, FK `platform.stored_file` | |
| `search_text` | `tsvector` | NOT NULL | Full-text search |
| `seo_title` | `text` | NULL | |
| `seo_description` | `text` | NULL | |
| `refreshed_at` | `timestamptz` | NOT NULL | |

- PK (`product_id`, `branch_id`). UNIQUE (`branch_id`, `slug`). GIN index on `search_text`.

### `shp.abandoned_cart_notice` · LEDGER

Abandoned-cart reminders requested.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `cart_id` | `uuid` | NOT NULL, FK `shp.cart` | |
| `sequence_no` | `integer` | NOT NULL, CHECK `> 0` | First reminder, second reminder |
| `recorded_at` | `timestamptz` | NOT NULL DEFAULT `now()` | |

- UNIQUE (`cart_id`, `sequence_no`): each reminder is requested once. Sent only when `recovery_consent` is true.

---

## As built (B07 continued 2, migration 0119; A-177, A-178)

- **`shp.cart`:** as above, plus `version` (optimistic lock, `platform.touch_version`). B07 continued 2 creates guest carts only: `guest_token_hash` is the 32-byte HMAC of the cookie token; `customer_id` stays null until registered checkout (B09a). `coupon_code` is checked by `ck_cart_coupon_code`.
- **`shp.cart_line`:** adds `uom` (the product's sale unit) and `updated_at`. Quantities are whole sale units (checked in the handler, A-178).
- **`shp.checkout_session`:** as above, plus `coupon_code`, `discount_pesewas`, `promotions` (jsonb snapshot of the applied promotions as shown), `tax_pesewas` (the levies inside the tax-inclusive total), `version` and `posted_at`/`posted_by` for the ended statuses. `order_id` has no foreign key yet: B09a adds `fk_checkout_session_order` to `ord.sales_order` when the table exists (expand). `ck_checkout_session_delivery`: a delivered checkout names its zone and address; a collected one has no zone, slot or fee. Frozen once `COMPLETED`, `EXPIRED` or `CANCELLED` (`platform.freeze_posted`). The reservations are INV's, keyed by `holder_document_id` = the checkout id (document type `CHECKOUT_SESSION`, migration 0117).
- **B09a continued 2f (A-232, ADR-0070, migration 0205):** `fk_checkout_session_order` (to `ord.sales_order`, the expand 0119 announced) and `ck_checkout_session_awaiting` (a checkout `AWAITING_PAYMENT` names its order). `placeOrder` moves a `STARTED` checkout to `AWAITING_PAYMENT` with `order_id`; the checkout completes (`COMPLETED`, the cart `CONVERTED`) in the transaction that hands its reservations to the order (`inv.ReservationReleased` with `transferredToDocumentId` its order), and is cancelled or expired as before when its hold ends first.
- **`shp.checkout_line` (DOCUMENT, new):** the lines as priced when the checkout started: product, quantity and unit, `base_qty` reserved (a catch-weight line's packs times the nominal pack weight), the price list entry, unit price and basis, the estimated weight, estimated and maximum line totals, the discount taken from the line and its tax category. PK (`checkout_id`, `line_no`). Written once, while the checkout is `STARTED` (`shp.checkout_line_guard`, HK004); `ck_checkout_line_totals`.
- **`shp.product_listing`:** as above, plus `description`, `category_code` (leaf), `category_codes` (root first, GIN index), `category_sort`, `sale_uom`, `nominal_pack_kg`, `catch_weight`, `weight_tolerance_percent` and `images` (jsonb snapshot of the public variants). Indexes for the shared sort (ADR-0054): name, price (unpriced last) and the shop's order. Written only by `shp.replace_product_listing(branch, rows)` (SECURITY DEFINER); `hk_app` reads it. Rebuilt every minute by the `catalogue-refresh` job.
- **`shp.abandoned_cart_notice`** (B11 continued 12, migration 0341, ADR-0084, A-378): as above, with `sequence_no` always 1 (`ck_abandoned_cart_notice_sequence`: one reminder per cart, ever), `idle_since` (when the cart was last changed, before `recorded_at`), `recorded_at` and `actor_id` written from the application's clock. Only a customer's cart (`shp.abandoned_cart_notice_guard`, HK010). Insert only. Written by the `abandoned-carts` job for a cart idle two hours whose customer gave marketing consent.
