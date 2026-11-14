-- 0006_iam_create_approval_request
-- One maker-checker mechanism for every module (ADR-0017). The rule that the maker cannot be the checker is a
-- database constraint. `evidence_file_id` references platform.stored_file, which the file store creates in B4;
-- that session adds the column by an expand migration (docs/DATA_MODEL.md, Migrations).
-- Data category: INTERNAL.

-- migrate:up
CREATE TABLE iam.approval_request (
  id                  uuid PRIMARY KEY,
  kind                text NOT NULL CONSTRAINT ck_approval_request_kind CHECK (kind ~ '^[A-Z][A-Z_]{2,39}$'),
  branch_id           uuid NOT NULL CONSTRAINT fk_approval_request_branch REFERENCES mdm.branch (id) ON DELETE RESTRICT,
  subject_document_id uuid NOT NULL CONSTRAINT fk_approval_request_subject REFERENCES platform.business_document (id) ON DELETE RESTRICT,
  payload_hash        bytea NOT NULL CONSTRAINT ck_approval_request_payload_hash CHECK (length(payload_hash) = 32),
  amount_pesewas      platform.pesewas NULL,
  summary             text NOT NULL CONSTRAINT ck_approval_request_summary CHECK (length(btrim(summary)) BETWEEN 1 AND 500),
  requested_by        uuid NOT NULL CONSTRAINT fk_approval_request_requested_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  requested_at        timestamptz NOT NULL DEFAULT now(),
  status              text NOT NULL CONSTRAINT ck_approval_request_status CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'EXPIRED')),
  decided_by          uuid NULL CONSTRAINT fk_approval_request_decided_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  decided_at          timestamptz NULL,
  decision_reason     text NULL,
  expires_at          timestamptz NULL,
  version             integer NOT NULL DEFAULT 1,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  -- The maker cannot be the checker (security architecture, section 4).
  CONSTRAINT ck_approval_request_maker_not_checker CHECK (decided_by IS NULL OR decided_by <> requested_by),
  CONSTRAINT ck_approval_request_decision CHECK (
    (status IN ('APPROVED', 'REJECTED')) = (decided_by IS NOT NULL AND decided_at IS NOT NULL)),
  CONSTRAINT ck_approval_request_rejection_reason CHECK (status <> 'REJECTED' OR decision_reason IS NOT NULL),
  CONSTRAINT ck_approval_request_expiry CHECK (expires_at IS NULL OR expires_at > requested_at)
);
COMMENT ON TABLE iam.approval_request IS 'class=DOCUMENT';
CREATE UNIQUE INDEX uq_approval_request_open ON iam.approval_request (subject_document_id, kind) WHERE status = 'PENDING';
CREATE INDEX ix_approval_request_branch_pending ON iam.approval_request (branch_id, requested_at) WHERE status = 'PENDING';
CREATE TRIGGER trg_approval_request_version BEFORE UPDATE ON iam.approval_request
  FOR EACH ROW EXECUTE FUNCTION platform.touch_version();
-- Frozen once decided: nothing changes after APPROVED, REJECTED, CANCELLED or EXPIRED.
CREATE TRIGGER trg_approval_request_frozen BEFORE UPDATE ON iam.approval_request
  FOR EACH ROW EXECUTE FUNCTION platform.freeze_posted('APPROVED,REJECTED,CANCELLED,EXPIRED');

REVOKE ALL ON iam.approval_request FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON iam.approval_request TO hk_app, hk_worker;

-- migrate:down
DROP TABLE iam.approval_request;
