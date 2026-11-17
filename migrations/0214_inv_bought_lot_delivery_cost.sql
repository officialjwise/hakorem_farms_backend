-- 0214_inv_bought_lot_delivery_cost
-- B09e (the owner's decision 2 of 2026-11-17, option B; ADR-0075 superseding ADR-0018's issue rule for bought lots
-- only): a lot bought from a supplier keeps its delivery, and every issue from it is valued by its place in that
-- delivery, never by a rate and never by the current pool alone.
--   cost_pool.anchor_qty, anchor_value_pesewas   the delivery a bought lot's pool is valued against: set by the database
--                           when a RECEIPT_PURCHASE (not a reversal) brings a lot into its pool, to what the pool then
--                           holds; null for every other pool (an untracked product, an animal, a lot made by processing,
--                           harvest or opening stock), which ADR-0018 keeps valuing on what it holds
--   the issue value         for a bought lot, an issue of q leaving a physical location, with Q0 and V0 its anchor and
--                           p = Q0 - Q the eggs already gone, carries half_up(V0 x (p + q) / Q0) - half_up(V0 x p / Q0),
--                           in exact thousandths. The whole of what the pool holds (q >= Q) still carries all of it, and a
--                           pool at or below zero still carries nothing (ADR-0018). A crate whose price is a whole number
--                           of pesewas therefore always carries exactly that price, and the delivery sums exactly.
--   on schedule or anchored again   a pool is on its delivery's schedule when p >= 0 and it holds exactly
--                           V0 - half_up(V0 x p / Q0). A value-only addition, a gain, a return or a reversal that leaves it
--                           off schedule re-anchors it, at the next issue, at what it then holds (p = 0 from there), so
--                           its issues still sum exactly to what it holds. A reversal carries its original's value and
--                           a reversal of the latest issue puts the pool back on schedule. A transfer within the branch
--                           shows the schedule value of what it moves and leaves the pool alone (ADR-0018).
-- Additions to docs/data-model/inv.md: the two anchor columns.
-- Data category: CONFIDENTIAL (DC-22): stock and cost.
-- Rollback: tested (`pnpm db:rollback`); safe at any time for the schema (the issues already valued keep their values,
-- and the pools fall back to ADR-0018's rule from the next issue), so a rollback changes only how later issues are valued.

-- migrate:up
ALTER TABLE inv.cost_pool
  ADD COLUMN anchor_qty numeric(14,3) NULL,
  ADD COLUMN anchor_value_pesewas bigint NULL,
  ADD CONSTRAINT ck_cost_pool_anchor CHECK (
    (anchor_qty IS NULL) = (anchor_value_pesewas IS NULL) AND (anchor_qty IS NULL OR (anchor_qty > 0 AND anchor_value_pesewas >= 0))
  );
COMMENT ON COLUMN inv.cost_pool.anchor_qty IS 'The delivery quantity a bought lot is valued against (ADR-0075); null for every other pool';
COMMENT ON COLUMN inv.cost_pool.anchor_value_pesewas IS 'The delivery value a bought lot is valued against (ADR-0075); null for every other pool';

-- half_up(n / d) for n >= 0 and d > 0, in exact integers.
CREATE FUNCTION inv.half_up_div(n numeric, d numeric) RETURNS bigint
  LANGUAGE sql IMMUTABLE STRICT
  SET search_path = pg_catalog
AS $$ SELECT div(2 * n + d, 2 * d)::bigint $$;
REVOKE ALL ON FUNCTION inv.half_up_div(numeric, numeric) FROM PUBLIC;

-- BEFORE INSERT, after trg_stock_movement_check has set the ADR-0018 value and locked the pool: for an issue from a
-- bought lot, the value by its place in the delivery. Anything else is left as trg_stock_movement_check valued it.
CREATE FUNCTION inv.value_bought_lot_issue() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
DECLARE
  unit_branch uuid;
  from_virtual boolean;
  c inv.cost_pool;
  a_q bigint;
  a_v bigint;
  p bigint;
  q bigint;
BEGIN
  IF NEW.stock_unit_id IS NULL OR NEW.reverses_movement_id IS NOT NULL OR NEW.qty_base <= 0 THEN
    RETURN NEW;
  END IF;
  SELECT f.is_virtual INTO from_virtual FROM mdm.location_stock_facts(NEW.from_location_id) f;
  IF from_virtual THEN
    RETURN NEW;
  END IF;
  SELECT u.branch_id INTO unit_branch FROM inv.stock_unit u WHERE u.id = NEW.stock_unit_id AND u.tracking = 'LOT';
  IF unit_branch IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT * INTO c FROM inv.cost_pool cp
   WHERE cp.product_id = NEW.product_id AND cp.stock_unit_id = NEW.stock_unit_id AND cp.branch_id = unit_branch
   FOR UPDATE;
  IF c.anchor_qty IS NULL OR c.qty <= 0 OR NEW.qty_base >= c.qty THEN
    RETURN NEW;
  END IF;
  a_q := (c.anchor_qty * 1000)::bigint;
  a_v := c.anchor_value_pesewas;
  p := ((c.anchor_qty - c.qty) * 1000)::bigint;
  IF p < 0 OR c.value_pesewas <> a_v - inv.half_up_div(a_v::numeric * p, a_q) THEN
    -- Off its delivery's schedule (a value-only addition, a gain, a return or a reversal): anchored again at what it holds.
    UPDATE inv.cost_pool cp SET anchor_qty = c.qty, anchor_value_pesewas = c.value_pesewas
     WHERE cp.product_id = c.product_id AND cp.stock_unit_id = c.stock_unit_id AND cp.branch_id = c.branch_id;
    a_q := (c.qty * 1000)::bigint;
    a_v := c.value_pesewas;
    p := 0;
  END IF;
  q := (NEW.qty_base * 1000)::bigint;
  NEW.value_pesewas := inv.half_up_div(a_v::numeric * (p + q), a_q) - inv.half_up_div(a_v::numeric * p, a_q);
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION inv.value_bought_lot_issue() FROM PUBLIC;
-- Named to run after trg_stock_movement_check and before trg_stock_movement_expired and trg_stock_movement_sale_return
-- (BEFORE triggers fire by name).
CREATE TRIGGER trg_stock_movement_delivery_cost BEFORE INSERT ON inv.stock_movement
  FOR EACH ROW EXECUTE FUNCTION inv.value_bought_lot_issue();

-- AFTER INSERT, after trg_stock_movement_apply has moved the pool: a purchase receipt of a lot anchors the lot's pool at
-- what it then holds, which for a new lot is its delivery.
CREATE FUNCTION inv.anchor_bought_lot() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
DECLARE
  unit_branch uuid;
BEGIN
  IF NEW.movement_type <> 'RECEIPT_PURCHASE' OR NEW.reverses_movement_id IS NOT NULL OR NEW.stock_unit_id IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT u.branch_id INTO unit_branch FROM inv.stock_unit u WHERE u.id = NEW.stock_unit_id AND u.tracking = 'LOT';
  IF unit_branch IS NULL THEN
    RETURN NULL;
  END IF;
  UPDATE inv.cost_pool cp SET anchor_qty = cp.qty, anchor_value_pesewas = cp.value_pesewas
   WHERE cp.product_id = NEW.product_id AND cp.stock_unit_id = NEW.stock_unit_id AND cp.branch_id = unit_branch AND cp.qty > 0;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION inv.anchor_bought_lot() FROM PUBLIC;
-- Named to run after trg_stock_movement_apply and trg_stock_movement_held (AFTER triggers fire by name).
CREATE TRIGGER trg_stock_movement_pool_anchor AFTER INSERT ON inv.stock_movement
  FOR EACH ROW EXECUTE FUNCTION inv.anchor_bought_lot();

-- migrate:down
DROP TRIGGER trg_stock_movement_pool_anchor ON inv.stock_movement;
DROP FUNCTION inv.anchor_bought_lot();
DROP TRIGGER trg_stock_movement_delivery_cost ON inv.stock_movement;
DROP FUNCTION inv.value_bought_lot_issue();
DROP FUNCTION inv.half_up_div(numeric, numeric);
ALTER TABLE inv.cost_pool DROP CONSTRAINT ck_cost_pool_anchor, DROP COLUMN anchor_value_pesewas, DROP COLUMN anchor_qty;
