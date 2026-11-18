-- 0238_pos_shift_entry_state
-- B09b continued (ADR-0077 Amendments): a till shift publishes, through the platform's document entry state (migration
-- 0236), that it takes cash only while OPEN, whose it is (its cashier) and which till it is on, so PAY's constraints can
-- refuse till cash outside it without reading pos tables. Every shift written already is published once here. The cash
-- movement guard now also refuses a movement recorded by someone who neither runs the shift nor may recover another
-- cashier's till (`pos.shift.force_close`, IAM's published iam.holds_permission_at).
-- Data category: internal.
-- Rollback: tested (`pnpm db:rollback`), after 0239 is rolled back.

-- migrate:up
CREATE FUNCTION pos.shift_entry_state() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
BEGIN
  PERFORM platform.set_document_entry_state(NEW.id, NEW.status = 'OPEN', NEW.cashier_id, NEW.register_id);
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION pos.shift_entry_state() FROM PUBLIC;
CREATE TRIGGER trg_shift_entry_state AFTER INSERT OR UPDATE OF status ON pos.shift
  FOR EACH ROW EXECUTE FUNCTION pos.shift_entry_state();
SELECT platform.set_document_entry_state(s.id, s.status = 'OPEN', s.cashier_id, s.register_id) FROM pos.shift s;

CREATE OR REPLACE FUNCTION pos.cash_movement_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  s record;
BEGIN
  SELECT x.status, x.cashier_id, x.branch_id INTO s FROM pos.shift x WHERE x.id = NEW.shift_id FOR UPDATE;
  IF s.status IS DISTINCT FROM 'OPEN' THEN
    RAISE EXCEPTION 'pos.cash_movement: shift % is %, and cash moves only in an open shift', NEW.shift_id, s.status USING ERRCODE = 'HK010', CONSTRAINT = 'ck_cash_movement_open_shift';
  END IF;
  IF NEW.witness_id = s.cashier_id THEN
    RAISE EXCEPTION 'pos.cash_movement: the cashier of shift % cannot witness its own drop', NEW.shift_id USING ERRCODE = 'HK010', CONSTRAINT = 'ck_cash_movement_witness';
  END IF;
  IF NEW.kind <> 'FLOAT_IN' AND NEW.actor_id <> s.cashier_id AND NOT iam.holds_permission_at(NEW.actor_id, 'pos.shift.force_close', s.branch_id) THEN
    RAISE EXCEPTION 'pos.cash_movement: % neither runs shift % nor may recover another cashier''s till', NEW.actor_id, NEW.shift_id USING ERRCODE = 'HK010', CONSTRAINT = 'ck_cash_movement_own_shift';
  END IF;
  RETURN NEW;
END
$$;

-- migrate:down
CREATE OR REPLACE FUNCTION pos.cash_movement_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  s record;
BEGIN
  SELECT x.status, x.cashier_id INTO s FROM pos.shift x WHERE x.id = NEW.shift_id FOR UPDATE;
  IF s.status IS DISTINCT FROM 'OPEN' THEN
    RAISE EXCEPTION 'pos.cash_movement: shift % is %, and cash moves only in an open shift', NEW.shift_id, s.status USING ERRCODE = 'HK010', CONSTRAINT = 'ck_cash_movement_open_shift';
  END IF;
  IF NEW.witness_id = s.cashier_id THEN
    RAISE EXCEPTION 'pos.cash_movement: the cashier of shift % cannot witness its own drop', NEW.shift_id USING ERRCODE = 'HK010', CONSTRAINT = 'ck_cash_movement_witness';
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER trg_shift_entry_state ON pos.shift;
DROP FUNCTION pos.shift_entry_state();
