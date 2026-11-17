-- 0226_pos_registers_shifts
-- B9b (FR-POS-015 to FR-POS-019, ADR-0027, A-212 (a), A-273): the till. A register sells from one location of its
-- branch; a shift is one cashier's session on one register, opened with a float, closed blind and signed off by a
-- supervisor who is not the cashier. Cash enters and leaves a till only inside an open shift.
--   pos.register            MASTER: a till, its branch and the location it sells from; its code prints in receipt
--                           numbers (uq_register_code per branch among live registers).
--   pos.shift               DOCUMENT, registered as a SHIFT business document: OPEN, then CLOSING once the cashier has
--                           declared the count blind, then CLOSED once a supervisor signs it off (pos.shift_guard,
--                           HK004 and HK010: the opening facts never change, the steps run in that order only, and a
--                           closed shift is frozen). One open shift per register and per cashier (partial unique
--                           indexes). The supervisor is never the cashier (ck_shift_close_checker). Over or short is
--                           exactly declared minus expected with its direction (ck_shift_over_short).
--   pos.cash_movement       LEDGER, insert-only: the opening float (FLOAT_IN, once per shift), drops to the safe,
--                           pay-outs and pay-ins from the safe, each with its reason; a drop has a witness who is
--                           neither the person recording it (ck_cash_movement_witness) nor the cashier, and nothing is
--                           written to a shift that is not OPEN (pos.cash_movement_guard, HK010).
--   pos.shift_tender_count  DOCUMENT: the count per payment method, declared at close while the shift is CLOSING and
--                           completed with what was expected at the sign-off, once (pos.shift_tender_count_guard).
--   pos.shift_report        LEDGER, insert-only: the Z report as produced at the sign-off, one per shift.
-- Device enrolments, held sales and the offline sync log are added by the phases that build them (A-273 (a)).
-- Additions to docs/data-model/pos.md: the tables above as built.
-- Data category: CONFIDENTIAL (DC-11: what a till took and what its cashier counted).
-- Rollback: tested (`pnpm db:rollback`), safe before the first shift; afterwards forward fix only (a shift and its
-- cash movements are records of money and are never removed).

-- migrate:up
CREATE SCHEMA pos AUTHORIZATION hk_owner;
REVOKE ALL ON SCHEMA pos FROM PUBLIC;
GRANT USAGE ON SCHEMA pos TO hk_app, hk_worker, hk_report;

CREATE TABLE pos.register (
  id            uuid PRIMARY KEY,
  branch_id     uuid NOT NULL CONSTRAINT fk_register_branch REFERENCES mdm.branch (id) ON DELETE RESTRICT,
  location_id   uuid NOT NULL CONSTRAINT fk_register_location REFERENCES mdm.location (id) ON DELETE RESTRICT,
  code          text NOT NULL CONSTRAINT ck_register_code CHECK (code ~ '^[A-Z0-9]{1,4}$'),
  name          text NOT NULL CONSTRAINT ck_register_name CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  status        text NOT NULL CONSTRAINT ck_register_status CHECK (status IN ('ACTIVE', 'RETIRED')),
  version       integer NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL,
  created_by    uuid NOT NULL CONSTRAINT fk_register_created_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  updated_at    timestamptz NOT NULL,
  updated_by    uuid NOT NULL CONSTRAINT fk_register_updated_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  deleted_at    timestamptz NULL,
  deleted_by    uuid NULL CONSTRAINT fk_register_deleted_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  delete_reason text NULL,
  CONSTRAINT ck_register_soft_delete CHECK ((deleted_at IS NULL) = (deleted_by IS NULL) AND (deleted_at IS NULL) = (delete_reason IS NULL))
);
COMMENT ON TABLE pos.register IS 'class=MASTER';
CREATE UNIQUE INDEX uq_register_code ON pos.register (branch_id, code) WHERE deleted_at IS NULL;
CREATE TRIGGER trg_register_version BEFORE UPDATE ON pos.register
  FOR EACH ROW EXECUTE FUNCTION platform.touch_version();

CREATE TABLE pos.shift (
  id                    uuid PRIMARY KEY CONSTRAINT fk_shift_document REFERENCES platform.business_document (id) ON DELETE RESTRICT,
  shift_no              text NOT NULL CONSTRAINT uq_shift_no UNIQUE,
  register_id           uuid NOT NULL CONSTRAINT fk_shift_register REFERENCES pos.register (id) ON DELETE RESTRICT,
  cashier_id            uuid NOT NULL CONSTRAINT fk_shift_cashier REFERENCES iam.principal (id) ON DELETE RESTRICT,
  shift_seq             integer NOT NULL CONSTRAINT ck_shift_seq CHECK (shift_seq > 0),
  opened_at             timestamptz NOT NULL,
  opening_float_pesewas platform.pesewas NOT NULL,
  declared_at           timestamptz NULL,
  declared_cash_pesewas platform.pesewas NULL,
  expected_cash_pesewas platform.pesewas NULL,
  over_short_pesewas    platform.pesewas NULL,
  over_short_direction  text NULL CONSTRAINT ck_shift_over_short_direction CHECK (over_short_direction IN ('OVER', 'SHORT', 'EXACT')),
  close_approved_by     uuid NULL CONSTRAINT fk_shift_close_approved_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  closed_at             timestamptz NULL,
  last_device_counter   integer NOT NULL DEFAULT 0 CONSTRAINT ck_shift_last_device_counter CHECK (last_device_counter >= 0),
  force_closed          boolean NOT NULL DEFAULT false,
  currency              char(3) NOT NULL DEFAULT 'GHS' CONSTRAINT ck_shift_currency CHECK (currency = 'GHS'),
  status                text NOT NULL CONSTRAINT ck_shift_status CHECK (status IN ('OPEN', 'CLOSING', 'CLOSED')),
  branch_id             uuid NOT NULL CONSTRAINT fk_shift_branch REFERENCES mdm.branch (id) ON DELETE RESTRICT,
  version               integer NOT NULL DEFAULT 1,
  created_at            timestamptz NOT NULL,
  created_by            uuid NOT NULL CONSTRAINT fk_shift_created_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  updated_at            timestamptz NOT NULL,
  updated_by            uuid NOT NULL CONSTRAINT fk_shift_updated_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  posted_at             timestamptz NULL,
  posted_by             uuid NULL CONSTRAINT fk_shift_posted_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  CONSTRAINT uq_shift_register_seq UNIQUE (register_id, shift_seq),
  CONSTRAINT ck_shift_close_checker CHECK (close_approved_by IS NULL OR close_approved_by <> cashier_id),
  CONSTRAINT ck_shift_steps CHECK (
    (status = 'OPEN' AND declared_at IS NULL AND declared_cash_pesewas IS NULL AND expected_cash_pesewas IS NULL AND closed_at IS NULL AND close_approved_by IS NULL)
    OR (status = 'CLOSING' AND declared_at IS NOT NULL AND declared_cash_pesewas IS NOT NULL AND expected_cash_pesewas IS NULL AND closed_at IS NULL AND close_approved_by IS NULL)
    OR (status = 'CLOSED' AND declared_at IS NOT NULL AND declared_cash_pesewas IS NOT NULL AND expected_cash_pesewas IS NOT NULL AND closed_at IS NOT NULL AND close_approved_by IS NOT NULL)),
  CONSTRAINT ck_shift_over_short CHECK (
    (expected_cash_pesewas IS NULL AND over_short_pesewas IS NULL AND over_short_direction IS NULL)
    OR (expected_cash_pesewas IS NOT NULL
        AND over_short_pesewas = abs(declared_cash_pesewas - expected_cash_pesewas)
        AND over_short_direction = CASE WHEN declared_cash_pesewas > expected_cash_pesewas THEN 'OVER' WHEN declared_cash_pesewas < expected_cash_pesewas THEN 'SHORT' ELSE 'EXACT' END)),
  CONSTRAINT ck_shift_posted CHECK ((status = 'CLOSED') = (posted_at IS NOT NULL) AND (posted_at IS NULL) = (posted_by IS NULL))
);
COMMENT ON TABLE pos.shift IS 'class=DOCUMENT';
CREATE UNIQUE INDEX uq_shift_open_register ON pos.shift (register_id) WHERE status <> 'CLOSED';
CREATE UNIQUE INDEX uq_shift_open_cashier ON pos.shift (cashier_id) WHERE status <> 'CLOSED';
CREATE INDEX ix_shift_branch ON pos.shift (branch_id, opened_at);
CREATE INDEX ix_shift_cashier ON pos.shift (cashier_id, opened_at);
CREATE TRIGGER trg_shift_version BEFORE UPDATE ON pos.shift
  FOR EACH ROW EXECUTE FUNCTION platform.touch_version();
CREATE TRIGGER trg_shift_freeze BEFORE UPDATE ON pos.shift
  FOR EACH ROW EXECUTE FUNCTION platform.freeze_posted('CLOSED');

-- A shift opens OPEN with nothing counted; its opening facts never change; it moves OPEN to CLOSING to CLOSED only.
CREATE FUNCTION pos.shift_guard() RETURNS trigger
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
REVOKE ALL ON FUNCTION pos.shift_guard() FROM PUBLIC;
CREATE TRIGGER trg_shift_guard BEFORE INSERT OR UPDATE ON pos.shift
  FOR EACH ROW EXECUTE FUNCTION pos.shift_guard();

CREATE TABLE pos.cash_movement (
  id             uuid PRIMARY KEY,
  shift_id       uuid NOT NULL CONSTRAINT fk_cash_movement_shift REFERENCES pos.shift (id) ON DELETE RESTRICT,
  kind           text NOT NULL CONSTRAINT ck_cash_movement_kind CHECK (kind IN ('FLOAT_IN', 'CASH_DROP', 'PAY_OUT', 'PAY_IN')),
  amount_pesewas platform.pesewas NOT NULL CONSTRAINT ck_cash_movement_amount CHECK (amount_pesewas > 0),
  reason_code    text NULL CONSTRAINT fk_cash_movement_reason REFERENCES mdm.reason_code (code) ON DELETE RESTRICT,
  note           text NULL CONSTRAINT ck_cash_movement_note CHECK (length(btrim(note)) BETWEEN 1 AND 500),
  witness_id     uuid NULL CONSTRAINT fk_cash_movement_witness REFERENCES iam.principal (id) ON DELETE RESTRICT,
  occurred_at    timestamptz NOT NULL,
  recorded_at    timestamptz NOT NULL,
  actor_id       uuid NOT NULL CONSTRAINT fk_cash_movement_actor REFERENCES iam.principal (id) ON DELETE RESTRICT,
  CONSTRAINT ck_cash_movement_reason CHECK ((kind = 'FLOAT_IN') = (reason_code IS NULL)),
  CONSTRAINT ck_cash_movement_witness CHECK ((kind = 'CASH_DROP') = (witness_id IS NOT NULL) AND (witness_id IS NULL OR witness_id <> actor_id))
);
COMMENT ON TABLE pos.cash_movement IS 'class=LEDGER';
CREATE INDEX ix_cash_movement_shift ON pos.cash_movement (shift_id, occurred_at);
CREATE UNIQUE INDEX uq_cash_movement_float ON pos.cash_movement (shift_id) WHERE kind = 'FLOAT_IN';
CREATE TRIGGER trg_cash_movement_immutable BEFORE UPDATE OR DELETE ON pos.cash_movement
  FOR EACH ROW EXECUTE FUNCTION platform.reject_change();
CREATE TRIGGER trg_cash_movement_no_truncate BEFORE TRUNCATE ON pos.cash_movement
  FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_change();

-- Cash moves only in an open shift (A-212 (a)), and a drop's witness is never the shift's cashier.
CREATE FUNCTION pos.cash_movement_guard() RETURNS trigger
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
REVOKE ALL ON FUNCTION pos.cash_movement_guard() FROM PUBLIC;
CREATE TRIGGER trg_cash_movement_guard BEFORE INSERT ON pos.cash_movement
  FOR EACH ROW EXECUTE FUNCTION pos.cash_movement_guard();

CREATE TABLE pos.shift_tender_count (
  shift_id           uuid NOT NULL CONSTRAINT fk_shift_tender_count_shift REFERENCES pos.shift (id) ON DELETE RESTRICT,
  payment_method_id  uuid NOT NULL CONSTRAINT fk_shift_tender_count_method REFERENCES mdm.payment_method (id) ON DELETE RESTRICT,
  declared_pesewas   platform.pesewas NOT NULL,
  expected_pesewas   platform.pesewas NULL,
  variance_pesewas   platform.pesewas NULL,
  variance_direction text NULL CONSTRAINT ck_shift_tender_count_direction CHECK (variance_direction IN ('OVER', 'SHORT', 'EXACT')),
  created_at         timestamptz NOT NULL,
  created_by         uuid NOT NULL CONSTRAINT fk_shift_tender_count_created_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  CONSTRAINT pk_shift_tender_count PRIMARY KEY (shift_id, payment_method_id),
  CONSTRAINT ck_shift_tender_count_variance CHECK (
    (expected_pesewas IS NULL AND variance_pesewas IS NULL AND variance_direction IS NULL)
    OR (expected_pesewas IS NOT NULL
        AND variance_pesewas = abs(declared_pesewas - expected_pesewas)
        AND variance_direction = CASE WHEN declared_pesewas > expected_pesewas THEN 'OVER' WHEN declared_pesewas < expected_pesewas THEN 'SHORT' ELSE 'EXACT' END))
);
COMMENT ON TABLE pos.shift_tender_count IS 'class=DOCUMENT';

-- Declared while the shift is CLOSING; completed once with what was expected, at the sign-off; never changed after.
CREATE FUNCTION pos.shift_tender_count_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  shift_status text;
BEGIN
  SELECT x.status INTO shift_status FROM pos.shift x WHERE x.id = NEW.shift_id;
  IF shift_status IS DISTINCT FROM 'CLOSING' THEN
    RAISE EXCEPTION 'pos.shift_tender_count: shift % is %, and a count is declared and signed off only while it is CLOSING', NEW.shift_id, shift_status USING ERRCODE = 'HK010', CONSTRAINT = 'ck_shift_steps';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.expected_pesewas IS NOT NULL THEN
      RAISE EXCEPTION 'pos.shift_tender_count: a count is declared blind, with nothing expected' USING ERRCODE = 'HK010', CONSTRAINT = 'ck_shift_steps';
    END IF;
  ELSIF OLD.expected_pesewas IS NOT NULL OR (NEW.shift_id, NEW.payment_method_id, NEW.declared_pesewas, NEW.created_at, NEW.created_by)
        IS DISTINCT FROM (OLD.shift_id, OLD.payment_method_id, OLD.declared_pesewas, OLD.created_at, OLD.created_by) THEN
    RAISE EXCEPTION 'pos.shift_tender_count: a declared count never changes, and its expected figure is set once' USING ERRCODE = 'HK004';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION pos.shift_tender_count_guard() FROM PUBLIC;
CREATE TRIGGER trg_shift_tender_count_guard BEFORE INSERT OR UPDATE ON pos.shift_tender_count
  FOR EACH ROW EXECUTE FUNCTION pos.shift_tender_count_guard();

CREATE TABLE pos.shift_report (
  id                   uuid PRIMARY KEY,
  shift_id             uuid NOT NULL CONSTRAINT fk_shift_report_shift REFERENCES pos.shift (id) ON DELETE RESTRICT,
  kind                 text NOT NULL CONSTRAINT ck_shift_report_kind CHECK (kind IN ('X', 'Z')),
  totals               jsonb NOT NULL,
  archived_document_id uuid NULL CONSTRAINT fk_shift_report_archive REFERENCES doc.archived_document (id) ON DELETE RESTRICT,
  recorded_at          timestamptz NOT NULL,
  actor_id             uuid NOT NULL CONSTRAINT fk_shift_report_actor REFERENCES iam.principal (id) ON DELETE RESTRICT
);
COMMENT ON TABLE pos.shift_report IS 'class=LEDGER';
CREATE UNIQUE INDEX uq_shift_report_z ON pos.shift_report (shift_id) WHERE kind = 'Z';
CREATE TRIGGER trg_shift_report_immutable BEFORE UPDATE OR DELETE ON pos.shift_report
  FOR EACH ROW EXECUTE FUNCTION platform.reject_change();
CREATE TRIGGER trg_shift_report_no_truncate BEFORE TRUNCATE ON pos.shift_report
  FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_change();

REVOKE ALL ON ALL TABLES IN SCHEMA pos FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON pos.register, pos.shift, pos.shift_tender_count TO hk_app, hk_worker;
GRANT SELECT, INSERT ON pos.cash_movement, pos.shift_report TO hk_app, hk_worker;

-- migrate:down
DROP TABLE pos.shift_report;
DROP TABLE pos.shift_tender_count;
DROP FUNCTION pos.shift_tender_count_guard();
DROP TABLE pos.cash_movement;
DROP FUNCTION pos.cash_movement_guard();
DROP TABLE pos.shift;
DROP FUNCTION pos.shift_guard();
DROP TABLE pos.register;
DROP SCHEMA pos;
