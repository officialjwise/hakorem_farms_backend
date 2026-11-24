-- 0339_ntf_message_links
-- Notifications, third pass (docs/data-model/ntf.md; FR-NTF-002, FR-NTF-003; B11 continued 12, ADR-0084, A-349): a
-- message may carry a link that the sending worker asks the record's own module for just before the provider call
-- (ADR-0074), so the stored text keeps the `{{link}}` merge field unfilled and no token is ever kept in the outbox or the
-- message row. The message names which kind of record its link opens and the record; the guest's tracking SMS (an
-- online order placed), the receipt SMS (a counter sale synced from a till) and the abandoned-cart reminder (MARKETING,
-- shp.CartAbandoned) are seeded as templates and triggers.
-- The database holds the rules:
--   ck_message_link            a link kind and its record both or neither; the kinds are fixed
--   ck_message_link_placeholder  a message that carries a link keeps its placeholder, and no other message has one
--   ntf.message_link_fixed()   what a message links to never changes (HK004)
--   ck_message_suppressed_reason  adds NO_LINK (the record's module made no link: a sale with no till link) and
--                                 NO_CONSENT (a marketing message to a customer who has not consented)

-- migrate:up
ALTER TABLE ntf.message
  ADD COLUMN link_kind text NULL CONSTRAINT ck_message_link_kind CHECK (link_kind IN ('TRACKING', 'RECEIPT', 'CART', 'DOCUMENT')),
  ADD COLUMN link_record_id uuid NULL,
  ADD CONSTRAINT ck_message_link CHECK ((link_kind IS NULL) = (link_record_id IS NULL)),
  ADD CONSTRAINT ck_message_link_placeholder CHECK ((link_kind IS NOT NULL) = (position('{{link}}' IN rendered_body) > 0));

ALTER TABLE ntf.message DROP CONSTRAINT ck_message_suppressed_reason;
ALTER TABLE ntf.message ADD CONSTRAINT ck_message_suppressed_reason
  CHECK (suppressed_reason IN ('NO_ADDRESS', 'RATE_LIMITED', 'OPTED_OUT', 'PREFERENCE_OFF', 'NO_LINK', 'NO_CONSENT'));

CREATE FUNCTION ntf.message_link_fixed() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.link_kind IS DISTINCT FROM OLD.link_kind OR NEW.link_record_id IS DISTINCT FROM OLD.link_record_id THEN
    RAISE EXCEPTION 'ntf.message %: what a message links to never changes', OLD.id USING ERRCODE = 'HK004', CONSTRAINT = 'ck_message_transition';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION ntf.message_link_fixed() FROM PUBLIC;
CREATE TRIGGER trg_message_link_fixed BEFORE UPDATE ON ntf.message
  FOR EACH ROW EXECUTE FUNCTION ntf.message_link_fixed();

-- The two link messages of CR-033 point 3 and the guest's tracking link, drafted and active as the seeded system's own
-- (as 0335 and 0338 seed theirs); a manager drafts the next version and another activates it.
INSERT INTO ntf.template (id, code, channel, locale, category, subject, body, version_no, status, created_at, created_by, updated_at, updated_by) VALUES
  ('019a7c00-0000-7000-8000-00000000000c', 'ORDER_TRACKING', 'SMS', 'en-GH', 'TRANSACTIONAL', NULL,
   'HaKorem Farms: thank you for order {{orderNo}}. Follow it here: {{link}}', 1, 'ACTIVE',
   platform.app_now(), '01900000-0000-7000-8000-000000000001', platform.app_now(), '01900000-0000-7000-8000-000000000001'),
  ('019a7c00-0000-7000-8000-00000000000d', 'SALE_RECEIPT', 'SMS', 'en-GH', 'TRANSACTIONAL', NULL,
   'HaKorem Farms: receipt {{receiptNo}} for {{total}}, sale {{saleReference}}. Your receipt: {{link}}', 1, 'ACTIVE',
   platform.app_now(), '01900000-0000-7000-8000-000000000001', platform.app_now(), '01900000-0000-7000-8000-000000000001'),
  ('019a7c00-0000-7000-8000-00000000000e', 'CART_REMINDER', 'SMS', 'en-GH', 'MARKETING', NULL,
   'HaKorem Farms: {{customerName}}, your cart is still saved. Finish your order here: {{link}} Reply STOP to stop these messages.', 1, 'ACTIVE',
   platform.app_now(), '01900000-0000-7000-8000-000000000001', platform.app_now(), '01900000-0000-7000-8000-000000000001');

INSERT INTO ntf.trigger_rule (id, event_type, template_code, recipient_kind, recipient_role_code, channels, created_at, created_by, updated_at, updated_by) VALUES
  ('019a7c01-0000-7000-8000-00000000000c', 'ord.OrderPlaced', 'ORDER_TRACKING', 'CONTACT_ON_EVENT', NULL, ARRAY['SMS'], platform.app_now(), '01900000-0000-7000-8000-000000000001', platform.app_now(), '01900000-0000-7000-8000-000000000001'),
  ('019a7c01-0000-7000-8000-00000000000d', 'ord.OrderCompleted', 'SALE_RECEIPT', 'CONTACT_ON_EVENT', NULL, ARRAY['SMS'], platform.app_now(), '01900000-0000-7000-8000-000000000001', platform.app_now(), '01900000-0000-7000-8000-000000000001'),
  ('019a7c01-0000-7000-8000-00000000000e', 'shp.CartAbandoned', 'CART_REMINDER', 'CUSTOMER', NULL, ARRAY['SMS'], platform.app_now(), '01900000-0000-7000-8000-000000000001', platform.app_now(), '01900000-0000-7000-8000-000000000001');

-- migrate:down
DELETE FROM ntf.trigger_rule WHERE id IN ('019a7c01-0000-7000-8000-00000000000c', '019a7c01-0000-7000-8000-00000000000d', '019a7c01-0000-7000-8000-00000000000e');
DELETE FROM ntf.template WHERE id IN ('019a7c00-0000-7000-8000-00000000000c', '019a7c00-0000-7000-8000-00000000000d', '019a7c00-0000-7000-8000-00000000000e');
DROP TRIGGER trg_message_link_fixed ON ntf.message;
DROP FUNCTION ntf.message_link_fixed();
ALTER TABLE ntf.message DROP CONSTRAINT ck_message_suppressed_reason;
ALTER TABLE ntf.message ADD CONSTRAINT ck_message_suppressed_reason CHECK (suppressed_reason IN ('NO_ADDRESS', 'RATE_LIMITED', 'OPTED_OUT', 'PREFERENCE_OFF'));
ALTER TABLE ntf.message DROP CONSTRAINT ck_message_link_placeholder, DROP CONSTRAINT ck_message_link, DROP COLUMN link_record_id, DROP COLUMN link_kind;
