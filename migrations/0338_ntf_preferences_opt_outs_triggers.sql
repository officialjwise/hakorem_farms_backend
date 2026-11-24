-- 0338_ntf_preferences_opt_outs_triggers
-- Notifications, second pass (docs/data-model/ntf.md; FR-NTF-002, FR-NTF-004 to FR-NTF-006, FR-NTF-008; B11 continued 11,
-- ADR-0097, A-376): which event sends which template by which channels (ntf.trigger_rule), each recipient's channel
-- preferences and quiet hours (ntf.preference), every opt-out and opt-in a number sent (ntf.opt_out) and the console's
-- in-app notifications (ntf.in_app_notification). A message may now wait out quiet hours (DEFERRED_QUIET_HOURS) and carry
-- an in-app title and a console path. The payment reminders and the returned death report are seeded as templates, and
-- every message NTF sends as a trigger. The database holds the rules:
--   uq_trigger_rule            one live trigger per event and template
--   ck_trigger_rule_*          at least one channel, each a known one; a role only with ROLE
--   uq_preference              one live preference per recipient, category and channel (NULLS NOT DISTINCT)
--   ck_preference_*            exactly one recipient; quiet hours both or neither, never empty, only on reminders and marketing
--   opt_out: LEDGER (insert only); the latest row per number and channel is its state
--   ntf.in_app_notification_guard()  what a notification says and whose it is never change; it is read once
--   uq_in_app_notification_message   one notification per message
--   ntf.message_guard() (replaced)   a message is written QUEUED, DEFERRED_QUIET_HOURS or SUPPRESSED; DEFERRED_QUIET_HOURS
--                                    moves on as QUEUED does; its subject and link never change
--   ck_template_subject_titled (replaces ck_template_subject_email): a subject on email and in-app, and only there
-- No address is stored (A-374 (b)): an opt-out keeps the number masked and its keyed hash, so it outlives the customer
-- record and is matched without the number.
-- No now() in business SQL (ADR-0067): every time is written by the application from its clock.
-- Data category: CONFIDENTIAL (masked numbers, notification text, DC-21); no secret.
-- Rollback: tested (`pnpm db:rollback`), safe before the first opt-out, preference, in-app notification or deferred
-- message is written; afterwards forward fix only.

-- migrate:up
ALTER TABLE ntf.template DROP CONSTRAINT ck_template_subject_email;
ALTER TABLE ntf.template ADD CONSTRAINT ck_template_subject_titled CHECK ((channel IN ('EMAIL', 'IN_APP')) = (subject IS NOT NULL));

ALTER TABLE ntf.message
  ADD COLUMN rendered_subject text NULL CONSTRAINT ck_message_rendered_subject CHECK (length(rendered_subject) BETWEEN 1 AND 300),
  ADD COLUMN link_path text NULL CONSTRAINT ck_message_link_path CHECK (link_path ~ '^/[a-z0-9][a-z0-9/_-]{0,199}$' AND link_path !~ '//'),
  ADD CONSTRAINT ck_message_staff CHECK (recipient_kind <> 'STAFF' OR principal_id IS NOT NULL);

CREATE OR REPLACE FUNCTION ntf.message_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  fixed text[] := ARRAY['id', 'idempotency_key', 'source_event_ref', 'source_event_type', 'branch_id', 'sales_order_id', 'template_id', 'channel',
                        'category', 'recipient_kind', 'customer_id', 'principal_id', 'rendered_body', 'rendered_subject', 'link_path', 'created_at', 'created_by'];
  k text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status NOT IN ('QUEUED', 'DEFERRED_QUIET_HOURS', 'SUPPRESSED') OR NEW.attempts <> 0 THEN
      RAISE EXCEPTION 'ntf.message %: a message is written QUEUED, DEFERRED_QUIET_HOURS or SUPPRESSED, never tried', NEW.id USING ERRCODE = 'HK004', CONSTRAINT = 'ck_message_transition';
    END IF;
    IF NEW.status = 'DEFERRED_QUIET_HOURS' AND NEW.send_after IS NULL THEN
      RAISE EXCEPTION 'ntf.message %: a deferred message says when it may go', NEW.id USING ERRCODE = 'HK004', CONSTRAINT = 'ck_message_transition';
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
       (OLD.status IN ('QUEUED', 'DEFERRED_QUIET_HOURS') AND NEW.status IN ('QUEUED', 'DEFERRED_QUIET_HOURS', 'SENT', 'FAILED', 'SUPPRESSED'))
    OR (OLD.status = 'SENT' AND NEW.status IN ('DELIVERED', 'FAILED'))
    OR (OLD.status = 'FAILED' AND NEW.status = 'QUEUED')) THEN
    RAISE EXCEPTION 'ntf.message %: % cannot move to %', OLD.id, OLD.status, NEW.status USING ERRCODE = 'HK004', CONSTRAINT = 'ck_message_transition';
  END IF;
  IF NEW.status = 'DEFERRED_QUIET_HOURS' AND NEW.send_after IS NULL THEN
    RAISE EXCEPTION 'ntf.message %: a deferred message says when it may go', OLD.id USING ERRCODE = 'HK004', CONSTRAINT = 'ck_message_transition';
  END IF;
  RETURN NEW;
END
$$;

-- Which event sends which template, to whom, by which channels in order (FR-NTF-002).
CREATE TABLE ntf.trigger_rule (
  id                  uuid PRIMARY KEY,
  event_type          text NOT NULL CONSTRAINT ck_trigger_rule_event_type CHECK (event_type ~ '^[a-z]{3,8}\.[A-Z][A-Za-z]+$'),
  template_code       text NOT NULL CONSTRAINT ck_trigger_rule_template_code CHECK (template_code ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  recipient_kind      text NOT NULL CONSTRAINT ck_trigger_rule_recipient_kind CHECK (recipient_kind IN ('CUSTOMER', 'CONTACT_ON_EVENT', 'ROLE', 'PRINCIPAL_ON_EVENT')),
  recipient_role_code text NULL CONSTRAINT ck_trigger_rule_role_code CHECK (recipient_role_code ~ '^[A-Z][A-Z_]{1,39}$'),
  channels            text[] NOT NULL CONSTRAINT ck_trigger_rule_channels CHECK (cardinality(channels) BETWEEN 1 AND 4 AND channels <@ ARRAY['SMS', 'WHATSAPP', 'EMAIL', 'IN_APP']::text[]),
  is_active           boolean NOT NULL DEFAULT true,
  version             integer NOT NULL DEFAULT 1,
  created_at          timestamptz NOT NULL,
  created_by          uuid NOT NULL CONSTRAINT fk_trigger_rule_created_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  updated_at          timestamptz NOT NULL,
  updated_by          uuid NOT NULL CONSTRAINT fk_trigger_rule_updated_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  deleted_at          timestamptz NULL,
  deleted_by          uuid NULL CONSTRAINT fk_trigger_rule_deleted_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  delete_reason       text NULL,
  CONSTRAINT ck_trigger_rule_role CHECK ((recipient_kind = 'ROLE') = (recipient_role_code IS NOT NULL)),
  CONSTRAINT ck_trigger_rule_soft_delete CHECK ((deleted_at IS NULL) = (deleted_by IS NULL) AND (deleted_at IS NULL) = (delete_reason IS NULL))
);
COMMENT ON TABLE ntf.trigger_rule IS 'class=MASTER';
CREATE UNIQUE INDEX uq_trigger_rule ON ntf.trigger_rule (event_type, template_code) WHERE deleted_at IS NULL;
CREATE TRIGGER trg_trigger_rule_version BEFORE UPDATE ON ntf.trigger_rule
  FOR EACH ROW EXECUTE FUNCTION platform.touch_version();

-- A recipient's channel preferences, in order, with quiet hours (FR-NTF-004, FR-NTF-006); a customer by its record, a
-- member of staff or an investor by their principal.
CREATE TABLE ntf.preference (
  id            uuid PRIMARY KEY,
  customer_id   uuid NULL CONSTRAINT fk_preference_customer REFERENCES mdm.customer (id) ON DELETE RESTRICT,
  principal_id  uuid NULL CONSTRAINT fk_preference_principal REFERENCES iam.principal (id) ON DELETE RESTRICT,
  category      text NOT NULL CONSTRAINT ck_preference_category CHECK (category IN ('TRANSACTIONAL', 'REMINDER', 'MARKETING', 'OPERATIONAL')),
  channel       text NOT NULL CONSTRAINT ck_preference_channel CHECK (channel IN ('SMS', 'WHATSAPP', 'EMAIL', 'IN_APP')),
  rank          integer NOT NULL CONSTRAINT ck_preference_rank CHECK (rank BETWEEN 1 AND 16),
  is_enabled    boolean NOT NULL,
  quiet_from    time NULL,
  quiet_to      time NULL,
  version       integer NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL,
  created_by    uuid NOT NULL CONSTRAINT fk_preference_created_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  updated_at    timestamptz NOT NULL,
  updated_by    uuid NOT NULL CONSTRAINT fk_preference_updated_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  deleted_at    timestamptz NULL,
  deleted_by    uuid NULL CONSTRAINT fk_preference_deleted_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  delete_reason text NULL,
  CONSTRAINT ck_preference_recipient CHECK ((customer_id IS NULL) <> (principal_id IS NULL)),
  CONSTRAINT ck_preference_quiet CHECK ((quiet_from IS NULL) = (quiet_to IS NULL) AND (quiet_from IS NULL OR quiet_from <> quiet_to)),
  CONSTRAINT ck_preference_quiet_category CHECK (quiet_from IS NULL OR category IN ('REMINDER', 'MARKETING')),
  CONSTRAINT ck_preference_soft_delete CHECK ((deleted_at IS NULL) = (deleted_by IS NULL) AND (deleted_at IS NULL) = (delete_reason IS NULL))
);
COMMENT ON TABLE ntf.preference IS 'class=MASTER';
CREATE UNIQUE INDEX uq_preference ON ntf.preference (customer_id, principal_id, category, channel) NULLS NOT DISTINCT WHERE deleted_at IS NULL;
CREATE TRIGGER trg_preference_version BEFORE UPDATE ON ntf.preference
  FOR EACH ROW EXECUTE FUNCTION platform.touch_version();

-- Every opt-out and opt-in a number sent or a member of staff recorded (FR-NTF-005); its latest row per channel is its
-- state. The number is kept only as its mask and its keyed hash (the message log's), so it outlives the customer record.
CREATE TABLE ntf.opt_out (
  id                 uuid PRIMARY KEY,
  address_hash       bytea NOT NULL CONSTRAINT ck_opt_out_address_hash CHECK (length(address_hash) = 32),
  address_masked     text NOT NULL CONSTRAINT ck_opt_out_address_masked CHECK (length(address_masked) BETWEEN 1 AND 40),
  channel            text NOT NULL CONSTRAINT ck_opt_out_channel CHECK (channel IN ('SMS', 'WHATSAPP', 'EMAIL')),
  direction          text NOT NULL CONSTRAINT ck_opt_out_direction CHECK (direction IN ('OPT_OUT', 'OPT_IN')),
  source             text NOT NULL CONSTRAINT ck_opt_out_source CHECK (source IN ('REPLY_STOP', 'REPLY_START')),
  provider_report_id uuid NULL CONSTRAINT fk_opt_out_provider_report REFERENCES ntf.provider_report (id) ON DELETE RESTRICT,
  occurred_at        timestamptz NOT NULL,
  recorded_at        timestamptz NOT NULL,
  actor_id           uuid NOT NULL CONSTRAINT fk_opt_out_actor REFERENCES iam.principal (id) ON DELETE RESTRICT,
  CONSTRAINT ck_opt_out_reply CHECK (source NOT LIKE 'REPLY_%' OR provider_report_id IS NOT NULL)
);
COMMENT ON TABLE ntf.opt_out IS 'class=LEDGER';
CREATE INDEX ix_opt_out_address ON ntf.opt_out (address_hash, channel, recorded_at DESC, id DESC);
CREATE INDEX ix_opt_out_recorded ON ntf.opt_out (recorded_at DESC, id DESC);
CREATE UNIQUE INDEX uq_opt_out_report ON ntf.opt_out (provider_report_id) WHERE provider_report_id IS NOT NULL;
CREATE TRIGGER trg_opt_out_immutable BEFORE UPDATE OR DELETE ON ntf.opt_out
  FOR EACH ROW EXECUTE FUNCTION platform.reject_change();
CREATE TRIGGER trg_opt_out_no_truncate BEFORE TRUNCATE ON ntf.opt_out
  FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_change();

-- The console's notifications (FR-NTF-008): each one a message on IN_APP, written by the sender, read by its own
-- recipient only.
CREATE TABLE ntf.in_app_notification (
  id           uuid PRIMARY KEY,
  principal_id uuid NOT NULL CONSTRAINT fk_in_app_notification_principal REFERENCES iam.principal (id) ON DELETE RESTRICT,
  message_id   uuid NOT NULL CONSTRAINT fk_in_app_notification_message REFERENCES ntf.message (id) ON DELETE RESTRICT,
  title        text NOT NULL CONSTRAINT ck_in_app_notification_title CHECK (length(title) BETWEEN 1 AND 300),
  body         text NOT NULL CONSTRAINT ck_in_app_notification_body CHECK (length(body) BETWEEN 1 AND 2000),
  link         text NULL CONSTRAINT ck_in_app_notification_link CHECK (link ~ '^/[a-z0-9][a-z0-9/_-]{0,199}$' AND link !~ '//'),
  read_at      timestamptz NULL,
  created_at   timestamptz NOT NULL,
  CONSTRAINT uq_in_app_notification_message UNIQUE (message_id)
);
COMMENT ON TABLE ntf.in_app_notification IS 'class=WORK';
CREATE INDEX ix_in_app_notification_mine ON ntf.in_app_notification (principal_id, created_at DESC, id DESC);

CREATE FUNCTION ntf.in_app_notification_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF to_jsonb(NEW) - 'read_at' IS DISTINCT FROM to_jsonb(OLD) - 'read_at' THEN
    RAISE EXCEPTION 'ntf.in_app_notification %: only its read state changes', OLD.id USING ERRCODE = 'HK004', CONSTRAINT = 'ck_in_app_notification_transition';
  END IF;
  IF OLD.read_at IS NOT NULL AND NEW.read_at IS DISTINCT FROM OLD.read_at THEN
    RAISE EXCEPTION 'ntf.in_app_notification %: it is read once', OLD.id USING ERRCODE = 'HK004', CONSTRAINT = 'ck_in_app_notification_transition';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER trg_in_app_notification_guard BEFORE UPDATE ON ntf.in_app_notification
  FOR EACH ROW EXECUTE FUNCTION ntf.in_app_notification_guard();

REVOKE ALL ON ntf.trigger_rule, ntf.preference, ntf.opt_out, ntf.in_app_notification FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON ntf.trigger_rule, ntf.preference TO hk_app, hk_worker;
GRANT SELECT, INSERT ON ntf.opt_out TO hk_app, hk_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON ntf.in_app_notification TO hk_app, hk_worker;

-- The payment reminders WHL's seeded levels name (PAYMENT_REMINDER_1 to 3) and the returned death report, one active
-- version each, written by the System principal with no activation of its own (A-374 (e)).
INSERT INTO ntf.template (id, code, channel, locale, category, subject, body, version_no, status, created_at, created_by, updated_at, updated_by) VALUES
  ('019a7c00-0000-7000-8000-000000000008', 'PAYMENT_REMINDER_1', 'SMS', 'en-GH', 'REMINDER', NULL,
   'HaKorem Farms: dear {{customerName}}, {{documentNo}} for {{outstanding}} is now {{daysPastDue}} days overdue. Please pay at your earliest convenience.', 1, 'ACTIVE',
   platform.app_now(), '01900000-0000-7000-8000-000000000001', platform.app_now(), '01900000-0000-7000-8000-000000000001'),
  ('019a7c00-0000-7000-8000-000000000009', 'PAYMENT_REMINDER_2', 'SMS', 'en-GH', 'REMINDER', NULL,
   'HaKorem Farms: dear {{customerName}}, {{documentNo}} for {{outstanding}} is {{daysPastDue}} days overdue. Please pay now or call us.', 1, 'ACTIVE',
   platform.app_now(), '01900000-0000-7000-8000-000000000001', platform.app_now(), '01900000-0000-7000-8000-000000000001'),
  ('019a7c00-0000-7000-8000-00000000000a', 'PAYMENT_REMINDER_3', 'SMS', 'en-GH', 'REMINDER', NULL,
   'HaKorem Farms: dear {{customerName}}, {{documentNo}} for {{outstanding}} is {{daysPastDue}} days overdue. Your account may be held until it is paid.', 1, 'ACTIVE',
   platform.app_now(), '01900000-0000-7000-8000-000000000001', platform.app_now(), '01900000-0000-7000-8000-000000000001'),
  ('019a7c00-0000-7000-8000-00000000000b', 'MORTALITY_RETURNED', 'IN_APP', 'en-GH', 'OPERATIONAL', 'Death report sent back',
   'The death report of {{tagNo}} came back to you: {{reason}}. Report it again with a new photograph.', 1, 'ACTIVE',
   platform.app_now(), '01900000-0000-7000-8000-000000000001', platform.app_now(), '01900000-0000-7000-8000-000000000001');

-- Every message NTF sends, as a trigger (A-376 (c)): the customer's by SMS to the record's own contact, the reminders
-- by the level's channels that the trigger allows, the returned death report in the console to its reporter.
INSERT INTO ntf.trigger_rule (id, event_type, template_code, recipient_kind, recipient_role_code, channels, created_at, created_by, updated_at, updated_by) VALUES
  ('019a7c01-0000-7000-8000-000000000001', 'ord.OrderDispatched', 'ORDER_DISPATCHED', 'CONTACT_ON_EVENT', NULL, ARRAY['SMS'], platform.app_now(), '01900000-0000-7000-8000-000000000001', platform.app_now(), '01900000-0000-7000-8000-000000000001'),
  ('019a7c01-0000-7000-8000-000000000002', 'ord.OrderCollected', 'ORDER_COLLECTED', 'CONTACT_ON_EVENT', NULL, ARRAY['SMS'], platform.app_now(), '01900000-0000-7000-8000-000000000001', platform.app_now(), '01900000-0000-7000-8000-000000000001'),
  ('019a7c01-0000-7000-8000-000000000003', 'del.DeliveryOnTheWay', 'DELIVERY_ON_THE_WAY', 'CONTACT_ON_EVENT', NULL, ARRAY['SMS'], platform.app_now(), '01900000-0000-7000-8000-000000000001', platform.app_now(), '01900000-0000-7000-8000-000000000001'),
  ('019a7c01-0000-7000-8000-000000000004', 'del.DeliveryRescheduled', 'DELIVERY_RESCHEDULED', 'CONTACT_ON_EVENT', NULL, ARRAY['SMS'], platform.app_now(), '01900000-0000-7000-8000-000000000001', platform.app_now(), '01900000-0000-7000-8000-000000000001'),
  ('019a7c01-0000-7000-8000-000000000005', 'del.DeliveryCancelled', 'DELIVERY_CANCELLED', 'CONTACT_ON_EVENT', NULL, ARRAY['SMS'], platform.app_now(), '01900000-0000-7000-8000-000000000001', platform.app_now(), '01900000-0000-7000-8000-000000000001'),
  ('019a7c01-0000-7000-8000-000000000006', 'del.DeliveryCompleted', 'DELIVERY_COMPLETED', 'CONTACT_ON_EVENT', NULL, ARRAY['SMS'], platform.app_now(), '01900000-0000-7000-8000-000000000001', platform.app_now(), '01900000-0000-7000-8000-000000000001'),
  ('019a7c01-0000-7000-8000-000000000007', 'del.DeliveryCompleted', 'DELIVERY_PART_COMPLETED', 'CONTACT_ON_EVENT', NULL, ARRAY['SMS'], platform.app_now(), '01900000-0000-7000-8000-000000000001', platform.app_now(), '01900000-0000-7000-8000-000000000001'),
  ('019a7c01-0000-7000-8000-000000000008', 'whl.DunningNoticeDue', 'PAYMENT_REMINDER_1', 'CUSTOMER', NULL, ARRAY['SMS', 'WHATSAPP', 'EMAIL'], platform.app_now(), '01900000-0000-7000-8000-000000000001', platform.app_now(), '01900000-0000-7000-8000-000000000001'),
  ('019a7c01-0000-7000-8000-000000000009', 'whl.DunningNoticeDue', 'PAYMENT_REMINDER_2', 'CUSTOMER', NULL, ARRAY['SMS', 'WHATSAPP', 'EMAIL'], platform.app_now(), '01900000-0000-7000-8000-000000000001', platform.app_now(), '01900000-0000-7000-8000-000000000001'),
  ('019a7c01-0000-7000-8000-00000000000a', 'whl.DunningNoticeDue', 'PAYMENT_REMINDER_3', 'CUSTOMER', NULL, ARRAY['SMS', 'WHATSAPP', 'EMAIL'], platform.app_now(), '01900000-0000-7000-8000-000000000001', platform.app_now(), '01900000-0000-7000-8000-000000000001'),
  ('019a7c01-0000-7000-8000-00000000000b', 'liv.MortalityReturned', 'MORTALITY_RETURNED', 'PRINCIPAL_ON_EVENT', NULL, ARRAY['IN_APP'], platform.app_now(), '01900000-0000-7000-8000-000000000001', platform.app_now(), '01900000-0000-7000-8000-000000000001');

-- migrate:down
DELETE FROM ntf.template WHERE id IN ('019a7c00-0000-7000-8000-000000000008', '019a7c00-0000-7000-8000-000000000009', '019a7c00-0000-7000-8000-00000000000a', '019a7c00-0000-7000-8000-00000000000b');
DROP TABLE ntf.in_app_notification;
DROP FUNCTION ntf.in_app_notification_guard();
DROP TABLE ntf.opt_out;
DROP TABLE ntf.preference;
DROP TABLE ntf.trigger_rule;
CREATE OR REPLACE FUNCTION ntf.message_guard() RETURNS trigger
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
ALTER TABLE ntf.message DROP CONSTRAINT ck_message_staff, DROP COLUMN link_path, DROP COLUMN rendered_subject;
ALTER TABLE ntf.template DROP CONSTRAINT ck_template_subject_titled;
ALTER TABLE ntf.template ADD CONSTRAINT ck_template_subject_email CHECK ((channel = 'EMAIL') = (subject IS NOT NULL));
