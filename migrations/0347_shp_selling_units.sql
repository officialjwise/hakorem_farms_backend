-- 0347_shp_selling_units
-- B11 continued 13 (CR-039, FR-SHP-001, FR-SHP-003; A-290): the shop sells a product in more than one unit, each at its
-- own price (a crate of eggs and a single egg), as the till does since CR-038.
--   shp.product_listing.selling_units  PROJECTION: one entry per unit the product is sold by online, the sale unit
--                                      first, each priced by its own price list entry and never derived from another
--                                      unit's (`CatalogueItem.sellingUnits`, `ProductDetail.sellingUnits`); written only
--                                      by shp.replace_product_listing, which this migration redefines to carry it (its
--                                      body is otherwise 0119's, its refresh time now the application's clock,
--                                      ADR-0067)
--   uq_cart_line_product_uom           one cart line per product and unit, so a crate and a single egg of one product are
--                                      two lines (replaces uq_cart_line_product)
-- Rollback: tested; rolling back while a cart holds two lines of one product in two units fails on the old index, and
-- the forward fix is to remove one of them.

-- migrate:up
ALTER TABLE shp.product_listing ADD COLUMN selling_units jsonb NOT NULL DEFAULT '[]'::jsonb
  CONSTRAINT ck_product_listing_selling_units CHECK (jsonb_typeof(selling_units) = 'array');

CREATE OR REPLACE FUNCTION shp.replace_product_listing(p_branch_id uuid, p_rows jsonb) RETURNS integer
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
                                   search_text, seo_title, seo_description, refreshed_at, selling_units)
  SELECT (r ->> 'productId')::uuid, p_branch_id, r ->> 'slug', r ->> 'name', r ->> 'description', r ->> 'categoryCode',
         ARRAY(SELECT jsonb_array_elements_text(r -> 'categoryCodes')), ARRAY(SELECT jsonb_array_elements_text(r -> 'categoryPath')),
         (r ->> 'categorySort')::integer, r ->> 'productLine', r ->> 'onlineMode', (r ->> 'priceFromPesewas')::bigint,
         (r ->> 'priceToPesewas')::bigint, r ->> 'priceBasis', (r ->> 'taxInclusive')::boolean, r ->> 'saleUom',
         (r ->> 'nominalPackKg')::numeric, (r ->> 'catchWeight')::boolean, (r ->> 'weightTolerancePercent')::numeric,
         r ->> 'availability', r -> 'images', (r ->> 'mainImageFileId')::uuid,
         setweight(to_tsvector('english'::regconfig, r ->> 'name'), 'A') || setweight(to_tsvector('english'::regconfig, COALESCE(r ->> 'description', '')), 'B'),
         r ->> 'seoTitle', r ->> 'seoDescription', platform.app_now(), COALESCE(r -> 'sellingUnits', '[]'::jsonb)
    FROM jsonb_array_elements(p_rows) r;
  GET DIAGNOSTICS written = ROW_COUNT;
  RETURN written;
END
$$;

DROP INDEX shp.uq_cart_line_product;
CREATE UNIQUE INDEX uq_cart_line_product_uom ON shp.cart_line (cart_id, product_id, uom);

-- migrate:down
DROP INDEX shp.uq_cart_line_product_uom;
CREATE UNIQUE INDEX uq_cart_line_product ON shp.cart_line (cart_id, product_id);
CREATE OR REPLACE FUNCTION shp.replace_product_listing(p_branch_id uuid, p_rows jsonb) RETURNS integer
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
ALTER TABLE shp.product_listing DROP COLUMN selling_units;
