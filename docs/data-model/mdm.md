# Table dictionary: `mdm`

Owner: MDM module. Catalogue, parties, branches and locations, pricing, promotions, tax configuration and reference data (ADR-0004, ADR-0007, ADR-0020). Conventions are in `docs/DATA_MODEL.md`.

## Catalogue

### `mdm.category` · MASTER

Product categories, in a tree. A category fixes the product line, tax category and ledger grouping its products default to.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `parent_id` | `uuid` | NULL, FK `mdm.category` | Tree |
| `code` | `text` | NOT NULL, UNIQUE among live rows | |
| `name` | `text` | NOT NULL | |
| `product_line` | `text` | NOT NULL, CHECK in (`LIVE`, `MEAT`, `PRODUCE`, `BY_PRODUCT`, `FEED`, `SUPPLY`, `SERVICE`) | Reporting by line |
| `gl_group` | `text` | NOT NULL, CHECK in (`LIVE_ANIMALS`, `MEAT`, `OFFAL`, `PRODUCE_EGGS`, `FEED_MEDICATION`, `SUPPLIES`, `SERVICE`) | The determinant the ledger maps to inventory, sales and cost accounts (ADR-0003) |
| `tax_category_id` | `uuid` | NOT NULL, FK `mdm.tax_category` | Default tax category |
| `sort_order` | `integer` | NOT NULL DEFAULT 0 | Storefront and POS tile order |
| `is_online_visible` | `boolean` | NOT NULL DEFAULT `true` | |

Standard columns: `MASTER`. UNIQUE (`parent_id`, `lower(btrim(name))`) among live rows, roots counting as siblings (`uq_category_sibling_name`, migration 0019). A category with live products or live children is not archived (application, FR-MDM-002).

### `mdm.uom` · LOOKUP

Units of measure.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `code` | `text` | PK | `HEAD`, `KG`, `CRATE`, `BUNCH`, `TUBER`, `PACK`, `UNIT`, `BAG`, `LITRE` |
| `name` | `text` | NOT NULL | |
| `kind` | `text` | NOT NULL, CHECK in (`COUNT`, `WEIGHT`, `VOLUME`) | Whether fractions are allowed |
| `display_decimals` | `smallint` | NOT NULL, CHECK `BETWEEN 0 AND 3` | Decimal places a quantity in the unit is shown with: 0 for counted units, 3 for weight and volume (CR-003, migration 0019) |

### `mdm.species` · MASTER

Species of livestock.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `code` | `text` | NOT NULL, UNIQUE among live rows | `GOAT`, `SHEEP`, `PIG`, `BROILER`, `LOCAL_CHICKEN`, `DUCK`, `RABBIT`, `CATTLE` |
| `name` | `text` | NOT NULL | |
| `tracking_default` | `text` | NOT NULL, CHECK in (`SERIAL`, `LOT`) | Goats are individuals; broilers are flocks |

Standard columns: `MASTER`.

### `mdm.grade` · MASTER

Quality grades within a species, used by pricing and quoting.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `species_id` | `uuid` | NOT NULL, FK `mdm.species` | Grades are per species |
| `code` | `text` | NOT NULL | |
| `name` | `text` | NOT NULL | |
| `description` | `text` | NULL | What qualifies an animal for it |
| `sort_order` | `integer` | NOT NULL DEFAULT 0 | |

Standard columns: `MASTER`. UNIQUE (`species_id`, `code`) among live rows.

### `mdm.weight_band` · MASTER

Live-weight ranges within a species, used by pricing and quoting.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `species_id` | `uuid` | NOT NULL, FK `mdm.species` | |
| `code` | `text` | NOT NULL | |
| `min_kg` | `kg` | NOT NULL | Inclusive lower bound |
| `max_kg` | `kg` | NOT NULL, CHECK `> min_kg` | Exclusive upper bound |

Standard columns: `MASTER`.

- EXCLUDE: for one `species_id`, the ranges `[min_kg, max_kg)` of live rows do not overlap. A weight maps to at most one band.
- A band (or grade) that a `PENDING_APPROVAL` or `ACTIVE` price list version prices with is not archived, and such a band keeps its range (application, A-106).

### `mdm.product` · MASTER

The catalogue. One abstraction for all three stock archetypes.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | Published key |
| `sku` | `text` | NOT NULL, UNIQUE among live rows | |
| `name` | `text` | NOT NULL | |
| `category_id` | `uuid` | NOT NULL, FK `mdm.category` | |
| `stock_policy` | `text` | NOT NULL, CHECK in (`SERIALISED`, `CATCH_WEIGHT`, `COUNTABLE`, `NON_STOCK`) | The three archetypes, plus services such as delivery |
| `tracking` | `text` | NOT NULL, CHECK in (`SERIAL`, `LOT`, `NONE`) | Whether stock units exist for it |
| `species_id` | `uuid` | NULL, FK `mdm.species`; required when `stock_policy = 'SERIALISED'` | Links to grades and bands |
| `base_uom` | `text` | NOT NULL, FK `mdm.uom` | Stock is held in this unit; `KG` for catch-weight |
| `sale_uom` | `text` | NOT NULL, FK `mdm.uom` | Unit shown to the buyer |
| `nominal_pack_kg` | `kg` | NULL | Standard pack size, for estimates (15 kg packs) |
| `weight_tolerance_percent` | `percent` | NOT NULL DEFAULT 10 | Catch-weight tolerance (ADR-0021) |
| `tax_category_id` | `uuid` | NOT NULL, FK `mdm.tax_category` | Overrides the category default |
| `gl_group` | `text` | NOT NULL | Copied from the category; may be overridden |
| `shelf_life_days` | `integer` | NULL, CHECK `> 0` | Default expiry for new lots |
| `storage_temp_class` | `text` | NULL, CHECK in (`AMBIENT`, `CHILLED`, `FROZEN`) | Cold chain |
| `withdrawal_days` | `integer` | NULL, CHECK `>= 0` | For veterinary products: days before a treated animal may be sold |
| `barcode` | `text` | NULL, UNIQUE among live rows | Counter scanning |
| `description` | `text` | NULL | |
| `online_mode` | `text` | NOT NULL, CHECK in (`HIDDEN`, `LISTED`, `REQUEST_TO_BUY`) | ADR-0019 |
| `seo_slug` | `text` | NULL, UNIQUE among live rows | Storefront URL |
| `seo_title` | `text` | NULL | |
| `seo_description` | `text` | NULL | |
| `is_purchasable` | `boolean` | NOT NULL DEFAULT `true` | May appear on purchase orders |
| `is_sellable` | `boolean` | NOT NULL DEFAULT `true` | May appear on sales |
| `status` | `text` | NOT NULL, CHECK in (`DRAFT`, `ACTIVE`, `DISCONTINUED`) | |

Standard columns: `MASTER`.

- CHECK: `SERIALISED` implies `tracking = 'SERIAL'`; `CATCH_WEIGHT` implies `tracking = 'LOT'` and `base_uom = 'KG'`; `NON_STOCK` implies `tracking = 'NONE'`.

### `mdm.product_uom_conversion` · MASTER

Exact conversion between two units for a product.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `product_id` | `uuid` | NOT NULL, FK `mdm.product` | |
| `from_uom` | `text` | NOT NULL, FK `mdm.uom` | |
| `to_uom` | `text` | NOT NULL, FK `mdm.uom` | |
| `numerator` | `bigint` | NOT NULL, CHECK `> 0` | Exact ratio; no stored decimal factor |
| `denominator` | `bigint` | NOT NULL, CHECK `> 0` | |

Standard columns: `MASTER`. PK (`product_id`, `from_uom`, `to_uom`).

### `mdm.product_image` · MASTER

Photographs of a product.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `product_id` | `uuid` | NOT NULL, FK `mdm.product` | |
| `file_id` | `uuid` | NOT NULL, FK `platform.stored_file` | Variants come from the file store |
| `alt_text` | `text` | NOT NULL | Accessibility |
| `sort_order` | `integer` | NOT NULL DEFAULT 0 | First is the main image |

Standard columns: `MASTER`.

Created in B04e continued 3 (migration 0037, ADR-0045). `alt_text` is 1 to 200 characters and `sort_order` 0 to 999. A partial unique index keeps one live image per (`product_id`, `file_id`). `mdm.product_image_guard()` (SQLSTATE HK008) asks `platform.require_clean_file(file_id, 'PRODUCT_IMAGE')` on insert, so only a CLEAN product photograph is attached, and refuses a change to an image's product or file. Removing an image is a soft delete with the reason "Removed from the product gallery".

## Parties

### `mdm.customer_tier` · MASTER

Customer tiers, an input to pricing.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `code` | `text` | NOT NULL, UNIQUE among live rows | `RETAIL`, `WHOLESALE`, `RESELLER` seeded |
| `name` | `text` | NOT NULL | |

Standard columns: `MASTER`.

### `mdm.customer` · MASTER

Customer identity. Credit terms are in `whl.business_account`.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | Published key |
| `customer_no` | `text` | NOT NULL, UNIQUE | Human reference |
| `kind` | `text` | NOT NULL, CHECK in (`INDIVIDUAL`, `BUSINESS`) | |
| `name` | `text` | NOT NULL | Confidential |
| `phone_e164` | `text` | NULL | Receipts and delivery updates; confidential |
| `phone_hash` | `bytea` | NULL | Keyed hash for lookup without exposing the number in indexes |
| `email` | `text` | NULL | Confidential |
| `tier_id` | `uuid` | NOT NULL, FK `mdm.customer_tier` | Pricing input |
| `principal_id` | `uuid` | NULL, UNIQUE, FK `iam.principal` | Set when the customer has a storefront login |
| `tin_enc` | `bytea` | NULL | Tax identification number, encrypted |
| `marketing_consent_at` | `timestamptz` | NULL | Data protection: consent is dated |
| `status` | `text` | NOT NULL, CHECK in (`ACTIVE`, `BLOCKED`, `ANONYMISED`) | |

Standard columns: `MASTER`.

- UNIQUE (`phone_hash`) among live rows: the keyed hash (HMAC of the E.164 number under a key derived from `LOOKUP_HMAC_KEY`) finds a customer by phone without indexing the number (B4).
- `customer_no` comes from the sequence `mdm.customer_no_seq` as `C-00001` onward (migration 0021); a customer number is not a financial document, so a gap is harmless (A-112).
- `tin_enc` is sealed with the customer's subject key, bound to `mdm.customer.tin_enc:<id>` (ADR-0022); responses show its last four characters.

### `mdm.customer_address` · MASTER

Saved delivery addresses.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | Published key |
| `customer_id` | `uuid` | NOT NULL, FK `mdm.customer` | |
| `label` | `text` | NOT NULL | "Home", "Shop" |
| `recipient_name` | `text` | NOT NULL | |
| `recipient_phone_e164` | `text` | NOT NULL | Driver contact |
| `line1` | `text` | NOT NULL | Street or landmark; Ghanaian addresses are often descriptive |
| `area` | `text` | NOT NULL | Suburb or town |
| `city` | `text` | NOT NULL | |
| `region` | `text` | NOT NULL | One of Ghana's sixteen regions |
| `digital_address` | `text` | NULL | GhanaPostGPS code |
| `directions` | `text` | NULL | Free-text directions for the driver |
| `latitude` | `numeric(9,6)` | NULL | |
| `longitude` | `numeric(9,6)` | NULL | |
| `delivery_zone_id` | `uuid` | NULL, FK `mdm.delivery_zone` | Resolved at save (A-112, A-116). Added by migration 0024, B04d continued 3's expand step, with `mdm.delivery_zone` |
| `is_default` | `boolean` | NOT NULL DEFAULT `false` | |

Standard columns: `MASTER`. Created in B04d continued 2 (migration 0021).

- CHECK: `region` is one of Ghana's sixteen regions; `digital_address` matches GhanaPostGPS `^[A-Z]{2}-[0-9]{3,4}-[0-9]{4}$`; `line1` is not blank unless `digital_address` is set (FR-MDM-008); latitude and longitude are both set or both null.
- UNIQUE (`customer_id`) where `is_default` among live rows: one default address per customer.

### `mdm.supplier` · MASTER

Identity only. Terms and payout details are in `pur.supplier_profile`. Created in B04d continued 3 (migration 0024).

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | Published key |
| `supplier_no` | `text` | NOT NULL, UNIQUE, CHECK `^S-[0-9]{4,10}$` | From `mdm.supplier_no_seq`; not a financial document, so a gap is harmless |
| `name` | `text` | NOT NULL | |
| `contact_name` | `text` | NULL | |
| `phone_e164` | `text` | NULL | Typed any way, stored in E.164 (FR-MDM-007, as FR-MDM-008) |
| `phone_hash` | `bytea` | NULL, 32 bytes, set with `phone_e164` | Keyed HMAC of the phone, so the number itself is never indexed |
| `email` | `text` | NULL | |
| `address` | `text` | NULL | |
| `tin_enc` | `bytea` | NULL | Encrypted with the supplier's subject key |
| `status` | `text` | NOT NULL, CHECK in (`ACTIVE`, `BLOCKED`) | |

Standard columns: `MASTER`.

- UNIQUE (`phone_hash`) among live rows: two live suppliers never share a phone (FR-MDM-007).

### `mdm.supplier_category` · MASTER

The catalogue categories a supplier supplies (FR-MDM-007). Created in B04d continued 3 (migration 0024).

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `supplier_id` | `uuid` | NOT NULL, FK `mdm.supplier` | |
| `category_id` | `uuid` | NOT NULL, FK `mdm.category` | |

Standard columns: `MASTER`. UNIQUE (`supplier_id`, `category_id`) among live rows. A category dropped from the list is archived, never deleted.

## Branches and locations

### `mdm.branch` · MASTER

Universally referenceable (ADR-0011). Created in B3.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `code` | `text` | NOT NULL, UNIQUE, CHECK matches `^[A-Z0-9]{2,5}$` | Appears in document numbers |
| `name` | `text` | NOT NULL | |
| `address` | `text` | NULL | Printed on documents |
| `phone_e164` | `text` | NULL | |
| `is_test` | `boolean` | NOT NULL DEFAULT `false` | The smoke-suite branch; excluded from statutory reports (ADR-0007) |
| `status` | `text` | NOT NULL, CHECK in (`ACTIVE`, `CLOSED`) | |

Standard columns: `MASTER`.

### `mdm.location` · MASTER

The stock tree. Universally referenceable. Created in B3.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `branch_id` | `uuid` | NOT NULL, FK `mdm.branch` | Every location belongs to a branch |
| `parent_id` | `uuid` | NULL, FK `mdm.location` | Tree |
| `code` | `text` | NOT NULL | |
| `name` | `text` | NOT NULL | |
| `kind` | `text` | NOT NULL, CHECK in (`SITE`, `PEN`, `COLD_ROOM`, `STORE`, `SHOP_FLOOR`, `VEHICLE`, `RETURNS_HOLD`, `QUARANTINE`, `IN_TRANSIT`, `SUPPLIER`, `CUSTOMER`, `PRODUCTION`, `PROCESSING`, `CONSUMPTION`, `LOSS`, `ADJUSTMENT`, `OPENING`) | ADR-0002, ADR-0007 |
| `is_virtual` | `boolean` | NOT NULL | True for the last eight kinds |
| `is_sellable` | `boolean` | NOT NULL DEFAULT `false` | Stock here can be sold |
| `allows_negative` | `boolean` | NOT NULL DEFAULT `false` | Needed, with the movement type, for an offline sale to overdraw |
| `temp_class` | `text` | NULL, CHECK in (`AMBIENT`, `CHILLED`, `FROZEN`) | |
| `temp_min_c` | `numeric(4,1)` | NULL | Excursion threshold |
| `temp_max_c` | `numeric(4,1)` | NULL | |
| `capacity_head` | `integer` | NULL | Pen capacity |

Standard columns: `MASTER`.

- UNIQUE (`branch_id`, `code`) among live rows.
- CHECK: `is_virtual` agrees with `kind`.
- Trigger: `parent_id`, when set, is in the same branch.
- Each branch is given one location of each virtual kind (`V-<KIND>`) in the transaction that creates it (`createBranch`, or the first-branch bootstrap of ADR-0042).
- Trigger `mdm.location_virtual_fixed` (migration 0021): a virtual location cannot be updated or archived (SQLSTATE 23514).

## Pricing and promotions

### `mdm.price_list` · MASTER

A price list occupying one slot in the resolution order.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | Published key |
| `code` | `text` | NOT NULL, UNIQUE among live rows | |
| `name` | `text` | NOT NULL | |
| `kind` | `text` | NOT NULL, CHECK in (`BASE`, `CHANNEL`, `TIER`, `CUSTOMER`) | Position in the resolution order (ADR-0004) |
| `channel` | `text` | NULL, CHECK in (`POS`, `ONLINE`, `WHOLESALE`, `QUOTE`); required for `CHANNEL` and `TIER` | |
| `customer_tier_id` | `uuid` | NULL, FK `mdm.customer_tier`; required for `TIER` | |
| `branch_id` | `uuid` | NULL, FK `mdm.branch` | Null applies to every branch |
| `tax_inclusive` | `boolean` | NOT NULL | Whether prices in the list include levies |
| `currency` | `char(3)` | NOT NULL DEFAULT `'GHS'`, CHECK `= 'GHS'` | |

Standard columns: `MASTER`.

- UNIQUE NULLS NOT DISTINCT (`kind`, `channel`, `customer_tier_id`, `branch_id`) among live rows, for kinds other than `CUSTOMER`: there is one list per slot in the resolution order.

### `mdm.price_list_version` · DOCUMENT

Posted statuses: `ACTIVE`, `SUPERSEDED`, `REJECTED`. Registered as a business document so it can be approved.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK, FK `platform.business_document` | |
| `price_list_id` | `uuid` | NOT NULL, FK `mdm.price_list` | |
| `version_no` | `integer` | NOT NULL, CHECK `> 0` | |
| `status` | `text` | NOT NULL, CHECK in (`DRAFT`, `PENDING_APPROVAL`, `ACTIVE`, `SUPERSEDED`, `REJECTED`) | |
| `valid_from` | `timestamptz` | NOT NULL | |
| `valid_to` | `timestamptz` | NULL, CHECK `> valid_from` | Null is open-ended |
| `approval_request_id` | `uuid` | NULL, FK `iam.approval_request`; required to become `ACTIVE` | Maker-checker |
| `activated_at` | `timestamptz` | NULL | |
| `activated_by` | `uuid` | NULL, FK `iam.principal` | |
| `notes` | `text` | NULL | |

Standard columns: `DOCUMENT` (its `branch_id` is that of the list, or the head-office branch for a list that applies everywhere).

- UNIQUE (`price_list_id`, `version_no`).
- EXCLUDE: for one `price_list_id`, the validity ranges of `ACTIVE` versions do not overlap.
- Frozen once `ACTIVE`: only `status` (to `SUPERSEDED`) and `valid_to` may change. Its entries are frozen with it.
- Lifecycle guard (trigger `mdm.price_list_version_guard`, B4): `DRAFT` to `PENDING_APPROVAL` to `ACTIVE` or `REJECTED`, `ACTIVE` to `SUPERSEDED`; once submitted only the lifecycle columns move. `valid_to` of an `ACTIVE` version may only become earlier. Activation may move `valid_from` later, to the moment of approval, never earlier (ADR-0036).
- CHECK: `PENDING_APPROVAL`, `ACTIVE` and `SUPERSEDED` need `approval_request_id`; `ACTIVE` and `SUPERSEDED` need `activated_at` and `activated_by`.
- UNIQUE (`price_list_id`) where `status` is `DRAFT` or `PENDING_APPROVAL`: one open version per list.

### `mdm.price_list_entry` · MASTER

Mutable while its version is a draft; frozen by trigger afterwards. Published key (order lines reference the rule that priced them).

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `version_id` | `uuid` | NOT NULL, FK `mdm.price_list_version` | |
| `product_id` | `uuid` | NOT NULL, FK `mdm.product` | |
| `grade_id` | `uuid` | NULL, FK `mdm.grade` | |
| `weight_band_id` | `uuid` | NULL, FK `mdm.weight_band` | |
| `basis` | `text` | NOT NULL, CHECK in (`PER_HEAD`, `PER_KG`, `PER_UNIT`) | What the price multiplies |
| `list_price_pesewas` | `pesewas` | NOT NULL | The price offered |
| `floor_price_pesewas` | `pesewas` | NOT NULL | Lowest price without approval |
| `ceiling_price_pesewas` | `pesewas` | NOT NULL | Highest price without approval |
| `quote_only` | `boolean` | NOT NULL DEFAULT `false` | Stops resolution and sends the buyer to a quote |
| `min_qty` | `qty` | NOT NULL DEFAULT 0 | Quantity break; the entry with the largest `min_qty` not above the quantity applies |

- UNIQUE NULLS NOT DISTINCT (`version_id`, `product_id`, `grade_id`, `weight_band_id`, `min_qty`): no two entries can match the same request.
- CHECK: `floor_price_pesewas <= list_price_pesewas <= ceiling_price_pesewas`.
- CHECK: `quote_only` or `floor_price_pesewas > 0`: a priced entry never lets a sale be agreed at nothing (B4).
- Created and changed columns as `MASTER`, without soft delete: a draft entry is removed outright, an active one never. `hk_app` holds no `DELETE`; the removal is `mdm.clear_draft_price_list_entries(version_id)`, `SECURITY DEFINER`, and the guard trigger `mdm.price_list_entry_guard` refuses any insert, update or delete of an entry whose version is not `DRAFT` (ADR-0036).

### `mdm.customer_price_list` · MASTER

The price list assigned to a customer. Set by the wholesale module through MDM's interface.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `customer_id` | `uuid` | NOT NULL, FK `mdm.customer` | |
| `price_list_id` | `uuid` | NOT NULL, FK `mdm.price_list`; the list's `kind` must be `CUSTOMER` | |
| `valid_from` | `timestamptz` | NOT NULL | |
| `valid_to` | `timestamptz` | NULL | |

Standard columns: `MASTER`. EXCLUDE: one customer has at most one assignment at a time. A trigger refuses a list whose `kind` is not `CUSTOMER` (SQLSTATE 23514).

### `mdm.promotion` · DOCUMENT

Posted statuses: `ACTIVE`, `ENDED`, `REJECTED`. Registered as a business document.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK, FK `platform.business_document` | Published key |
| `code` | `text` | NOT NULL, UNIQUE | |
| `name` | `text` | NOT NULL | |
| `kind` | `text` | NOT NULL, CHECK in (`PERCENT_OFF`, `AMOUNT_OFF`, `BUNDLE_PRICE`, `FREE_DELIVERY`) | |
| `percent_off` | `percent` | NULL; required for `PERCENT_OFF` | |
| `amount_off_pesewas` | `pesewas` | NULL; required for `AMOUNT_OFF` | |
| `bundle_price_pesewas` | `pesewas` | NULL; required for `BUNDLE_PRICE` | |
| `applies_to` | `text` | NOT NULL, CHECK in (`LINE`, `ORDER`) | |
| `channel` | `text` | NULL | Null is every channel |
| `min_order_pesewas` | `pesewas` | NULL | |
| `stack_group` | `text` | NOT NULL DEFAULT `'DEFAULT'` | At most one promotion per group applies |
| `is_exclusive` | `boolean` | NOT NULL DEFAULT `false` | Excludes all others |
| `requires_coupon` | `boolean` | NOT NULL DEFAULT `false` | |
| `max_redemptions` | `integer` | NULL | |
| `valid_from` | `timestamptz` | NOT NULL | |
| `valid_to` | `timestamptz` | NOT NULL, CHECK `> valid_from` | |
| `status` | `text` | NOT NULL, CHECK in (`DRAFT`, `PENDING_APPROVAL`, `ACTIVE`, `ENDED`, `REJECTED`) | |
| `approval_request_id` | `uuid` | NULL, FK `iam.approval_request`; required to become `ACTIVE` | |

Standard columns: `DOCUMENT`, plus `activated_at` and `activated_by` (required for `ACTIVE` and `ENDED`). Built in B04d (migration 0017, ADR-0040).

- CHECK `ck_promotion_value`: exactly the value its kind needs and no other; `FREE_DELIVERY` applies to `ORDER`. `percent_off` is above 0 and at most 100; the money values and `max_redemptions` are positive.
- Lifecycle guard `mdm.promotion_guard`: `DRAFT` to `PENDING_APPROVAL` to `ACTIVE` or `REJECTED`, `ACTIVE` to `ENDED`; once submitted only the lifecycle columns move; `valid_to` of an `ACTIVE` promotion may only become earlier; activation may move `valid_from` later, to the moment of approval, never earlier (SQLSTATE HK004).
- UNIQUE `code` (stored upper-case).

### `mdm.promotion_target` · MASTER

The products or categories a promotion applies to.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `promotion_id` | `uuid` | NOT NULL, FK `mdm.promotion` | |
| `product_id` | `uuid` | NULL, FK `mdm.product` | |
| `category_id` | `uuid` | NULL, FK `mdm.category` | |
| `bundle_qty` | `qty` | NULL | Quantity of this product in a bundle |

- CHECK: exactly one of `product_id`, `category_id` is set; `bundle_qty` positive. UNIQUE NULLS NOT DISTINCT (`promotion_id`, `product_id`, `category_id`). A category target covers the categories below it (ADR-0040).
- Standard columns: `version`, created and changed, no soft delete. Frozen with its promotion by `mdm.promotion_target_guard`; a draft's targets are emptied only by `mdm.clear_draft_promotion_targets(promotion_id)`, `SECURITY DEFINER` (B04d).

### `mdm.coupon` · MASTER

A code that unlocks a promotion.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | Published key |
| `promotion_id` | `uuid` | NOT NULL, FK `mdm.promotion` | |
| `code` | `text` | NOT NULL, UNIQUE | Stored upper-case |
| `max_uses` | `integer` | NULL | |
| `per_customer_limit` | `integer` | NULL | |
| `used_count` | `integer` | NOT NULL DEFAULT 0, CHECK `>= 0` and `max_uses IS NULL OR used_count <= max_uses` | Maintained by the redemption trigger only: `mdm.coupon_guard` refuses any other change, and a change of `code` or `promotion_id` |

Standard columns: `MASTER`.

### `mdm.coupon_redemption` · LEDGER

Each use, or release, of a coupon.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `coupon_id` | `uuid` | NOT NULL, FK `mdm.coupon` | |
| `customer_id` | `uuid` | NULL, FK `mdm.customer` | |
| `source_document_id` | `uuid` | NOT NULL, FK `platform.business_document` | The order |
| `direction` | `text` | NOT NULL, CHECK in (`REDEEM`, `RELEASE`) | A cancelled order releases the use |
| `amount_pesewas` | `pesewas` | NOT NULL | Discount given |

Standard columns: `LEDGER`.

- Trigger `mdm.coupon_redemption_count` (B04d, ADR-0040) locks the promotion and then the coupon, refuses a use beyond the coupon's `max_uses`, the promotion's `max_redemptions` across its coupons, the customer's `per_customer_limit`, or a second use by one document, and a release with no use to release (SQLSTATE HK006, reason in `DETAIL`: `LIMIT_REACHED`, `ALREADY_USED`, `NOT_APPLICABLE`, `NOTHING_TO_RELEASE`); then moves `used_count`. Update, delete and truncate are refused for every role.

## Tax

### `mdm.tax_levy` · MASTER

A named levy (ADR-0020). Published key.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `code` | `text` | NOT NULL, UNIQUE | `VAT`, `NHIL`, `GETFUND` seeded |
| `name` | `text` | NOT NULL | As printed on documents |
| `sort_order` | `integer` | NOT NULL DEFAULT 0 | Print order |

Standard columns: `MASTER`.

### `mdm.tax_category` · MASTER

Published key.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `code` | `text` | NOT NULL, UNIQUE | `LIVE_ANIMALS`, `RAW_PRODUCE`, `EGGS`, `PROCESSED_MEAT`, `FARM_INPUTS`, `DELIVERY_SERVICE`, `OTHER_GOODS` seeded |
| `name` | `text` | NOT NULL | |

Standard columns: `MASTER`.

### `mdm.tax_scheme_version` · DOCUMENT

An effective-dated version of the whole levy matrix. Posted statuses: `ACTIVE`, `SUPERSEDED`, `REJECTED`. Published key.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK, FK `platform.business_document` | |
| `version_no` | `integer` | NOT NULL, UNIQUE | |
| `status` | `text` | NOT NULL, CHECK in (`DRAFT`, `PENDING_APPROVAL`, `ACTIVE`, `SUPERSEDED`, `REJECTED`) | |
| `valid_from` | `date` | NOT NULL | Tax date from which it applies |
| `valid_to` | `date` | NULL | |
| `source_note` | `text` | NOT NULL | Where the rates came from and who confirmed them |
| `approval_request_id` | `uuid` | NULL, FK `iam.approval_request`; required to become `ACTIVE` | |

Standard columns: `DOCUMENT`.

- EXCLUDE: validity ranges of `ACTIVE` versions do not overlap.
- Deferred constraint trigger `trg_tax_scheme_version_complete` (B04 continued): a version moving to `PENDING_APPROVAL` or `ACTIVE` has a `tax_category_levy` row for every live category and levy (SQLSTATE 23514, `ck_tax_scheme_version_complete`).
- Lifecycle guard `mdm.tax_scheme_version_guard` (B04 continued), as for price list versions: `DRAFT` to `PENDING_APPROVAL` to `ACTIVE` or `REJECTED`, `ACTIVE` to `SUPERSEDED`; once submitted only the lifecycle columns move; `valid_to` of an `ACTIVE` version may only become earlier; activation may move `valid_from` later, to the day of approval, never earlier (ADR-0039). `valid_to` is exclusive: the first day the version no longer applies.
- UNIQUE: at most one version is `DRAFT` or `PENDING_APPROVAL` (`uq_tax_scheme_version_open`, ADR-0039).
- Also `branch_id` (`DOCUMENT` standard), `activated_at` and `activated_by` (required for `ACTIVE` and `SUPERSEDED`).
- Frozen once `ACTIVE`, with its rows.

### `mdm.tax_category_levy` · MASTER

One cell of the matrix. Mutable while its version is a draft.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `version_id` | `uuid` | NOT NULL, FK `mdm.tax_scheme_version` | |
| `tax_category_id` | `uuid` | NOT NULL, FK `mdm.tax_category` | |
| `levy_id` | `uuid` | NOT NULL, FK `mdm.tax_levy` | |
| `treatment` | `text` | NOT NULL, CHECK in (`STANDARD`, `ZERO_RATED`, `EXEMPT`, `OUT_OF_SCOPE`) | Printed and reported |
| `rate_percent` | `percent` | NOT NULL; CHECK zero unless `treatment = 'STANDARD'` | Zero where the levy does not apply |
| `base_kind` | `text` | NOT NULL, CHECK in (`NET`, `NET_PLUS_LEVIES`) | The levy's own base |
| `is_reclaimable` | `boolean` | NOT NULL | Whether the levy paid on purchases is recoverable |
| `calc_order` | `integer` | NOT NULL, CHECK `> 0` | Order of calculation |

- UNIQUE (`version_id`, `tax_category_id`, `levy_id`).

### `mdm.tax_levy_base_component` · MASTER

For a `NET_PLUS_LEVIES` cell: which other levies are added to its base.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `tax_category_levy_id` | `uuid` | NOT NULL, FK `mdm.tax_category_levy` | The compounding levy |
| `included_category_levy_id` | `uuid` | NOT NULL, FK `mdm.tax_category_levy` | A levy in its base |

- PK (both columns), plus `created_at` and `created_by`. Trigger `mdm.tax_levy_base_component_rule`: both rows belong to the same version and category, the owning cell is `NET_PLUS_LEVIES`, and the included row has a lower `calc_order`, so a definition cannot be circular.
- Cells and components change only while their version is `DRAFT` (trigger `mdm.tax_cell_guard`); a draft's matrix is emptied only by `mdm.clear_draft_tax_cells(version_id)`, `SECURITY DEFINER` (B04 continued). `tax_category_levy` also has UNIQUE (`version_id`, `tax_category_id`, `calc_order`), so the inclusive tie-break is never ambiguous.

## Reference data

### `mdm.payment_method` · MASTER

Published key.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `code` | `text` | NOT NULL, UNIQUE | `CASH`, `MOMO`, `CARD`, `BANK_TRANSFER`, `CHEQUE`, `STORE_CREDIT`, `COD` seeded |
| `name` | `text` | NOT NULL | |
| `kind` | `text` | NOT NULL, CHECK in (`CASH`, `MOBILE_MONEY`, `CARD`, `BANK_TRANSFER`, `CHEQUE`, `STORE_CREDIT`) | Clearing behaviour and ledger determinant |
| `requires_provider_verification` | `boolean` | NOT NULL | True for mobile money and card |
| `allowed_offline` | `boolean` | NOT NULL DEFAULT `false` | Only cash by default (ADR-0027) |
| `channels` | `text[]` | NOT NULL | Where it may be used |
| `is_enabled` | `boolean` | NOT NULL DEFAULT `true` | |

Standard columns: `MASTER`. Created in B04d continued 3 (migration 0024), with the seven rows written by the System and all disabled; the farm enables the ones it takes (A-115).

- CHECK: verification is required for `MOBILE_MONEY` and `CARD`; `allowed_offline` only for `CASH` and `MOBILE_MONEY` (the handler allows mobile money only under `pos.offline_mobile_money_allowed`); `channels` is non-empty and within `POS`, `ONLINE`, `WHOLESALE`, `QUOTE`.

### `mdm.delivery_zone` · MASTER

Published key.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `branch_id` | `uuid` | NOT NULL, FK `mdm.branch` | The branch that delivers there |
| `code` | `text` | NOT NULL | |
| `name` | `text` | NOT NULL | |
| `areas` | `text[]` | NOT NULL | Towns and suburbs covered, matched against the address |
| `fee_pesewas` | `pesewas` | NOT NULL | |
| `free_over_pesewas` | `pesewas` | NULL | Order value above which delivery is free |
| `cutoff_time` | `time` | NOT NULL | Latest order time for next-slot delivery, Africa/Accra |
| `is_active` | `boolean` | NOT NULL DEFAULT `true` | |

Standard columns: `MASTER`. UNIQUE (`branch_id`, `code`) among live rows. Created in B04d continued 3 (migration 0024).

- CHECK: one to 100 areas, none null; `cutoff_time` in whole minutes. The fee is `platform.pesewas`, so never negative; zero is a fee.
- An area belongs to one live, active zone farm-wide, so an address maps to one zone or none: checked by the handler under serializable isolation (A-116).

### `mdm.reason_code` · LOOKUP

The fixed list of reasons. Changed only by migration, as the threat model requires. Published key.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `code` | `text` | PK | |
| `domain` | `text` | NOT NULL, CHECK in (`STOCK_ADJUSTMENT`, `MORTALITY`, `CULL`, `WASTAGE`, `PRICE_OVERRIDE`, `VOID`, `REFUND`, `RETURN`, `CANCELLATION`, `DELIVERY_FAILURE`, `CASH_MOVEMENT`, `HOLD_RELEASE`) | Where it may be used |
| `description` | `text` | NOT NULL | |
| `requires_note` | `boolean` | NOT NULL DEFAULT `false` | Free-text explanation mandatory |
| `loss_account_group` | `text` | NULL, CHECK in (`MORTALITY`, `SHRINKAGE`, `WASTAGE`) | Ledger determinant for write-offs |

Created in B04d continued 3 (migration 0024) with 48 codes across the twelve domains. `hk_app` holds `SELECT` only.

### `mdm.import_job` · DOCUMENT

A spreadsheet import or export of master data. Posted statuses: `APPLIED`, `FAILED`, `CANCELLED`.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `entity` | `text` | NOT NULL, CHECK in (`PRODUCT`, `CUSTOMER`, `SUPPLIER`, `PRICE_LIST_ENTRY`, `LOCATION`, `OPENING_STOCK`) | |
| `direction` | `text` | NOT NULL, CHECK in (`IMPORT`, `EXPORT`) | |
| `file_id` | `uuid` | NOT NULL, FK `platform.stored_file` | |
| `status` | `text` | NOT NULL, CHECK in (`UPLOADED`, `VALIDATED`, `APPLIED`, `FAILED`, `CANCELLED`) | `VALIDATED` is the dry-run preview |
| `rows_total` | `integer` | NULL | |
| `rows_valid` | `integer` | NULL | |
| `rows_applied` | `integer` | NULL | Export row count is audited |

Standard columns: `DOCUMENT`.

### `mdm.import_job_error` · WORK

Row-level validation errors of an import.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `import_job_id` | `uuid` | NOT NULL, FK `mdm.import_job` | |
| `row_no` | `integer` | NOT NULL | |
| `column_name` | `text` | NULL | |
| `message` | `text` | NOT NULL | Shown in the dry-run preview |
