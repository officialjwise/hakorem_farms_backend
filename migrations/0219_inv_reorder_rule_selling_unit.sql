-- 0219_inv_reorder_rule_selling_unit
-- B09e continued (the rest of the owner's decision 6 of 2026-11-17): a reorder rule's minimum, reorder point and maximum
-- may be counted in a selling unit (a reorder point of 30 crates) and are stored in the product's base unit (900 eggs),
-- converted by the server through MasterDataRefs.toBaseIn and checked again here through MDM's published
-- mdm.uom_to_base (0216, ADR-0047). The alert and the suggested reorder answer in both.
--   inv.reorder_rule.uom             the unit the levels were entered in: null for the product's base unit (every rule
--                           before B09e continued), otherwise a unit the product converts from; it never changes
--   min_qty_uom, reorder_point_qty_uom, max_qty_uom   the levels as entered, in `uom`; null with a null `uom`. min_qty,
--                           reorder_point_qty and max_qty stay in the base unit: inv.pub_reorder_level, the alerts and
--                           RPT's low stock tile read them unchanged
--   ck_reorder_rule_uom      a unit comes with its three levels as entered, and only then
--   inv.reorder_rule_uom_guard()   (BEFORE INSERT OR UPDATE) each base level is exactly its entered level converted by the
--                           product's live conversion, and a rule's unit never changes (HK010 ck_reorder_rule_uom_conversion)
-- Additions to docs/data-model/inv.md: the four columns.
-- Data category: INTERNAL (stock levels).
-- Rollback: tested (`pnpm db:rollback`), and it keeps the data: it removes only the guard, and leaves the columns and
-- their check, which the release before never writes (every rule it writes is in the base unit, `uom` null). Applying
-- 0219 again is safe: each step is written to run over what a rollback left.

-- migrate:up
ALTER TABLE inv.reorder_rule
  ADD COLUMN IF NOT EXISTS uom text NULL CONSTRAINT fk_reorder_rule_uom REFERENCES mdm.uom (code) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS min_qty_uom platform.qty NULL,
  ADD COLUMN IF NOT EXISTS reorder_point_qty_uom platform.qty NULL,
  ADD COLUMN IF NOT EXISTS max_qty_uom platform.qty NULL;
ALTER TABLE inv.reorder_rule DROP CONSTRAINT IF EXISTS ck_reorder_rule_uom;
ALTER TABLE inv.reorder_rule
  ADD CONSTRAINT ck_reorder_rule_uom CHECK (
    (uom IS NULL) = (min_qty_uom IS NULL) AND (uom IS NULL) = (reorder_point_qty_uom IS NULL) AND (uom IS NULL) = (max_qty_uom IS NULL));

CREATE OR REPLACE FUNCTION inv.reorder_rule_uom_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.uom IS DISTINCT FROM OLD.uom THEN
    RAISE EXCEPTION 'reorder rule %: the unit its levels are counted in never changes', OLD.id
      USING ERRCODE = 'HK010', CONSTRAINT = 'ck_reorder_rule_uom_conversion';
  END IF;
  IF NEW.uom IS NULL THEN
    RETURN NEW;
  END IF;
  IF mdm.uom_to_base(NEW.product_id, NEW.uom, NEW.min_qty_uom) IS DISTINCT FROM NEW.min_qty
     OR mdm.uom_to_base(NEW.product_id, NEW.uom, NEW.reorder_point_qty_uom) IS DISTINCT FROM NEW.reorder_point_qty
     OR mdm.uom_to_base(NEW.product_id, NEW.uom, NEW.max_qty_uom) IS DISTINCT FROM NEW.max_qty THEN
    RAISE EXCEPTION 'reorder rule %: its levels in % are not its base levels by a live conversion of product %', NEW.id, NEW.uom, NEW.product_id
      USING ERRCODE = 'HK010', CONSTRAINT = 'ck_reorder_rule_uom_conversion';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION inv.reorder_rule_uom_guard() FROM PUBLIC;
DROP TRIGGER IF EXISTS trg_reorder_rule_uom_guard ON inv.reorder_rule;
CREATE TRIGGER trg_reorder_rule_uom_guard
  BEFORE INSERT OR UPDATE OF uom, product_id, min_qty, reorder_point_qty, max_qty, min_qty_uom, reorder_point_qty_uom, max_qty_uom ON inv.reorder_rule
  FOR EACH ROW EXECUTE FUNCTION inv.reorder_rule_uom_guard();

-- migrate:down
DROP TRIGGER trg_reorder_rule_uom_guard ON inv.reorder_rule;
DROP FUNCTION inv.reorder_rule_uom_guard();
