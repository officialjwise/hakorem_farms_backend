-- 0098_pur_supplier_register
-- The supplier register's procurement half (docs/data-model/pur.md; FR-PUR-001 to FR-PUR-003; ADR-0022; A-166):
-- a supplier's commercial profile (terms, lead time, notes and the payout details in force), each change of payout
-- details as its own document awaiting a different person's approval (SUPPLIER_PAYOUT_CHANGE), the documents held for
-- a supplier in the file store, and the payout details each supplier payment pays to.
--
-- Payout details are restricted data: `payout_details_enc` holds only ciphertext sealed with the supplier's own key
-- (platform.subject_key) by the application; the masked form is all that is kept in clear.
--
-- The database holds the rules itself, whoever writes:
--   pur.supplier_payout_change_guard    a change is inserted PENDING_APPROVAL naming its approval request, is decided
--                                       once (APPROVED, REJECTED or CANCELLED), and its content never changes (HK004)
--   ck_supplier_payout_change_checker   an approved change was decided by someone other than its maker (FR-PUR-002)
--   uq_supplier_payout_change_pending   one change waits per supplier at a time
--   pur.supplier_profile_payout_guard   the details in force are an APPROVED change of the same supplier (HK010)
--   pur.supplier_payment_payee_guard    a bank or mobile money payment pays the details of its method in force when it
--                                       is prepared, a cash or cheque payment none, and the payee never changes (HK010)
-- Data category: RESTRICTED (DC-05) for payout details; CONFIDENTIAL (DC-11) for terms and documents.
-- Rollback: tested (`pnpm db:rollback`), safe before the first payout change; afterwards forward fix only, since a
-- change is the record of who approved where the money goes.

-- migrate:up
CREATE TABLE pur.supplier_payout_change (
  id                  uuid PRIMARY KEY CONSTRAINT fk_supplier_payout_change_document REFERENCES platform.business_document (id) ON DELETE RESTRICT,
  supplier_id         uuid NOT NULL CONSTRAINT fk_supplier_payout_change_supplier REFERENCES mdm.supplier (id) ON DELETE RESTRICT,
  payout_method       text NOT NULL CONSTRAINT ck_supplier_payout_change_method CHECK (payout_method IN ('BANK', 'MOBILE_MONEY', 'CASH', 'CHEQUE')),
  -- AES-256-GCM under the supplier's subject key, bound to this row (ADR-0022). A bank account or wallet only: cash
  -- names nothing and a cheque only its payee, which the masked form carries.
  payout_details_enc  bytea NULL,
  payout_masked       text NOT NULL CONSTRAINT ck_supplier_payout_change_masked CHECK (length(payout_masked) BETWEEN 1 AND 200),
  -- Terms asked for in the same request: they wait with the details and take effect with them (null: unchanged).
  payment_terms_days  integer NULL CONSTRAINT ck_supplier_payout_change_terms CHECK (payment_terms_days BETWEEN 0 AND 365),
  lead_time_days      integer NULL CONSTRAINT ck_supplier_payout_change_lead_time CHECK (lead_time_days BETWEEN 0 AND 365),
  notes               text NULL CONSTRAINT ck_supplier_payout_change_notes CHECK (length(btrim(notes)) BETWEEN 1 AND 1000),
  approval_request_id uuid NOT NULL CONSTRAINT fk_supplier_payout_change_approval REFERENCES iam.approval_request (id) ON DELETE RESTRICT,
  decision_reason     text NULL CONSTRAINT ck_supplier_payout_change_reason CHECK (length(btrim(decision_reason)) BETWEEN 1 AND 500),
  status              text NOT NULL CONSTRAINT ck_supplier_payout_change_status CHECK (status IN ('PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'CANCELLED')),
  branch_id           uuid NOT NULL CONSTRAINT fk_supplier_payout_change_branch REFERENCES mdm.branch (id) ON DELETE RESTRICT,
  version             integer NOT NULL DEFAULT 1,
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid NOT NULL CONSTRAINT fk_supplier_payout_change_created_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  updated_by          uuid NOT NULL CONSTRAINT fk_supplier_payout_change_updated_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  posted_at           timestamptz NULL,
  posted_by           uuid NULL CONSTRAINT fk_supplier_payout_change_posted_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  CONSTRAINT ck_supplier_payout_change_details CHECK ((payout_method IN ('BANK', 'MOBILE_MONEY')) = (payout_details_enc IS NOT NULL)),
  CONSTRAINT ck_supplier_payout_change_decided CHECK ((posted_at IS NULL) = (posted_by IS NULL) AND (status = 'PENDING_APPROVAL') = (posted_at IS NULL)),
  -- FR-PUR-002: the maker never approves their own change, on the row itself as well as on the approval request.
  CONSTRAINT ck_supplier_payout_change_checker CHECK (status <> 'APPROVED' OR posted_by <> created_by)
);
COMMENT ON TABLE pur.supplier_payout_change IS 'class=DOCUMENT';
CREATE UNIQUE INDEX uq_supplier_payout_change_pending ON pur.supplier_payout_change (supplier_id) WHERE status = 'PENDING_APPROVAL';
CREATE INDEX ix_supplier_payout_change_supplier ON pur.supplier_payout_change (supplier_id, created_at);
CREATE TRIGGER trg_supplier_payout_change_version BEFORE UPDATE ON pur.supplier_payout_change
  FOR EACH ROW EXECUTE FUNCTION platform.touch_version();
CREATE TRIGGER trg_supplier_payout_change_freeze BEFORE UPDATE ON pur.supplier_payout_change
  FOR EACH ROW EXECUTE FUNCTION platform.freeze_posted('APPROVED,REJECTED,CANCELLED');

CREATE FUNCTION pur.supplier_payout_change_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'PENDING_APPROVAL' THEN
      RAISE EXCEPTION 'pur.supplier_payout_change %: a change starts PENDING_APPROVAL', NEW.id USING ERRCODE = 'HK004';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.supplier_id, NEW.payout_method, NEW.payout_details_enc, NEW.payout_masked, NEW.payment_terms_days, NEW.lead_time_days, NEW.notes,
      NEW.approval_request_id, NEW.created_by)
     IS DISTINCT FROM (OLD.supplier_id, OLD.payout_method, OLD.payout_details_enc, OLD.payout_masked, OLD.payment_terms_days, OLD.lead_time_days, OLD.notes,
      OLD.approval_request_id, OLD.created_by) THEN
    RAISE EXCEPTION 'pur.supplier_payout_change %: what a change asks for never changes', OLD.id USING ERRCODE = 'HK004';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (OLD.status = 'PENDING_APPROVAL' AND NEW.status IN ('APPROVED', 'REJECTED', 'CANCELLED')) THEN
    RAISE EXCEPTION 'pur.supplier_payout_change %: % cannot become %', OLD.id, OLD.status, NEW.status USING ERRCODE = 'HK004';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION pur.supplier_payout_change_guard() FROM PUBLIC;
CREATE TRIGGER trg_supplier_payout_change_guard BEFORE INSERT OR UPDATE ON pur.supplier_payout_change
  FOR EACH ROW EXECUTE FUNCTION pur.supplier_payout_change_guard();

CREATE TABLE pur.supplier_profile (
  supplier_id        uuid PRIMARY KEY CONSTRAINT fk_supplier_profile_supplier REFERENCES mdm.supplier (id) ON DELETE RESTRICT,
  payment_terms_days integer NOT NULL DEFAULT 0 CONSTRAINT ck_supplier_profile_terms CHECK (payment_terms_days BETWEEN 0 AND 365),
  lead_time_days     integer NULL CONSTRAINT ck_supplier_profile_lead_time CHECK (lead_time_days BETWEEN 0 AND 365),
  notes              text NULL CONSTRAINT ck_supplier_profile_notes CHECK (length(btrim(notes)) BETWEEN 1 AND 1000),
  -- The payout details in force: always an approved change of this supplier (pur.supplier_profile_payout_guard).
  payout_change_id   uuid NULL CONSTRAINT fk_supplier_profile_payout REFERENCES pur.supplier_payout_change (id) ON DELETE RESTRICT,
  version            integer NOT NULL DEFAULT 1,
  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid NOT NULL CONSTRAINT fk_supplier_profile_created_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  updated_by         uuid NOT NULL CONSTRAINT fk_supplier_profile_updated_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  deleted_at         timestamptz NULL,
  deleted_by         uuid NULL CONSTRAINT fk_supplier_profile_deleted_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  delete_reason      text NULL,
  CONSTRAINT ck_supplier_profile_soft_delete CHECK ((deleted_at IS NULL) = (deleted_by IS NULL) AND (deleted_at IS NULL) = (delete_reason IS NULL))
);
COMMENT ON TABLE pur.supplier_profile IS 'class=MASTER';
CREATE TRIGGER trg_supplier_profile_version BEFORE UPDATE ON pur.supplier_profile
  FOR EACH ROW EXECUTE FUNCTION platform.touch_version();

-- FR-PUR-002 in the database: nothing but an approved change of this supplier is ever put in force. HK010.
CREATE FUNCTION pur.supplier_profile_payout_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  change pur.supplier_payout_change;
BEGIN
  IF NEW.payout_change_id IS NULL OR (TG_OP = 'UPDATE' AND NEW.payout_change_id IS NOT DISTINCT FROM OLD.payout_change_id) THEN
    IF TG_OP = 'UPDATE' AND NEW.payout_change_id IS NULL AND OLD.payout_change_id IS NOT NULL THEN
      RAISE EXCEPTION 'pur.supplier_profile %: payout details in force are replaced by an approved change, never removed', NEW.supplier_id
        USING ERRCODE = 'HK010', CONSTRAINT = 'ck_supplier_profile_payout_approved';
    END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO change FROM pur.supplier_payout_change c WHERE c.id = NEW.payout_change_id;
  IF change.supplier_id <> NEW.supplier_id OR change.status <> 'APPROVED' THEN
    RAISE EXCEPTION 'pur.supplier_profile %: payout change % is % for supplier %, not an approved change of this supplier',
      NEW.supplier_id, change.id, change.status, change.supplier_id
      USING ERRCODE = 'HK010', CONSTRAINT = 'ck_supplier_profile_payout_approved';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION pur.supplier_profile_payout_guard() FROM PUBLIC;
CREATE TRIGGER trg_supplier_profile_payout_guard BEFORE INSERT OR UPDATE ON pur.supplier_profile
  FOR EACH ROW EXECUTE FUNCTION pur.supplier_profile_payout_guard();

CREATE TABLE pur.supplier_document (
  id            uuid PRIMARY KEY,
  supplier_id   uuid NOT NULL CONSTRAINT fk_supplier_document_supplier REFERENCES mdm.supplier (id) ON DELETE RESTRICT,
  kind          text NOT NULL CONSTRAINT ck_supplier_document_kind CHECK (kind IN ('REGISTRATION', 'CONTRACT', 'HEALTH_CERTIFICATE', 'TAX_CLEARANCE', 'OTHER')),
  file_id       uuid NOT NULL CONSTRAINT fk_supplier_document_file REFERENCES platform.stored_file (id) ON DELETE RESTRICT,
  expires_on    date NULL,
  version       integer NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid NOT NULL CONSTRAINT fk_supplier_document_created_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    uuid NOT NULL CONSTRAINT fk_supplier_document_updated_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  deleted_at    timestamptz NULL,
  deleted_by    uuid NULL CONSTRAINT fk_supplier_document_deleted_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  delete_reason text NULL,
  CONSTRAINT ck_supplier_document_soft_delete CHECK ((deleted_at IS NULL) = (deleted_by IS NULL) AND (deleted_at IS NULL) = (delete_reason IS NULL))
);
COMMENT ON TABLE pur.supplier_document IS 'class=MASTER';
-- One stored file is one supplier's document once: the same upload cannot be filed twice.
CREATE UNIQUE INDEX uq_supplier_document_file ON pur.supplier_document (file_id) WHERE deleted_at IS NULL;
CREATE INDEX ix_supplier_document_supplier ON pur.supplier_document (supplier_id, id) WHERE deleted_at IS NULL;
CREATE INDEX ix_supplier_document_expiry ON pur.supplier_document (expires_on) WHERE deleted_at IS NULL AND expires_on IS NOT NULL;
CREATE TRIGGER trg_supplier_document_version BEFORE UPDATE ON pur.supplier_document
  FOR EACH ROW EXECUTE FUNCTION platform.touch_version();

-- The payout details a payment pays (FR-PUR-002): fixed when it is prepared, from the details then in force.
ALTER TABLE pur.supplier_payment
  ADD COLUMN payout_change_id uuid NULL CONSTRAINT fk_supplier_payment_payout REFERENCES pur.supplier_payout_change (id) ON DELETE RESTRICT;

CREATE FUNCTION pur.supplier_payment_payee_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  in_force uuid;
  in_force_method text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.payout_change_id IS DISTINCT FROM OLD.payout_change_id OR NEW.method IS DISTINCT FROM OLD.method OR NEW.supplier_id IS DISTINCT FROM OLD.supplier_id THEN
      RAISE EXCEPTION 'pur.supplier_payment %: who a payment pays never changes', OLD.id USING ERRCODE = 'HK004';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.method IN ('CASH', 'CHEQUE') THEN
    IF NEW.payout_change_id IS NOT NULL THEN
      RAISE EXCEPTION 'pur.supplier_payment %: a % payment names no payout details', NEW.id, NEW.method
        USING ERRCODE = 'HK010', CONSTRAINT = 'ck_supplier_payment_payee';
    END IF;
    RETURN NEW;
  END IF;
  SELECT p.payout_change_id, c.payout_method INTO in_force, in_force_method
    FROM pur.supplier_profile p JOIN pur.supplier_payout_change c ON c.id = p.payout_change_id
   WHERE p.supplier_id = NEW.supplier_id;
  IF NEW.payout_change_id IS NULL OR NEW.payout_change_id IS DISTINCT FROM in_force OR in_force_method <> NEW.method THEN
    RAISE EXCEPTION 'pur.supplier_payment %: a % payment pays the approved % details in force for its supplier', NEW.id, NEW.method, NEW.method
      USING ERRCODE = 'HK010', CONSTRAINT = 'ck_supplier_payment_payee';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION pur.supplier_payment_payee_guard() FROM PUBLIC;
CREATE TRIGGER trg_supplier_payment_payee_guard BEFORE INSERT OR UPDATE ON pur.supplier_payment
  FOR EACH ROW EXECUTE FUNCTION pur.supplier_payment_payee_guard();

REVOKE ALL ON pur.supplier_payout_change, pur.supplier_profile, pur.supplier_document FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON pur.supplier_payout_change, pur.supplier_profile, pur.supplier_document TO hk_app, hk_worker;

-- migrate:down
DROP TRIGGER trg_supplier_payment_payee_guard ON pur.supplier_payment;
DROP FUNCTION pur.supplier_payment_payee_guard();
ALTER TABLE pur.supplier_payment DROP COLUMN payout_change_id;
DROP TABLE pur.supplier_document;
DROP TABLE pur.supplier_profile;
DROP FUNCTION pur.supplier_profile_payout_guard();
DROP TABLE pur.supplier_payout_change;
DROP FUNCTION pur.supplier_payout_change_guard();
