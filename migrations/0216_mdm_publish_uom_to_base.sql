-- 0216_mdm_publish_uom_to_base
-- B09e continued (the owner's decisions 3 and 6 of 2026-11-17): a goods receipt line, a stock transfer line and a
-- reorder rule may be entered in a unit the product converts from (a crate of 30 eggs), and are held in the product's
-- base unit. INV's database rules check that the base quantity is exactly the entered quantity converted by the
-- product's live conversion, so a line can never carry a factor of its own. MDM publishes the conversion as a
-- function INV's triggers call (ADR-0047, listed in tooling/architecture.json): INV never reads mdm.product or
-- mdm.product_uom_conversion itself.
--   mdm.uom_to_base(product, uom, qty)   the quantity in the product's base unit: the base unit passes through; another
--                           unit converts by its live exact factor; null for an unknown product, a unit the product has
--                           no live conversion from, or a result that would need a fourth decimal place (never rounded).
--                           The same answer as MasterDataRefs.toBaseIn (B06u, A-163 (e)).
-- Data category: none (a function over the catalogue's units).
-- Rollback: tested (`pnpm db:rollback`); 0217 and 0219, whose triggers call it, are rolled back first.

-- migrate:up
CREATE OR REPLACE FUNCTION mdm.uom_to_base(p_product_id uuid, p_uom text, p_qty numeric) RETURNS numeric
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
  SELECT CASE
           WHEN p.base_uom = p_uom THEN p_qty
           ELSE (SELECT p_qty * c.numerator / c.denominator
                   FROM mdm.product_uom_conversion c
                  WHERE c.product_id = p.id AND c.from_uom = p_uom AND c.to_uom = p.base_uom AND c.deleted_at IS NULL
                    AND (p_qty * 1000 * c.numerator) % c.denominator = 0)
         END
    FROM mdm.product p
   WHERE p.id = p_product_id
$$;
REVOKE ALL ON FUNCTION mdm.uom_to_base(uuid, text, numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mdm.uom_to_base(uuid, text, numeric) TO hk_app, hk_worker;

-- migrate:down
DROP FUNCTION mdm.uom_to_base(uuid, text, numeric);
