-- 0270_pos_till_pin
-- B09b continued 3 (FR-POS-010, CR-032, CR-050, ADR-0080, A-280, abuse cases 4, 17 and 35): the till PIN. The till derives
-- a verifier from the PIN typed into it and sends only the verifier; the server never sees, stores or checks a PIN.
--   pos.till_pin           LEDGER (insert only): each verifier a person set, by version: PBKDF2-SHA256 only, 600,000 to
--                   10,000,000 iterations, a salt of 16 to 64 bytes never used twice, a 32-byte hash; set by its owner
--                   only (ck_till_pin_own); each version the next (ck_till_pin_version). A newer version replaces it.
--   pos.till_pin_event     LEDGER (insert only): each PIN try a till reports, exactly once by its client id (the
--                   primary key): whose PIN, the version tried, FAILED or SUCCEEDED, what for, the till's time. Five
--                   FAILED tries against a version lock it (pos.till_pin_wrong_tries).
--   pos.till_sign_out      LEDGER (insert only): a locked cashier signed out of a till by a supervisor's PIN, exactly
--                   once by its client id; never by the cashier (ck_till_sign_out_checker); only a supervisor of the
--                   branch (ck_till_sign_out_supervisor), only once the cashier's PIN is locked (ck_till_sign_out_locked),
--                   with the supervisor's PIN in force and not locked (ck_till_sign_out_supervisor_pin).
--   pos.cash_movement.witness_pin_version   a drop's witness confirmed with their PIN on the till (the owner on
--                   2026-11-18): from now a witnessed drop names the witness's PIN version, in force and not locked when
--                   the drop was made (ck_cash_movement_witness_pin_required, ck_cash_movement_witness_pin_in_force);
--                   rows recorded before keep a null version.
-- Every time is written by the application from its clock or the till's (ADR-0067); nothing here reads now().
-- Additions to docs/data-model/pos.md: the tables and the column above, as built.
-- Data category: RESTRICTED for the verifier (DC-43, a verifier: never logged, never returned but to an enrolled till
-- of the person's branch); CONFIDENTIAL for the tries and sign-outs (DC-27, device and session facts).
-- Rollback: tested (`pnpm db:rollback`) before the first PIN is set; afterwards the tries are evidence and only a
-- forward fix is safe.

-- migrate:up
CREATE TABLE pos.till_pin (
  id            uuid PRIMARY KEY,
  principal_id  uuid NOT NULL CONSTRAINT fk_till_pin_principal REFERENCES iam.principal (id) ON DELETE RESTRICT,
  version       integer NOT NULL CONSTRAINT ck_till_pin_version_positive CHECK (version > 0),
  algorithm     text NOT NULL CONSTRAINT ck_till_pin_algorithm CHECK (algorithm = 'PBKDF2-SHA256'),
  iterations    integer NOT NULL CONSTRAINT ck_till_pin_iterations CHECK (iterations BETWEEN 600000 AND 10000000),
  salt          bytea NOT NULL CONSTRAINT ck_till_pin_salt CHECK (octet_length(salt) BETWEEN 16 AND 64),
  hash          bytea NOT NULL CONSTRAINT ck_till_pin_hash CHECK (octet_length(hash) = 32),
  set_at        timestamptz NOT NULL,
  recorded_at   timestamptz NOT NULL,
  actor_id      uuid NOT NULL CONSTRAINT fk_till_pin_actor REFERENCES iam.principal (id) ON DELETE RESTRICT,
  CONSTRAINT uq_till_pin_version UNIQUE (principal_id, version),
  CONSTRAINT uq_till_pin_salt UNIQUE (salt),
  CONSTRAINT ck_till_pin_own CHECK (actor_id = principal_id)
);
COMMENT ON TABLE pos.till_pin IS 'class=LEDGER';
CREATE TRIGGER trg_till_pin_immutable BEFORE UPDATE OR DELETE ON pos.till_pin
  FOR EACH ROW EXECUTE FUNCTION platform.reject_change();
CREATE TRIGGER trg_till_pin_no_truncate BEFORE TRUNCATE ON pos.till_pin
  FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_change();

CREATE FUNCTION pos.till_pin_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.version <> 1 + COALESCE((SELECT max(p.version) FROM pos.till_pin p WHERE p.principal_id = NEW.principal_id), 0) THEN
    RAISE EXCEPTION 'pos.till_pin: version % is not the next of principal %', NEW.version, NEW.principal_id
      USING ERRCODE = 'HK010', CONSTRAINT = 'ck_till_pin_version';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION pos.till_pin_guard() FROM PUBLIC;
CREATE TRIGGER trg_till_pin_guard BEFORE INSERT ON pos.till_pin
  FOR EACH ROW EXECUTE FUNCTION pos.till_pin_guard();

CREATE TABLE pos.till_pin_event (
  id            uuid PRIMARY KEY,
  register_id   uuid NOT NULL CONSTRAINT fk_till_pin_event_register REFERENCES pos.register (id) ON DELETE RESTRICT,
  device_id     uuid NOT NULL CONSTRAINT fk_till_pin_event_device REFERENCES pos.device_enrolment (id) ON DELETE RESTRICT,
  branch_id     uuid NOT NULL CONSTRAINT fk_till_pin_event_branch REFERENCES mdm.branch (id) ON DELETE RESTRICT,
  principal_id  uuid NOT NULL,
  pin_version   integer NOT NULL,
  outcome       text NOT NULL CONSTRAINT ck_till_pin_event_outcome CHECK (outcome IN ('FAILED', 'SUCCEEDED')),
  purpose       text NOT NULL CONSTRAINT ck_till_pin_event_purpose CHECK (purpose IN ('UNLOCK', 'APPROVAL', 'WITNESS', 'SIGN_OUT')),
  occurred_at   timestamptz NOT NULL,
  received_at   timestamptz NOT NULL,
  recorded_at   timestamptz NOT NULL,
  actor_id      uuid NOT NULL CONSTRAINT fk_till_pin_event_actor REFERENCES iam.principal (id) ON DELETE RESTRICT,
  CONSTRAINT fk_till_pin_event_pin FOREIGN KEY (principal_id, pin_version) REFERENCES pos.till_pin (principal_id, version) ON DELETE RESTRICT
);
COMMENT ON TABLE pos.till_pin_event IS 'class=LEDGER';
CREATE INDEX ix_till_pin_event_pin ON pos.till_pin_event (principal_id, pin_version, occurred_at) WHERE outcome = 'FAILED';
CREATE TRIGGER trg_till_pin_event_immutable BEFORE UPDATE OR DELETE ON pos.till_pin_event
  FOR EACH ROW EXECUTE FUNCTION platform.reject_change();
CREATE TRIGGER trg_till_pin_event_no_truncate BEFORE TRUNCATE ON pos.till_pin_event
  FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_change();

CREATE FUNCTION pos.till_device_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pos.device_enrolment d JOIN pos.register r ON r.id = d.register_id
                  WHERE d.id = NEW.device_id AND r.id = NEW.register_id AND r.branch_id = NEW.branch_id) THEN
    RAISE EXCEPTION '%: device % is not enrolled on till % of branch %', TG_TABLE_NAME, NEW.device_id, NEW.register_id, NEW.branch_id
      USING ERRCODE = 'HK010', CONSTRAINT = 'ck_' || TG_TABLE_NAME || '_device';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION pos.till_device_guard() FROM PUBLIC;
CREATE TRIGGER trg_till_pin_event_device BEFORE INSERT ON pos.till_pin_event
  FOR EACH ROW EXECUTE FUNCTION pos.till_device_guard();

-- The wrong tries counted against a PIN version made at or before a moment, by the till's time (A-280 (c)).
CREATE FUNCTION pos.till_pin_wrong_tries(p_principal uuid, p_version integer, p_at timestamptz) RETURNS bigint
  LANGUAGE sql STABLE
  SET search_path = pg_catalog
AS $$
  SELECT count(*) FROM pos.till_pin_event e
   WHERE e.principal_id = p_principal AND e.pin_version = p_version AND e.outcome = 'FAILED' AND e.occurred_at <= p_at
$$;
REVOKE ALL ON FUNCTION pos.till_pin_wrong_tries(uuid, integer, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pos.till_pin_wrong_tries(uuid, integer, timestamptz) TO hk_app, hk_worker;

-- A PIN version in force and not locked at a moment: no newer version set by then, fewer than five wrong tries by then.
CREATE FUNCTION pos.till_pin_in_force(p_principal uuid, p_version integer, p_at timestamptz) RETURNS boolean
  LANGUAGE sql STABLE
  SET search_path = pg_catalog
AS $$
  SELECT EXISTS (SELECT 1 FROM pos.till_pin p WHERE p.principal_id = p_principal AND p.version = p_version)
     AND NOT EXISTS (SELECT 1 FROM pos.till_pin n WHERE n.principal_id = p_principal AND n.version > p_version AND n.set_at <= p_at)
     AND pos.till_pin_wrong_tries(p_principal, p_version, p_at) < 5
$$;
REVOKE ALL ON FUNCTION pos.till_pin_in_force(uuid, integer, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pos.till_pin_in_force(uuid, integer, timestamptz) TO hk_app, hk_worker;

CREATE TABLE pos.till_sign_out (
  id                      uuid PRIMARY KEY,
  register_id             uuid NOT NULL CONSTRAINT fk_till_sign_out_register REFERENCES pos.register (id) ON DELETE RESTRICT,
  device_id               uuid NOT NULL CONSTRAINT fk_till_sign_out_device REFERENCES pos.device_enrolment (id) ON DELETE RESTRICT,
  branch_id               uuid NOT NULL CONSTRAINT fk_till_sign_out_branch REFERENCES mdm.branch (id) ON DELETE RESTRICT,
  shift_id                uuid NULL CONSTRAINT fk_till_sign_out_shift REFERENCES pos.shift (id) ON DELETE RESTRICT,
  cashier_id              uuid NOT NULL CONSTRAINT fk_till_sign_out_cashier REFERENCES iam.principal (id) ON DELETE RESTRICT,
  supervisor_id           uuid NOT NULL,
  supervisor_pin_version  integer NOT NULL,
  occurred_at             timestamptz NOT NULL,
  received_at             timestamptz NOT NULL,
  recorded_at             timestamptz NOT NULL,
  actor_id                uuid NOT NULL CONSTRAINT fk_till_sign_out_actor REFERENCES iam.principal (id) ON DELETE RESTRICT,
  CONSTRAINT fk_till_sign_out_supervisor_pin FOREIGN KEY (supervisor_id, supervisor_pin_version) REFERENCES pos.till_pin (principal_id, version) ON DELETE RESTRICT,
  CONSTRAINT ck_till_sign_out_checker CHECK (supervisor_id <> cashier_id)
);
COMMENT ON TABLE pos.till_sign_out IS 'class=LEDGER';
CREATE INDEX ix_till_sign_out_branch ON pos.till_sign_out (branch_id, occurred_at);
CREATE TRIGGER trg_till_sign_out_immutable BEFORE UPDATE OR DELETE ON pos.till_sign_out
  FOR EACH ROW EXECUTE FUNCTION platform.reject_change();
CREATE TRIGGER trg_till_sign_out_no_truncate BEFORE TRUNCATE ON pos.till_sign_out
  FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_change();
CREATE TRIGGER trg_till_sign_out_device BEFORE INSERT ON pos.till_sign_out
  FOR EACH ROW EXECUTE FUNCTION pos.till_device_guard();

CREATE FUNCTION pos.till_sign_out_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  latest integer;
BEGIN
  IF NEW.supervisor_id = NEW.cashier_id THEN
    RAISE EXCEPTION 'pos.till_sign_out %: a cashier never signs themselves out', NEW.id
      USING ERRCODE = 'HK010', CONSTRAINT = 'ck_till_sign_out_checker';
  END IF;
  IF NOT iam.holds_permission_at(NEW.supervisor_id, 'pos.shift.close.approve', NEW.branch_id) THEN
    RAISE EXCEPTION 'pos.till_sign_out %: % is not a supervisor at branch %', NEW.id, NEW.supervisor_id, NEW.branch_id
      USING ERRCODE = 'HK010', CONSTRAINT = 'ck_till_sign_out_supervisor';
  END IF;
  SELECT max(p.version) INTO latest FROM pos.till_pin p WHERE p.principal_id = NEW.cashier_id;
  IF latest IS NULL OR pos.till_pin_wrong_tries(NEW.cashier_id, latest, 'infinity') < 5 THEN
    RAISE EXCEPTION 'pos.till_sign_out %: the PIN of cashier % is not locked', NEW.id, NEW.cashier_id
      USING ERRCODE = 'HK010', CONSTRAINT = 'ck_till_sign_out_locked';
  END IF;
  IF NOT pos.till_pin_in_force(NEW.supervisor_id, NEW.supervisor_pin_version, NEW.occurred_at) THEN
    RAISE EXCEPTION 'pos.till_sign_out %: PIN version % of supervisor % was replaced or locked by %', NEW.id, NEW.supervisor_pin_version, NEW.supervisor_id, NEW.occurred_at
      USING ERRCODE = 'HK010', CONSTRAINT = 'ck_till_sign_out_supervisor_pin';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION pos.till_sign_out_guard() FROM PUBLIC;
CREATE TRIGGER trg_till_sign_out_guard BEFORE INSERT ON pos.till_sign_out
  FOR EACH ROW EXECUTE FUNCTION pos.till_sign_out_guard();

ALTER TABLE pos.cash_movement
  ADD COLUMN witness_pin_version integer NULL,
  ADD CONSTRAINT fk_cash_movement_witness_pin FOREIGN KEY (witness_id, witness_pin_version) REFERENCES pos.till_pin (principal_id, version) ON DELETE RESTRICT,
  ADD CONSTRAINT ck_cash_movement_witness_pin CHECK (witness_pin_version IS NULL OR witness_id IS NOT NULL);

-- From this migration a witnessed drop is witnessed by a PIN (the owner on 2026-11-18): the witness's version, in force
-- and not locked when the drop was made. A drop recorded before keeps its null version; the column only grows.
CREATE FUNCTION pos.cash_movement_witness_pin_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  -- Only a witnessed drop; a row breaking ck_cash_movement_witness is left to that check.
  IF NEW.witness_id IS NULL OR NEW.unwitnessed OR NEW.kind <> 'CASH_DROP' THEN
    RETURN NEW;
  END IF;
  IF NEW.witness_pin_version IS NULL THEN
    RAISE EXCEPTION 'pos.cash_movement %: the witness % confirms the drop with their PIN; a name alone is no witness', NEW.id, NEW.witness_id
      USING ERRCODE = 'HK010', CONSTRAINT = 'ck_cash_movement_witness_pin_required';
  END IF;
  IF NOT pos.till_pin_in_force(NEW.witness_id, NEW.witness_pin_version, NEW.occurred_at) THEN
    RAISE EXCEPTION 'pos.cash_movement %: PIN version % of witness % was replaced or locked by %', NEW.id, NEW.witness_pin_version, NEW.witness_id, NEW.occurred_at
      USING ERRCODE = 'HK010', CONSTRAINT = 'ck_cash_movement_witness_pin_in_force';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION pos.cash_movement_witness_pin_guard() FROM PUBLIC;
CREATE TRIGGER trg_cash_movement_witness_pin BEFORE INSERT ON pos.cash_movement
  FOR EACH ROW EXECUTE FUNCTION pos.cash_movement_witness_pin_guard();

REVOKE ALL ON pos.till_pin, pos.till_pin_event, pos.till_sign_out FROM PUBLIC;
GRANT SELECT, INSERT ON pos.till_pin, pos.till_pin_event, pos.till_sign_out TO hk_app, hk_worker;

-- migrate:down
DROP TRIGGER trg_cash_movement_witness_pin ON pos.cash_movement;
DROP FUNCTION pos.cash_movement_witness_pin_guard();
ALTER TABLE pos.cash_movement DROP CONSTRAINT ck_cash_movement_witness_pin, DROP CONSTRAINT fk_cash_movement_witness_pin, DROP COLUMN witness_pin_version;
DROP TABLE pos.till_sign_out;
DROP FUNCTION pos.till_sign_out_guard();
DROP TABLE pos.till_pin_event;
DROP FUNCTION pos.till_pin_in_force(uuid, integer, timestamptz);
DROP FUNCTION pos.till_pin_wrong_tries(uuid, integer, timestamptz);
DROP FUNCTION pos.till_device_guard();
DROP TABLE pos.till_pin;
DROP FUNCTION pos.till_pin_guard();
