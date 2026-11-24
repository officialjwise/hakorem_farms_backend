-- 0343_ntf_document_sends
-- Notifications, fourth pass (docs/data-model/ntf.md; FR-NTF-002, FR-NTF-003; B11 continued 13, ADR-0062, ADR-0084,
-- ADR-0099, A-288): a billing document or a customer's statement sent on request (`sendBillingDocument`,
-- `sendStatement`) and a supplier's remittance advice once per payment (`pur.SupplierRemittanceReady`), each carrying a
-- document link of its own made by DOC at send, and each reminder's delivery handed back to WHL's dunning notice.
-- The database holds the rules:
--   ck_message_recipient_kind   adds SUPPLIER (a remittance advice goes to the supplier's own contact, read through MDM)
--   ck_message_supplier         a SUPPLIER message names its supplier (supplier_id, a published key of MDM)
--   record_id                   the record the message is about, as its idempotency key names it (the dunning notice,
--                               the send, the remittance), so the notice it reports on is never guessed from text
--   ntf.message_record_fixed()  the supplier and the record never change (HK004)
--   ck_trigger_rule_recipient_kind  adds SUPPLIER
-- Seeds the document templates (SMS, WhatsApp and email, the email with a subject) and three triggers.
-- Rollback: tested before the first document send; afterwards only a forward fix (the rows are the log).

-- migrate:up
ALTER TABLE ntf.message
  ADD COLUMN supplier_id uuid NULL CONSTRAINT fk_message_supplier REFERENCES mdm.supplier (id) ON DELETE RESTRICT,
  ADD COLUMN record_id uuid NULL;
ALTER TABLE ntf.message DROP CONSTRAINT ck_message_recipient_kind;
ALTER TABLE ntf.message ADD CONSTRAINT ck_message_recipient_kind CHECK (recipient_kind IN ('CUSTOMER', 'STAFF', 'INVESTOR', 'CONTACT', 'SUPPLIER'));
ALTER TABLE ntf.message ADD CONSTRAINT ck_message_supplier CHECK ((recipient_kind = 'SUPPLIER') = (supplier_id IS NOT NULL));
CREATE INDEX ix_message_record ON ntf.message (record_id) WHERE record_id IS NOT NULL;

CREATE FUNCTION ntf.message_record_fixed() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.supplier_id IS DISTINCT FROM OLD.supplier_id OR NEW.record_id IS DISTINCT FROM OLD.record_id THEN
    RAISE EXCEPTION 'ntf.message %: whom and what a message is about never changes', OLD.id USING ERRCODE = 'HK004', CONSTRAINT = 'ck_message_transition';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION ntf.message_record_fixed() FROM PUBLIC;
CREATE TRIGGER trg_message_record_fixed BEFORE UPDATE ON ntf.message
  FOR EACH ROW EXECUTE FUNCTION ntf.message_record_fixed();

ALTER TABLE ntf.trigger_rule DROP CONSTRAINT ck_trigger_rule_recipient_kind;
ALTER TABLE ntf.trigger_rule ADD CONSTRAINT ck_trigger_rule_recipient_kind CHECK (recipient_kind IN ('CUSTOMER', 'CONTACT_ON_EVENT', 'ROLE', 'PRINCIPAL_ON_EVENT', 'SUPPLIER'));

-- The document sends, drafted and active as the seeded system's own (as 0335, 0338 and 0339 seed theirs); a manager
-- drafts the next version and another activates it. WhatsApp has no adapter yet: a message routed to it fails visibly.
INSERT INTO ntf.template (id, code, channel, locale, category, subject, body, version_no, status, created_at, created_by, updated_at, updated_by) VALUES
  ('019a7c00-0000-7000-8000-00000000000f', 'DOCUMENT_SENT', 'SMS', 'en-GH', 'TRANSACTIONAL', NULL,
   'HaKorem Farms: your {{documentType}} {{documentNo}} for {{total}}. View it here: {{link}}', 1, 'ACTIVE',
   platform.app_now(), '01900000-0000-7000-8000-000000000001', platform.app_now(), '01900000-0000-7000-8000-000000000001'),
  ('019a7c00-0000-7000-8000-000000000010', 'DOCUMENT_SENT', 'WHATSAPP', 'en-GH', 'TRANSACTIONAL', NULL,
   'HaKorem Farms: your {{documentType}} {{documentNo}} for {{total}}. View it here: {{link}}', 1, 'ACTIVE',
   platform.app_now(), '01900000-0000-7000-8000-000000000001', platform.app_now(), '01900000-0000-7000-8000-000000000001'),
  ('019a7c00-0000-7000-8000-000000000011', 'DOCUMENT_SENT', 'EMAIL', 'en-GH', 'TRANSACTIONAL', 'Your {{documentType}} {{documentNo}} from HaKorem Farms',
   'Your {{documentType}} {{documentNo}} for {{total}} is attached. You can also view it here: {{link}}', 1, 'ACTIVE',
   platform.app_now(), '01900000-0000-7000-8000-000000000001', platform.app_now(), '01900000-0000-7000-8000-000000000001'),
  ('019a7c00-0000-7000-8000-000000000012', 'REMITTANCE_ADVICE', 'SMS', 'en-GH', 'TRANSACTIONAL', NULL,
   'HaKorem Farms paid {{supplierName}} {{amount}} on {{paidOn}}. Remittance advice: {{link}}', 1, 'ACTIVE',
   platform.app_now(), '01900000-0000-7000-8000-000000000001', platform.app_now(), '01900000-0000-7000-8000-000000000001'),
  ('019a7c00-0000-7000-8000-000000000013', 'REMITTANCE_ADVICE', 'WHATSAPP', 'en-GH', 'TRANSACTIONAL', NULL,
   'HaKorem Farms paid {{supplierName}} {{amount}} on {{paidOn}}. Remittance advice: {{link}}', 1, 'ACTIVE',
   platform.app_now(), '01900000-0000-7000-8000-000000000001', platform.app_now(), '01900000-0000-7000-8000-000000000001'),
  ('019a7c00-0000-7000-8000-000000000014', 'REMITTANCE_ADVICE', 'EMAIL', 'en-GH', 'TRANSACTIONAL', 'Remittance advice from HaKorem Farms',
   'HaKorem Farms paid {{supplierName}} {{amount}} on {{paidOn}}. The remittance advice is attached. You can also view it here: {{link}}', 1, 'ACTIVE',
   platform.app_now(), '01900000-0000-7000-8000-000000000001', platform.app_now(), '01900000-0000-7000-8000-000000000001');

INSERT INTO ntf.trigger_rule (id, event_type, template_code, recipient_kind, recipient_role_code, channels, created_at, created_by, updated_at, updated_by) VALUES
  ('019a7c01-0000-7000-8000-00000000000f', 'bil.DocumentSendRequested', 'DOCUMENT_SENT', 'CUSTOMER', NULL, ARRAY['SMS', 'WHATSAPP', 'EMAIL'], platform.app_now(), '01900000-0000-7000-8000-000000000001', platform.app_now(), '01900000-0000-7000-8000-000000000001'),
  ('019a7c01-0000-7000-8000-000000000010', 'whl.StatementSendRequested', 'DOCUMENT_SENT', 'CUSTOMER', NULL, ARRAY['SMS', 'WHATSAPP', 'EMAIL'], platform.app_now(), '01900000-0000-7000-8000-000000000001', platform.app_now(), '01900000-0000-7000-8000-000000000001'),
  ('019a7c01-0000-7000-8000-000000000011', 'pur.SupplierRemittanceReady', 'REMITTANCE_ADVICE', 'SUPPLIER', NULL, ARRAY['SMS', 'EMAIL'], platform.app_now(), '01900000-0000-7000-8000-000000000001', platform.app_now(), '01900000-0000-7000-8000-000000000001');

-- migrate:down
DELETE FROM ntf.trigger_rule WHERE id IN ('019a7c01-0000-7000-8000-00000000000f', '019a7c01-0000-7000-8000-000000000010', '019a7c01-0000-7000-8000-000000000011');
DELETE FROM ntf.template WHERE id IN ('019a7c00-0000-7000-8000-00000000000f', '019a7c00-0000-7000-8000-000000000010', '019a7c00-0000-7000-8000-000000000011',
                                      '019a7c00-0000-7000-8000-000000000012', '019a7c00-0000-7000-8000-000000000013', '019a7c00-0000-7000-8000-000000000014');
ALTER TABLE ntf.trigger_rule DROP CONSTRAINT ck_trigger_rule_recipient_kind;
ALTER TABLE ntf.trigger_rule ADD CONSTRAINT ck_trigger_rule_recipient_kind CHECK (recipient_kind IN ('CUSTOMER', 'CONTACT_ON_EVENT', 'ROLE', 'PRINCIPAL_ON_EVENT'));
DROP TRIGGER trg_message_record_fixed ON ntf.message;
DROP FUNCTION ntf.message_record_fixed();
DROP INDEX ntf.ix_message_record;
ALTER TABLE ntf.message DROP CONSTRAINT ck_message_supplier;
ALTER TABLE ntf.message DROP CONSTRAINT ck_message_recipient_kind;
ALTER TABLE ntf.message ADD CONSTRAINT ck_message_recipient_kind CHECK (recipient_kind IN ('CUSTOMER', 'STAFF', 'INVESTOR', 'CONTACT'));
ALTER TABLE ntf.message DROP COLUMN record_id, DROP COLUMN supplier_id;
