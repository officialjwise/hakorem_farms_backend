-- 0060_inv_transfer_variance_held
-- ADR-0048 (owner, 2026-11-15) and FR-INV-021, FR-INV-023: a transfer shortfall is held, not lost; an exception is
-- resolved once with a resolution kind; held and in-transit stock is never sold, reserved or dispatched; a unit under
-- hold is never reserved. The held state adds no movement type, no location kind and no exception kind: the shortfall
-- stays in the source branch's IN_TRANSIT location, still the farm's stock at its value, and the open
-- TRANSFER_VARIANCE exception with no movement (movement_id IS NULL) is what holds it until a person writes it off
-- (through a stock adjustment and its approval) or records it found (a TRANSFER_RECEIPT to where it was found).
-- Expand only: one nullable column, constraints that every existing row already meets, and new trigger functions.
--
--   ck_stock_transfer_line_movements   replaced: a variance no longer needs a variance movement (it is held)
--   resolution_kind                    how an exception was resolved; set exactly when it is resolved
--   ck_stock_exception_held_resolution a held variance is resolved only by a write-off or as found, with its document
--   inv.stock_exception_guard          replaced: resolution_kind is written with the resolution, once
--   ck_stock_in_transit (HK010)        a movement type blocked by hold (sale, offline sale, processing, dispatch)
--                                      never leaves an in-transit location: in-transit stock is not sellable
--   ck_stock_held (HK010)              no movement takes an in-transit balance below what open variances hold there;
--                                      a resolution marks its exception resolved before it posts
--   ck_stock_reservation_place (HK010) a reservation is at a physical location other than in-transit
--   ck_stock_reservation_held (HK010)  a unit under a hold in force is never reserved (available = on hand less
--                                      reserved less held)
-- The new triggers read only inv tables and MDM's published location_stock_facts (ADR-0047, unchanged).
-- Data category: INTERNAL (DC-13): quantities and free text about stock; no personal data.
-- Rollback: tested (`pnpm db:rollback`): drops the triggers, restores the B05 continued 2 line check and the B5
-- exception guard and drops the column. Safe before the first held variance; afterwards a forward fix only, since
-- the old line check refuses a held variance's row.

-- migrate:up
ALTER TABLE inv.stock_transfer_line DROP CONSTRAINT ck_stock_transfer_line_movements;
ALTER TABLE inv.stock_transfer_line
  ADD CONSTRAINT ck_stock_transfer_line_movements CHECK ((COALESCE(qty_received, 0) > 0) = (receipt_movement_id IS NOT NULL)
                                                         AND (variance_movement_id IS NULL OR COALESCE(variance_qty, 0) > 0));

ALTER TABLE inv.stock_exception
  ADD COLUMN resolution_kind text NULL
    CONSTRAINT ck_stock_exception_resolution_kind CHECK (resolution_kind IN ('WRITE_OFF', 'FOUND', 'ADJUSTED', 'NO_CORRECTION'));
ALTER TABLE inv.stock_exception
  ADD CONSTRAINT ck_stock_exception_resolution_kind_set CHECK ((status = 'RESOLVED') = (resolution_kind IS NOT NULL)),
  ADD CONSTRAINT ck_stock_exception_held_resolution CHECK (
    status <> 'RESOLVED' OR NOT (kind = 'TRANSFER_VARIANCE' AND movement_id IS NULL)
    OR (resolution_kind IN ('WRITE_OFF', 'FOUND') AND resolution_document_id IS NOT NULL));
CREATE INDEX ix_stock_exception_held ON inv.stock_exception (location_id, product_id)
  WHERE kind = 'TRANSFER_VARIANCE' AND status = 'OPEN' AND movement_id IS NULL;
-- A resolution asks whether a write-off of its exception waits for approval: a point read.
CREATE INDEX ix_stock_adjustment_exception ON inv.stock_adjustment (exception_id) WHERE exception_id IS NOT NULL;

-- An exception is resolved once; only its resolution columns and status change.
CREATE OR REPLACE FUNCTION inv.stock_exception_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  mutable text[] := ARRAY['status', 'resolved_at', 'resolved_by', 'resolution_document_id', 'resolution_note', 'resolution_kind'];
BEGIN
  IF OLD.status <> 'OPEN' OR (to_jsonb(NEW) - mutable) IS DISTINCT FROM (to_jsonb(OLD) - mutable) THEN
    PERFORM inv.refuse('ck_stock_exception_change', format('stock exception %s is resolved once, and only its resolution is written', OLD.id));
  END IF;
  RETURN NEW;
END
$$;

-- AFTER INSERT on a movement, after inv.apply_movement (triggers fire in name order): in-transit stock is never sold,
-- processed or dispatched again, and what an open transfer variance holds there stays there until it is resolved.
CREATE FUNCTION inv.protect_in_transit() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
DECLARE
  from_kind text;
  blocked boolean;
  held numeric;
  on_hand numeric;
BEGIN
  IF NEW.qty_base = 0 THEN
    RETURN NULL;
  END IF;
  SELECT f.kind INTO from_kind FROM mdm.location_stock_facts(NEW.from_location_id) f;
  IF from_kind IS DISTINCT FROM 'IN_TRANSIT' THEN
    RETURN NULL;
  END IF;
  SELECT t.blocked_by_hold INTO blocked FROM inv.movement_type t WHERE t.code = NEW.movement_type;
  IF blocked THEN
    PERFORM inv.refuse('ck_stock_in_transit', format('%s cannot leave an in-transit location: stock in transit is not sellable', NEW.movement_type));
  END IF;
  SELECT COALESCE(sum(e.qty), 0) INTO held FROM inv.stock_exception e
   WHERE e.kind = 'TRANSFER_VARIANCE' AND e.status = 'OPEN' AND e.movement_id IS NULL
     AND e.location_id = NEW.from_location_id AND e.product_id = NEW.product_id AND e.stock_unit_id IS NOT DISTINCT FROM NEW.stock_unit_id;
  IF held > 0 THEN
    SELECT b.on_hand_qty INTO on_hand FROM inv.stock_balance b
     WHERE b.product_id = NEW.product_id AND b.stock_unit_id IS NOT DISTINCT FROM NEW.stock_unit_id AND b.location_id = NEW.from_location_id;
    IF COALESCE(on_hand, 0) < held THEN
      PERFORM inv.refuse('ck_stock_held', format('product %s in transit: %s would remain against %s held by open transfer variances', NEW.product_id, COALESCE(on_hand, 0), held));
    END IF;
  END IF;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION inv.protect_in_transit() FROM PUBLIC;
CREATE TRIGGER trg_stock_movement_held AFTER INSERT ON inv.stock_movement
  FOR EACH ROW EXECUTE FUNCTION inv.protect_in_transit();

-- BEFORE INSERT on a reservation, before inv.apply_reservation (AFTER): only stock at a physical location other than
-- in-transit is promised, and never a unit under a hold in force.
CREATE FUNCTION inv.check_reservation_place() RETURNS trigger
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
REVOKE ALL ON FUNCTION inv.check_reservation_place() FROM PUBLIC;
CREATE TRIGGER trg_stock_reservation_check BEFORE INSERT ON inv.stock_reservation
  FOR EACH ROW EXECUTE FUNCTION inv.check_reservation_place();

-- migrate:down
DROP TRIGGER trg_stock_reservation_check ON inv.stock_reservation;
DROP FUNCTION inv.check_reservation_place();
DROP TRIGGER trg_stock_movement_held ON inv.stock_movement;
DROP FUNCTION inv.protect_in_transit();
CREATE OR REPLACE FUNCTION inv.stock_exception_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  mutable text[] := ARRAY['status', 'resolved_at', 'resolved_by', 'resolution_document_id', 'resolution_note'];
BEGIN
  IF OLD.status <> 'OPEN' OR (to_jsonb(NEW) - mutable) IS DISTINCT FROM (to_jsonb(OLD) - mutable) THEN
    PERFORM inv.refuse('ck_stock_exception_change', format('stock exception %s is resolved once, and only its resolution is written', OLD.id));
  END IF;
  RETURN NEW;
END
$$;
DROP INDEX inv.ix_stock_adjustment_exception;
DROP INDEX inv.ix_stock_exception_held;
ALTER TABLE inv.stock_exception DROP CONSTRAINT ck_stock_exception_held_resolution, DROP CONSTRAINT ck_stock_exception_resolution_kind_set;
ALTER TABLE inv.stock_exception DROP COLUMN resolution_kind;
ALTER TABLE inv.stock_transfer_line DROP CONSTRAINT ck_stock_transfer_line_movements;
ALTER TABLE inv.stock_transfer_line
  ADD CONSTRAINT ck_stock_transfer_line_movements CHECK ((COALESCE(qty_received, 0) > 0) = (receipt_movement_id IS NOT NULL)
                                                         AND (COALESCE(variance_qty, 0) > 0) = (variance_movement_id IS NOT NULL));
