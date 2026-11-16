-- 0186_inv_hold_window_app_clock
-- B09t (owner, 2026-11-16; ADR-0067, A-217): a hold "in force now" is in force at the application's clock. The three
-- rules that read the hold window against the database's `now()` read `platform.app_now()` (0185) instead, unchanged
-- otherwise:
--   inv.pub_stock_on_hand.available_qty    nothing is available of a unit under a hold in force (0044)
--   inv.pub_reorder_level.held_qty         a held unit's positive on hand counts as held (0064)
--   inv.check_reservation_place            a reservation of a unit under a hold in force is refused (0060)
-- The movement rule (ck_stock_on_hold, 0044) already reads the movement's own `occurred_at` and is unchanged. The
-- views keep their columns, so every reader is unaffected (expand only).
-- Data category: INTERNAL (stock).
-- Rollback: tested (`pnpm db:rollback`), restores the three definitions on `now()`; safe at any time.

-- migrate:up
CREATE OR REPLACE VIEW inv.pub_stock_on_hand AS
SELECT b.product_id, b.stock_unit_id, b.location_id, b.branch_id, b.on_hand_qty, b.on_hand_weight_kg, b.reserved_qty,
       CASE WHEN b.stock_unit_id IS NOT NULL AND EXISTS (
              SELECT 1 FROM inv.stock_hold h
               WHERE h.stock_unit_id = b.stock_unit_id AND h.released_at IS NULL AND h.starts_at <= platform.app_now() AND (h.ends_at IS NULL OR h.ends_at > platform.app_now()))
            THEN 0::numeric(14,3)
            ELSE GREATEST(b.on_hand_qty - b.reserved_qty, 0)::numeric(14,3) END AS available_qty
  FROM inv.stock_balance b
 WHERE NOT (SELECT f.is_virtual FROM mdm.location_stock_facts(b.location_id) f);

CREATE OR REPLACE VIEW inv.pub_reorder_level AS
SELECT r.id AS reorder_rule_id, r.product_id, r.branch_id, r.location_id, r.min_qty, r.reorder_point_qty, r.max_qty,
       COALESCE(s.on_hand, 0)::numeric(14,3) AS on_hand_qty,
       COALESCE(s.reserved, 0)::numeric(14,3) AS reserved_qty,
       COALESCE(s.held, 0)::numeric(14,3) AS held_qty,
       (COALESCE(s.on_hand, 0) - COALESCE(s.reserved, 0) - COALESCE(s.held, 0))::numeric(14,3) AS available_qty,
       (COALESCE(s.on_hand, 0) - COALESCE(s.reserved, 0) - COALESCE(s.held, 0)) <= r.reorder_point_qty AS at_or_below_reorder_point,
       (COALESCE(s.on_hand, 0) - COALESCE(s.reserved, 0) - COALESCE(s.held, 0)) < r.min_qty AS below_minimum
  FROM inv.reorder_rule r
  LEFT JOIN LATERAL (
    SELECT sum(b.on_hand_qty) AS on_hand, sum(b.reserved_qty) AS reserved,
           sum(CASE WHEN b.stock_unit_id IS NOT NULL AND b.on_hand_qty > 0 AND EXISTS (
                      SELECT 1 FROM inv.stock_hold h
                       WHERE h.stock_unit_id = b.stock_unit_id AND h.released_at IS NULL AND h.starts_at <= platform.app_now() AND (h.ends_at IS NULL OR h.ends_at > platform.app_now()))
                    THEN b.on_hand_qty ELSE 0 END) AS held
      FROM inv.stock_balance b
      CROSS JOIN LATERAL mdm.location_stock_facts(b.location_id) f
     WHERE b.product_id = r.product_id AND b.branch_id = r.branch_id AND (r.location_id IS NULL OR b.location_id = r.location_id)
       AND NOT f.is_virtual AND f.kind NOT IN ('IN_TRANSIT', 'SITE')
  ) s ON true
 WHERE r.deleted_at IS NULL;

CREATE OR REPLACE FUNCTION inv.check_reservation_place() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
DECLARE
  facts record;
BEGIN
  SELECT * INTO facts FROM mdm.location_stock_facts(NEW.location_id);
  IF facts.is_virtual IS DISTINCT FROM false OR facts.kind = 'IN_TRANSIT' THEN
    PERFORM inv.refuse('ck_stock_reservation_place', format('reservation %s: only stock at a physical location other than in-transit is promised', NEW.id));
  END IF;
  IF NEW.stock_unit_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM inv.stock_hold h
     WHERE h.stock_unit_id = NEW.stock_unit_id AND h.released_at IS NULL
       AND h.starts_at <= platform.app_now() AND (h.ends_at IS NULL OR h.ends_at > platform.app_now())
  ) THEN
    PERFORM inv.refuse('ck_stock_reservation_held', format('reservation %s: the stock unit is under a hold and cannot be promised', NEW.id));
  END IF;
  RETURN NEW;
END
$$;

-- migrate:down
CREATE OR REPLACE VIEW inv.pub_stock_on_hand AS
SELECT b.product_id, b.stock_unit_id, b.location_id, b.branch_id, b.on_hand_qty, b.on_hand_weight_kg, b.reserved_qty,
       CASE WHEN b.stock_unit_id IS NOT NULL AND EXISTS (
              SELECT 1 FROM inv.stock_hold h
               WHERE h.stock_unit_id = b.stock_unit_id AND h.released_at IS NULL AND h.starts_at <= now() AND (h.ends_at IS NULL OR h.ends_at > now()))
            THEN 0::numeric(14,3)
            ELSE GREATEST(b.on_hand_qty - b.reserved_qty, 0)::numeric(14,3) END AS available_qty
  FROM inv.stock_balance b
 WHERE NOT (SELECT f.is_virtual FROM mdm.location_stock_facts(b.location_id) f);

CREATE OR REPLACE VIEW inv.pub_reorder_level AS
SELECT r.id AS reorder_rule_id, r.product_id, r.branch_id, r.location_id, r.min_qty, r.reorder_point_qty, r.max_qty,
       COALESCE(s.on_hand, 0)::numeric(14,3) AS on_hand_qty,
       COALESCE(s.reserved, 0)::numeric(14,3) AS reserved_qty,
       COALESCE(s.held, 0)::numeric(14,3) AS held_qty,
       (COALESCE(s.on_hand, 0) - COALESCE(s.reserved, 0) - COALESCE(s.held, 0))::numeric(14,3) AS available_qty,
       (COALESCE(s.on_hand, 0) - COALESCE(s.reserved, 0) - COALESCE(s.held, 0)) <= r.reorder_point_qty AS at_or_below_reorder_point,
       (COALESCE(s.on_hand, 0) - COALESCE(s.reserved, 0) - COALESCE(s.held, 0)) < r.min_qty AS below_minimum
  FROM inv.reorder_rule r
  LEFT JOIN LATERAL (
    SELECT sum(b.on_hand_qty) AS on_hand, sum(b.reserved_qty) AS reserved,
           sum(CASE WHEN b.stock_unit_id IS NOT NULL AND b.on_hand_qty > 0 AND EXISTS (
                      SELECT 1 FROM inv.stock_hold h
                       WHERE h.stock_unit_id = b.stock_unit_id AND h.released_at IS NULL AND h.starts_at <= now() AND (h.ends_at IS NULL OR h.ends_at > now()))
                    THEN b.on_hand_qty ELSE 0 END) AS held
      FROM inv.stock_balance b
      CROSS JOIN LATERAL mdm.location_stock_facts(b.location_id) f
     WHERE b.product_id = r.product_id AND b.branch_id = r.branch_id AND (r.location_id IS NULL OR b.location_id = r.location_id)
       AND NOT f.is_virtual AND f.kind NOT IN ('IN_TRANSIT', 'SITE')
  ) s ON true
 WHERE r.deleted_at IS NULL;

CREATE OR REPLACE FUNCTION inv.check_reservation_place() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
DECLARE
  facts record;
BEGIN
  SELECT * INTO facts FROM mdm.location_stock_facts(NEW.location_id);
  IF facts.is_virtual IS DISTINCT FROM false OR facts.kind = 'IN_TRANSIT' THEN
    PERFORM inv.refuse('ck_stock_reservation_place', format('reservation %s: only stock at a physical location other than in-transit is promised', NEW.id));
  END IF;
  IF NEW.stock_unit_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM inv.stock_hold h
     WHERE h.stock_unit_id = NEW.stock_unit_id AND h.released_at IS NULL
       AND h.starts_at <= now() AND (h.ends_at IS NULL OR h.ends_at > now())
  ) THEN
    PERFORM inv.refuse('ck_stock_reservation_held', format('reservation %s: the stock unit is under a hold and cannot be promised', NEW.id));
  END IF;
  RETURN NEW;
END
$$;
