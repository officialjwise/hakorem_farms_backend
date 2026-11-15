-- 0043_mdm_publish_stock_facts
-- Two read-only facts the inventory movement trigger needs from master data (ADR-0002 steps 2 and 5, ADR-0047): what a
-- location is (its branch, kind, code, whether it is virtual and whether it allows negative stock) and how a product
-- is tracked. INV never reads mdm tables; it asks these functions by primary key, as an import asks
-- platform.require_clean_file. They are STABLE, SECURITY DEFINER, owned by hk_owner, with a fixed search_path, and
-- return no row for an unknown id.
-- Data category: INTERNAL (DC-13).
-- Rollback: tested (`pnpm db:rollback`); 0044 is rolled back first, since its triggers call these.

-- migrate:up
CREATE FUNCTION mdm.location_stock_facts(p_location_id uuid)
  RETURNS TABLE (branch_id uuid, kind text, code text, is_virtual boolean, allows_negative boolean)
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
  SELECT l.branch_id, l.kind, l.code, l.is_virtual, l.allows_negative FROM mdm.location l WHERE l.id = p_location_id
$$;

CREATE FUNCTION mdm.product_tracking(p_product_id uuid)
  RETURNS text
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
  SELECT p.tracking FROM mdm.product p WHERE p.id = p_product_id
$$;

REVOKE ALL ON FUNCTION mdm.location_stock_facts(uuid), mdm.product_tracking(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mdm.location_stock_facts(uuid), mdm.product_tracking(uuid) TO hk_app, hk_worker, hk_report;

-- migrate:down
DROP FUNCTION mdm.product_tracking(uuid);
DROP FUNCTION mdm.location_stock_facts(uuid);
