-- 0235_pos_device_enrolment
-- B09b continued (FR-POS-010, ADR-0016, A-274): a device allowed to run a till. A manager enrols it and its credential
-- (`hkdev_<till>.<43 base64url characters>`, 256 random bits) is shown once and stored only as its SHA-256 hash, unique;
-- a lost device is revoked by someone with the reason, and a revoked device never comes back (it is enrolled again as a
-- new device). Who enrolled and revoked it, when, and its label never change; only the last sync time moves.
-- Data category: RESTRICTED for credential_hash (a credential's digest, never returned); internal otherwise.
-- Rollback: tested (`pnpm db:rollback`), safe before the first enrolment; afterwards forward fix only (a revoked
-- device's record is the evidence a stolen tablet is refused).

-- migrate:up
CREATE TABLE pos.device_enrolment (
  id              uuid PRIMARY KEY,
  register_id     uuid NOT NULL CONSTRAINT fk_device_enrolment_register REFERENCES pos.register (id) ON DELETE RESTRICT,
  device_label    text NOT NULL CONSTRAINT ck_device_enrolment_label CHECK (length(btrim(device_label)) BETWEEN 1 AND 80),
  credential_hash bytea NOT NULL CONSTRAINT ck_device_enrolment_hash CHECK (length(credential_hash) = 32),
  enrolled_by     uuid NOT NULL CONSTRAINT fk_device_enrolment_enrolled_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  enrolled_at     timestamptz NOT NULL,
  last_sync_at    timestamptz NULL,
  revoked_at      timestamptz NULL,
  revoked_by      uuid NULL CONSTRAINT fk_device_enrolment_revoked_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  revoke_reason   text NULL CONSTRAINT ck_device_enrolment_revoke_reason CHECK (length(btrim(revoke_reason)) BETWEEN 1 AND 500),
  branch_id       uuid NOT NULL CONSTRAINT fk_device_enrolment_branch REFERENCES mdm.branch (id) ON DELETE RESTRICT,
  version         integer NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL,
  created_by      uuid NOT NULL CONSTRAINT fk_device_enrolment_created_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  updated_at      timestamptz NOT NULL,
  updated_by      uuid NOT NULL CONSTRAINT fk_device_enrolment_updated_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  deleted_at      timestamptz NULL,
  deleted_by      uuid NULL CONSTRAINT fk_device_enrolment_deleted_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  delete_reason   text NULL,
  CONSTRAINT uq_device_enrolment_credential UNIQUE (credential_hash),
  CONSTRAINT ck_device_enrolment_revoked CHECK ((revoked_at IS NULL) = (revoked_by IS NULL) AND (revoked_at IS NULL) = (revoke_reason IS NULL)),
  CONSTRAINT ck_device_enrolment_soft_delete CHECK ((deleted_at IS NULL) = (deleted_by IS NULL) AND (deleted_at IS NULL) = (delete_reason IS NULL))
);
COMMENT ON TABLE pos.device_enrolment IS 'class=MASTER';
CREATE INDEX ix_device_enrolment_register ON pos.device_enrolment (register_id, id);
CREATE TRIGGER trg_device_enrolment_version BEFORE UPDATE ON pos.device_enrolment
  FOR EACH ROW EXECUTE FUNCTION platform.touch_version();

-- What a device was enrolled as never changes; a revoked device stays revoked.
CREATE FUNCTION pos.device_enrolment_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.revoked_at IS NOT NULL OR NEW.last_sync_at IS NOT NULL THEN
      RAISE EXCEPTION 'pos.device_enrolment: a device is enrolled live, never synced' USING ERRCODE = 'HK010', CONSTRAINT = 'ck_device_enrolment_revoked';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW.register_id, NEW.device_label, NEW.credential_hash, NEW.enrolled_by, NEW.enrolled_at, NEW.branch_id, NEW.created_at, NEW.created_by)
     IS DISTINCT FROM (OLD.id, OLD.register_id, OLD.device_label, OLD.credential_hash, OLD.enrolled_by, OLD.enrolled_at, OLD.branch_id, OLD.created_at, OLD.created_by) THEN
    RAISE EXCEPTION 'pos.device_enrolment %: what a device was enrolled as never changes', OLD.id USING ERRCODE = 'HK004';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND (NEW.revoked_at, NEW.revoked_by, NEW.revoke_reason, NEW.last_sync_at) IS DISTINCT FROM (OLD.revoked_at, OLD.revoked_by, OLD.revoke_reason, OLD.last_sync_at) THEN
    RAISE EXCEPTION 'pos.device_enrolment %: a revoked device stays revoked and syncs nothing', OLD.id USING ERRCODE = 'HK004';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION pos.device_enrolment_guard() FROM PUBLIC;
CREATE TRIGGER trg_device_enrolment_guard BEFORE INSERT OR UPDATE ON pos.device_enrolment
  FOR EACH ROW EXECUTE FUNCTION pos.device_enrolment_guard();

REVOKE ALL ON pos.device_enrolment FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON pos.device_enrolment TO hk_app, hk_worker;

-- migrate:down
DROP TABLE pos.device_enrolment;
DROP FUNCTION pos.device_enrolment_guard();
