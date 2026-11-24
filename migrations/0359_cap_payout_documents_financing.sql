-- 0359_cap_payout_documents_financing
-- B12 continued (FR-CAP-002, FR-CAP-015, ADR-0011, ADR-0012, ADR-0017, ADR-0022, ADR-0101): the rest of CAP's tables.
--   cap.investor (expand)          payout_masked, payout_change_id (the change whose sealed details are in force, so the
--                                  ciphertext opens only in its own place), id_number_masked. Payout details and the
--                                  identity number are sealed with the investor's own key (ADR-0022) and only ever shown
--                                  masked; the payout columns move only together (ck_investor_payout_set).
--   cap.investor_payout_change     DOCUMENT, an INVESTOR_PAYOUT_CHANGE business document: every setting of an investor's
--                                  payout details, the first included, waits for a different person's approval
--                                  (ck_investor_payout_change_checker, HK004 frozen once decided).
--   cap.investor_document          MASTER: the agreement, identification and other files held for an investor, private.
--   cap.financing                  DOCUMENT, a FINANCING business document numbered when recorded: a loan (interest
--                                  ACTUAL_365, simple) or a grant (no interest, recognised over its term). Recorded as a
--                                  DRAFT and made ACTIVE (drawn and posted) only by someone other than its maker
--                                  (ck_financing_checker); its figures never change once it leaves DRAFT (HK004
--                                  ck_financing_frozen).
--   cap.financing_schedule_line    DOCUMENT, the repayment schedule written with the loan and never changed (HK004).
--   cap.financing_accrual          LEDGER, insert-only: a month's interest accrued on a loan, or a month's part of a grant
--                                  recognised, once per financing and month (uq_financing_accrual_month), with its journal.
--   cap.financing_repayment        LEDGER, insert-only: a repayment of a loan, interest and principal, with its journal;
--                                  never more principal than was drawn nor more interest than has accrued (HK010
--                                  ck_financing_repayment_owed, the loan's row locked).
-- Data category: RESTRICTED for the sealed columns (DC-03), CONFIDENTIAL for the rest (DC-13).
-- Rollback: tested (`pnpm db:rollback`), safe before the first payout change, document or financing; afterwards forward
-- fix only (the investor books are never removed).

-- migrate:up
ALTER TABLE cap.investor
  ADD COLUMN payout_masked    text NULL CONSTRAINT ck_investor_payout_masked CHECK (length(payout_masked) BETWEEN 1 AND 200),
  ADD COLUMN payout_change_id uuid NULL,
  ADD COLUMN id_number_masked text NULL CONSTRAINT ck_investor_id_number_masked CHECK (length(id_number_masked) BETWEEN 1 AND 40),
  ADD CONSTRAINT ck_investor_payout_set CHECK ((payout_method IS NULL) = (payout_masked IS NULL) AND (payout_method IS NULL) = (payout_change_id IS NULL)),
  ADD CONSTRAINT ck_investor_id_number CHECK ((id_number_enc IS NULL) = (id_number_masked IS NULL));

CREATE TABLE cap.investor_payout_change (
  id                  uuid PRIMARY KEY CONSTRAINT fk_investor_payout_change_document REFERENCES platform.business_document (id) ON DELETE RESTRICT,
  investor_id         uuid NOT NULL CONSTRAINT fk_investor_payout_change_investor REFERENCES cap.investor (id) ON DELETE RESTRICT,
  method              text NOT NULL CONSTRAINT ck_investor_payout_change_method CHECK (method IN ('BANK', 'MOBILE_MONEY')),
  details_enc         bytea NOT NULL,
  masked              text NOT NULL CONSTRAINT ck_investor_payout_change_masked CHECK (length(masked) BETWEEN 1 AND 200),
  last4               text NOT NULL CONSTRAINT ck_investor_payout_change_last4 CHECK (last4 ~ '^[0-9]{4}$'),
  approval_request_id uuid NOT NULL CONSTRAINT fk_investor_payout_change_approval REFERENCES iam.approval_request (id) ON DELETE RESTRICT
                      CONSTRAINT uq_investor_payout_change_approval UNIQUE,
  status              text NOT NULL CONSTRAINT ck_investor_payout_change_status CHECK (status IN ('PENDING_APPROVAL', 'APPLIED', 'REJECTED', 'CANCELLED')),
  branch_id           uuid NOT NULL CONSTRAINT fk_investor_payout_change_branch REFERENCES mdm.branch (id) ON DELETE RESTRICT,
  version             integer NOT NULL DEFAULT 1,
  created_at          timestamptz NOT NULL,
  created_by          uuid NOT NULL CONSTRAINT fk_investor_payout_change_created_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  updated_at          timestamptz NOT NULL,
  updated_by          uuid NOT NULL CONSTRAINT fk_investor_payout_change_updated_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  posted_at           timestamptz NULL,
  posted_by           uuid NULL CONSTRAINT fk_investor_payout_change_posted_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  CONSTRAINT ck_investor_payout_change_decided CHECK ((status IN ('APPLIED', 'REJECTED')) = (posted_at IS NOT NULL AND posted_by IS NOT NULL)),
  CONSTRAINT ck_investor_payout_change_checker CHECK (status <> 'APPLIED' OR posted_by IS DISTINCT FROM created_by)
);
COMMENT ON TABLE cap.investor_payout_change IS 'class=DOCUMENT';
-- One change waits at a time for an investor.
CREATE UNIQUE INDEX uq_investor_payout_change_pending ON cap.investor_payout_change (investor_id) WHERE status = 'PENDING_APPROVAL';
CREATE TRIGGER trg_investor_payout_change_version BEFORE UPDATE ON cap.investor_payout_change FOR EACH ROW EXECUTE FUNCTION platform.touch_version();

CREATE FUNCTION cap.investor_payout_change_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'PENDING_APPROVAL' THEN
      RAISE EXCEPTION 'cap.investor_payout_change %: a change is asked for before it is decided', NEW.id USING ERRCODE = 'HK004', CONSTRAINT = 'ck_investor_payout_change_frozen';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status <> 'PENDING_APPROVAL' OR NEW.status = 'PENDING_APPROVAL'
     OR (to_jsonb(NEW) - ARRAY['status', 'posted_at', 'posted_by', 'version', 'updated_at', 'updated_by'])
        IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'posted_at', 'posted_by', 'version', 'updated_at', 'updated_by']) THEN
    RAISE EXCEPTION 'cap.investor_payout_change % is decided once and never changed', OLD.id USING ERRCODE = 'HK004', CONSTRAINT = 'ck_investor_payout_change_frozen';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION cap.investor_payout_change_guard() FROM PUBLIC;
CREATE TRIGGER trg_investor_payout_change_guard BEFORE INSERT OR UPDATE ON cap.investor_payout_change
  FOR EACH ROW EXECUTE FUNCTION cap.investor_payout_change_guard();

ALTER TABLE cap.investor ADD CONSTRAINT fk_investor_payout_change FOREIGN KEY (payout_change_id) REFERENCES cap.investor_payout_change (id) ON DELETE RESTRICT;

CREATE TABLE cap.investor_document (
  id            uuid PRIMARY KEY,
  investor_id   uuid NOT NULL CONSTRAINT fk_investor_document_investor REFERENCES cap.investor (id) ON DELETE RESTRICT,
  kind          text NOT NULL CONSTRAINT ck_investor_document_kind CHECK (kind IN ('AGREEMENT', 'IDENTIFICATION', 'STATEMENT', 'DISTRIBUTION_SCHEDULE', 'OTHER')),
  name          text NOT NULL CONSTRAINT ck_investor_document_name CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  file_id       uuid NOT NULL CONSTRAINT fk_investor_document_file REFERENCES platform.stored_file (id) ON DELETE RESTRICT,
  version       integer NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL,
  created_by    uuid NOT NULL CONSTRAINT fk_investor_document_created_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  updated_at    timestamptz NOT NULL,
  updated_by    uuid NOT NULL CONSTRAINT fk_investor_document_updated_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  deleted_at    timestamptz NULL,
  deleted_by    uuid NULL CONSTRAINT fk_investor_document_deleted_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  delete_reason text NULL,
  CONSTRAINT ck_investor_document_soft_delete CHECK ((deleted_at IS NULL) = (deleted_by IS NULL) AND (deleted_at IS NULL) = (delete_reason IS NULL))
);
COMMENT ON TABLE cap.investor_document IS 'class=MASTER';
CREATE UNIQUE INDEX uq_investor_document_file ON cap.investor_document (investor_id, file_id) WHERE deleted_at IS NULL;
CREATE INDEX ix_investor_document_investor ON cap.investor_document (investor_id, id);
CREATE TRIGGER trg_investor_document_version BEFORE UPDATE ON cap.investor_document FOR EACH ROW EXECUTE FUNCTION platform.touch_version();

CREATE TABLE cap.financing (
  id                  uuid PRIMARY KEY CONSTRAINT fk_financing_document REFERENCES platform.business_document (id) ON DELETE RESTRICT,
  financing_no        text NOT NULL CONSTRAINT uq_financing_no UNIQUE,
  kind                text NOT NULL CONSTRAINT ck_financing_kind CHECK (kind IN ('LOAN', 'GRANT')),
  lender_investor_id  uuid NULL CONSTRAINT fk_financing_lender_investor REFERENCES cap.investor (id) ON DELETE RESTRICT,
  lender_name         text NOT NULL CONSTRAINT ck_financing_lender_name CHECK (length(btrim(lender_name)) BETWEEN 1 AND 200),
  principal_pesewas   platform.pesewas NOT NULL CONSTRAINT ck_financing_principal CHECK (principal_pesewas > 0),
  annual_rate_percent platform.percent NOT NULL DEFAULT 0,
  interest_basis      text NOT NULL DEFAULT 'ACTUAL_365' CONSTRAINT ck_financing_interest_basis CHECK (interest_basis = 'ACTUAL_365'),
  start_date          date NOT NULL,
  term_months         integer NULL CONSTRAINT ck_financing_term CHECK (term_months BETWEEN 1 AND 600),
  bank_account_id     uuid NOT NULL CONSTRAINT fk_financing_bank_account REFERENCES fin.bank_account (id) ON DELETE RESTRICT,
  agreement_file_id   uuid NULL CONSTRAINT fk_financing_agreement_file REFERENCES platform.stored_file (id) ON DELETE RESTRICT,
  approval_request_id uuid NOT NULL CONSTRAINT fk_financing_approval REFERENCES iam.approval_request (id) ON DELETE RESTRICT
                      CONSTRAINT uq_financing_approval UNIQUE,
  journal_entry_id    uuid NULL CONSTRAINT fk_financing_journal_entry REFERENCES platform.business_document (id) ON DELETE RESTRICT
                      CONSTRAINT uq_financing_journal_entry UNIQUE,
  status              text NOT NULL CONSTRAINT ck_financing_status CHECK (status IN ('DRAFT', 'ACTIVE', 'SETTLED', 'CANCELLED')),
  branch_id           uuid NOT NULL CONSTRAINT fk_financing_branch REFERENCES mdm.branch (id) ON DELETE RESTRICT,
  version             integer NOT NULL DEFAULT 1,
  created_at          timestamptz NOT NULL,
  created_by          uuid NOT NULL CONSTRAINT fk_financing_created_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  updated_at          timestamptz NOT NULL,
  updated_by          uuid NOT NULL CONSTRAINT fk_financing_updated_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  posted_at           timestamptz NULL,
  posted_by           uuid NULL CONSTRAINT fk_financing_posted_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  -- A grant carries no interest and is recognised over a term; a loan's term is optional.
  CONSTRAINT ck_financing_grant CHECK (kind = 'LOAN' OR (annual_rate_percent = 0 AND term_months IS NOT NULL)),
  CONSTRAINT ck_financing_drawn CHECK ((status IN ('ACTIVE', 'SETTLED')) = (posted_at IS NOT NULL AND posted_by IS NOT NULL AND journal_entry_id IS NOT NULL)),
  CONSTRAINT ck_financing_checker CHECK (posted_by IS DISTINCT FROM created_by)
);
COMMENT ON TABLE cap.financing IS 'class=DOCUMENT';
CREATE INDEX ix_financing_status ON cap.financing (status, id);
CREATE TRIGGER trg_financing_version BEFORE UPDATE ON cap.financing FOR EACH ROW EXECUTE FUNCTION platform.touch_version();

-- Recorded as a DRAFT; then ACTIVE (drawn) or CANCELLED once; ACTIVE to SETTLED once; nothing of its figures changes.
CREATE FUNCTION cap.financing_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  moving CONSTANT text[] := ARRAY['status', 'journal_entry_id', 'posted_at', 'posted_by', 'version', 'updated_at', 'updated_by'];
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'DRAFT' THEN
      RAISE EXCEPTION 'cap.financing %: a loan or grant is recorded as a draft', NEW.id USING ERRCODE = 'HK004', CONSTRAINT = 'ck_financing_frozen';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT ((OLD.status = 'DRAFT' AND NEW.status IN ('ACTIVE', 'CANCELLED')) OR (OLD.status = 'ACTIVE' AND NEW.status = 'SETTLED'))
     OR (to_jsonb(NEW) - moving) IS DISTINCT FROM (to_jsonb(OLD) - moving)
     OR (OLD.status = 'ACTIVE' AND (NEW.journal_entry_id, NEW.posted_at, NEW.posted_by) IS DISTINCT FROM (OLD.journal_entry_id, OLD.posted_at, OLD.posted_by)) THEN
    RAISE EXCEPTION 'cap.financing % cannot move from % to % or change its figures', OLD.id, OLD.status, NEW.status USING ERRCODE = 'HK004', CONSTRAINT = 'ck_financing_frozen';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION cap.financing_guard() FROM PUBLIC;
CREATE TRIGGER trg_financing_guard BEFORE INSERT OR UPDATE ON cap.financing FOR EACH ROW EXECUTE FUNCTION cap.financing_guard();

CREATE TABLE cap.financing_schedule_line (
  financing_id          uuid NOT NULL CONSTRAINT fk_financing_schedule_line_financing REFERENCES cap.financing (id) ON DELETE RESTRICT,
  instalment_no         integer NOT NULL CONSTRAINT ck_financing_schedule_line_no CHECK (instalment_no >= 1),
  due_date              date NOT NULL,
  principal_due_pesewas platform.pesewas NOT NULL,
  interest_due_pesewas  platform.pesewas NOT NULL,
  branch_id             uuid NOT NULL CONSTRAINT fk_financing_schedule_line_branch REFERENCES mdm.branch (id) ON DELETE RESTRICT,
  status                text NOT NULL DEFAULT 'SCHEDULED' CONSTRAINT ck_financing_schedule_line_status CHECK (status = 'SCHEDULED'),
  version               integer NOT NULL DEFAULT 1,
  created_at            timestamptz NOT NULL,
  created_by            uuid NOT NULL CONSTRAINT fk_financing_schedule_line_created_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  updated_at            timestamptz NOT NULL,
  updated_by            uuid NOT NULL CONSTRAINT fk_financing_schedule_line_updated_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  CONSTRAINT pk_financing_schedule_line PRIMARY KEY (financing_id, instalment_no)
);
COMMENT ON TABLE cap.financing_schedule_line IS 'class=DOCUMENT';
-- What was paid against an instalment is read from the repayments, never stored here: the schedule never changes.
CREATE TRIGGER trg_financing_schedule_line_frozen BEFORE UPDATE OR DELETE ON cap.financing_schedule_line FOR EACH ROW EXECUTE FUNCTION platform.reject_change();

CREATE TABLE cap.financing_accrual (
  id               uuid PRIMARY KEY,
  financing_id     uuid NOT NULL CONSTRAINT fk_financing_accrual_financing REFERENCES cap.financing (id) ON DELETE RESTRICT,
  kind             text NOT NULL CONSTRAINT ck_financing_accrual_kind CHECK (kind IN ('INTEREST', 'RECOGNITION')),
  month_start      date NOT NULL,
  month_end        date NOT NULL CONSTRAINT ck_financing_accrual_month CHECK (month_end >= month_start AND date_trunc('month', month_start) = date_trunc('month', month_end)),
  amount_pesewas   platform.pesewas NOT NULL,
  journal_entry_id uuid NULL CONSTRAINT fk_financing_accrual_journal_entry REFERENCES platform.business_document (id) ON DELETE RESTRICT
                   CONSTRAINT uq_financing_accrual_journal_entry UNIQUE,
  recorded_at      timestamptz NOT NULL,
  actor_id         uuid NOT NULL CONSTRAINT fk_financing_accrual_actor REFERENCES iam.principal (id) ON DELETE RESTRICT,
  -- Nothing to post is still a month done, with no journal; anything to post has one.
  CONSTRAINT ck_financing_accrual_journal CHECK ((amount_pesewas = 0) = (journal_entry_id IS NULL)),
  CONSTRAINT uq_financing_accrual_month UNIQUE (financing_id, month_end)
);
COMMENT ON TABLE cap.financing_accrual IS 'class=LEDGER';
CREATE TRIGGER trg_financing_accrual_immutable BEFORE UPDATE OR DELETE ON cap.financing_accrual FOR EACH ROW EXECUTE FUNCTION platform.reject_change();
CREATE TRIGGER trg_financing_accrual_no_truncate BEFORE TRUNCATE ON cap.financing_accrual FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_change();

CREATE TABLE cap.financing_repayment (
  id                 uuid PRIMARY KEY,
  financing_id       uuid NOT NULL CONSTRAINT fk_financing_repayment_financing REFERENCES cap.financing (id) ON DELETE RESTRICT,
  principal_pesewas  platform.pesewas NOT NULL,
  interest_pesewas   platform.pesewas NOT NULL,
  bank_account_id    uuid NOT NULL CONSTRAINT fk_financing_repayment_bank_account REFERENCES fin.bank_account (id) ON DELETE RESTRICT,
  external_reference text NULL CONSTRAINT ck_financing_repayment_reference CHECK (length(btrim(external_reference)) BETWEEN 1 AND 120)
                     CONSTRAINT uq_financing_repayment_reference UNIQUE,
  paid_at            timestamptz NOT NULL,
  value_date         date NOT NULL,
  journal_entry_id   uuid NOT NULL CONSTRAINT fk_financing_repayment_journal_entry REFERENCES platform.business_document (id) ON DELETE RESTRICT
                     CONSTRAINT uq_financing_repayment_journal_entry UNIQUE,
  recorded_at        timestamptz NOT NULL,
  actor_id           uuid NOT NULL CONSTRAINT fk_financing_repayment_actor REFERENCES iam.principal (id) ON DELETE RESTRICT,
  CONSTRAINT ck_financing_repayment_positive CHECK (principal_pesewas + interest_pesewas > 0)
);
COMMENT ON TABLE cap.financing_repayment IS 'class=LEDGER';
CREATE INDEX ix_financing_repayment_financing ON cap.financing_repayment (financing_id, value_date);
CREATE TRIGGER trg_financing_repayment_immutable BEFORE UPDATE OR DELETE ON cap.financing_repayment FOR EACH ROW EXECUTE FUNCTION platform.reject_change();
CREATE TRIGGER trg_financing_repayment_no_truncate BEFORE TRUNCATE ON cap.financing_repayment FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_change();

-- A repayment lands only on an ACTIVE loan, and never takes more principal than was drawn nor more interest than has
-- accrued, all repayments counted, with the loan's row locked so two repayments queue.
CREATE FUNCTION cap.financing_repayment_check() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  loan record;
  repaid_principal numeric;
  repaid_interest numeric;
  accrued numeric;
BEGIN
  SELECT kind, status, principal_pesewas INTO loan FROM cap.financing WHERE id = NEW.financing_id FOR UPDATE;
  IF loan.kind <> 'LOAN' OR loan.status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'cap.financing_repayment %: only an active loan is repaid', NEW.id USING ERRCODE = 'HK010', CONSTRAINT = 'ck_financing_repayment_owed';
  END IF;
  SELECT COALESCE(sum(principal_pesewas), 0), COALESCE(sum(interest_pesewas), 0) INTO repaid_principal, repaid_interest
    FROM cap.financing_repayment WHERE financing_id = NEW.financing_id AND id <> NEW.id;
  SELECT COALESCE(sum(amount_pesewas), 0) INTO accrued FROM cap.financing_accrual WHERE financing_id = NEW.financing_id AND kind = 'INTEREST';
  IF repaid_principal + NEW.principal_pesewas > loan.principal_pesewas OR repaid_interest + NEW.interest_pesewas > accrued THEN
    RAISE EXCEPTION 'cap.financing_repayment %: more than is owed on loan %', NEW.id, NEW.financing_id USING ERRCODE = 'HK010', CONSTRAINT = 'ck_financing_repayment_owed';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION cap.financing_repayment_check() FROM PUBLIC;
CREATE TRIGGER trg_financing_repayment_check BEFORE INSERT ON cap.financing_repayment FOR EACH ROW EXECUTE FUNCTION cap.financing_repayment_check();

REVOKE ALL ON cap.investor_payout_change, cap.investor_document, cap.financing, cap.financing_schedule_line, cap.financing_accrual, cap.financing_repayment FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON cap.investor_payout_change, cap.investor_document, cap.financing, cap.financing_schedule_line TO hk_app, hk_worker;
GRANT SELECT, INSERT ON cap.financing_accrual, cap.financing_repayment TO hk_app, hk_worker;

-- migrate:down
DROP TABLE cap.financing_repayment;
DROP FUNCTION cap.financing_repayment_check();
DROP TABLE cap.financing_accrual;
DROP TABLE cap.financing_schedule_line;
DROP TABLE cap.financing;
DROP FUNCTION cap.financing_guard();
DROP TABLE cap.investor_document;
ALTER TABLE cap.investor DROP CONSTRAINT fk_investor_payout_change;
DROP TABLE cap.investor_payout_change;
DROP FUNCTION cap.investor_payout_change_guard();
ALTER TABLE cap.investor
  DROP CONSTRAINT ck_investor_id_number,
  DROP CONSTRAINT ck_investor_payout_set,
  DROP COLUMN id_number_masked,
  DROP COLUMN payout_change_id,
  DROP COLUMN payout_masked;
