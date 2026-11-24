-- 0353_cap_capital_and_distributions
-- B12 (FR-CAP-001, FR-CAP-003 to FR-CAP-012, ADR-0011, ADR-0012, ADR-0017, ADR-0028): the CAP schema with the investor
-- register, capital and units, and profit distribution. Loans and grants, investor documents, payout details and the
-- portal are B12 continued's (A-380).
--   cap.investor                   MASTER. Numbered INV-001, INV-002 (the tie key of an allocation, never reused, never
--                                  deleted; archived as EXITED).
--   cap.capital_withdrawal_request DOCUMENT, a CAPITAL_WITHDRAWAL business document: asked by one person, decided once
--                                  by another (ck_capital_withdrawal_request_checker, HK004 frozen once decided).
--   cap.capital_transaction        LEDGER, insert-only, a CAPITAL_TRANSACTION business document numbered from its series
--                                  (ck_capital_transaction_number). Units are the amount over the unit price exactly
--                                  (ck_capital_transaction_units). A withdrawal is written only for its applied request
--                                  (ck_capital_transaction_approved) and never redeems more units than the investor holds
--                                  on its value date or any later day (HK010 ck_capital_transaction_holding). Its journal
--                                  entry is named on it. Maintains cap.unit_holding.
--   cap.unit_holding               PROJECTION, written only by the trigger: units, contributed and withdrawn per investor.
--   cap.distribution_run           DOCUMENT, a DISTRIBUTION_RUN numbered when drafted. Periods of runs not REJECTED never
--                                  overlap (ex_distribution_run_period): profit is distributed once. Draft, pending
--                                  approval (never edited: A-382), approved by someone other than its maker
--                                  (ck_distribution_run_checker),
--                                  posted once with its journal, paid; nothing of the figures changes once it leaves draft
--                                  (HK004 ck_distribution_run_frozen). At commit, once it has left draft, its current
--                                  lines sum to the distributable amount and their unit-days to its total (HK010
--                                  ck_distribution_run_allocated, deferred): no pesewa is created or lost.
--   cap.distribution_line          DOCUMENT, one investor's share in one computation of a run (a recompute writes a new
--                                  computation and keeps the old). Frozen once written except what is paid, which only
--                                  the payment trigger moves and never above net payable (ck_distribution_line_paid).
--   cap.distribution_payment       LEDGER, insert-only: money paid against a line of a posted run, with its journal.
-- Data category: CONFIDENTIAL (DC-13: investors, their capital and their shares).
-- Rollback: tested (`pnpm db:rollback`), safe before the first capital transaction; afterwards forward fix only (capital
-- and distributions are the books of the farm's owners and are never removed).

-- migrate:up
CREATE SCHEMA cap AUTHORIZATION hk_owner;
REVOKE ALL ON SCHEMA cap FROM PUBLIC;
GRANT USAGE ON SCHEMA cap TO hk_app, hk_worker, hk_report;

CREATE TABLE cap.investor (
  id                 uuid PRIMARY KEY,
  investor_no        text NOT NULL CONSTRAINT ck_investor_no CHECK (investor_no ~ '^INV-[0-9]{3,9}$'),
  kind               text NOT NULL CONSTRAINT ck_investor_kind CHECK (kind IN ('INDIVIDUAL', 'ENTITY')),
  legal_name         text NOT NULL CONSTRAINT ck_investor_legal_name CHECK (length(btrim(legal_name)) BETWEEN 1 AND 200),
  phone_e164         text NULL CONSTRAINT ck_investor_phone CHECK (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  email              text NULL CONSTRAINT ck_investor_email CHECK (length(email) BETWEEN 3 AND 254 AND position('@' IN email) > 1),
  principal_id       uuid NULL CONSTRAINT fk_investor_principal REFERENCES iam.principal (id) ON DELETE RESTRICT,
  id_number_enc      bytea NULL,
  payout_method      text NULL CONSTRAINT ck_investor_payout_method CHECK (payout_method IN ('BANK', 'MOBILE_MONEY')),
  payout_details_enc bytea NULL,
  payout_last4       text NULL CONSTRAINT ck_investor_payout_last4 CHECK (payout_last4 ~ '^[0-9]{4}$'),
  agreement_file_id  uuid NULL CONSTRAINT fk_investor_agreement_file REFERENCES platform.stored_file (id) ON DELETE RESTRICT,
  joined_on          date NOT NULL,
  status             text NOT NULL CONSTRAINT ck_investor_status CHECK (status IN ('ACTIVE', 'EXITED')),
  version            integer NOT NULL DEFAULT 1,
  created_at         timestamptz NOT NULL,
  created_by         uuid NOT NULL CONSTRAINT fk_investor_created_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  updated_at         timestamptz NOT NULL,
  updated_by         uuid NOT NULL CONSTRAINT fk_investor_updated_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  deleted_at         timestamptz NULL,
  deleted_by         uuid NULL CONSTRAINT fk_investor_deleted_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  delete_reason      text NULL,
  CONSTRAINT ck_investor_soft_delete CHECK ((deleted_at IS NULL) = (deleted_by IS NULL) AND (deleted_at IS NULL) = (delete_reason IS NULL)),
  -- An investor is never deleted: one with units or capital transactions is archived as EXITED (FR-CAP-001).
  CONSTRAINT ck_investor_never_deleted CHECK (deleted_at IS NULL),
  CONSTRAINT ck_investor_payout CHECK ((payout_method IS NULL) = (payout_details_enc IS NULL))
);
COMMENT ON TABLE cap.investor IS 'class=MASTER';
CREATE UNIQUE INDEX uq_investor_no ON cap.investor (investor_no);
CREATE UNIQUE INDEX uq_investor_principal ON cap.investor (principal_id) WHERE principal_id IS NOT NULL;
CREATE TRIGGER trg_investor_version BEFORE UPDATE ON cap.investor FOR EACH ROW EXECUTE FUNCTION platform.touch_version();

CREATE TABLE cap.unit_holding (
  investor_id         uuid PRIMARY KEY CONSTRAINT fk_unit_holding_investor REFERENCES cap.investor (id) ON DELETE RESTRICT,
  units               numeric(18,4) NOT NULL CONSTRAINT ck_unit_holding_units CHECK (units >= 0),
  contributed_pesewas platform.pesewas NOT NULL,
  withdrawn_pesewas   platform.pesewas NOT NULL,
  updated_at          timestamptz NOT NULL
);
COMMENT ON TABLE cap.unit_holding IS 'class=PROJECTION';

CREATE TABLE cap.capital_withdrawal_request (
  id                  uuid PRIMARY KEY CONSTRAINT fk_capital_withdrawal_request_document REFERENCES platform.business_document (id) ON DELETE RESTRICT,
  investor_id         uuid NOT NULL CONSTRAINT fk_capital_withdrawal_request_investor REFERENCES cap.investor (id) ON DELETE RESTRICT,
  amount_pesewas      platform.pesewas NOT NULL CONSTRAINT ck_capital_withdrawal_request_amount CHECK (amount_pesewas > 0),
  value_date          date NOT NULL,
  unit_price_pesewas  platform.pesewas NOT NULL CONSTRAINT ck_capital_withdrawal_request_unit_price CHECK (unit_price_pesewas > 0),
  units               numeric(18,4) NOT NULL CONSTRAINT ck_capital_withdrawal_request_units CHECK (units > 0 AND units * unit_price_pesewas = amount_pesewas),
  bank_account_id     uuid NOT NULL CONSTRAINT fk_capital_withdrawal_request_bank_account REFERENCES fin.bank_account (id) ON DELETE RESTRICT,
  external_reference  text NULL CONSTRAINT ck_capital_withdrawal_request_reference CHECK (length(btrim(external_reference)) BETWEEN 1 AND 120),
  approval_request_id uuid NOT NULL CONSTRAINT fk_capital_withdrawal_request_approval REFERENCES iam.approval_request (id) ON DELETE RESTRICT
                      CONSTRAINT uq_capital_withdrawal_request_approval UNIQUE,
  status              text NOT NULL CONSTRAINT ck_capital_withdrawal_request_status CHECK (status IN ('PENDING_APPROVAL', 'APPLIED', 'REJECTED', 'CANCELLED')),
  branch_id           uuid NOT NULL CONSTRAINT fk_capital_withdrawal_request_branch REFERENCES mdm.branch (id) ON DELETE RESTRICT,
  version             integer NOT NULL DEFAULT 1,
  created_at          timestamptz NOT NULL,
  created_by          uuid NOT NULL CONSTRAINT fk_capital_withdrawal_request_created_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  updated_at          timestamptz NOT NULL,
  updated_by          uuid NOT NULL CONSTRAINT fk_capital_withdrawal_request_updated_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  posted_at           timestamptz NULL,
  posted_by           uuid NULL CONSTRAINT fk_capital_withdrawal_request_posted_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  CONSTRAINT ck_capital_withdrawal_request_decided CHECK ((status IN ('APPLIED', 'REJECTED')) = (posted_at IS NOT NULL AND posted_by IS NOT NULL)),
  CONSTRAINT ck_capital_withdrawal_request_checker CHECK (status <> 'APPLIED' OR posted_by IS DISTINCT FROM created_by)
);
COMMENT ON TABLE cap.capital_withdrawal_request IS 'class=DOCUMENT';
CREATE INDEX ix_capital_withdrawal_request_investor ON cap.capital_withdrawal_request (investor_id, id);
CREATE TRIGGER trg_capital_withdrawal_request_version BEFORE UPDATE ON cap.capital_withdrawal_request FOR EACH ROW EXECUTE FUNCTION platform.touch_version();

-- Asked once and decided once: written PENDING_APPROVAL, moved once to its decision, nothing else of it changes.
CREATE FUNCTION cap.capital_withdrawal_request_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'PENDING_APPROVAL' THEN
      RAISE EXCEPTION 'cap.capital_withdrawal_request %: a withdrawal is asked for before it is decided', NEW.id USING ERRCODE = 'HK004', CONSTRAINT = 'ck_capital_withdrawal_request_frozen';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status <> 'PENDING_APPROVAL' OR NEW.status = 'PENDING_APPROVAL'
     OR (to_jsonb(NEW) - ARRAY['status', 'posted_at', 'posted_by', 'version', 'updated_at', 'updated_by'])
        IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'posted_at', 'posted_by', 'version', 'updated_at', 'updated_by']) THEN
    RAISE EXCEPTION 'cap.capital_withdrawal_request % is decided once and never changed', OLD.id USING ERRCODE = 'HK004', CONSTRAINT = 'ck_capital_withdrawal_request_frozen';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION cap.capital_withdrawal_request_guard() FROM PUBLIC;
CREATE TRIGGER trg_capital_withdrawal_request_guard BEFORE INSERT OR UPDATE ON cap.capital_withdrawal_request
  FOR EACH ROW EXECUTE FUNCTION cap.capital_withdrawal_request_guard();

CREATE TABLE cap.capital_transaction (
  id                      uuid PRIMARY KEY CONSTRAINT fk_capital_transaction_document REFERENCES platform.business_document (id) ON DELETE RESTRICT,
  transaction_no          text NOT NULL CONSTRAINT uq_capital_transaction_no UNIQUE,
  investor_id             uuid NOT NULL CONSTRAINT fk_capital_transaction_investor REFERENCES cap.investor (id) ON DELETE RESTRICT,
  branch_id               uuid NOT NULL CONSTRAINT fk_capital_transaction_branch REFERENCES mdm.branch (id) ON DELETE RESTRICT,
  kind                    text NOT NULL CONSTRAINT ck_capital_transaction_kind CHECK (kind IN ('CONTRIBUTION', 'WITHDRAWAL')),
  amount_pesewas          platform.pesewas NOT NULL CONSTRAINT ck_capital_transaction_amount CHECK (amount_pesewas > 0),
  value_date              date NOT NULL,
  posting_date            date NOT NULL CONSTRAINT ck_capital_transaction_posting_date CHECK (posting_date >= value_date),
  unit_price_pesewas      platform.pesewas NOT NULL CONSTRAINT ck_capital_transaction_unit_price CHECK (unit_price_pesewas > 0),
  units                   numeric(18,4) NOT NULL,
  bank_account_id         uuid NOT NULL CONSTRAINT fk_capital_transaction_bank_account REFERENCES fin.bank_account (id) ON DELETE RESTRICT,
  external_reference      text NULL CONSTRAINT ck_capital_transaction_reference CHECK (length(btrim(external_reference)) BETWEEN 1 AND 120),
  approval_request_id     uuid NULL CONSTRAINT fk_capital_transaction_approval REFERENCES iam.approval_request (id) ON DELETE RESTRICT,
  withdrawal_request_id   uuid NULL CONSTRAINT fk_capital_transaction_withdrawal_request REFERENCES cap.capital_withdrawal_request (id) ON DELETE RESTRICT
                          CONSTRAINT uq_capital_transaction_withdrawal_request UNIQUE,
  reverses_transaction_id uuid NULL CONSTRAINT fk_capital_transaction_reverses REFERENCES cap.capital_transaction (id) ON DELETE RESTRICT
                          CONSTRAINT uq_capital_transaction_reverses UNIQUE,
  journal_entry_id        uuid NOT NULL CONSTRAINT fk_capital_transaction_journal REFERENCES platform.business_document (id) ON DELETE RESTRICT
                          CONSTRAINT uq_capital_transaction_journal UNIQUE,
  recorded_at             timestamptz NOT NULL,
  actor_id                uuid NOT NULL CONSTRAINT fk_capital_transaction_actor REFERENCES iam.principal (id) ON DELETE RESTRICT,
  -- Units are the amount over the unit price exactly, never rounded (A-380).
  CONSTRAINT ck_capital_transaction_units CHECK (units > 0 AND units * unit_price_pesewas = amount_pesewas),
  -- A withdrawal needs its approval (FR-CAP-004); a contribution needs none.
  CONSTRAINT ck_capital_transaction_withdrawal CHECK ((kind = 'WITHDRAWAL') = (withdrawal_request_id IS NOT NULL AND approval_request_id IS NOT NULL))
);
COMMENT ON TABLE cap.capital_transaction IS 'class=LEDGER';
CREATE INDEX ix_capital_transaction_investor ON cap.capital_transaction (investor_id, value_date);
CREATE INDEX ix_capital_transaction_value_date ON cap.capital_transaction (value_date, id);
CREATE TRIGGER trg_capital_transaction_immutable BEFORE UPDATE OR DELETE ON cap.capital_transaction FOR EACH ROW EXECUTE FUNCTION platform.reject_change();
CREATE TRIGGER trg_capital_transaction_no_truncate BEFORE TRUNCATE ON cap.capital_transaction FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_change();

-- Before a capital transaction is written: its number is the one allocated to it; a withdrawal is its applied request
-- exactly, decided by someone other than its maker, and never takes the investor's units below nothing on its value
-- date or any later day (units issued on E are held from E; units redeemed on R are not held on R). The investor's
-- holding row is locked first, so two withdrawals of one investor queue. Then the holding projection is kept.
CREATE FUNCTION cap.capital_transaction_check() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
DECLARE
  r record;
  short_on date;
BEGIN
  IF NOT platform.number_allocated(NEW.id, NEW.transaction_no, 'CAPITAL_TRANSACTION') THEN
    RAISE EXCEPTION 'cap.capital_transaction %: % was not allocated to it', NEW.id, NEW.transaction_no USING ERRCODE = 'HK010', CONSTRAINT = 'ck_capital_transaction_number';
  END IF;
  INSERT INTO cap.unit_holding (investor_id, units, contributed_pesewas, withdrawn_pesewas, updated_at)
  VALUES (NEW.investor_id, 0, 0, 0, NEW.recorded_at)
  ON CONFLICT (investor_id) DO NOTHING;
  PERFORM 1 FROM cap.unit_holding h WHERE h.investor_id = NEW.investor_id FOR UPDATE;
  IF NEW.kind = 'WITHDRAWAL' THEN
    SELECT q.status, q.investor_id, q.amount_pesewas, q.value_date, q.unit_price_pesewas, q.bank_account_id, q.approval_request_id, q.created_by, q.posted_by
      INTO r FROM cap.capital_withdrawal_request q WHERE q.id = NEW.withdrawal_request_id;
    IF r.status IS DISTINCT FROM 'APPLIED' OR r.investor_id <> NEW.investor_id OR r.amount_pesewas <> NEW.amount_pesewas OR r.value_date <> NEW.value_date
       OR r.unit_price_pesewas <> NEW.unit_price_pesewas OR r.bank_account_id <> NEW.bank_account_id OR r.approval_request_id <> NEW.approval_request_id
       OR r.posted_by IS NULL OR r.posted_by = r.created_by THEN
      RAISE EXCEPTION 'cap.capital_transaction %: a withdrawal is written only for its approved request, as asked, decided by someone other than its maker', NEW.id
        USING ERRCODE = 'HK010', CONSTRAINT = 'ck_capital_transaction_approved';
    END IF;
    SELECT d.day INTO short_on
      FROM (SELECT NEW.value_date AS day UNION SELECT t.value_date FROM cap.capital_transaction t WHERE t.investor_id = NEW.investor_id AND t.value_date > NEW.value_date) d
     WHERE COALESCE((SELECT sum(CASE t.kind WHEN 'CONTRIBUTION' THEN t.units ELSE -t.units END)
                       FROM cap.capital_transaction t WHERE t.investor_id = NEW.investor_id AND t.value_date <= d.day), 0) - NEW.units < 0
     ORDER BY d.day LIMIT 1;
    IF short_on IS NOT NULL THEN
      RAISE EXCEPTION 'cap.capital_transaction %: the withdrawal redeems more units than investor % holds on %', NEW.id, NEW.investor_id, short_on
        USING ERRCODE = 'HK010', CONSTRAINT = 'ck_capital_transaction_holding';
    END IF;
    UPDATE cap.unit_holding SET units = units - NEW.units, withdrawn_pesewas = withdrawn_pesewas + NEW.amount_pesewas, updated_at = NEW.recorded_at
     WHERE investor_id = NEW.investor_id;
  ELSE
    UPDATE cap.unit_holding SET units = units + NEW.units, contributed_pesewas = contributed_pesewas + NEW.amount_pesewas, updated_at = NEW.recorded_at
     WHERE investor_id = NEW.investor_id;
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION cap.capital_transaction_check() FROM PUBLIC;
CREATE TRIGGER trg_capital_transaction_check BEFORE INSERT ON cap.capital_transaction FOR EACH ROW EXECUTE FUNCTION cap.capital_transaction_check();

CREATE TABLE cap.distribution_run (
  id                       uuid PRIMARY KEY CONSTRAINT fk_distribution_run_document REFERENCES platform.business_document (id) ON DELETE RESTRICT,
  run_no                   text NOT NULL CONSTRAINT uq_distribution_run_no UNIQUE,
  period_start             date NOT NULL,
  period_end               date NOT NULL,
  days_in_period           integer NOT NULL,
  net_profit_pesewas       platform.pesewas NOT NULL,
  is_loss                  boolean NOT NULL DEFAULT false,
  retention_rate_percent   platform.percent NOT NULL CONSTRAINT ck_distribution_run_retention CHECK (retention_rate_percent BETWEEN 0 AND 100),
  retained_pesewas         platform.pesewas NOT NULL,
  distributable_pesewas    platform.pesewas NOT NULL,
  allocation_method        text NOT NULL DEFAULT 'UNIT_DAYS' CONSTRAINT ck_distribution_run_method CHECK (allocation_method = 'UNIT_DAYS'),
  day_count_convention     text NOT NULL CONSTRAINT ck_distribution_run_convention CHECK (length(btrim(day_count_convention)) > 0),
  total_unit_days          numeric(24,4) NOT NULL CONSTRAINT ck_distribution_run_unit_days CHECK (total_unit_days >= 0),
  withholding_rate_percent platform.percent NOT NULL DEFAULT 0 CONSTRAINT ck_distribution_run_withholding CHECK (withholding_rate_percent BETWEEN 0 AND 100),
  computation_no           integer NOT NULL CONSTRAINT ck_distribution_run_computation CHECK (computation_no > 0),
  computed_at              timestamptz NOT NULL,
  approval_request_id      uuid NULL CONSTRAINT fk_distribution_run_approval REFERENCES iam.approval_request (id) ON DELETE RESTRICT,
  approved_at              timestamptz NULL,
  approved_by              uuid NULL CONSTRAINT fk_distribution_run_approved_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  schedule_document_id     uuid NULL CONSTRAINT fk_distribution_run_schedule REFERENCES doc.archived_document (id) ON DELETE RESTRICT,
  journal_entry_id         uuid NULL CONSTRAINT fk_distribution_run_journal REFERENCES platform.business_document (id) ON DELETE RESTRICT
                           CONSTRAINT uq_distribution_run_journal UNIQUE,
  paid_pesewas             platform.pesewas NOT NULL DEFAULT 0,
  currency                 char(3) NOT NULL DEFAULT 'GHS' CONSTRAINT ck_distribution_run_currency CHECK (currency = 'GHS'),
  status                   text NOT NULL CONSTRAINT ck_distribution_run_status CHECK (status IN ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'POSTED', 'PAID', 'REJECTED')),
  branch_id                uuid NOT NULL CONSTRAINT fk_distribution_run_branch REFERENCES mdm.branch (id) ON DELETE RESTRICT,
  version                  integer NOT NULL DEFAULT 1,
  created_at               timestamptz NOT NULL,
  created_by               uuid NOT NULL CONSTRAINT fk_distribution_run_created_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  updated_at               timestamptz NOT NULL,
  updated_by               uuid NOT NULL CONSTRAINT fk_distribution_run_updated_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  posted_at                timestamptz NULL,
  posted_by                uuid NULL CONSTRAINT fk_distribution_run_posted_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  CONSTRAINT ck_distribution_run_period CHECK (period_end >= period_start),
  CONSTRAINT ck_distribution_run_days CHECK (days_in_period = period_end - period_start + 1),
  CONSTRAINT ck_distribution_run_distributable CHECK (distributable_pesewas = net_profit_pesewas - retained_pesewas),
  CONSTRAINT ck_distribution_run_loss CHECK (NOT is_loss OR net_profit_pesewas = 0),
  CONSTRAINT ck_distribution_run_approval CHECK (status IN ('DRAFT', 'REJECTED') OR approval_request_id IS NOT NULL),
  CONSTRAINT ck_distribution_run_approved CHECK ((status IN ('APPROVED', 'POSTED', 'PAID')) = (approved_by IS NOT NULL AND approved_at IS NOT NULL)),
  -- The maker never checks (ADR-0017): here as well as in IAM and the application.
  CONSTRAINT ck_distribution_run_checker CHECK (approved_by IS DISTINCT FROM created_by),
  CONSTRAINT ck_distribution_run_posted CHECK ((status IN ('POSTED', 'PAID')) = (posted_at IS NOT NULL AND posted_by IS NOT NULL AND journal_entry_id IS NOT NULL)),
  CONSTRAINT ck_distribution_run_paid CHECK (paid_pesewas <= distributable_pesewas AND (status <> 'PAID' OR paid_pesewas > 0))
);
COMMENT ON TABLE cap.distribution_run IS 'class=DOCUMENT';
-- Profit is distributed once: the periods of runs that were not rejected never overlap.
ALTER TABLE cap.distribution_run ADD CONSTRAINT ex_distribution_run_period
  EXCLUDE USING gist (daterange(period_start, period_end, '[]') WITH &&) WHERE (status <> 'REJECTED');
CREATE INDEX ix_distribution_run_status ON cap.distribution_run (status, id);
CREATE TRIGGER trg_distribution_run_version BEFORE UPDATE ON cap.distribution_run FOR EACH ROW EXECUTE FUNCTION platform.touch_version();

-- The lifecycle in the database: draft (recomputed in place), pending approval, approved or rejected, posted, paid. The
-- figures change only in draft: a submitted run is never edited, and a run that must change is rejected (or its maker
-- withdraws the request) and drafted again (A-382). The schedule is set once, after the submission; what is paid only
-- grows, and only on a posted run.
CREATE FUNCTION cap.distribution_run_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  figures text[] := ARRAY['net_profit_pesewas', 'is_loss', 'retention_rate_percent', 'retained_pesewas', 'distributable_pesewas', 'total_unit_days',
                          'withholding_rate_percent', 'computation_no', 'computed_at'];
  fixed text[] := ARRAY['id', 'run_no', 'period_start', 'period_end', 'days_in_period', 'allocation_method', 'day_count_convention', 'currency', 'branch_id', 'created_at', 'created_by'];
  allowed boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'DRAFT' OR NEW.approval_request_id IS NOT NULL OR NEW.schedule_document_id IS NOT NULL OR NEW.paid_pesewas <> 0 THEN
      RAISE EXCEPTION 'cap.distribution_run %: a run is drafted before anything else', NEW.id USING ERRCODE = 'HK004', CONSTRAINT = 'ck_distribution_run_frozen';
    END IF;
    IF NOT platform.number_allocated(NEW.id, NEW.run_no, 'DISTRIBUTION_RUN') THEN
      RAISE EXCEPTION 'cap.distribution_run %: % was not allocated to it', NEW.id, NEW.run_no USING ERRCODE = 'HK010', CONSTRAINT = 'ck_distribution_run_number';
    END IF;
    RETURN NEW;
  END IF;
  allowed := CASE
    WHEN OLD.status = 'DRAFT' THEN NEW.status IN ('DRAFT', 'PENDING_APPROVAL')
    WHEN OLD.status = 'PENDING_APPROVAL' THEN NEW.status IN ('PENDING_APPROVAL', 'APPROVED', 'REJECTED')
    WHEN OLD.status = 'APPROVED' THEN NEW.status IN ('APPROVED', 'POSTED')
    WHEN OLD.status = 'POSTED' THEN NEW.status IN ('POSTED', 'PAID')
    ELSE NEW.status = OLD.status
  END;
  IF NOT allowed
     OR EXISTS (SELECT 1 FROM unnest(fixed) f WHERE to_jsonb(NEW) -> f IS DISTINCT FROM to_jsonb(OLD) -> f)
     -- the figures move only while the run is a draft
     OR (OLD.status <> 'DRAFT' AND EXISTS (SELECT 1 FROM unnest(figures) f WHERE to_jsonb(NEW) -> f IS DISTINCT FROM to_jsonb(OLD) -> f))
     -- the approval request is named once, by the submission
     OR (NEW.approval_request_id IS DISTINCT FROM OLD.approval_request_id AND NOT (OLD.status = 'DRAFT' AND NEW.status = 'PENDING_APPROVAL'))
     -- the archived schedule is set once, after the submission
     OR (NEW.schedule_document_id IS DISTINCT FROM OLD.schedule_document_id AND (OLD.schedule_document_id IS NOT NULL OR OLD.status = 'DRAFT'))
     OR (NEW.approved_by IS DISTINCT FROM OLD.approved_by AND NOT (OLD.status = 'PENDING_APPROVAL' AND NEW.status = 'APPROVED'))
     OR (NEW.journal_entry_id IS DISTINCT FROM OLD.journal_entry_id AND NOT (OLD.status = 'APPROVED' AND NEW.status = 'POSTED'))
     OR NEW.paid_pesewas < OLD.paid_pesewas
     OR (NEW.paid_pesewas <> OLD.paid_pesewas AND OLD.status NOT IN ('POSTED', 'PAID')) THEN
    RAISE EXCEPTION 'cap.distribution_run %: % to % is not a step of its lifecycle, or changes what that step may not', OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'HK004', CONSTRAINT = 'ck_distribution_run_frozen';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION cap.distribution_run_guard() FROM PUBLIC;
CREATE TRIGGER trg_distribution_run_guard BEFORE INSERT OR UPDATE ON cap.distribution_run FOR EACH ROW EXECUTE FUNCTION cap.distribution_run_guard();

CREATE TABLE cap.distribution_line (
  id                    uuid PRIMARY KEY,
  distribution_run_id   uuid NOT NULL CONSTRAINT fk_distribution_line_run REFERENCES cap.distribution_run (id) ON DELETE RESTRICT,
  computation_no        integer NOT NULL CONSTRAINT ck_distribution_line_computation CHECK (computation_no > 0),
  investor_id           uuid NOT NULL CONSTRAINT fk_distribution_line_investor REFERENCES cap.investor (id) ON DELETE RESTRICT,
  unit_days             numeric(24,4) NOT NULL CONSTRAINT ck_distribution_line_unit_days CHECK (unit_days > 0),
  allocated_pesewas     platform.pesewas NOT NULL,
  received_extra_pesewa boolean NOT NULL DEFAULT false,
  withheld_pesewas      platform.pesewas NOT NULL DEFAULT 0,
  net_payable_pesewas   platform.pesewas NOT NULL,
  paid_pesewas          platform.pesewas NOT NULL DEFAULT 0,
  created_at            timestamptz NOT NULL,
  CONSTRAINT ck_distribution_line_net CHECK (net_payable_pesewas = allocated_pesewas - withheld_pesewas),
  CONSTRAINT ck_distribution_line_paid CHECK (paid_pesewas <= net_payable_pesewas),
  CONSTRAINT uq_distribution_line UNIQUE (distribution_run_id, computation_no, investor_id)
);
COMMENT ON TABLE cap.distribution_line IS 'class=DOCUMENT';
CREATE INDEX ix_distribution_line_investor ON cap.distribution_line (investor_id, distribution_run_id);

-- A line is written for a draft's current computation and never changes again but for what is paid, which only grows.
CREATE FUNCTION cap.distribution_line_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  run cap.distribution_run;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO run FROM cap.distribution_run WHERE id = NEW.distribution_run_id;
    IF run.status <> 'DRAFT' OR run.computation_no <> NEW.computation_no OR NEW.paid_pesewas <> 0 THEN
      RAISE EXCEPTION 'cap.distribution_line %: lines are written only for a draft run''s current computation', NEW.id USING ERRCODE = 'HK004', CONSTRAINT = 'ck_distribution_line_frozen';
    END IF;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - 'paid_pesewas') IS DISTINCT FROM (to_jsonb(OLD) - 'paid_pesewas') OR NEW.paid_pesewas < OLD.paid_pesewas THEN
    RAISE EXCEPTION 'cap.distribution_line % is frozen; only what is paid grows', OLD.id USING ERRCODE = 'HK004', CONSTRAINT = 'ck_distribution_line_frozen';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION cap.distribution_line_guard() FROM PUBLIC;
CREATE TRIGGER trg_distribution_line_guard BEFORE INSERT OR UPDATE ON cap.distribution_line FOR EACH ROW EXECUTE FUNCTION cap.distribution_line_guard();

-- At commit, once a run has left draft: its current computation's lines sum to the distributable amount exactly and their
-- unit-days to its total (ADR-0028). It runs for the run and for every line, so no pesewa is created or lost.
CREATE FUNCTION cap.distribution_run_check() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  rid uuid := COALESCE(to_jsonb(NEW)->>'distribution_run_id', to_jsonb(NEW)->>'id')::uuid;
  run cap.distribution_run;
  allocated numeric;
  weights numeric;
  paid numeric;
BEGIN
  SELECT * INTO run FROM cap.distribution_run WHERE id = rid;
  SELECT COALESCE(sum(l.allocated_pesewas), 0), COALESCE(sum(l.unit_days), 0), COALESCE(sum(l.paid_pesewas), 0) INTO allocated, weights, paid
    FROM cap.distribution_line l WHERE l.distribution_run_id = rid AND l.computation_no = run.computation_no;
  IF run.status <> 'DRAFT' AND (allocated <> run.distributable_pesewas OR weights <> run.total_unit_days) THEN
    RAISE EXCEPTION 'cap.distribution_run %: its lines allocate % of % distributable over % of % unit-days', rid, allocated, run.distributable_pesewas, weights, run.total_unit_days
      USING ERRCODE = 'HK010', CONSTRAINT = 'ck_distribution_run_allocated';
  END IF;
  IF paid <> run.paid_pesewas OR (run.status = 'PAID') <> (run.status IN ('POSTED', 'PAID') AND paid = run.distributable_pesewas - (SELECT COALESCE(sum(l.withheld_pesewas), 0) FROM cap.distribution_line l WHERE l.distribution_run_id = rid AND l.computation_no = run.computation_no)) THEN
    RAISE EXCEPTION 'cap.distribution_run %: % paid on its lines, % on the run, status %', rid, paid, run.paid_pesewas, run.status
      USING ERRCODE = 'HK010', CONSTRAINT = 'ck_distribution_run_paid_lines';
  END IF;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION cap.distribution_run_check() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER trg_distribution_run_check AFTER INSERT OR UPDATE ON cap.distribution_run
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION cap.distribution_run_check();
CREATE CONSTRAINT TRIGGER trg_distribution_line_check AFTER INSERT OR UPDATE ON cap.distribution_line
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION cap.distribution_run_check();

CREATE TABLE cap.distribution_payment (
  id                   uuid PRIMARY KEY,
  distribution_line_id uuid NOT NULL CONSTRAINT fk_distribution_payment_line REFERENCES cap.distribution_line (id) ON DELETE RESTRICT,
  amount_pesewas       platform.pesewas NOT NULL CONSTRAINT ck_distribution_payment_amount CHECK (amount_pesewas > 0),
  bank_account_id      uuid NOT NULL CONSTRAINT fk_distribution_payment_bank_account REFERENCES fin.bank_account (id) ON DELETE RESTRICT,
  external_reference   text NULL CONSTRAINT ck_distribution_payment_reference CHECK (length(btrim(external_reference)) BETWEEN 1 AND 120)
                       CONSTRAINT uq_distribution_payment_reference UNIQUE,
  paid_at              timestamptz NOT NULL,
  journal_entry_id     uuid NOT NULL CONSTRAINT fk_distribution_payment_journal REFERENCES platform.business_document (id) ON DELETE RESTRICT
                       CONSTRAINT uq_distribution_payment_journal UNIQUE,
  recorded_at          timestamptz NOT NULL,
  actor_id             uuid NOT NULL CONSTRAINT fk_distribution_payment_actor REFERENCES iam.principal (id) ON DELETE RESTRICT
);
COMMENT ON TABLE cap.distribution_payment IS 'class=LEDGER';
CREATE INDEX ix_distribution_payment_line ON cap.distribution_payment (distribution_line_id, paid_at);
CREATE TRIGGER trg_distribution_payment_immutable BEFORE UPDATE OR DELETE ON cap.distribution_payment FOR EACH ROW EXECUTE FUNCTION platform.reject_change();
CREATE TRIGGER trg_distribution_payment_no_truncate BEFORE TRUNCATE ON cap.distribution_payment FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_change();

-- A payment lands only on a current line of a posted run, and raises what the line and the run have paid; the line's
-- check refuses anything above its net payable (FR-CAP-012). The application marks the run PAID with its last payment.
CREATE FUNCTION cap.distribution_payment_apply() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
DECLARE
  line cap.distribution_line;
  run cap.distribution_run;
BEGIN
  SELECT * INTO line FROM cap.distribution_line WHERE id = NEW.distribution_line_id FOR UPDATE;
  SELECT * INTO run FROM cap.distribution_run WHERE id = line.distribution_run_id FOR UPDATE;
  IF run.status <> 'POSTED' OR run.computation_no <> line.computation_no THEN
    RAISE EXCEPTION 'cap.distribution_payment %: a payment lands only on a current line of a posted run', NEW.id USING ERRCODE = 'HK010', CONSTRAINT = 'ck_distribution_payment_posted';
  END IF;
  UPDATE cap.distribution_line SET paid_pesewas = paid_pesewas + NEW.amount_pesewas WHERE id = line.id;
  UPDATE cap.distribution_run SET paid_pesewas = paid_pesewas + NEW.amount_pesewas, version = version + 1, updated_at = NEW.recorded_at, updated_by = NEW.actor_id WHERE id = run.id;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION cap.distribution_payment_apply() FROM PUBLIC;
CREATE TRIGGER trg_distribution_payment_apply BEFORE INSERT ON cap.distribution_payment FOR EACH ROW EXECUTE FUNCTION cap.distribution_payment_apply();

REVOKE ALL ON ALL TABLES IN SCHEMA cap FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON cap.investor, cap.capital_withdrawal_request, cap.distribution_run, cap.distribution_line TO hk_app, hk_worker;
GRANT SELECT, INSERT ON cap.capital_transaction, cap.distribution_payment TO hk_app, hk_worker;
GRANT SELECT ON cap.unit_holding TO hk_app, hk_worker;

-- migrate:down
DROP TABLE cap.distribution_payment;
DROP FUNCTION cap.distribution_payment_apply();
DROP TABLE cap.distribution_line;
DROP FUNCTION cap.distribution_line_guard();
DROP TABLE cap.distribution_run;
DROP FUNCTION cap.distribution_run_check();
DROP FUNCTION cap.distribution_run_guard();
DROP TABLE cap.capital_transaction;
DROP FUNCTION cap.capital_transaction_check();
DROP TABLE cap.capital_withdrawal_request;
DROP FUNCTION cap.capital_withdrawal_request_guard();
DROP TABLE cap.unit_holding;
DROP TABLE cap.investor;
DROP SCHEMA cap;
