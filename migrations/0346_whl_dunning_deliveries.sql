-- 0346_whl_dunning_deliveries
-- B11 continued 13 (FR-WHL-011, FR-NTF-007; the owner, 2026-11-23, from the frontend's F12 and F10n; A-289): a dunning
-- level picks one of the reminder templates NTF lists (`listNotificationTemplates`, PAYMENT_REMINDER_1 to 3) instead of
-- a typed code, and each reminder's delivery is recorded on its notice per channel, so a failed reminder shows as failed.
--   ck_dunning_policy_template      a live level names a reminder template: PAYMENT_REMINDER_1, _2 or _3 (a level
--                                   removed earlier keeps whatever it named)
--   whl.dunning_notice_delivery     LEDGER, insert-only: what NTF reported of a notice's reminder on a channel (SENT,
--                                   DELIVERED, FAILED), with the time and NTF's message; once per message and status
--                                   (uq_dunning_notice_delivery), written by NTF through `Dunning.recordDeliveryIn`
-- Every time is written by the application from its clock (ADR-0067); nothing here reads now().
-- Data category: CONFIDENTIAL (DC-24): which reminder reached which customer, on which channel.
-- Rollback: tested before the first delivery; afterwards the rows are evidence and only a forward fix applies.

-- migrate:up
ALTER TABLE whl.dunning_policy DROP CONSTRAINT ck_dunning_policy_template;
ALTER TABLE whl.dunning_policy ADD CONSTRAINT ck_dunning_policy_template
  CHECK (template_code ~ '^[A-Z][A-Z0-9_]{1,59}$' AND (deleted_at IS NOT NULL OR template_code IN ('PAYMENT_REMINDER_1', 'PAYMENT_REMINDER_2', 'PAYMENT_REMINDER_3')));

CREATE TABLE whl.dunning_notice_delivery (
  id                uuid PRIMARY KEY,
  dunning_notice_id uuid NOT NULL CONSTRAINT fk_dunning_notice_delivery_notice REFERENCES whl.dunning_notice (id) ON DELETE RESTRICT,
  channel           text NOT NULL CONSTRAINT ck_dunning_notice_delivery_channel CHECK (channel IN ('SMS', 'EMAIL', 'WHATSAPP')),
  status            text NOT NULL CONSTRAINT ck_dunning_notice_delivery_status CHECK (status IN ('SENT', 'DELIVERED', 'FAILED')),
  message_ref       uuid NOT NULL,
  occurred_at       timestamptz NOT NULL,
  recorded_at       timestamptz NOT NULL,
  actor_id          uuid NOT NULL CONSTRAINT fk_dunning_notice_delivery_actor REFERENCES iam.principal (id) ON DELETE RESTRICT,
  CONSTRAINT uq_dunning_notice_delivery UNIQUE (message_ref, status)
);
COMMENT ON TABLE whl.dunning_notice_delivery IS 'class=LEDGER';
CREATE INDEX ix_dunning_notice_delivery_notice ON whl.dunning_notice_delivery (dunning_notice_id, occurred_at);
CREATE TRIGGER trg_dunning_notice_delivery_immutable BEFORE UPDATE OR DELETE ON whl.dunning_notice_delivery
  FOR EACH ROW EXECUTE FUNCTION platform.reject_change();
CREATE TRIGGER trg_dunning_notice_delivery_no_truncate BEFORE TRUNCATE ON whl.dunning_notice_delivery
  FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_change();

REVOKE ALL ON whl.dunning_notice_delivery FROM PUBLIC;
GRANT SELECT, INSERT ON whl.dunning_notice_delivery TO hk_app, hk_worker;

-- migrate:down
DROP TABLE whl.dunning_notice_delivery;
ALTER TABLE whl.dunning_policy DROP CONSTRAINT ck_dunning_policy_template;
ALTER TABLE whl.dunning_policy ADD CONSTRAINT ck_dunning_policy_template CHECK (template_code ~ '^[A-Z][A-Z0-9_]{1,59}$');
