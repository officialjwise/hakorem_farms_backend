-- 0002_iam_create_identity
-- The IAM schema: the principal every actor has, staff, customer and investor logins, TOTP, sessions, rotating
-- refresh tokens, one-time tokens and the permission catalogue (docs/data-model/iam.md, ADR-0016, ADR-0017).
-- Roles, grants and approvals follow in 0004 and 0006, once mdm.branch and platform.business_document exist.
-- Seeds the SYSTEM principals the workers act as, so every automated action has an actor.
-- Data category: CONFIDENTIAL (staff and customer login identifiers); RESTRICTED (TOTP secrets, encrypted).

-- migrate:up
CREATE SCHEMA iam AUTHORIZATION hk_owner;
REVOKE ALL ON SCHEMA iam FROM PUBLIC;
GRANT USAGE ON SCHEMA iam TO hk_app, hk_worker;

CREATE TABLE iam.principal (
  id            uuid PRIMARY KEY,
  kind          text NOT NULL CONSTRAINT ck_principal_kind CHECK (kind IN ('USER', 'API_KEY', 'SYSTEM')),
  display_name  text NOT NULL CONSTRAINT ck_principal_display_name CHECK (length(btrim(display_name)) BETWEEN 1 AND 120),
  status        text NOT NULL CONSTRAINT ck_principal_status CHECK (status IN ('ACTIVE', 'DISABLED')),
  version       integer NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    uuid NOT NULL,
  deleted_at    timestamptz NULL,
  deleted_by    uuid NULL,
  delete_reason text NULL,
  CONSTRAINT fk_principal_created_by FOREIGN KEY (created_by) REFERENCES iam.principal (id) ON DELETE RESTRICT,
  CONSTRAINT fk_principal_updated_by FOREIGN KEY (updated_by) REFERENCES iam.principal (id) ON DELETE RESTRICT,
  CONSTRAINT fk_principal_deleted_by FOREIGN KEY (deleted_by) REFERENCES iam.principal (id) ON DELETE RESTRICT,
  CONSTRAINT ck_principal_soft_delete CHECK ((deleted_at IS NULL) = (deleted_by IS NULL) AND (deleted_at IS NULL) = (delete_reason IS NULL))
);
COMMENT ON TABLE iam.principal IS 'class=MASTER';
CREATE TRIGGER trg_principal_version BEFORE UPDATE ON iam.principal
  FOR EACH ROW EXECUTE FUNCTION platform.touch_version();

-- The SYSTEM principals. Fixed ids so code and later migrations can name them; each created itself.
INSERT INTO iam.principal (id, kind, display_name, status, created_by, updated_by) VALUES
  ('01900000-0000-7000-8000-000000000001', 'SYSTEM', 'System', 'ACTIVE', '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001'),
  ('01900000-0000-7000-8000-000000000002', 'SYSTEM', 'Audit sealer', 'ACTIVE', '01900000-0000-7000-8000-000000000002', '01900000-0000-7000-8000-000000000002'),
  ('01900000-0000-7000-8000-000000000003', 'SYSTEM', 'Outbox dispatcher', 'ACTIVE', '01900000-0000-7000-8000-000000000003', '01900000-0000-7000-8000-000000000003'),
  ('01900000-0000-7000-8000-000000000004', 'SYSTEM', 'Scheduler', 'ACTIVE', '01900000-0000-7000-8000-000000000004', '01900000-0000-7000-8000-000000000004');

CREATE TABLE iam.user_account (
  principal_id         uuid PRIMARY KEY CONSTRAINT fk_user_account_principal REFERENCES iam.principal (id) ON DELETE RESTRICT,
  realm                text NOT NULL CONSTRAINT ck_user_account_realm CHECK (realm IN ('STAFF', 'CUSTOMER', 'INVESTOR')),
  email                text NULL CONSTRAINT ck_user_account_email CHECK (email = lower(email) AND email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  phone_e164           text NULL CONSTRAINT ck_user_account_phone CHECK (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  password_hash        text NULL CONSTRAINT ck_user_account_password_hash CHECK (password_hash LIKE '$argon2id$%'),
  password_changed_at  timestamptz NULL,
  must_change_password boolean NOT NULL DEFAULT false,
  totp_required        boolean NOT NULL DEFAULT false,
  failed_attempts      integer NOT NULL DEFAULT 0 CONSTRAINT ck_user_account_failed_attempts CHECK (failed_attempts >= 0),
  locked_until         timestamptz NULL,
  last_login_at        timestamptz NULL,
  version              integer NOT NULL DEFAULT 1,
  created_at           timestamptz NOT NULL DEFAULT now(),
  created_by           uuid NOT NULL CONSTRAINT fk_user_account_created_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  updated_by           uuid NOT NULL CONSTRAINT fk_user_account_updated_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  deleted_at           timestamptz NULL,
  deleted_by           uuid NULL CONSTRAINT fk_user_account_deleted_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  delete_reason        text NULL,
  CONSTRAINT ck_user_account_identifier CHECK (email IS NOT NULL OR phone_e164 IS NOT NULL),
  CONSTRAINT ck_user_account_soft_delete CHECK ((deleted_at IS NULL) = (deleted_by IS NULL) AND (deleted_at IS NULL) = (delete_reason IS NULL))
);
COMMENT ON TABLE iam.user_account IS 'class=MASTER';
CREATE UNIQUE INDEX uq_user_account_realm_email ON iam.user_account (realm, email) WHERE deleted_at IS NULL AND email IS NOT NULL;
CREATE UNIQUE INDEX uq_user_account_realm_phone ON iam.user_account (realm, phone_e164) WHERE deleted_at IS NULL AND phone_e164 IS NOT NULL;
CREATE TRIGGER trg_user_account_version BEFORE UPDATE ON iam.user_account
  FOR EACH ROW EXECUTE FUNCTION platform.touch_version();

CREATE TABLE iam.totp_credential (
  principal_id   uuid PRIMARY KEY CONSTRAINT fk_totp_credential_principal REFERENCES iam.principal (id) ON DELETE RESTRICT,
  secret_enc     bytea NOT NULL,
  confirmed_at   timestamptz NULL,
  last_used_step bigint NULL CONSTRAINT ck_totp_credential_step CHECK (last_used_step >= 0),
  version        integer NOT NULL DEFAULT 1,
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid NOT NULL CONSTRAINT fk_totp_credential_created_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     uuid NOT NULL CONSTRAINT fk_totp_credential_updated_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  deleted_at     timestamptz NULL,
  deleted_by     uuid NULL CONSTRAINT fk_totp_credential_deleted_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  delete_reason  text NULL,
  CONSTRAINT ck_totp_credential_soft_delete CHECK ((deleted_at IS NULL) = (deleted_by IS NULL) AND (deleted_at IS NULL) = (delete_reason IS NULL))
);
COMMENT ON TABLE iam.totp_credential IS 'class=MASTER';
CREATE TRIGGER trg_totp_credential_version BEFORE UPDATE ON iam.totp_credential
  FOR EACH ROW EXECUTE FUNCTION platform.touch_version();

CREATE TABLE iam.recovery_code (
  id           uuid PRIMARY KEY,
  principal_id uuid NOT NULL CONSTRAINT fk_recovery_code_principal REFERENCES iam.principal (id) ON DELETE RESTRICT,
  code_hash    bytea NOT NULL CONSTRAINT ck_recovery_code_hash CHECK (length(code_hash) = 32),
  used_at      timestamptz NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE iam.recovery_code IS 'class=WORK';
CREATE INDEX ix_recovery_code_principal ON iam.recovery_code (principal_id) WHERE used_at IS NULL;

-- One row per login: the device list. Never deleted; revocation sets revoked_at.
CREATE TABLE iam.session (
  id                  uuid PRIMARY KEY,
  principal_id        uuid NOT NULL CONSTRAINT fk_session_principal REFERENCES iam.principal (id) ON DELETE RESTRICT,
  realm               text NOT NULL CONSTRAINT ck_session_realm CHECK (realm IN ('STAFF', 'CUSTOMER', 'INVESTOR')),
  device_label        text NULL CONSTRAINT ck_session_device_label CHECK (length(device_label) <= 80),
  user_agent          text NULL,
  ip_created          inet NULL,
  csrf_token_hash     bytea NOT NULL CONSTRAINT ck_session_csrf_hash CHECK (length(csrf_token_hash) = 32),
  created_at          timestamptz NOT NULL DEFAULT now(),
  last_seen_at        timestamptz NOT NULL,
  idle_expires_at     timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  stepped_up_at       timestamptz NULL,
  revoked_at          timestamptz NULL,
  revoked_by          uuid NULL CONSTRAINT fk_session_revoked_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  revoke_reason       text NULL,
  CONSTRAINT ck_session_expiry CHECK (idle_expires_at <= absolute_expires_at),
  CONSTRAINT ck_session_revocation CHECK ((revoked_at IS NULL) = (revoke_reason IS NULL))
);
COMMENT ON TABLE iam.session IS 'class=DOCUMENT';
CREATE INDEX ix_session_principal_live ON iam.session (principal_id) WHERE revoked_at IS NULL;
-- A revoked session stays revoked: nothing about it may change afterwards.
CREATE FUNCTION iam.session_stays_revoked() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'iam.session %: a revoked session cannot change', OLD.id USING ERRCODE = 'HK003';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION iam.session_stays_revoked() FROM PUBLIC;
CREATE TRIGGER trg_session_stays_revoked BEFORE UPDATE ON iam.session
  FOR EACH ROW EXECUTE FUNCTION iam.session_stays_revoked();

CREATE TABLE iam.refresh_token (
  id             uuid PRIMARY KEY,
  session_id     uuid NOT NULL CONSTRAINT fk_refresh_token_session REFERENCES iam.session (id) ON DELETE RESTRICT,
  token_hash     bytea NOT NULL CONSTRAINT uq_refresh_token_hash UNIQUE CONSTRAINT ck_refresh_token_hash CHECK (length(token_hash) = 32),
  issued_at      timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  used_at        timestamptz NULL,
  replaced_by_id uuid NULL CONSTRAINT fk_refresh_token_replaced_by REFERENCES iam.refresh_token (id) ON DELETE RESTRICT,
  CONSTRAINT ck_refresh_token_rotation CHECK (replaced_by_id IS NULL OR used_at IS NOT NULL)
);
COMMENT ON TABLE iam.refresh_token IS 'class=WORK';
CREATE INDEX ix_refresh_token_session ON iam.refresh_token (session_id);

-- One-time tokens: password reset, verification codes and the challenge between login steps (LOGIN_*).
CREATE TABLE iam.verification_token (
  id           uuid PRIMARY KEY,
  principal_id uuid NOT NULL CONSTRAINT fk_verification_token_principal REFERENCES iam.principal (id) ON DELETE RESTRICT,
  purpose      text NOT NULL CONSTRAINT ck_verification_token_purpose CHECK (purpose IN (
                 'PASSWORD_RESET', 'PHONE_VERIFY', 'EMAIL_VERIFY', 'LOGIN_CODE',
                 'LOGIN_TOTP', 'LOGIN_TOTP_ENROLMENT', 'LOGIN_PASSWORD_CHANGE')),
  token_hash   bytea NOT NULL CONSTRAINT uq_verification_token_hash UNIQUE CONSTRAINT ck_verification_token_hash CHECK (length(token_hash) = 32),
  device_label text NULL CONSTRAINT ck_verification_token_device_label CHECK (length(device_label) <= 80),
  expires_at   timestamptz NOT NULL,
  attempts     integer NOT NULL DEFAULT 0 CONSTRAINT ck_verification_token_attempts CHECK (attempts >= 0),
  consumed_at  timestamptz NULL
);
COMMENT ON TABLE iam.verification_token IS 'class=WORK';
CREATE INDEX ix_verification_token_expires ON iam.verification_token (expires_at);

-- The fixed list of permission codes. Changed only by migration; a new code is granted to no role.
CREATE TABLE iam.permission (
  code             text PRIMARY KEY CONSTRAINT ck_permission_code CHECK (code ~ '^[a-z]+\.[a-z_]+\.[a-z_.]+$'),
  module           text NOT NULL CONSTRAINT ck_permission_module CHECK (code LIKE module || '.%'),
  description      text NOT NULL,
  requires_step_up boolean NOT NULL DEFAULT false
);
COMMENT ON TABLE iam.permission IS 'class=LOOKUP';

REVOKE ALL ON ALL TABLES IN SCHEMA iam FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON iam.principal, iam.user_account, iam.totp_credential, iam.session TO hk_app, hk_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON iam.recovery_code, iam.refresh_token, iam.verification_token TO hk_app, hk_worker;
GRANT SELECT ON iam.permission TO hk_app, hk_worker;

-- migrate:down
DROP TABLE iam.permission;
DROP TABLE iam.verification_token;
DROP TABLE iam.refresh_token;
DROP TABLE iam.session;
DROP FUNCTION iam.session_stays_revoked();
DROP TABLE iam.recovery_code;
DROP TABLE iam.totp_credential;
DROP TABLE iam.user_account;
DROP TABLE iam.principal;
DROP SCHEMA iam;
