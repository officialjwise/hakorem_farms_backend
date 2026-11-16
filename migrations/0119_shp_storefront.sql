-- 0119_shp_storefront
-- The online store's schema (docs/data-model/shp.md; FR-SHP-001 to FR-SHP-008; ADR-0019, ADR-0021, ADR-0026; A-177,
-- A-178): guest carts and their lines, the checkout that holds the stock reservations with its priced lines, and the
-- public catalogue's read model. Order placement fills `order_id` in B9a (its foreign key to `ord.sales_order` is
-- added there, when the table exists); abandoned-cart notices arrive with B11.
-- The database holds the rules itself, whoever writes:
--   ck_cart_owner                a cart belongs to a guest token or a customer
--   uq_cart_line_product         one line per product in a cart
--   ck_checkout_session_totals   the most a customer can be charged is never below the estimate (FR-SHP-007)
--   ck_checkout_session_delivery a delivered checkout names its zone; a collected one has no zone, slot or fee
--   uq_checkout_session_live     one live checkout per cart (STARTED or AWAITING_PAYMENT)
--   trg_checkout_session_freeze  a COMPLETED, EXPIRED or CANCELLED checkout never changes (HK004)
--   ck_checkout_line_totals      a line's maximum is never below its estimate; a catch-weight line has its weight
--   shp.replace_product_listing  the only writer of the catalogue read model (SECURITY DEFINER): the application role
--                                reads `shp.product_listing` and cannot write it directly
-- Data category: CONFIDENTIAL (DC-09) for a checkout's contact and address; PUBLIC for the listing.
-- Rollback: tested (`pnpm db:rollback`), safe before the first checkout; afterwards forward fix only, since a
-- checkout is the holder of record of its stock reservations.

-- migrate:up
CREATE SCHEMA shp AUTHORIZATION hk_owner;
REVOKE ALL ON SCHEMA shp FROM PUBLIC;
GRANT USAGE ON SCHEMA shp TO hk_app, hk_worker, hk_report;

CREATE TABLE shp.cart (
  id                 uuid PRIMARY KEY,
  customer_id        uuid NULL CONSTRAINT fk_cart_customer REFERENCES mdm.customer (id) ON DELETE RESTRICT,
  guest_token_hash   bytea NULL CONSTRAINT ck_cart_guest_token CHECK (octet_length(guest_token_hash) = 32),
  branch_id          uuid NOT NULL CONSTRAINT fk_cart_branch REFERENCES mdm.branch (id) ON DELETE RESTRICT,
  contact_phone_e164 text NULL CONSTRAINT ck_cart_contact_phone CHECK (contact_phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  recovery_consent   boolean NOT NULL DEFAULT false,
  coupon_code        text NULL CONSTRAINT ck_cart_coupon_code CHECK (coupon_code ~ '^[A-Z0-9][A-Z0-9_-]{1,39}$'),
  status             text NOT NULL CONSTRAINT ck_cart_status CHECK (status IN ('ACTIVE', 'CHECKOUT', 'CONVERTED', 'ABANDONED', 'EXPIRED')),
  version            integer NOT NULL DEFAULT 1,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_cart_owner CHECK (customer_id IS NOT NULL OR guest_token_hash IS NOT NULL)
);
COMMENT ON TABLE shp.cart IS 'class=WORK';
CREATE INDEX ix_cart_updated ON shp.cart (status, updated_at);
CREATE TRIGGER trg_cart_version BEFORE UPDATE ON shp.cart
  FOR EACH ROW EXECUTE FUNCTION platform.touch_version();

CREATE TABLE shp.cart_line (
  id                           uuid PRIMARY KEY,
  cart_id                      uuid NOT NULL CONSTRAINT fk_cart_line_cart REFERENCES shp.cart (id) ON DELETE RESTRICT,
  product_id                   uuid NOT NULL CONSTRAINT fk_cart_line_product REFERENCES mdm.product (id) ON DELETE RESTRICT,
  qty                          platform.qty NOT NULL CONSTRAINT ck_cart_line_qty CHECK (qty > 0),
  uom                          text NOT NULL,
  displayed_unit_price_pesewas platform.pesewas NOT NULL,
  added_at                     timestamptz NOT NULL DEFAULT now(),
  updated_at                   timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE shp.cart_line IS 'class=WORK';
CREATE UNIQUE INDEX uq_cart_line_product ON shp.cart_line (cart_id, product_id);

CREATE TABLE shp.checkout_session (
  id                      uuid PRIMARY KEY CONSTRAINT fk_checkout_session_document REFERENCES platform.business_document (id) ON DELETE RESTRICT,
  cart_id                 uuid NOT NULL CONSTRAINT fk_checkout_session_cart REFERENCES shp.cart (id) ON DELETE RESTRICT,
  customer_id             uuid NULL CONSTRAINT fk_checkout_session_customer REFERENCES mdm.customer (id) ON DELETE RESTRICT,
  contact_name            text NOT NULL CONSTRAINT ck_checkout_session_contact_name CHECK (length(btrim(contact_name)) BETWEEN 1 AND 120),
  contact_phone_e164      text NOT NULL CONSTRAINT ck_checkout_session_contact_phone CHECK (contact_phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  delivery_address_id     uuid NULL CONSTRAINT fk_checkout_session_address REFERENCES mdm.customer_address (id) ON DELETE RESTRICT,
  address_snapshot        jsonb NULL,
  fulfilment_mode         text NOT NULL CONSTRAINT ck_checkout_session_fulfilment CHECK (fulfilment_mode IN ('COLLECTION', 'DELIVERY')),
  delivery_zone_id        uuid NULL CONSTRAINT fk_checkout_session_zone REFERENCES mdm.delivery_zone (id) ON DELETE RESTRICT,
  delivery_slot_id        uuid NULL CONSTRAINT fk_checkout_session_slot REFERENCES del.delivery_slot (id) ON DELETE RESTRICT,
  delivery_fee_pesewas    platform.pesewas NOT NULL DEFAULT 0,
  payment_terms           text NOT NULL CONSTRAINT ck_checkout_session_terms CHECK (payment_terms IN ('PREPAID', 'COD')),
  tax_inclusive           boolean NOT NULL,
  coupon_code             text NULL,
  discount_pesewas        platform.pesewas NOT NULL DEFAULT 0,
  promotions              jsonb NOT NULL DEFAULT '[]',
  tax_pesewas             platform.pesewas NOT NULL DEFAULT 0,
  estimated_total_pesewas platform.pesewas NOT NULL,
  maximum_total_pesewas   platform.pesewas NOT NULL,
  difference_preference   text NOT NULL DEFAULT 'REFUND' CONSTRAINT ck_checkout_session_difference CHECK (difference_preference IN ('REFUND', 'STORE_CREDIT')),
  price_changed           boolean NOT NULL DEFAULT false,
  reserved_until          timestamptz NOT NULL,
  order_id                uuid NULL CONSTRAINT uq_checkout_session_order UNIQUE,
  status                  text NOT NULL CONSTRAINT ck_checkout_session_status CHECK (status IN ('STARTED', 'AWAITING_PAYMENT', 'COMPLETED', 'EXPIRED', 'CANCELLED')),
  branch_id               uuid NOT NULL CONSTRAINT fk_checkout_session_branch REFERENCES mdm.branch (id) ON DELETE RESTRICT,
  version                 integer NOT NULL DEFAULT 1,
  created_at              timestamptz NOT NULL DEFAULT now(),
  created_by              uuid NOT NULL CONSTRAINT fk_checkout_session_created_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  updated_at              timestamptz NOT NULL DEFAULT now(),
  updated_by              uuid NOT NULL CONSTRAINT fk_checkout_session_updated_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  posted_at               timestamptz NULL,
  posted_by               uuid NULL CONSTRAINT fk_checkout_session_posted_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  CONSTRAINT ck_checkout_session_totals CHECK (maximum_total_pesewas >= estimated_total_pesewas),
  CONSTRAINT ck_checkout_session_delivery CHECK (
    (fulfilment_mode = 'DELIVERY' AND delivery_zone_id IS NOT NULL AND address_snapshot IS NOT NULL)
    OR (fulfilment_mode = 'COLLECTION' AND delivery_zone_id IS NULL AND delivery_slot_id IS NULL AND delivery_fee_pesewas = 0)),
  CONSTRAINT ck_checkout_session_posted CHECK ((posted_at IS NULL) = (posted_by IS NULL)
                                              AND (status IN ('STARTED', 'AWAITING_PAYMENT')) = (posted_at IS NULL))
);
COMMENT ON TABLE shp.checkout_session IS 'class=DOCUMENT';
CREATE UNIQUE INDEX uq_checkout_session_live ON shp.checkout_session (cart_id) WHERE status IN ('STARTED', 'AWAITING_PAYMENT');
CREATE INDEX ix_checkout_session_reserved ON shp.checkout_session (reserved_until) WHERE status IN ('STARTED', 'AWAITING_PAYMENT');
CREATE TRIGGER trg_checkout_session_version BEFORE UPDATE ON shp.checkout_session
  FOR EACH ROW EXECUTE FUNCTION platform.touch_version();
CREATE TRIGGER trg_checkout_session_freeze BEFORE UPDATE ON shp.checkout_session
  FOR EACH ROW EXECUTE FUNCTION platform.freeze_posted('COMPLETED,EXPIRED,CANCELLED');

-- The checkout's lines as priced when it started: what the reservations hold, and what the customer was shown.
CREATE TABLE shp.checkout_line (
  checkout_id                  uuid NOT NULL CONSTRAINT fk_checkout_line_checkout REFERENCES shp.checkout_session (id) ON DELETE RESTRICT,
  line_no                      integer NOT NULL CONSTRAINT ck_checkout_line_no CHECK (line_no > 0),
  cart_line_id                 uuid NOT NULL,
  product_id                   uuid NOT NULL CONSTRAINT fk_checkout_line_product REFERENCES mdm.product (id) ON DELETE RESTRICT,
  qty                          platform.qty NOT NULL CONSTRAINT ck_checkout_line_qty CHECK (qty > 0),
  uom                          text NOT NULL,
  base_qty                     platform.qty NOT NULL CONSTRAINT ck_checkout_line_base_qty CHECK (base_qty > 0),
  price_list_entry_id          uuid NOT NULL CONSTRAINT fk_checkout_line_price_entry REFERENCES mdm.price_list_entry (id) ON DELETE RESTRICT,
  unit_price_pesewas           platform.pesewas NOT NULL,
  price_basis                  text NOT NULL CONSTRAINT ck_checkout_line_basis CHECK (price_basis IN ('PER_HEAD', 'PER_KG', 'PER_UNIT')),
  catch_weight                 boolean NOT NULL,
  estimated_weight_kg          platform.kg NULL,
  estimated_line_total_pesewas platform.pesewas NOT NULL,
  maximum_line_total_pesewas   platform.pesewas NOT NULL,
  discount_pesewas             platform.pesewas NOT NULL DEFAULT 0,
  tax_category_id              uuid NOT NULL CONSTRAINT fk_checkout_line_tax_category REFERENCES mdm.tax_category (id) ON DELETE RESTRICT,
  CONSTRAINT pk_checkout_line PRIMARY KEY (checkout_id, line_no),
  CONSTRAINT ck_checkout_line_totals CHECK (maximum_line_total_pesewas >= estimated_line_total_pesewas
                                            AND discount_pesewas <= estimated_line_total_pesewas
                                            AND catch_weight = (estimated_weight_kg IS NOT NULL))
);
COMMENT ON TABLE shp.checkout_line IS 'class=DOCUMENT';

-- A checkout's lines are written once, while it is STARTED, and never change.
CREATE FUNCTION shp.checkout_line_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'INSERT' AND EXISTS (SELECT 1 FROM shp.checkout_session c WHERE c.id = NEW.checkout_id AND c.status = 'STARTED') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'shp.checkout_line of checkout %: lines are written once, while the checkout is STARTED', COALESCE(NEW.checkout_id, OLD.checkout_id) USING ERRCODE = 'HK004';
END
$$;
REVOKE ALL ON FUNCTION shp.checkout_line_guard() FROM PUBLIC;
CREATE TRIGGER trg_checkout_line_guard BEFORE INSERT OR UPDATE OR DELETE ON shp.checkout_line
  FOR EACH ROW EXECUTE FUNCTION shp.checkout_line_guard();

-- The public catalogue as the storefront reads it: one row per listed product and branch (no cost, ever).
CREATE TABLE shp.product_listing (
  product_id               uuid NOT NULL CONSTRAINT fk_product_listing_product REFERENCES mdm.product (id) ON DELETE RESTRICT,
  branch_id                uuid NOT NULL CONSTRAINT fk_product_listing_branch REFERENCES mdm.branch (id) ON DELETE RESTRICT,
  slug                     text NOT NULL CONSTRAINT ck_product_listing_slug CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name                     text NOT NULL,
  description              text NULL,
  category_code            text NOT NULL,
  category_codes           text[] NOT NULL,
  category_path            text[] NOT NULL,
  category_sort            integer NOT NULL,
  product_line             text NOT NULL,
  online_mode              text NOT NULL CONSTRAINT ck_product_listing_mode CHECK (online_mode IN ('LISTED', 'REQUEST_TO_BUY')),
  price_from_pesewas       platform.pesewas NULL,
  price_to_pesewas         platform.pesewas NULL,
  price_basis              text NULL,
  tax_inclusive            boolean NULL,
  sale_uom                 text NOT NULL,
  nominal_pack_kg          platform.kg NULL,
  catch_weight             boolean NOT NULL,
  weight_tolerance_percent platform.percent NULL,
  availability             text NOT NULL CONSTRAINT ck_product_listing_availability CHECK (availability IN ('IN_STOCK', 'LOW_STOCK', 'OUT_OF_STOCK', 'ON_REQUEST')),
  images                   jsonb NOT NULL,
  main_image_file_id       uuid NULL CONSTRAINT fk_product_listing_image REFERENCES platform.stored_file (id) ON DELETE RESTRICT,
  search_text              tsvector NOT NULL,
  seo_title                text NULL,
  seo_description          text NULL,
  refreshed_at             timestamptz NOT NULL,
  CONSTRAINT pk_product_listing PRIMARY KEY (product_id, branch_id),
  CONSTRAINT ck_product_listing_price CHECK (price_to_pesewas IS NULL OR price_to_pesewas > price_from_pesewas)
);
COMMENT ON TABLE shp.product_listing IS 'class=PROJECTION';
CREATE UNIQUE INDEX uq_product_listing_slug ON shp.product_listing (branch_id, slug);
CREATE INDEX ix_product_listing_search ON shp.product_listing USING gin (search_text);
CREATE INDEX ix_product_listing_codes ON shp.product_listing USING gin (category_codes);
-- One index per allowed sort (CR-019): name, price (unpriced last) and the shop's own order.
CREATE INDEX ix_product_listing_name ON shp.product_listing (branch_id, lower(name), product_id);
CREATE INDEX ix_product_listing_price ON shp.product_listing (branch_id, (price_from_pesewas IS NULL), COALESCE(price_from_pesewas, 0), product_id);
CREATE INDEX ix_product_listing_relevance ON shp.product_listing (branch_id, category_sort, lower(name), product_id);

-- Replaces one branch's listing with the rows given, in one statement set: products no longer listed leave it.
CREATE FUNCTION shp.replace_product_listing(p_branch_id uuid, p_rows jsonb) RETURNS integer
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
DECLARE
  written integer;
BEGIN
  DELETE FROM shp.product_listing l
   WHERE l.branch_id = p_branch_id
     AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_rows) r WHERE (r ->> 'productId')::uuid = l.product_id);
  -- Slugs may move between products; clear the rows being replaced first so a swap never trips the unique slug.
  DELETE FROM shp.product_listing l
   WHERE l.branch_id = p_branch_id
     AND EXISTS (SELECT 1 FROM jsonb_array_elements(p_rows) r WHERE (r ->> 'productId')::uuid = l.product_id);
  INSERT INTO shp.product_listing (product_id, branch_id, slug, name, description, category_code, category_codes, category_path, category_sort,
                                   product_line, online_mode, price_from_pesewas, price_to_pesewas, price_basis, tax_inclusive, sale_uom,
                                   nominal_pack_kg, catch_weight, weight_tolerance_percent, availability, images, main_image_file_id,
                                   search_text, seo_title, seo_description, refreshed_at)
  SELECT (r ->> 'productId')::uuid, p_branch_id, r ->> 'slug', r ->> 'name', r ->> 'description', r ->> 'categoryCode',
         ARRAY(SELECT jsonb_array_elements_text(r -> 'categoryCodes')), ARRAY(SELECT jsonb_array_elements_text(r -> 'categoryPath')),
         (r ->> 'categorySort')::integer, r ->> 'productLine', r ->> 'onlineMode', (r ->> 'priceFromPesewas')::bigint,
         (r ->> 'priceToPesewas')::bigint, r ->> 'priceBasis', (r ->> 'taxInclusive')::boolean, r ->> 'saleUom',
         (r ->> 'nominalPackKg')::numeric, (r ->> 'catchWeight')::boolean, (r ->> 'weightTolerancePercent')::numeric,
         r ->> 'availability', r -> 'images', (r ->> 'mainImageFileId')::uuid,
         setweight(to_tsvector('english'::regconfig, r ->> 'name'), 'A') || setweight(to_tsvector('english'::regconfig, COALESCE(r ->> 'description', '')), 'B'),
         r ->> 'seoTitle', r ->> 'seoDescription', now()
    FROM jsonb_array_elements(p_rows) r;
  GET DIAGNOSTICS written = ROW_COUNT;
  RETURN written;
END
$$;
REVOKE ALL ON FUNCTION shp.replace_product_listing(uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION shp.replace_product_listing(uuid, jsonb) TO hk_app, hk_worker;

REVOKE ALL ON shp.cart, shp.cart_line, shp.checkout_session, shp.checkout_line, shp.product_listing FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON shp.cart, shp.cart_line TO hk_app, hk_worker;
GRANT SELECT, INSERT, UPDATE ON shp.checkout_session, shp.checkout_line TO hk_app, hk_worker;
GRANT SELECT ON shp.product_listing TO hk_app, hk_worker;

-- migrate:down
DROP FUNCTION shp.replace_product_listing(uuid, jsonb);
DROP TABLE shp.product_listing;
DROP TABLE shp.checkout_line;
DROP FUNCTION shp.checkout_line_guard();
DROP TABLE shp.checkout_session;
DROP TABLE shp.cart_line;
DROP TABLE shp.cart;
DROP SCHEMA shp;
