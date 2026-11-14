-- 0005_platform_create_mechanisms
-- The platform mechanisms B3 builds (docs/data-model/platform.md): the document freeze function, the document
-- registry, idempotency keys (ADR-0014), the outbox, its deliveries and the inbox (ADR-0010), typed settings,
-- per-subject encryption keys (ADR-0022), the audit trail with its hash chain and anchors (ADR-0006), and job runs.
-- The chain and anchor tables are written only by the sealer: hk_app and hk_worker may read them and nothing else,
-- declared as writer=hk_sealer in the class comment and checked by scripts/check/database-rules.ts.
-- Data category: CONFIDENTIAL (audit events hold IP addresses, user agents and encrypted personal data);
-- RESTRICTED (wrapped subject keys).

-- migrate:up

-- Generic document freeze (ADR-0012). TG_ARGV[0] is a comma-separated list of posted statuses; the remaining
-- arguments are the columns that may still change once a row is posted. SQLSTATE HK004.
CREATE FUNCTION platform.freeze_posted() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  posted text[] := string_to_array(TG_ARGV[0], ',');
  allowed text[] := TG_ARGV[1:TG_NARGS - 1];
BEGIN
  IF OLD.status = ANY (posted) AND (to_jsonb(NEW) - allowed) IS DISTINCT FROM (to_jsonb(OLD) - allowed) THEN
    RAISE EXCEPTION '%.% is frozen in status %', TG_TABLE_SCHEMA, TG_TABLE_NAME, OLD.status USING ERRCODE = 'HK004';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION platform.freeze_posted() FROM PUBLIC;

-- Document registry (ADR-0011).
CREATE TABLE platform.document_type (
  code          text PRIMARY KEY CONSTRAINT ck_document_type_code CHECK (code ~ '^[A-Z][A-Z_]{2,39}$'),
  owner_module  text NOT NULL CONSTRAINT ck_document_type_owner CHECK (owner_module ~ '^[a-z]{3}$'),
  name          text NOT NULL,
  is_numbered   boolean NOT NULL,
  series_prefix text NULL,
  CONSTRAINT ck_document_type_prefix CHECK (NOT is_numbered OR series_prefix IS NOT NULL)
);
COMMENT ON TABLE platform.document_type IS 'class=LOOKUP';

CREATE TABLE platform.business_document (
  id           uuid PRIMARY KEY,
  doc_type     text NOT NULL CONSTRAINT fk_business_document_type REFERENCES platform.document_type (code) ON DELETE RESTRICT,
  owner_module text NOT NULL,
  branch_id    uuid NOT NULL CONSTRAINT fk_business_document_branch REFERENCES mdm.branch (id) ON DELETE RESTRICT,
  created_at   timestamptz NOT NULL DEFAULT now(),
  actor_id     uuid NOT NULL CONSTRAINT fk_business_document_actor REFERENCES iam.principal (id) ON DELETE RESTRICT
);
COMMENT ON TABLE platform.business_document IS 'class=LEDGER';
CREATE TRIGGER trg_business_document_immutable BEFORE UPDATE OR DELETE ON platform.business_document
  FOR EACH ROW EXECUTE FUNCTION platform.reject_change();
CREATE TRIGGER trg_business_document_no_truncate BEFORE TRUNCATE ON platform.business_document
  FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_change();

-- Idempotency (ADR-0014): the first write of every state-changing request.
CREATE TABLE platform.idempotency_key (
  id              uuid PRIMARY KEY,
  scope           text NOT NULL,
  key             text NOT NULL CONSTRAINT ck_idempotency_key_key CHECK (length(key) BETWEEN 1 AND 64),
  principal_id    uuid NOT NULL CONSTRAINT fk_idempotency_key_principal REFERENCES iam.principal (id) ON DELETE RESTRICT,
  request_hash    bytea NOT NULL CONSTRAINT ck_idempotency_key_hash CHECK (length(request_hash) = 32),
  status          text NOT NULL CONSTRAINT ck_idempotency_key_status CHECK (status IN ('IN_PROGRESS', 'COMPLETED')),
  response_status integer NULL CONSTRAINT ck_idempotency_key_response_status CHECK (response_status BETWEEN 200 AND 299),
  response_body   jsonb NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  CONSTRAINT uq_idempotency_key_scope_key UNIQUE (scope, key),
  CONSTRAINT ck_idempotency_key_expiry CHECK (expires_at >= created_at + interval '72 hours'),
  CONSTRAINT ck_idempotency_key_completed CHECK ((status = 'COMPLETED') = (response_status IS NOT NULL))
);
COMMENT ON TABLE platform.idempotency_key IS 'class=WORK';
CREATE INDEX ix_idempotency_key_expires ON platform.idempotency_key (expires_at);

-- Outbox (ADR-0010).
CREATE TABLE platform.outbox_message (
  id             uuid PRIMARY KEY,
  event_type     text NOT NULL CONSTRAINT ck_outbox_message_type CHECK (event_type ~ '^[a-z]{3,8}\.[A-Z][A-Za-z]+$'),
  event_version  integer NOT NULL DEFAULT 1 CONSTRAINT ck_outbox_message_version CHECK (event_version > 0),
  subject_type   text NOT NULL,
  subject_id     uuid NOT NULL,
  branch_id      uuid NULL CONSTRAINT fk_outbox_message_branch REFERENCES mdm.branch (id) ON DELETE RESTRICT,
  actor_id       uuid NOT NULL CONSTRAINT fk_outbox_message_actor REFERENCES iam.principal (id) ON DELETE RESTRICT,
  correlation_id uuid NOT NULL,
  causation_id   uuid NULL,
  payload        jsonb NOT NULL,
  occurred_at    timestamptz NOT NULL,
  recorded_at    timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE platform.outbox_message IS 'class=LEDGER';
CREATE INDEX ix_outbox_message_subject ON platform.outbox_message (subject_id, id);
CREATE TRIGGER trg_outbox_message_immutable BEFORE UPDATE OR DELETE ON platform.outbox_message
  FOR EACH ROW EXECUTE FUNCTION platform.reject_change();
CREATE TRIGGER trg_outbox_message_no_truncate BEFORE TRUNCATE ON platform.outbox_message
  FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_change();

CREATE TABLE platform.outbox_delivery (
  message_id      uuid NOT NULL CONSTRAINT fk_outbox_delivery_message REFERENCES platform.outbox_message (id) ON DELETE RESTRICT,
  consumer        text NOT NULL CONSTRAINT ck_outbox_delivery_consumer CHECK (consumer ~ '^[a-z]{3,8}\.[a-z][a-z0-9-]+$'),
  subject_id      uuid NOT NULL,
  status          text NOT NULL CONSTRAINT ck_outbox_delivery_status CHECK (status IN ('PENDING', 'DELIVERED', 'FAILED', 'DEAD')),
  attempts        integer NOT NULL DEFAULT 0 CONSTRAINT ck_outbox_delivery_attempts CHECK (attempts >= 0),
  next_attempt_at timestamptz NULL,
  last_error      text NULL CONSTRAINT ck_outbox_delivery_error CHECK (length(last_error) <= 500),
  delivered_at    timestamptz NULL,
  CONSTRAINT pk_outbox_delivery PRIMARY KEY (message_id, consumer),
  CONSTRAINT ck_outbox_delivery_due CHECK ((status IN ('PENDING', 'FAILED')) = (next_attempt_at IS NOT NULL)),
  CONSTRAINT ck_outbox_delivery_delivered CHECK ((status = 'DELIVERED') = (delivered_at IS NOT NULL))
);
COMMENT ON TABLE platform.outbox_delivery IS 'class=WORK';
CREATE INDEX ix_outbox_delivery_due ON platform.outbox_delivery (next_attempt_at) WHERE status IN ('PENDING', 'FAILED');
CREATE INDEX ix_outbox_delivery_subject ON platform.outbox_delivery (consumer, subject_id, message_id) WHERE status IN ('PENDING', 'FAILED');
CREATE INDEX ix_outbox_delivery_dead ON platform.outbox_delivery (message_id) WHERE status = 'DEAD';

CREATE TABLE platform.inbox_message (
  consumer     text NOT NULL,
  message_id   uuid NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now(),
  recorded_at  timestamptz NOT NULL DEFAULT now(),
  actor_id     uuid NOT NULL CONSTRAINT fk_inbox_message_actor REFERENCES iam.principal (id) ON DELETE RESTRICT,
  CONSTRAINT pk_inbox_message PRIMARY KEY (consumer, message_id)
);
COMMENT ON TABLE platform.inbox_message IS 'class=LEDGER';
CREATE TRIGGER trg_inbox_message_immutable BEFORE UPDATE OR DELETE ON platform.inbox_message
  FOR EACH ROW EXECUTE FUNCTION platform.reject_change();
CREATE TRIGGER trg_inbox_message_no_truncate BEFORE TRUNCATE ON platform.inbox_message
  FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_change();

-- Typed settings. Rows are written only through the AUD module's audited administration (B13 for the screens);
-- code holds the defaults, so an absent row means the documented default applies.
CREATE TABLE platform.setting (
  id            uuid PRIMARY KEY,
  key           text NOT NULL CONSTRAINT ck_setting_key CHECK (key ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$'),
  branch_id     uuid NULL CONSTRAINT fk_setting_branch REFERENCES mdm.branch (id) ON DELETE RESTRICT,
  value         jsonb NOT NULL,
  value_type    text NOT NULL CONSTRAINT ck_setting_value_type CHECK (value_type IN ('BOOLEAN', 'INTEGER', 'PESEWAS', 'PERCENT', 'TEXT', 'JSON')),
  valid_from    timestamptz NOT NULL DEFAULT now(),
  description   text NOT NULL,
  version       integer NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid NOT NULL CONSTRAINT fk_setting_created_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    uuid NOT NULL CONSTRAINT fk_setting_updated_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  deleted_at    timestamptz NULL,
  deleted_by    uuid NULL CONSTRAINT fk_setting_deleted_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  delete_reason text NULL,
  CONSTRAINT ck_setting_soft_delete CHECK ((deleted_at IS NULL) = (deleted_by IS NULL) AND (deleted_at IS NULL) = (delete_reason IS NULL))
);
COMMENT ON TABLE platform.setting IS 'class=MASTER';
CREATE UNIQUE INDEX uq_setting_key_branch_from ON platform.setting (key, branch_id, valid_from) NULLS NOT DISTINCT WHERE deleted_at IS NULL;
CREATE TRIGGER trg_setting_version BEFORE UPDATE ON platform.setting
  FOR EACH ROW EXECUTE FUNCTION platform.touch_version();

-- Per-subject data keys (ADR-0022). Destroying one erases that subject's personal data from immutable records.
CREATE TABLE platform.subject_key (
  id             uuid PRIMARY KEY,
  subject_type   text NOT NULL CONSTRAINT ck_subject_key_type CHECK (subject_type IN ('CUSTOMER', 'SUPPLIER', 'INVESTOR', 'STAFF')),
  subject_id     uuid NOT NULL,
  wrapped_key    bytea NULL,
  kek_version    integer NOT NULL CONSTRAINT ck_subject_key_kek_version CHECK (kek_version > 0),
  created_at     timestamptz NOT NULL DEFAULT now(),
  destroyed_at   timestamptz NULL,
  destroyed_by   uuid NULL CONSTRAINT fk_subject_key_destroyed_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  destroy_reason text NULL,
  version        integer NOT NULL DEFAULT 1,
  created_by     uuid NOT NULL CONSTRAINT fk_subject_key_created_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     uuid NOT NULL CONSTRAINT fk_subject_key_updated_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  CONSTRAINT uq_subject_key_subject UNIQUE (subject_type, subject_id),
  CONSTRAINT ck_subject_key_destroyed CHECK ((wrapped_key IS NULL) = (destroyed_at IS NOT NULL)),
  CONSTRAINT ck_subject_key_destroy_record CHECK ((destroyed_at IS NULL) = (destroyed_by IS NULL) AND (destroyed_at IS NULL) = (destroy_reason IS NULL))
);
COMMENT ON TABLE platform.subject_key IS 'class=MASTER';
CREATE FUNCTION platform.subject_key_stays_destroyed() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF OLD.destroyed_at IS NOT NULL THEN
    RAISE EXCEPTION 'platform.subject_key %: a destroyed key cannot change', OLD.id USING ERRCODE = 'HK005';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION platform.subject_key_stays_destroyed() FROM PUBLIC;
CREATE TRIGGER trg_subject_key_stays_destroyed BEFORE UPDATE ON platform.subject_key
  FOR EACH ROW EXECUTE FUNCTION platform.subject_key_stays_destroyed();
CREATE TRIGGER trg_subject_key_version BEFORE UPDATE ON platform.subject_key
  FOR EACH ROW EXECUTE FUNCTION platform.touch_version();

-- The audit trail, stage one (ADR-0006): written in the business transaction.
CREATE TABLE platform.audit_event (
  id             uuid PRIMARY KEY,
  occurred_at    timestamptz NOT NULL,
  recorded_at    timestamptz NOT NULL DEFAULT now(),
  actor_id       uuid NULL CONSTRAINT fk_audit_event_actor REFERENCES iam.principal (id) ON DELETE RESTRICT,
  session_id     uuid NULL,
  ip             inet NULL,
  user_agent     text NULL CONSTRAINT ck_audit_event_user_agent CHECK (length(user_agent) <= 512),
  correlation_id uuid NOT NULL,
  branch_id      uuid NULL CONSTRAINT fk_audit_event_branch REFERENCES mdm.branch (id) ON DELETE RESTRICT,
  module         text NOT NULL CONSTRAINT ck_audit_event_module CHECK (module ~ '^[a-z]{3,8}$'),
  action         text NOT NULL CONSTRAINT ck_audit_event_action CHECK (action ~ '^[A-Z][A-Z_]{1,39}$'),
  entity_type    text NOT NULL,
  entity_id      uuid NULL,
  "before"       bytea NULL,
  "after"        bytea NULL,
  metadata       jsonb NULL,
  subject_key_id uuid NULL CONSTRAINT fk_audit_event_subject_key REFERENCES platform.subject_key (id) ON DELETE RESTRICT,
  txid           xid8 NOT NULL,
  content_hash   bytea NOT NULL
);
COMMENT ON TABLE platform.audit_event IS 'class=LEDGER';
CREATE INDEX ix_audit_event_entity ON platform.audit_event (entity_type, entity_id, occurred_at);
CREATE INDEX ix_audit_event_actor ON platform.audit_event (actor_id, occurred_at);
CREATE INDEX ix_audit_event_txid ON platform.audit_event (txid, id);

-- The canonical bytes of an audit event, hashed. Independent of every session setting: times as microseconds
-- since the epoch, bytes as hex, JSON through jsonb's normalised text. Used by the trigger and by the verifier.
CREATE FUNCTION platform.audit_event_content_hash(e platform.audit_event) RETURNS bytea
  LANGUAGE sql
  STABLE
  SET search_path = pg_catalog
AS $$
  SELECT sha256(convert_to(jsonb_build_array(
    e.id::text,
    (extract(epoch FROM e.occurred_at) * 1000000)::bigint::text,
    (extract(epoch FROM e.recorded_at) * 1000000)::bigint::text,
    e.actor_id::text, e.session_id::text, host(e.ip), e.user_agent, e.correlation_id::text, e.branch_id::text,
    e.module, e.action, e.entity_type, e.entity_id::text,
    encode(e."before", 'hex'), encode(e."after", 'hex'), e.metadata, e.subject_key_id::text, e.txid::text
  )::text, 'UTF8'))
$$;
REVOKE ALL ON FUNCTION platform.audit_event_content_hash(platform.audit_event) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.audit_event_content_hash(platform.audit_event) TO hk_app, hk_worker, hk_sealer;

-- The application cannot supply the transaction id or the hash: the trigger overwrites whatever was sent.
CREATE FUNCTION platform.audit_event_seal_fields() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  NEW.txid := pg_current_xact_id();
  NEW.content_hash := platform.audit_event_content_hash(NEW);
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION platform.audit_event_seal_fields() FROM PUBLIC;
CREATE TRIGGER trg_audit_event_seal_fields BEFORE INSERT ON platform.audit_event
  FOR EACH ROW EXECUTE FUNCTION platform.audit_event_seal_fields();
CREATE TRIGGER trg_audit_event_immutable BEFORE UPDATE OR DELETE ON platform.audit_event
  FOR EACH ROW EXECUTE FUNCTION platform.reject_change();
CREATE TRIGGER trg_audit_event_no_truncate BEFORE TRUNCATE ON platform.audit_event
  FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_change();

-- Stage two, the chain, written only by the sealer.
CREATE TABLE platform.audit_chain (
  seq            bigint PRIMARY KEY CONSTRAINT ck_audit_chain_seq CHECK (seq > 0),
  audit_event_id uuid NOT NULL CONSTRAINT uq_audit_chain_event UNIQUE
                   CONSTRAINT fk_audit_chain_event REFERENCES platform.audit_event (id) ON DELETE RESTRICT,
  prev_hash      bytea NOT NULL CONSTRAINT ck_audit_chain_prev_hash CHECK (length(prev_hash) = 32),
  chain_hash     bytea NOT NULL CONSTRAINT ck_audit_chain_hash CHECK (length(chain_hash) = 32),
  sealed_at      timestamptz NOT NULL DEFAULT now(),
  recorded_at    timestamptz NOT NULL DEFAULT now(),
  actor_id       uuid NOT NULL DEFAULT '01900000-0000-7000-8000-000000000002'
                   CONSTRAINT fk_audit_chain_actor REFERENCES iam.principal (id) ON DELETE RESTRICT
);
COMMENT ON TABLE platform.audit_chain IS 'class=LEDGER;writer=hk_sealer';
CREATE TRIGGER trg_audit_chain_immutable BEFORE UPDATE OR DELETE ON platform.audit_chain
  FOR EACH ROW EXECUTE FUNCTION platform.reject_change();
CREATE TRIGGER trg_audit_chain_no_truncate BEFORE TRUNCATE ON platform.audit_chain
  FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_change();

-- Stage three, signed copies of the chain head, also stored off the server.
CREATE TABLE platform.audit_anchor (
  id             uuid PRIMARY KEY,
  seq            bigint NOT NULL CONSTRAINT fk_audit_anchor_seq REFERENCES platform.audit_chain (seq) ON DELETE RESTRICT,
  chain_hash     bytea NOT NULL CONSTRAINT ck_audit_anchor_hash CHECK (length(chain_hash) = 32),
  signature      bytea NOT NULL,
  signing_key_id text NOT NULL,
  storage_uri    text NOT NULL,
  reason         text NOT NULL CONSTRAINT ck_audit_anchor_reason CHECK (reason IN ('DAILY', 'SHIFT_CLOSE', 'MANUAL')),
  anchored_at    timestamptz NOT NULL DEFAULT now(),
  recorded_at    timestamptz NOT NULL DEFAULT now(),
  actor_id       uuid NOT NULL DEFAULT '01900000-0000-7000-8000-000000000002'
                   CONSTRAINT fk_audit_anchor_actor REFERENCES iam.principal (id) ON DELETE RESTRICT
);
COMMENT ON TABLE platform.audit_anchor IS 'class=LEDGER;writer=hk_sealer';
CREATE TRIGGER trg_audit_anchor_immutable BEFORE UPDATE OR DELETE ON platform.audit_anchor
  FOR EACH ROW EXECUTE FUNCTION platform.reject_change();
CREATE TRIGGER trg_audit_anchor_no_truncate BEFORE TRUNCATE ON platform.audit_anchor
  FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_change();

-- Outcome of every scheduled job.
CREATE TABLE platform.job_run (
  id          uuid PRIMARY KEY,
  job_name    text NOT NULL CONSTRAINT ck_job_run_name CHECK (job_name ~ '^[a-z][a-z0-9-]{2,60}$'),
  started_at  timestamptz NOT NULL,
  finished_at timestamptz NOT NULL,
  outcome     text NOT NULL CONSTRAINT ck_job_run_outcome CHECK (outcome IN ('SUCCESS', 'DRIFT', 'FAILED')),
  summary     jsonb NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  actor_id    uuid NOT NULL CONSTRAINT fk_job_run_actor REFERENCES iam.principal (id) ON DELETE RESTRICT,
  CONSTRAINT ck_job_run_times CHECK (finished_at >= started_at)
);
COMMENT ON TABLE platform.job_run IS 'class=LEDGER';
CREATE INDEX ix_job_run_name_finished ON platform.job_run (job_name, finished_at DESC);
CREATE TRIGGER trg_job_run_immutable BEFORE UPDATE OR DELETE ON platform.job_run
  FOR EACH ROW EXECUTE FUNCTION platform.reject_change();
CREATE TRIGGER trg_job_run_no_truncate BEFORE TRUNCATE ON platform.job_run
  FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_change();

REVOKE ALL ON ALL TABLES IN SCHEMA platform FROM PUBLIC;
GRANT SELECT ON platform.document_type TO hk_app, hk_worker;
GRANT SELECT, INSERT ON platform.business_document, platform.outbox_message, platform.inbox_message,
  platform.audit_event, platform.job_run TO hk_app, hk_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON platform.idempotency_key, platform.outbox_delivery TO hk_app, hk_worker;
GRANT SELECT, INSERT, UPDATE ON platform.setting, platform.subject_key TO hk_app, hk_worker;
GRANT SELECT ON platform.audit_chain, platform.audit_anchor TO hk_app, hk_worker;
-- The sealer (ADR-0024): reads events, writes the chain and the anchors, and nothing else.
GRANT SELECT ON platform.audit_event TO hk_sealer;
GRANT SELECT, INSERT ON platform.audit_chain, platform.audit_anchor TO hk_sealer;

-- migrate:down
DROP TABLE platform.job_run;
DROP TABLE platform.audit_anchor;
DROP TABLE platform.audit_chain;
DROP TRIGGER trg_audit_event_seal_fields ON platform.audit_event;
DROP FUNCTION platform.audit_event_seal_fields();
DROP FUNCTION platform.audit_event_content_hash(platform.audit_event);
DROP TABLE platform.audit_event;
DROP TABLE platform.subject_key;
DROP FUNCTION platform.subject_key_stays_destroyed();
DROP TABLE platform.setting;
DROP TABLE platform.inbox_message;
DROP TABLE platform.outbox_delivery;
DROP TABLE platform.outbox_message;
DROP TABLE platform.idempotency_key;
DROP TABLE platform.business_document;
DROP TABLE platform.document_type;
DROP FUNCTION platform.freeze_posted();
