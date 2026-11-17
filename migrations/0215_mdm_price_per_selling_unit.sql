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
-- Rollback: tested (`pnpm db:rollback`), and it keeps the data: it removes only the unit guard, and leaves the two
-- columns, their check and the match key with the unit in it, which the release before reads and writes unchanged (every
-- entry it writes is in the base unit, `uom` null). Dropping the columns would make a crate's entry and a single egg's
-- collide, or delete a price an order line refers to, so the columns go only by a later forward fix. Applying 0215
-- again is safe: each step is written to run over what a rollback left.

-- migrate:up
ALTER TABLE mdm.price_list_entry
  ADD COLUMN IF NOT EXISTS uom text NULL CONSTRAINT fk_price_list_entry_uom REFERENCES mdm.uom (code) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS min_qty_uom platform.qty NULL;
ALTER TABLE mdm.price_list_entry DROP CONSTRAINT IF EXISTS ck_price_list_entry_uom;
ALTER TABLE mdm.price_list_entry
  ADD CONSTRAINT ck_price_list_entry_uom CHECK ((uom IS NULL) = (min_qty_uom IS NULL) AND (uom IS NULL OR basis <> 'PER_KG'));

DROP INDEX IF EXISTS mdm.uq_price_list_entry_match;
CREATE UNIQUE INDEX uq_price_list_entry_match ON mdm.price_list_entry (version_id, product_id, grade_id, weight_band_id, uom, min_qty) NULLS NOT DISTINCT;

CREATE OR REPLACE FUNCTION mdm.price_list_entry_uom_guard() RETURNS trigger
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
DROP TRIGGER IF EXISTS trg_price_list_entry_uom_guard ON mdm.price_list_entry;
CREATE TRIGGER trg_price_list_entry_uom_guard BEFORE INSERT OR UPDATE OF uom, product_id ON mdm.price_list_entry
  FOR EACH ROW EXECUTE FUNCTION mdm.price_list_entry_uom_guard();

-- migrate:down
DROP TRIGGER trg_price_list_entry_uom_guard ON mdm.price_list_entry;
DROP FUNCTION mdm.price_list_entry_uom_guard();
