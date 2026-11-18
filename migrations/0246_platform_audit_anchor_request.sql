-- 0246_platform_audit_anchor_request
-- B09b continued 1b (ADR-0006 stage three, "at every shift close"; A-275): a module asks, in its own business
-- transaction, for the audit chain to be anchored once that transaction's audit events are sealed. The worker, as
-- hk_sealer, seals, signs the chain head off the server (platform.audit_anchor, reason SHIFT_CLOSE) and records which
-- anchor answered each request. POS asks at each count sign-off and at each count of a force-closed shift.
--   platform.audit_anchor_request      LEDGER, insert-only, by the application: the reason, the subject (one request
--                                      per reason and subject, uq_audit_anchor_request_subject) and the transaction it
--                                      was written in (txid), so the worker anchors only once that transaction's audit
--                                      events are in the chain.
--   platform.audit_anchor_fulfilment   LEDGER, insert-only, written by hk_sealer alone: the anchor that covers the
--                                      request, once.
-- Data category: internal.
-- Rollback: tested (`pnpm db:rollback`); the requests and fulfilments are dropped with the tables (the anchors stay).

-- migrate:up
CREATE TABLE platform.audit_anchor_request (
  id           uuid PRIMARY KEY,
  reason       text NOT NULL CONSTRAINT ck_audit_anchor_request_reason CHECK (reason IN ('SHIFT_CLOSE')),
  subject_type text NOT NULL CONSTRAINT ck_audit_anchor_request_subject_type CHECK (subject_type ~ '^[A-Z][A-Za-z]{2,40}$'),
  subject_id   uuid NOT NULL,
  txid         xid8 NOT NULL DEFAULT pg_current_xact_id(),
  recorded_at  timestamptz NOT NULL,
  actor_id     uuid NOT NULL CONSTRAINT fk_audit_anchor_request_actor REFERENCES iam.principal (id) ON DELETE RESTRICT,
  CONSTRAINT uq_audit_anchor_request_subject UNIQUE (reason, subject_id)
);
COMMENT ON TABLE platform.audit_anchor_request IS 'class=LEDGER';
CREATE TRIGGER trg_audit_anchor_request_immutable BEFORE UPDATE OR DELETE ON platform.audit_anchor_request
  FOR EACH ROW EXECUTE FUNCTION platform.reject_change();
CREATE TRIGGER trg_audit_anchor_request_no_truncate BEFORE TRUNCATE ON platform.audit_anchor_request
  FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_change();

CREATE TABLE platform.audit_anchor_fulfilment (
  request_id  uuid PRIMARY KEY CONSTRAINT fk_audit_anchor_fulfilment_request REFERENCES platform.audit_anchor_request (id) ON DELETE RESTRICT,
  anchor_id   uuid NOT NULL CONSTRAINT fk_audit_anchor_fulfilment_anchor REFERENCES platform.audit_anchor (id) ON DELETE RESTRICT,
  recorded_at timestamptz NOT NULL,
  actor_id    uuid NOT NULL DEFAULT '01900000-0000-7000-8000-000000000002'
                CONSTRAINT fk_audit_anchor_fulfilment_actor REFERENCES iam.principal (id) ON DELETE RESTRICT
);
COMMENT ON TABLE platform.audit_anchor_fulfilment IS 'class=LEDGER;writer=hk_sealer';
CREATE INDEX ix_audit_anchor_fulfilment_anchor ON platform.audit_anchor_fulfilment (anchor_id);
CREATE TRIGGER trg_audit_anchor_fulfilment_immutable BEFORE UPDATE OR DELETE ON platform.audit_anchor_fulfilment
  FOR EACH ROW EXECUTE FUNCTION platform.reject_change();
CREATE TRIGGER trg_audit_anchor_fulfilment_no_truncate BEFORE TRUNCATE ON platform.audit_anchor_fulfilment
  FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_change();

REVOKE ALL ON platform.audit_anchor_request, platform.audit_anchor_fulfilment FROM PUBLIC;
GRANT SELECT, INSERT ON platform.audit_anchor_request TO hk_app, hk_worker;
GRANT SELECT ON platform.audit_anchor_request TO hk_sealer;
GRANT SELECT ON platform.audit_anchor_fulfilment TO hk_app, hk_worker;
GRANT SELECT, INSERT ON platform.audit_anchor_fulfilment TO hk_sealer;

-- migrate:down
DROP TABLE platform.audit_anchor_fulfilment;
DROP TABLE platform.audit_anchor_request;
