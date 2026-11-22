-- 0280_pos_late_entry
-- B09b continued 3b (ADR-0077 Amendments, the owner on 2026-11-18, replacing A-278 (e) and A-279 (f)): cash from the
-- till's queue whose shift has since stopped taking entries is recorded on the shift it happened in, by till time, as a
-- late entry; the shift is never reopened and nothing is put on another shift.
--   pos.cash_movement.late_entry   a queued drop, pay-out or pay-in recorded on a closing, closed or force-closed shift;
--                                  pos.cash_movement_guard takes it only on a shift that is no longer OPEN, never a float,
--                                  and only as the shift's own cashier's (ck_cash_movement_late_entry,
--                                  ck_cash_movement_own_shift); any other movement keeps the OPEN rule unchanged.
--   pos.shift_late_entry (LEDGER)  one row per late entry, a sale's cash (its payment) or a movement: what it moved the
--                                  expected cash by and the post-close adjustment it posts (pos.ShiftLateEntryPosted,
--                                  Dr 6900 Cr 1000 when short, Dr 1000 Cr 6900 when over), exactly the entry's amount.
-- A shift's close leaves late entries out (the count did not see them), so the closing over or short and the
-- adjustments together are the shift's over or short.
-- Data category: CONFIDENTIAL (DC-09): the farm's books.
-- Rollback: tested (`pnpm db:rollback`) before the first late entry; afterwards forward fix only.

-- migrate:up
ALTER TABLE pos.cash_movement ADD COLUMN late_entry boolean NOT NULL DEFAULT false;
ALTER TABLE pos.cash_movement ADD CONSTRAINT ck_cash_movement_late_kind CHECK (NOT late_entry OR kind <> 'FLOAT_IN');

CREATE OR REPLACE FUNCTION pos.cash_movement_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  s record;
BEGIN
  SELECT x.status, x.cashier_id, x.branch_id INTO s FROM pos.shift x WHERE x.id = NEW.shift_id FOR UPDATE;
  IF NEW.late_entry THEN
    IF s.status IS NULL OR s.status = 'OPEN' THEN
      RAISE EXCEPTION 'pos.cash_movement: shift % is %, and a late entry goes only on a shift that has stopped taking entries', NEW.shift_id, s.status USING ERRCODE = 'HK010', CONSTRAINT = 'ck_cash_movement_late_entry';
    END IF;
    IF NEW.actor_id <> s.cashier_id THEN
      RAISE EXCEPTION 'pos.cash_movement: a late entry on shift % is its own cashier''s, not %''s', NEW.shift_id, NEW.actor_id USING ERRCODE = 'HK010', CONSTRAINT = 'ck_cash_movement_own_shift';
    END IF;
  ELSIF s.status IS DISTINCT FROM 'OPEN' THEN
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

CREATE TABLE pos.shift_late_entry (
  id                    uuid PRIMARY KEY,
  shift_id              uuid NOT NULL CONSTRAINT fk_shift_late_entry_shift REFERENCES pos.shift (id) ON DELETE RESTRICT,
  branch_id             uuid NOT NULL CONSTRAINT fk_shift_late_entry_branch REFERENCES mdm.branch (id) ON DELETE RESTRICT,
  source_kind           text NOT NULL CONSTRAINT ck_shift_late_entry_kind CHECK (source_kind IN ('SALE_CASH', 'CASH_DROP', 'PAY_OUT', 'PAY_IN')),
  payment_id            uuid NULL CONSTRAINT fk_shift_late_entry_payment REFERENCES platform.business_document (id) ON DELETE RESTRICT,
  order_document_id     uuid NULL CONSTRAINT fk_shift_late_entry_order REFERENCES platform.business_document (id) ON DELETE RESTRICT,
  cash_movement_id      uuid NULL CONSTRAINT fk_shift_late_entry_movement REFERENCES pos.cash_movement (id) ON DELETE RESTRICT,
  amount_pesewas        platform.pesewas NOT NULL CONSTRAINT ck_shift_late_entry_amount CHECK (amount_pesewas > 0),
  expected_effect       text NOT NULL CONSTRAINT ck_shift_late_entry_effect CHECK (expected_effect = CASE WHEN source_kind IN ('SALE_CASH', 'PAY_IN') THEN 'RAISES' ELSE 'LOWERS' END),
  adjustment_direction  text NOT NULL CONSTRAINT ck_shift_late_entry_direction CHECK (adjustment_direction = CASE WHEN expected_effect = 'RAISES' THEN 'SHORT' ELSE 'OVER' END),
  shift_state           text NOT NULL CONSTRAINT ck_shift_late_entry_state CHECK (shift_state IN ('CLOSING', 'CLOSED', 'FORCE_CLOSED')),
  severity              text NOT NULL CONSTRAINT ck_shift_late_entry_severity CHECK (severity IN ('REVIEW', 'URGENT')),
  occurred_at           timestamptz NOT NULL,
  recorded_at           timestamptz NOT NULL,
  actor_id              uuid NOT NULL CONSTRAINT fk_shift_late_entry_actor REFERENCES iam.principal (id) ON DELETE RESTRICT,
  CONSTRAINT ck_shift_late_entry_source CHECK (
    (source_kind = 'SALE_CASH' AND payment_id IS NOT NULL AND order_document_id IS NOT NULL AND cash_movement_id IS NULL)
    OR (source_kind <> 'SALE_CASH' AND cash_movement_id IS NOT NULL AND payment_id IS NULL AND order_document_id IS NULL))
);
COMMENT ON TABLE pos.shift_late_entry IS 'class=LEDGER';
CREATE UNIQUE INDEX uq_shift_late_entry_payment ON pos.shift_late_entry (payment_id) WHERE payment_id IS NOT NULL;
CREATE UNIQUE INDEX uq_shift_late_entry_movement ON pos.shift_late_entry (cash_movement_id) WHERE cash_movement_id IS NOT NULL;
CREATE INDEX ix_shift_late_entry_shift ON pos.shift_late_entry (shift_id);
CREATE TRIGGER trg_shift_late_entry_immutable BEFORE UPDATE OR DELETE ON pos.shift_late_entry
  FOR EACH ROW EXECUTE FUNCTION platform.reject_change();
CREATE TRIGGER trg_shift_late_entry_no_truncate BEFORE TRUNCATE ON pos.shift_late_entry
  FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_change();

CREATE FUNCTION pos.shift_late_entry_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  s record;
  m record;
  state text;
BEGIN
  SELECT x.status, x.branch_id, x.force_closed INTO s FROM pos.shift x WHERE x.id = NEW.shift_id FOR UPDATE;
  state := CASE WHEN s.status = 'CLOSING' THEN 'CLOSING' WHEN s.force_closed THEN 'FORCE_CLOSED' ELSE 'CLOSED' END;
  IF s.status = 'OPEN' OR NEW.shift_state <> state THEN
    RAISE EXCEPTION 'pos.shift_late_entry: shift % is % and not %', NEW.shift_id, s.status, NEW.shift_state USING ERRCODE = 'HK010', CONSTRAINT = 'ck_shift_late_entry_shift';
  END IF;
  IF NEW.branch_id <> s.branch_id THEN
    RAISE EXCEPTION 'pos.shift_late_entry: shift % is not of branch %', NEW.shift_id, NEW.branch_id USING ERRCODE = 'HK010', CONSTRAINT = 'ck_shift_late_entry_shift';
  END IF;
  IF NEW.cash_movement_id IS NOT NULL THEN
    SELECT x.shift_id, x.kind, x.amount_pesewas, x.late_entry INTO m FROM pos.cash_movement x WHERE x.id = NEW.cash_movement_id;
    IF m.shift_id <> NEW.shift_id OR NOT m.late_entry OR m.kind <> NEW.source_kind OR m.amount_pesewas <> NEW.amount_pesewas THEN
      RAISE EXCEPTION 'pos.shift_late_entry: movement % is not a late % of % on shift %', NEW.cash_movement_id, NEW.source_kind, NEW.amount_pesewas, NEW.shift_id USING ERRCODE = 'HK010', CONSTRAINT = 'ck_shift_late_entry_movement';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION pos.shift_late_entry_guard() FROM PUBLIC;
CREATE TRIGGER trg_shift_late_entry_guard BEFORE INSERT ON pos.shift_late_entry
  FOR EACH ROW EXECUTE FUNCTION pos.shift_late_entry_guard();

REVOKE ALL ON pos.shift_late_entry FROM PUBLIC;
GRANT SELECT, INSERT ON pos.shift_late_entry TO hk_app, hk_worker;

-- migrate:down
DROP TABLE pos.shift_late_entry;
DROP FUNCTION pos.shift_late_entry_guard();
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
ALTER TABLE pos.cash_movement DROP CONSTRAINT ck_cash_movement_late_kind;
ALTER TABLE pos.cash_movement DROP COLUMN late_entry;
