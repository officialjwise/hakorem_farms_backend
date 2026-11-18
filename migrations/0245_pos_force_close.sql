-- 0245_pos_force_close
-- B09b continued 1b (FR-POS-020, A-275): a manager who is not the cashier force-closes an abandoned OPEN shift with a
-- reason. The shift goes straight from OPEN to CLOSED, flagged force-closed, at the cash its records say it holds
-- (expected_cash_pesewas, frozen); nothing is declared and nothing posts, because nobody has counted the drawer yet.
-- The drawer is counted later by a supervisor who is neither the cashier nor the manager who force-closed it, into
-- pos.shift_late_count (LEDGER, insert-only, one per shift); that count posts the over or short (pos.ShiftClosed).
--   pos.shift               force_close_reason, required exactly on a force-closed shift (ck_shift_force_close_reason);
--                           ck_shift_steps gains the force-closed CLOSED step (no declaration, expected and closer
--                           set) and refuses force_closed on every other step; ck_shift_over_short allows no over or
--                           short until both figures exist; pos.shift_guard lets OPEN become CLOSED only by a force
--                           close, and force_closed and its reason change only in that step. The checker is never the
--                           cashier (ck_shift_close_checker, unchanged, holds close_approved_by, the force-closer).
--   pos.shift_late_count    LEDGER: the count of a force-closed shift's drawer. pos.shift_late_count_guard (HK010):
--                           only a force-closed shift, never by its cashier (ck_shift_late_count_not_cashier) nor its
--                           force-closer (ck_shift_late_count_not_closer), by a holder of pos.shift.close.approve at
--                           its branch (IAM's published iam.holds_permission_at), against the shift's frozen expected
--                           cash (ck_shift_late_count_expected); over or short exactly declared minus expected.
-- Additions to docs/data-model/pos.md: the column and the table above.
-- Data category: CONFIDENTIAL (DC-11: what a till held and what was counted).
-- Rollback: tested (`pnpm db:rollback`), safe before the first force close; afterwards forward fix only (a force-closed
-- shift and its count are records of money).

-- migrate:up
ALTER TABLE pos.shift ADD COLUMN force_close_reason text NULL
  CONSTRAINT ck_shift_force_close_reason_text CHECK (length(btrim(force_close_reason)) BETWEEN 1 AND 500);
ALTER TABLE pos.shift ADD CONSTRAINT ck_shift_force_close_reason CHECK (force_closed = (force_close_reason IS NOT NULL));
ALTER TABLE pos.shift DROP CONSTRAINT ck_shift_steps;
ALTER TABLE pos.shift ADD CONSTRAINT ck_shift_steps CHECK (
  (status = 'OPEN' AND NOT force_closed AND declared_at IS NULL AND declared_cash_pesewas IS NULL AND expected_cash_pesewas IS NULL AND closed_at IS NULL AND close_approved_by IS NULL)
  OR (status = 'CLOSING' AND NOT force_closed AND declared_at IS NOT NULL AND declared_cash_pesewas IS NOT NULL AND expected_cash_pesewas IS NULL AND closed_at IS NULL AND close_approved_by IS NULL)
  OR (status = 'CLOSED' AND NOT force_closed AND declared_at IS NOT NULL AND declared_cash_pesewas IS NOT NULL AND expected_cash_pesewas IS NOT NULL AND closed_at IS NOT NULL AND close_approved_by IS NOT NULL)
  OR (status = 'CLOSED' AND force_closed AND declared_at IS NULL AND declared_cash_pesewas IS NULL AND expected_cash_pesewas IS NOT NULL AND closed_at IS NOT NULL AND close_approved_by IS NOT NULL));
ALTER TABLE pos.shift DROP CONSTRAINT ck_shift_over_short;
ALTER TABLE pos.shift ADD CONSTRAINT ck_shift_over_short CHECK (
  (over_short_pesewas IS NULL AND over_short_direction IS NULL AND (expected_cash_pesewas IS NULL OR declared_cash_pesewas IS NULL))
  OR (expected_cash_pesewas IS NOT NULL AND declared_cash_pesewas IS NOT NULL
      AND over_short_pesewas = abs(declared_cash_pesewas - expected_cash_pesewas)
      AND over_short_direction = CASE WHEN declared_cash_pesewas > expected_cash_pesewas THEN 'OVER' WHEN declared_cash_pesewas < expected_cash_pesewas THEN 'SHORT' ELSE 'EXACT' END));

-- A shift opens OPEN with nothing counted; its opening facts never change; it moves OPEN to CLOSING to CLOSED, or
-- OPEN to CLOSED by a force close, and is flagged force-closed only in that step.
CREATE OR REPLACE FUNCTION pos.shift_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'OPEN' OR NEW.force_closed OR NEW.last_device_counter <> 0 THEN
      RAISE EXCEPTION 'pos.shift: a shift opens OPEN, not force-closed, with no device counter' USING ERRCODE = 'HK010', CONSTRAINT = 'ck_shift_steps';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW.shift_no, NEW.register_id, NEW.cashier_id, NEW.shift_seq, NEW.opened_at, NEW.opening_float_pesewas, NEW.branch_id, NEW.created_at, NEW.created_by)
     IS DISTINCT FROM (OLD.id, OLD.shift_no, OLD.register_id, OLD.cashier_id, OLD.shift_seq, OLD.opened_at, OLD.opening_float_pesewas, OLD.branch_id, OLD.created_at, OLD.created_by) THEN
    RAISE EXCEPTION 'pos.shift %: its register, cashier, number, sequence, opening time and float never change', OLD.id USING ERRCODE = 'HK004';
  END IF;
  IF OLD.status = 'CLOSING' AND (NEW.declared_at, NEW.declared_cash_pesewas) IS DISTINCT FROM (OLD.declared_at, OLD.declared_cash_pesewas) THEN
    RAISE EXCEPTION 'pos.shift %: a declared count never changes', OLD.id USING ERRCODE = 'HK004';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'OPEN' AND NEW.status = 'CLOSING' AND NOT NEW.force_closed)
    OR (OLD.status = 'CLOSING' AND NEW.status = 'CLOSED' AND NOT NEW.force_closed)
    OR (OLD.status = 'OPEN' AND NEW.status = 'CLOSED' AND NEW.force_closed)) THEN
    RAISE EXCEPTION 'pos.shift %: % cannot become %', OLD.id, OLD.status, NEW.status USING ERRCODE = 'HK010', CONSTRAINT = 'ck_shift_steps';
  END IF;
  IF (NEW.force_closed, NEW.force_close_reason) IS DISTINCT FROM (OLD.force_closed, OLD.force_close_reason) AND NOT (OLD.status = 'OPEN' AND NEW.status = 'CLOSED') THEN
    RAISE EXCEPTION 'pos.shift %: a shift is flagged force-closed only as it is force-closed', OLD.id USING ERRCODE = 'HK010', CONSTRAINT = 'ck_shift_steps';
  END IF;
  RETURN NEW;
END
$$;

CREATE TABLE pos.shift_late_count (
  shift_id              uuid PRIMARY KEY CONSTRAINT fk_shift_late_count_shift REFERENCES pos.shift (id) ON DELETE RESTRICT,
  declared_cash_pesewas platform.pesewas NOT NULL,
  expected_cash_pesewas platform.pesewas NOT NULL,
  over_short_pesewas    platform.pesewas NOT NULL,
  over_short_direction  text NOT NULL CONSTRAINT ck_shift_late_count_direction CHECK (over_short_direction IN ('OVER', 'SHORT', 'EXACT')),
  reason                text NOT NULL CONSTRAINT ck_shift_late_count_reason CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
  counted_at            timestamptz NOT NULL,
  recorded_at           timestamptz NOT NULL,
  actor_id              uuid NOT NULL CONSTRAINT fk_shift_late_count_actor REFERENCES iam.principal (id) ON DELETE RESTRICT,
  CONSTRAINT ck_shift_late_count_over_short CHECK (
    over_short_pesewas = abs(declared_cash_pesewas - expected_cash_pesewas)
    AND over_short_direction = CASE WHEN declared_cash_pesewas > expected_cash_pesewas THEN 'OVER' WHEN declared_cash_pesewas < expected_cash_pesewas THEN 'SHORT' ELSE 'EXACT' END)
);
COMMENT ON TABLE pos.shift_late_count IS 'class=LEDGER';
CREATE TRIGGER trg_shift_late_count_immutable BEFORE UPDATE OR DELETE ON pos.shift_late_count
  FOR EACH ROW EXECUTE FUNCTION platform.reject_change();
CREATE TRIGGER trg_shift_late_count_no_truncate BEFORE TRUNCATE ON pos.shift_late_count
  FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_change();

-- Only a force-closed shift's drawer is counted late; never by its cashier nor its force-closer; against its frozen
-- expected cash; by a supervisor of its branch.
CREATE FUNCTION pos.shift_late_count_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  s record;
BEGIN
  SELECT x.status, x.force_closed, x.cashier_id, x.close_approved_by, x.expected_cash_pesewas, x.branch_id INTO s FROM pos.shift x WHERE x.id = NEW.shift_id FOR UPDATE;
  IF s.status IS DISTINCT FROM 'CLOSED' OR NOT s.force_closed THEN
    RAISE EXCEPTION 'pos.shift_late_count: shift % was not force-closed; its count is declared and signed off', NEW.shift_id USING ERRCODE = 'HK010', CONSTRAINT = 'ck_shift_late_count_forced';
  END IF;
  IF NEW.actor_id = s.cashier_id THEN
    RAISE EXCEPTION 'pos.shift_late_count: the cashier of shift % cannot count its drawer after a force close', NEW.shift_id USING ERRCODE = 'HK010', CONSTRAINT = 'ck_shift_late_count_not_cashier';
  END IF;
  IF NEW.actor_id = s.close_approved_by THEN
    RAISE EXCEPTION 'pos.shift_late_count: the manager who force-closed shift % cannot also count its drawer', NEW.shift_id USING ERRCODE = 'HK010', CONSTRAINT = 'ck_shift_late_count_not_closer';
  END IF;
  IF NEW.expected_cash_pesewas IS DISTINCT FROM s.expected_cash_pesewas THEN
    RAISE EXCEPTION 'pos.shift_late_count: shift % was closed at %, not %', NEW.shift_id, s.expected_cash_pesewas, NEW.expected_cash_pesewas USING ERRCODE = 'HK010', CONSTRAINT = 'ck_shift_late_count_expected';
  END IF;
  IF NOT iam.holds_permission_at(NEW.actor_id, 'pos.shift.close.approve', s.branch_id) THEN
    RAISE EXCEPTION 'pos.shift_late_count: % may not sign off a count at the branch of shift %', NEW.actor_id, NEW.shift_id USING ERRCODE = 'HK010', CONSTRAINT = 'ck_shift_late_count_supervisor';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION pos.shift_late_count_guard() FROM PUBLIC;
CREATE TRIGGER trg_shift_late_count_guard BEFORE INSERT ON pos.shift_late_count
  FOR EACH ROW EXECUTE FUNCTION pos.shift_late_count_guard();

REVOKE ALL ON pos.shift_late_count FROM PUBLIC;
GRANT SELECT, INSERT ON pos.shift_late_count TO hk_app, hk_worker;

-- migrate:down
DROP TABLE pos.shift_late_count;
DROP FUNCTION pos.shift_late_count_guard();
CREATE OR REPLACE FUNCTION pos.shift_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'OPEN' OR NEW.force_closed OR NEW.last_device_counter <> 0 THEN
      RAISE EXCEPTION 'pos.shift: a shift opens OPEN, not force-closed, with no device counter' USING ERRCODE = 'HK010', CONSTRAINT = 'ck_shift_steps';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW.shift_no, NEW.register_id, NEW.cashier_id, NEW.shift_seq, NEW.opened_at, NEW.opening_float_pesewas, NEW.branch_id, NEW.created_at, NEW.created_by)
     IS DISTINCT FROM (OLD.id, OLD.shift_no, OLD.register_id, OLD.cashier_id, OLD.shift_seq, OLD.opened_at, OLD.opening_float_pesewas, OLD.branch_id, OLD.created_at, OLD.created_by) THEN
    RAISE EXCEPTION 'pos.shift %: its register, cashier, number, sequence, opening time and float never change', OLD.id USING ERRCODE = 'HK004';
  END IF;
  IF OLD.status = 'CLOSING' AND (NEW.declared_at, NEW.declared_cash_pesewas) IS DISTINCT FROM (OLD.declared_at, OLD.declared_cash_pesewas) THEN
    RAISE EXCEPTION 'pos.shift %: a declared count never changes', OLD.id USING ERRCODE = 'HK004';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT ((OLD.status = 'OPEN' AND NEW.status = 'CLOSING') OR (OLD.status = 'CLOSING' AND NEW.status = 'CLOSED')) THEN
    RAISE EXCEPTION 'pos.shift %: % cannot become %', OLD.id, OLD.status, NEW.status USING ERRCODE = 'HK010', CONSTRAINT = 'ck_shift_steps';
  END IF;
  RETURN NEW;
END
$$;
ALTER TABLE pos.shift DROP CONSTRAINT ck_shift_over_short;
ALTER TABLE pos.shift ADD CONSTRAINT ck_shift_over_short CHECK (
  (expected_cash_pesewas IS NULL AND over_short_pesewas IS NULL AND over_short_direction IS NULL)
  OR (expected_cash_pesewas IS NOT NULL
      AND over_short_pesewas = abs(declared_cash_pesewas - expected_cash_pesewas)
      AND over_short_direction = CASE WHEN declared_cash_pesewas > expected_cash_pesewas THEN 'OVER' WHEN declared_cash_pesewas < expected_cash_pesewas THEN 'SHORT' ELSE 'EXACT' END));
ALTER TABLE pos.shift DROP CONSTRAINT ck_shift_steps;
ALTER TABLE pos.shift ADD CONSTRAINT ck_shift_steps CHECK (
  (status = 'OPEN' AND declared_at IS NULL AND declared_cash_pesewas IS NULL AND expected_cash_pesewas IS NULL AND closed_at IS NULL AND close_approved_by IS NULL)
  OR (status = 'CLOSING' AND declared_at IS NOT NULL AND declared_cash_pesewas IS NOT NULL AND expected_cash_pesewas IS NULL AND closed_at IS NULL AND close_approved_by IS NULL)
  OR (status = 'CLOSED' AND declared_at IS NOT NULL AND declared_cash_pesewas IS NOT NULL AND expected_cash_pesewas IS NOT NULL AND closed_at IS NOT NULL AND close_approved_by IS NOT NULL));
ALTER TABLE pos.shift DROP CONSTRAINT ck_shift_force_close_reason;
ALTER TABLE pos.shift DROP COLUMN force_close_reason;
