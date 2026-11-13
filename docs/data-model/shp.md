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
