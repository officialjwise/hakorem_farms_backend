-- 0262_pos_cash_movement_sync
-- B09b continued 2c (FR-POS-016, ADR-0027, ADR-0077, OFFLINE_SYNC 10, A-279): every cash movement a till sends in a
-- sync batch, logged once per submission, so each is decided exactly once by its client id and answered the same way on
-- every later sync.
--   pos.cash_movement_sync   LEDGER (insert only): the device, the batch's shift, the client's movement id, its kind,
--                   amount and till time, the outcome (APPLIED, DUPLICATE, REJECTED) with the reason for a refusal, the
--                   movement it applied or duplicates, the submission it answers, and a till clock outside the
--                   tolerance (AHEAD_OF_SERVER, BEFORE_SHIFT_OPENED).
--   uq_cash_movement_sync_decided   a client movement id is decided once: one APPLIED or first REJECTED row (answers_id
--                   null); a later submission answers that row.
--   ck_cash_movement_sync_fields    APPLIED and DUPLICATE name a movement and no reason; REJECTED a reason and no
--                   movement; only a later submission answers another.
--   pos.cash_movement_sync_guard (HK010): the shift is of the device's till (ck_cash_movement_sync_device_shift); an
--                   APPLIED row is its own movement, on the batch's shift, of its kind and amount
--                   (ck_cash_movement_sync_applied); a DUPLICATE names a movement of the same id and content
--                   (ck_cash_movement_sync_duplicate); an answer answers a decided row of the same client id
--                   (ck_cash_movement_sync_answers).
-- Every time is written by the application from its clock (ADR-0067); nothing here reads now().
-- Additions to docs/data-model/pos.md: the table above, as built.
-- Data category: INTERNAL (DC-04: till ids and amounts; no customer detail).
-- Rollback: tested (`pnpm db:rollback`) before the first movement syncs; afterwards the log is evidence and only a
-- forward fix is safe.

-- migrate:up
CREATE TABLE pos.cash_movement_sync (
  id                   uuid PRIMARY KEY,
  device_id            uuid NOT NULL CONSTRAINT fk_cash_movement_sync_device REFERENCES pos.device_enrolment (id) ON DELETE RESTRICT,
  shift_id             uuid NOT NULL CONSTRAINT fk_cash_movement_sync_shift REFERENCES pos.shift (id) ON DELETE RESTRICT,
  branch_id            uuid NOT NULL CONSTRAINT fk_cash_movement_sync_branch REFERENCES mdm.branch (id) ON DELETE RESTRICT,
  client_movement_id   uuid NOT NULL,
  kind                 text NOT NULL CONSTRAINT ck_cash_movement_sync_kind CHECK (kind IN ('CASH_DROP', 'PAY_OUT', 'PAY_IN')),
  amount_pesewas       platform.pesewas NOT NULL,
  client_occurred_at   timestamptz NOT NULL,
  outcome              text NOT NULL CONSTRAINT ck_cash_movement_sync_outcome CHECK (outcome IN ('APPLIED', 'DUPLICATE', 'REJECTED')),
  reason               text NULL CONSTRAINT ck_cash_movement_sync_reason CHECK (reason ~ '^[A-Z][A-Z0-9_]{1,79}$'),
  cash_movement_id     uuid NULL CONSTRAINT fk_cash_movement_sync_movement REFERENCES pos.cash_movement (id) ON DELETE RESTRICT,
  answers_id           uuid NULL CONSTRAINT fk_cash_movement_sync_answers REFERENCES pos.cash_movement_sync (id) ON DELETE RESTRICT,
  clock_verdict        text NULL CONSTRAINT ck_cash_movement_sync_clock CHECK (clock_verdict IN ('AHEAD_OF_SERVER', 'BEFORE_SHIFT_OPENED')),
  received_at          timestamptz NOT NULL,
  recorded_at          timestamptz NOT NULL,
  actor_id             uuid NOT NULL CONSTRAINT fk_cash_movement_sync_actor REFERENCES iam.principal (id) ON DELETE RESTRICT,
  CONSTRAINT ck_cash_movement_sync_fields CHECK (
    (outcome = 'APPLIED' AND cash_movement_id IS NOT NULL AND reason IS NULL AND answers_id IS NULL)
    OR (outcome = 'DUPLICATE' AND cash_movement_id IS NOT NULL AND reason IS NULL)
    OR (outcome = 'REJECTED' AND cash_movement_id IS NULL AND reason IS NOT NULL))
);
COMMENT ON TABLE pos.cash_movement_sync IS 'class=LEDGER';
CREATE UNIQUE INDEX uq_cash_movement_sync_decided ON pos.cash_movement_sync (client_movement_id) WHERE outcome IN ('APPLIED', 'REJECTED') AND answers_id IS NULL;
CREATE INDEX ix_cash_movement_sync_shift ON pos.cash_movement_sync (shift_id, received_at);
CREATE INDEX ix_cash_movement_sync_client ON pos.cash_movement_sync (client_movement_id);
CREATE TRIGGER trg_cash_movement_sync_immutable BEFORE UPDATE OR DELETE ON pos.cash_movement_sync
  FOR EACH ROW EXECUTE FUNCTION platform.reject_change();
CREATE TRIGGER trg_cash_movement_sync_no_truncate BEFORE TRUNCATE ON pos.cash_movement_sync
  FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_change();

CREATE FUNCTION pos.cash_movement_sync_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pos.shift s JOIN pos.device_enrolment d ON d.register_id = s.register_id
                  WHERE s.id = NEW.shift_id AND d.id = NEW.device_id AND s.branch_id = NEW.branch_id) THEN
    RAISE EXCEPTION 'pos.cash_movement_sync %: shift % is not of the till device % is enrolled on', NEW.id, NEW.shift_id, NEW.device_id
      USING ERRCODE = 'HK010', CONSTRAINT = 'ck_cash_movement_sync_device_shift';
  END IF;
  IF NEW.outcome = 'APPLIED' AND NOT EXISTS (
       SELECT 1 FROM pos.cash_movement m
        WHERE m.id = NEW.cash_movement_id AND m.id = NEW.client_movement_id AND m.shift_id = NEW.shift_id
          AND m.kind = NEW.kind AND m.amount_pesewas = NEW.amount_pesewas) THEN
    RAISE EXCEPTION 'pos.cash_movement_sync %: an applied movement is its own, on the batch''s shift, of its kind and amount', NEW.id
      USING ERRCODE = 'HK010', CONSTRAINT = 'ck_cash_movement_sync_applied';
  END IF;
  IF NEW.outcome = 'DUPLICATE' AND NOT EXISTS (
       SELECT 1 FROM pos.cash_movement m
        WHERE m.id = NEW.cash_movement_id AND m.id = NEW.client_movement_id AND m.shift_id = NEW.shift_id
          AND m.kind = NEW.kind AND m.amount_pesewas = NEW.amount_pesewas) THEN
    RAISE EXCEPTION 'pos.cash_movement_sync %: a duplicate names the movement of the same id and content', NEW.id
      USING ERRCODE = 'HK010', CONSTRAINT = 'ck_cash_movement_sync_duplicate';
  END IF;
  IF NEW.answers_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM pos.cash_movement_sync a
        WHERE a.id = NEW.answers_id AND a.client_movement_id = NEW.client_movement_id AND a.answers_id IS NULL AND a.outcome IN ('APPLIED', 'REJECTED')) THEN
    RAISE EXCEPTION 'pos.cash_movement_sync %: a later submission answers the row that decided its movement', NEW.id
      USING ERRCODE = 'HK010', CONSTRAINT = 'ck_cash_movement_sync_answers';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION pos.cash_movement_sync_guard() FROM PUBLIC;
CREATE TRIGGER trg_cash_movement_sync_guard BEFORE INSERT ON pos.cash_movement_sync
  FOR EACH ROW EXECUTE FUNCTION pos.cash_movement_sync_guard();

REVOKE ALL ON pos.cash_movement_sync FROM PUBLIC;
GRANT SELECT, INSERT ON pos.cash_movement_sync TO hk_app, hk_worker;

-- migrate:down
DROP TABLE pos.cash_movement_sync;
DROP FUNCTION pos.cash_movement_sync_guard();
