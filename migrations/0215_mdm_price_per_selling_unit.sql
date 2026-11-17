-- 0215_mdm_price_per_selling_unit
-- B09e (the owner's decisions 1 and 6 of 2026-11-17): a price list entry carries the selling unit its price is for, so a
-- crate and a single egg each have a price of their own, while stock stays in the product's base unit.
--   uom                     the selling unit the entry prices: null for the product's base unit (every entry before
--                           B09e), otherwise a unit the product converts from (mdm.product_uom_conversion, B06u). Never
--                           derived: a crate's price is entered as a crate's price, not as thirty times an egg's
--   min_qty_uom             the quantity break as entered, counted in `uom` (10 crates); null with a null `uom`
--   min_qty                 the break in the base unit (300 eggs), which the engine compares; for an entry in another
--                           unit, exactly min_qty_uom times the conversion's factor when the entry was written
--   uq_price_list_entry_match   no two entries match the same request: the unit joins product, grade, band and break
--   ck_price_list_entry_uom     a unit other than the base comes with its break as entered, and is never on a
--                           per-kilogram entry (that price multiplies weighed kilograms, A-157)
--   mdm.price_list_entry_uom_guard   a unit other than the base is one the product converts from, live, when the entry
--                           is written (HK010 ck_price_list_entry_uom_conversion)
-- Additions to docs/data-model/mdm.md: `uom`, `min_qty_uom`.
-- Data category: INTERNAL (prices).
-- Rollback: tested (`pnpm db:rollback`), safe before the first entry in another unit; afterwards forward fix only
-- (dropping the unit would leave two entries matching one request).

-- migrate:up
ALTER TABLE mdm.price_list_entry
  ADD COLUMN uom text NULL CONSTRAINT fk_price_list_entry_uom REFERENCES mdm.uom (code) ON DELETE RESTRICT,
  ADD COLUMN min_qty_uom platform.qty NULL,
  ADD CONSTRAINT ck_price_list_entry_uom CHECK ((uom IS NULL) = (min_qty_uom IS NULL) AND (uom IS NULL OR basis <> 'PER_KG'));

DROP INDEX mdm.uq_price_list_entry_match;
CREATE UNIQUE INDEX uq_price_list_entry_match ON mdm.price_list_entry (version_id, product_id, grade_id, weight_band_id, uom, min_qty) NULLS NOT DISTINCT;

CREATE FUNCTION mdm.price_list_entry_uom_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.uom IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM mdm.product_uom_conversion c
     WHERE c.product_id = NEW.product_id AND c.from_uom = NEW.uom AND c.deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'product % is not sold by %: no live conversion from that unit', NEW.product_id, NEW.uom
      USING ERRCODE = 'HK010', CONSTRAINT = 'ck_price_list_entry_uom_conversion';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION mdm.price_list_entry_uom_guard() FROM PUBLIC;
CREATE TRIGGER trg_price_list_entry_uom_guard BEFORE INSERT OR UPDATE OF uom, product_id ON mdm.price_list_entry
  FOR EACH ROW EXECUTE FUNCTION mdm.price_list_entry_uom_guard();

-- migrate:down
DROP TRIGGER trg_price_list_entry_uom_guard ON mdm.price_list_entry;
DROP FUNCTION mdm.price_list_entry_uom_guard();
DROP INDEX mdm.uq_price_list_entry_match;
CREATE UNIQUE INDEX uq_price_list_entry_match ON mdm.price_list_entry (version_id, product_id, grade_id, weight_band_id, min_qty) NULLS NOT DISTINCT;
ALTER TABLE mdm.price_list_entry DROP CONSTRAINT ck_price_list_entry_uom, DROP COLUMN min_qty_uom, DROP COLUMN uom;
