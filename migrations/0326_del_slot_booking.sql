-- 0326_del_slot_booking
-- B11 continued 5 (FR-DEL-001, FR-DEL-003, A-362): a delivery books a slot of its zone, and the slot's count of bookings
-- is the database's, never the caller's.
--   del.delivery            trg_delivery_slot_booking (AFTER INSERT OR UPDATE OF slot_id, status): a delivery naming a
--                           slot holds one unit of it while it is not CANCELLED, RETURNED or WRITTEN_OFF; moving to another
--                           slot frees one in the first and takes one in the second in the same statement, under the
--                           slot rows' locks, so ck_delivery_slot_booked (booked <= capacity) refuses an overbooking
--                           whoever writes (23514). ck_delivery_slot (HK010): the slot is a live one of the delivery's zone and
--                           branch, and a delivery changes its slot only while SCHEDULED, ASSIGNED or FAILED.
--   del.delivery_slot       trg_delivery_slot_booked (BEFORE UPDATE): booked changes only through a delivery's booking
--                           (ck_delivery_slot_booked_by_delivery, HK004); a capacity change never touches it.
-- Data category: INTERNAL (counts and ids only).
-- Rollback: tested (`pnpm db:rollback`); safe at any time (the counts stay as written; nothing reads them but the slot lists).

-- migrate:up
CREATE FUNCTION del.delivery_slot_booking() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  released text[] := ARRAY['CANCELLED', 'RETURNED', 'WRITTEN_OFF'];
  old_holds uuid := NULL;
  new_holds uuid := NULL;
  s record;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.slot_id IS DISTINCT FROM OLD.slot_id AND OLD.status NOT IN ('SCHEDULED', 'ASSIGNED', 'FAILED') THEN
      RAISE EXCEPTION 'del.delivery % is %: its slot no longer changes', OLD.id, OLD.status USING ERRCODE = 'HK010', CONSTRAINT = 'ck_delivery_slot';
    END IF;
    IF OLD.slot_id IS NOT NULL AND NOT (OLD.status = ANY (released)) THEN old_holds := OLD.slot_id; END IF;
  END IF;
  IF NEW.slot_id IS NOT NULL AND NOT (NEW.status = ANY (released)) THEN new_holds := NEW.slot_id; END IF;
  IF new_holds IS NOT NULL AND new_holds IS DISTINCT FROM old_holds THEN
    SELECT delivery_zone_id, branch_id, deleted_at INTO s FROM del.delivery_slot WHERE id = new_holds;
    IF s.deleted_at IS NOT NULL OR s.delivery_zone_id IS DISTINCT FROM NEW.delivery_zone_id OR s.branch_id IS DISTINCT FROM NEW.branch_id THEN
      RAISE EXCEPTION 'del.delivery %: slot % is not a live slot of its zone and branch', NEW.id, new_holds USING ERRCODE = 'HK010', CONSTRAINT = 'ck_delivery_slot';
    END IF;
  END IF;
  IF old_holds IS DISTINCT FROM new_holds THEN
    IF old_holds IS NOT NULL THEN
      UPDATE del.delivery_slot SET booked = booked - 1, version = version + 1, updated_by = NEW.updated_by WHERE id = old_holds;
    END IF;
    IF new_holds IS NOT NULL THEN
      UPDATE del.delivery_slot SET booked = booked + 1, version = version + 1, updated_by = NEW.updated_by WHERE id = new_holds;
    END IF;
  END IF;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION del.delivery_slot_booking() FROM PUBLIC;
CREATE TRIGGER trg_delivery_slot_booking AFTER INSERT OR UPDATE OF slot_id, status ON del.delivery
  FOR EACH ROW EXECUTE FUNCTION del.delivery_slot_booking();

CREATE FUNCTION del.delivery_slot_booked_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  -- Depth 1 is a statement on the slot itself; a delivery's booking trigger runs this one at depth 2.
  IF NEW.booked IS DISTINCT FROM OLD.booked AND pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'del.delivery_slot %: booked changes only through a delivery''s booking', OLD.id USING ERRCODE = 'HK004', CONSTRAINT = 'ck_delivery_slot_booked_by_delivery';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION del.delivery_slot_booked_guard() FROM PUBLIC;
CREATE TRIGGER trg_delivery_slot_booked BEFORE UPDATE ON del.delivery_slot
  FOR EACH ROW EXECUTE FUNCTION del.delivery_slot_booked_guard();

-- migrate:down
DROP TRIGGER trg_delivery_slot_booked ON del.delivery_slot;
DROP FUNCTION del.delivery_slot_booked_guard();
DROP TRIGGER trg_delivery_slot_booking ON del.delivery;
DROP FUNCTION del.delivery_slot_booking();
