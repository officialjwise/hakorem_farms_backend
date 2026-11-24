-- 0335_ntf_create_messages
-- The notifications schema's first tables (docs/data-model/ntf.md; FR-NTF-001, FR-NTF-003, FR-NTF-007, FR-DEL-012,
-- B11 continued 10, A-374): message templates by version, the message log with each send attempt, and every delivery
-- report a messaging provider sent. Preferences, opt-outs, triggers and in-app notifications follow in B11 continued 11.
-- The database holds the rules:
--   uq_template_active         one ACTIVE version of a code, channel and locale
--   uq_template_version        a code, channel and locale's versions are numbered once each
--   ck_template_maker_checker  a version is never activated by the person who drafted it (abuse case 57)
--   ntf.template_guard()       a version's text never changes once written; DRAFT -> ACTIVE -> RETIRED, DRAFT -> RETIRED
--   uq_message_idempotency     a message exists at most once per source event, template, channel and recipient (FR-NTF-003)
--   ntf.message_guard()        what a message is (its event, template, text, recipient, order) never changes; its status
--                              moves QUEUED -> SENT | FAILED | SUPPRESSED, SENT -> DELIVERED | FAILED, FAILED -> QUEUED
--                              (a manager's retry); DELIVERED and SUPPRESSED are final
--   ck_message_*               a suppressed message says why; a sent one when; a delivered one when; attempts never fall
--   message_attempt, provider_report: LEDGER (insert only); uq_provider_report_key: one report applied per provider id
-- No address is stored (A-374 (b)): the message is sent to its order's own contact, read from ORD when it is sent; the log
-- keeps the number masked and a keyed hash of it for the recipient's hourly limit (abuse case 58).
-- No now() in business SQL (ADR-0067): every time is written by the application from its clock.
-- Data category: CONFIDENTIAL (the masked number and the rendered text, DC-21); no secret.
-- Rollback: tested (`pnpm db:rollback`), safe before the first message is sent; afterwards forward fix only.

-- migrate:up
CREATE SCHEMA ntf AUTHORIZATION hk_owner;
REVOKE ALL ON SCHEMA ntf FROM PUBLIC;
GRANT USAGE ON SCHEMA ntf TO hk_app, hk_worker, hk_report;

CREATE TABLE ntf.template (
  id                    uuid PRIMARY KEY,
  code                  text NOT NULL CONSTRAINT ck_template_code CHECK (code ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  channel               text NOT NULL CONSTRAINT ck_template_channel CHECK (channel IN ('SMS', 'WHATSAPP', 'EMAIL', 'IN_APP')),
  locale                text NOT NULL DEFAULT 'en-GH' CONSTRAINT ck_template_locale CHECK (locale ~ '^[a-z]{2}-[A-Z]{2}$'),
  category              text NOT NULL CONSTRAINT ck_template_category CHECK (category IN ('TRANSACTIONAL', 'REMINDER', 'MARKETING', 'OPERATIONAL')),
  subject               text NULL CONSTRAINT ck_template_subject CHECK (length(subject) BETWEEN 1 AND 200),
  body                  text NOT NULL CONSTRAINT ck_template_body CHECK (length(body) BETWEEN 1 AND 1000),
  provider_template_ref text NULL CONSTRAINT ck_template_provider_ref CHECK (provider_template_ref ~ '^[a-z0-9_]{1,64}$'),
  version_no            integer NOT NULL CONSTRAINT ck_template_version_no CHECK (version_no >= 1),
  status                text NOT NULL CONSTRAINT ck_template_status CHECK (status IN ('DRAFT', 'ACTIVE', 'RETIRED')),
  activated_at          timestamptz NULL,
  activated_by          uuid NULL CONSTRAINT fk_template_activated_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  version               integer NOT NULL DEFAULT 1,
  created_at            timestamptz NOT NULL,
  created_by            uuid NOT NULL CONSTRAINT fk_template_created_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  updated_at            timestamptz NOT NULL,
  updated_by            uuid NOT NULL CONSTRAINT fk_template_updated_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  deleted_at            timestamptz NULL,
  deleted_by            uuid NULL CONSTRAINT fk_template_deleted_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  delete_reason         text NULL,
  CONSTRAINT ck_template_subject_email CHECK ((channel = 'EMAIL') = (subject IS NOT NULL)),
  CONSTRAINT ck_template_maker_checker CHECK (activated_by IS NULL OR activated_by <> created_by),
  CONSTRAINT ck_template_activated CHECK ((activated_at IS NULL) = (activated_by IS NULL)),
  CONSTRAINT ck_template_soft_delete CHECK ((deleted_at IS NULL) = (deleted_by IS NULL) AND (deleted_at IS NULL) = (delete_reason IS NULL))
);
COMMENT ON TABLE ntf.template IS 'class=MASTER';
CREATE UNIQUE INDEX uq_template_active ON ntf.template (code, channel, locale) WHERE status = 'ACTIVE' AND deleted_at IS NULL;
CREATE UNIQUE INDEX uq_template_version ON ntf.template (code, channel, locale, version_no);
-- The list's order: by code, channel, then the newest version first (CR-019's keyset with the id as tie-breaker).
CREATE INDEX ix_template_code ON ntf.template (code, channel, version_no DESC, id) WHERE deleted_at IS NULL;

CREATE FUNCTION ntf.template_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  fixed text[] := ARRAY['id', 'code', 'channel', 'locale', 'category', 'subject', 'body', 'provider_template_ref', 'version_no', 'created_at', 'created_by'];
  k text;
BEGIN
  FOREACH k IN ARRAY fixed LOOP
    IF to_jsonb(NEW) -> k IS DISTINCT FROM to_jsonb(OLD) -> k THEN
      RAISE EXCEPTION 'ntf.template %: % never changes; draft a new version', OLD.id, k USING ERRCODE = 'HK004', CONSTRAINT = 'ck_template_transition';
    END IF;
  END LOOP;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'DRAFT' AND NEW.status IN ('ACTIVE', 'RETIRED'))
    OR (OLD.status = 'ACTIVE' AND NEW.status = 'RETIRED')) THEN
    RAISE EXCEPTION 'ntf.template %: % cannot move to %', OLD.id, OLD.status, NEW.status USING ERRCODE = 'HK004', CONSTRAINT = 'ck_template_transition';
  END IF;
  IF NEW.status = 'ACTIVE' AND OLD.status = 'DRAFT' AND NEW.activated_by IS NULL THEN
    RAISE EXCEPTION 'ntf.template %: an activation names who activated it', OLD.id USING ERRCODE = 'HK004', CONSTRAINT = 'ck_template_transition';
  END IF;
  IF OLD.activated_by IS NOT NULL AND (NEW.activated_by IS DISTINCT FROM OLD.activated_by OR NEW.activated_at IS DISTINCT FROM OLD.activated_at) THEN
    RAISE EXCEPTION 'ntf.template %: its activation never changes', OLD.id USING ERRCODE = 'HK004', CONSTRAINT = 'ck_template_transition';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER trg_template_guard BEFORE UPDATE ON ntf.template
  FOR EACH ROW EXECUTE FUNCTION ntf.template_guard();
CREATE TRIGGER trg_template_version BEFORE UPDATE ON ntf.template
  FOR EACH ROW EXECUTE FUNCTION platform.touch_version();

CREATE TABLE ntf.message (
  id                   uuid PRIMARY KEY,
  idempotency_key      text NOT NULL CONSTRAINT ck_message_idempotency_key CHECK (length(idempotency_key) BETWEEN 1 AND 300),
  source_event_ref     uuid NOT NULL,
  source_event_type    text NOT NULL CONSTRAINT ck_message_source_event_type CHECK (source_event_type ~ '^[a-z]{3,8}\.[A-Z][A-Za-z]+$'),
  branch_id            uuid NULL CONSTRAINT fk_message_branch REFERENCES mdm.branch (id) ON DELETE RESTRICT,
  sales_order_id       uuid NULL CONSTRAINT fk_message_sales_order REFERENCES ord.sales_order (id) ON DELETE RESTRICT,
  template_id          uuid NOT NULL CONSTRAINT fk_message_template REFERENCES ntf.template (id) ON DELETE RESTRICT,
  channel              text NOT NULL CONSTRAINT ck_message_channel CHECK (channel IN ('SMS', 'WHATSAPP', 'EMAIL', 'IN_APP')),
  category             text NOT NULL CONSTRAINT ck_message_category CHECK (category IN ('TRANSACTIONAL', 'REMINDER', 'MARKETING', 'OPERATIONAL')),
  recipient_kind       text NOT NULL CONSTRAINT ck_message_recipient_kind CHECK (recipient_kind IN ('CUSTOMER', 'STAFF', 'INVESTOR', 'CONTACT')),
  customer_id          uuid NULL CONSTRAINT fk_message_customer REFERENCES mdm.customer (id) ON DELETE RESTRICT,
  principal_id         uuid NULL CONSTRAINT fk_message_principal REFERENCES iam.principal (id) ON DELETE RESTRICT,
  address_masked       text NOT NULL CONSTRAINT ck_message_address_masked CHECK (length(address_masked) <= 40),
  address_hash         bytea NULL CONSTRAINT ck_message_address_hash CHECK (length(address_hash) = 32),
  rendered_body        text NULL CONSTRAINT ck_message_rendered_body CHECK (length(rendered_body) <= 2000),
  status               text NOT NULL CONSTRAINT ck_message_status CHECK (status IN ('QUEUED', 'DEFERRED_QUIET_HOURS', 'SENT', 'DELIVERED', 'FAILED', 'SUPPRESSED')),
  suppressed_reason    text NULL CONSTRAINT ck_message_suppressed_reason CHECK (suppressed_reason IN ('NO_ADDRESS', 'RATE_LIMITED', 'OPTED_OUT', 'PREFERENCE_OFF')),
  failure_reason       text NULL CONSTRAINT ck_message_failure_reason CHECK (length(failure_reason) <= 500),
  attempts             integer NOT NULL DEFAULT 0 CONSTRAINT ck_message_attempts CHECK (attempts >= 0),
  send_after           timestamptz NULL,
  claimed_until        timestamptz NULL,
  claim_token          uuid NULL,
  provider_message_ref text NULL CONSTRAINT ck_message_provider_ref CHECK (length(provider_message_ref) BETWEEN 1 AND 200),
  sent_at              timestamptz NULL,
  delivered_at         timestamptz NULL,
  failed_at            timestamptz NULL,
  version              integer NOT NULL DEFAULT 1,
  created_at           timestamptz NOT NULL,
  created_by           uuid NOT NULL CONSTRAINT fk_message_created_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  updated_at           timestamptz NOT NULL,
  updated_by           uuid NOT NULL CONSTRAINT fk_message_updated_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  CONSTRAINT uq_message_idempotency UNIQUE (idempotency_key),
  CONSTRAINT ck_message_suppressed CHECK ((status = 'SUPPRESSED') = (suppressed_reason IS NOT NULL)),
  CONSTRAINT ck_message_sent CHECK (status NOT IN ('SENT', 'DELIVERED') OR (sent_at IS NOT NULL AND provider_message_ref IS NOT NULL)),
  CONSTRAINT ck_message_delivered CHECK ((status = 'DELIVERED') = (delivered_at IS NOT NULL)),
  CONSTRAINT ck_message_failed CHECK (status <> 'FAILED' OR failed_at IS NOT NULL),
  CONSTRAINT ck_message_claim CHECK ((claimed_until IS NULL) = (claim_token IS NULL)),
  CONSTRAINT ck_message_recipient CHECK (recipient_kind <> 'CUSTOMER' OR customer_id IS NOT NULL)
);
COMMENT ON TABLE ntf.message IS 'class=DOCUMENT';
CREATE INDEX ix_message_due ON ntf.message (status, send_after);
CREATE INDEX ix_message_recipient ON ntf.message (address_hash, created_at) WHERE address_hash IS NOT NULL;
CREATE INDEX ix_message_order ON ntf.message (sales_order_id) WHERE sales_order_id IS NOT NULL;
-- The log's order: the newest first, then the id (CR-019's keyset).
CREATE INDEX ix_message_created ON ntf.message (created_at DESC, id DESC);

CREATE FUNCTION ntf.message_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  fixed text[] := ARRAY['id', 'idempotency_key', 'source_event_ref', 'source_event_type', 'branch_id', 'sales_order_id', 'template_id', 'channel',
                        'category', 'recipient_kind', 'customer_id', 'principal_id', 'rendered_body', 'created_at', 'created_by'];
  k text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status NOT IN ('QUEUED', 'SUPPRESSED') OR NEW.attempts <> 0 THEN
      RAISE EXCEPTION 'ntf.message %: a message is written QUEUED or SUPPRESSED, never tried', NEW.id USING ERRCODE = 'HK004', CONSTRAINT = 'ck_message_transition';
    END IF;
    RETURN NEW;
  END IF;
  FOREACH k IN ARRAY fixed LOOP
    IF to_jsonb(NEW) -> k IS DISTINCT FROM to_jsonb(OLD) -> k THEN
      RAISE EXCEPTION 'ntf.message %: % never changes', OLD.id, k USING ERRCODE = 'HK004', CONSTRAINT = 'ck_message_transition';
    END IF;
  END LOOP;
  IF NEW.attempts < OLD.attempts THEN
    RAISE EXCEPTION 'ntf.message %: attempts never fall', OLD.id USING ERRCODE = 'HK004', CONSTRAINT = 'ck_message_transition';
  END IF;
  IF OLD.status IN ('DELIVERED', 'SUPPRESSED') AND to_jsonb(NEW) - 'version' - 'updated_at' - 'updated_by' IS DISTINCT FROM to_jsonb(OLD) - 'version' - 'updated_at' - 'updated_by' THEN
    RAISE EXCEPTION 'ntf.message % is % and final', OLD.id, OLD.status USING ERRCODE = 'HK004', CONSTRAINT = 'ck_message_transition';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'QUEUED' AND NEW.status IN ('SENT', 'FAILED', 'SUPPRESSED'))
    OR (OLD.status = 'SENT' AND NEW.status IN ('DELIVERED', 'FAILED'))
    OR (OLD.status = 'FAILED' AND NEW.status = 'QUEUED')) THEN
    RAISE EXCEPTION 'ntf.message %: % cannot move to %', OLD.id, OLD.status, NEW.status USING ERRCODE = 'HK004', CONSTRAINT = 'ck_message_transition';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER trg_message_guard BEFORE INSERT OR UPDATE ON ntf.message
  FOR EACH ROW EXECUTE FUNCTION ntf.message_guard();
CREATE TRIGGER trg_message_version BEFORE UPDATE ON ntf.message
  FOR EACH ROW EXECUTE FUNCTION platform.touch_version();

CREATE TABLE ntf.message_attempt (
  message_id        uuid NOT NULL CONSTRAINT fk_message_attempt_message REFERENCES ntf.message (id) ON DELETE RESTRICT,
  attempt_no        integer NOT NULL CONSTRAINT ck_message_attempt_no CHECK (attempt_no >= 1),
  outcome           text NOT NULL CONSTRAINT ck_message_attempt_outcome CHECK (outcome IN ('ACCEPTED', 'TEMPORARY_FAILURE', 'PERMANENT_FAILURE')),
  provider_response text NULL CONSTRAINT ck_message_attempt_response CHECK (length(provider_response) <= 500),
  attempted_at      timestamptz NOT NULL,
  recorded_at       timestamptz NOT NULL,
  actor_id          uuid NOT NULL CONSTRAINT fk_message_attempt_actor REFERENCES iam.principal (id) ON DELETE RESTRICT,
  CONSTRAINT pk_message_attempt PRIMARY KEY (message_id, attempt_no)
);
COMMENT ON TABLE ntf.message_attempt IS 'class=LEDGER';
CREATE TRIGGER trg_message_attempt_immutable BEFORE UPDATE OR DELETE ON ntf.message_attempt
  FOR EACH ROW EXECUTE FUNCTION platform.reject_change();
CREATE TRIGGER trg_message_attempt_no_truncate BEFORE TRUNCATE ON ntf.message_attempt
  FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_change();

-- Every request to the messaging webhook, accepted or not (FR-NTF-007, abuse case 57), as pay.webhook_event logs payments'.
CREATE TABLE ntf.provider_report (
  id              uuid PRIMARY KEY,
  provider        text NOT NULL CONSTRAINT ck_provider_report_provider CHECK (provider ~ '^[A-Z][A-Z0-9_]{1,31}$'),
  report_key      text NULL CONSTRAINT ck_provider_report_key CHECK (length(report_key) BETWEEN 1 AND 200),
  outcome         text NOT NULL CONSTRAINT ck_provider_report_outcome CHECK (outcome IN ('APPLIED', 'NO_CHANGE', 'UNKNOWN_MESSAGE', 'IGNORED', 'REPLAYED', 'REJECTED_SIGNATURE', 'REJECTED_MALFORMED')),
  message_id      uuid NULL CONSTRAINT fk_provider_report_message REFERENCES ntf.message (id) ON DELETE RESTRICT,
  reported_status text NULL CONSTRAINT ck_provider_report_status CHECK (reported_status IN ('DELIVERED', 'FAILED')),
  payload_hash    bytea NOT NULL CONSTRAINT ck_provider_report_hash CHECK (length(payload_hash) = 32),
  source_ip       text NULL CONSTRAINT ck_provider_report_ip CHECK (length(source_ip) <= 64),
  received_at     timestamptz NOT NULL,
  recorded_at     timestamptz NOT NULL,
  actor_id        uuid NOT NULL CONSTRAINT fk_provider_report_actor REFERENCES iam.principal (id) ON DELETE RESTRICT,
  CONSTRAINT ck_provider_report_keyed CHECK (outcome LIKE 'REJECTED_%' OR outcome = 'IGNORED' OR report_key IS NOT NULL)
);
COMMENT ON TABLE ntf.provider_report IS 'class=LEDGER';
CREATE UNIQUE INDEX uq_provider_report_key ON ntf.provider_report (provider, report_key) WHERE outcome IN ('APPLIED', 'NO_CHANGE', 'UNKNOWN_MESSAGE');
CREATE TRIGGER trg_provider_report_immutable BEFORE UPDATE OR DELETE ON ntf.provider_report
  FOR EACH ROW EXECUTE FUNCTION platform.reject_change();
CREATE TRIGGER trg_provider_report_no_truncate BEFORE TRUNCATE ON ntf.provider_report
  FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_change();

REVOKE ALL ON ntf.template, ntf.message, ntf.message_attempt, ntf.provider_report FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON ntf.template, ntf.message TO hk_app, hk_worker;
GRANT SELECT, INSERT ON ntf.message_attempt, ntf.provider_report TO hk_app, hk_worker;

-- The customer's messages (B11 continued 10, A-374 (e)): one active SMS version of each, written by the System principal
-- with no activation of its own (a manager's next version is drafted and activated by two people).
INSERT INTO ntf.template (id, code, channel, locale, category, subject, body, version_no, status, created_at, created_by, updated_at, updated_by) VALUES
  ('019a7c00-0000-7000-8000-000000000001', 'ORDER_DISPATCHED', 'SMS', 'en-GH', 'TRANSACTIONAL', NULL,
   'HaKorem Farms: order {{orderNo}} is on its way ({{deliveryNo}}): {{items}}. Total {{total}}, to pay on delivery {{codDue}}.', 1, 'ACTIVE',
   platform.app_now(), '01900000-0000-7000-8000-000000000001', platform.app_now(), '01900000-0000-7000-8000-000000000001'),
  ('019a7c00-0000-7000-8000-000000000002', 'ORDER_COLLECTED', 'SMS', 'en-GH', 'TRANSACTIONAL', NULL,
   'HaKorem Farms: thank you for collecting order {{orderNo}}. Invoice {{documentNo}}, total {{total}}, left to pay {{dueAtTill}}.', 1, 'ACTIVE',
   platform.app_now(), '01900000-0000-7000-8000-000000000001', platform.app_now(), '01900000-0000-7000-8000-000000000001'),
  ('019a7c00-0000-7000-8000-000000000003', 'DELIVERY_ON_THE_WAY', 'SMS', 'en-GH', 'TRANSACTIONAL', NULL,
   'HaKorem Farms: our driver is on the way with order {{orderNo}} ({{deliveryNo}}).', 1, 'ACTIVE',
   platform.app_now(), '01900000-0000-7000-8000-000000000001', platform.app_now(), '01900000-0000-7000-8000-000000000001'),
  ('019a7c00-0000-7000-8000-000000000004', 'DELIVERY_RESCHEDULED', 'SMS', 'en-GH', 'TRANSACTIONAL', NULL,
   'HaKorem Farms: delivery {{deliveryNo}} of order {{orderNo}} is now on {{slotDate}}, {{slotStart}} to {{slotEnd}}.', 1, 'ACTIVE',
   platform.app_now(), '01900000-0000-7000-8000-000000000001', platform.app_now(), '01900000-0000-7000-8000-000000000001'),
  ('019a7c00-0000-7000-8000-000000000005', 'DELIVERY_CANCELLED', 'SMS', 'en-GH', 'TRANSACTIONAL', NULL,
   'HaKorem Farms: delivery {{deliveryNo}} of order {{orderNo}} has been cancelled. We will call you about it.', 1, 'ACTIVE',
   platform.app_now(), '01900000-0000-7000-8000-000000000001', platform.app_now(), '01900000-0000-7000-8000-000000000001'),
  ('019a7c00-0000-7000-8000-000000000006', 'DELIVERY_COMPLETED', 'SMS', 'en-GH', 'TRANSACTIONAL', NULL,
   'HaKorem Farms: order {{orderNo}} was delivered. Paid on delivery {{collected}}. Thank you!', 1, 'ACTIVE',
   platform.app_now(), '01900000-0000-7000-8000-000000000001', platform.app_now(), '01900000-0000-7000-8000-000000000001'),
  ('019a7c00-0000-7000-8000-000000000007', 'DELIVERY_PART_COMPLETED', 'SMS', 'en-GH', 'TRANSACTIONAL', NULL,
   'HaKorem Farms: part of order {{orderNo}} was delivered. Paid on delivery {{collected}}; {{returnedCredit}} credited for what came back.', 1, 'ACTIVE',
   platform.app_now(), '01900000-0000-7000-8000-000000000001', platform.app_now(), '01900000-0000-7000-8000-000000000001');

-- migrate:down
DROP TABLE ntf.provider_report;
DROP TABLE ntf.message_attempt;
DROP TABLE ntf.message;
DROP FUNCTION ntf.message_guard();
DROP TABLE ntf.template;
DROP FUNCTION ntf.template_guard();
DROP SCHEMA ntf;
