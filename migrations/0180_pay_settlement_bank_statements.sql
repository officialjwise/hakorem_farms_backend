-- 0180_pay_settlement_bank_statements
-- B09a continued 1c (FR-PAY-005, FR-PAY-010, FR-PAY-011, FR-PAY-016, FR-PAY-017, ADR-0065, A-214): provider settlement
-- reports and bank statements imported from a file, matched line by line, and the break queue's resolutions.
-- Reconciliation never corrects: a line that does not match exactly is a break, and a break is resolved only through a
-- second person's approval. What the database holds:
--   pay.settlement_report     DOCUMENT; one per provider and settlement reference and one per file's SHA-256, so the
--                             same file imported twice collides (`uq_settlement_report_file`); gross less fee is net;
--                             IMPORTED, then POSTED or HAS_BREAKS once matched, then frozen
--   pay.settlement_line       DOCUMENT; one per provider reference ever (`uq_settlement_line_reference`: a transaction
--                             is settled once), one line per payment (`uq_settlement_line_payment`); UNMATCHED, then
--                             MATCHED, AMOUNT_DIFFERS or NOT_FOUND once, then frozen; MATCHED only to a cleared payment
--                             of the same provider, reference and amount (`trg_settlement_line_guard`)
--   pay.bank_statement        DOCUMENT; BANK accounts only; one per account and file hash, and no two statements of an
--                             account overlap in period (`ex_bank_statement_period`); IMPORTED or HAS_BREAKS until
--                             every line is matched, then RECONCILED and frozen
--   pay.bank_statement_line   DOCUMENT; UNMATCHED, then MATCHED once to one pending bank transfer
--                             (`uq_bank_statement_line_payment`) or one journal entry (`uq_bank_statement_line_entry`),
--                             then frozen
--   pay.payment               a bank transfer becomes CLEARED only when a statement line of its own bank account names
--                             it for exactly its amount (`trg_payment_transfer_cleared`, FR-PAY-005)
--   pay.reconciliation_break  names the settlement or statement line it was raised for; one open break per line and kind
--   pay.break_resolution      DOCUMENT; one resolution asked for per break at a time (`uq_break_resolution_open`), its
--                             note and posting; PENDING_APPROVAL to APPROVED or REJECTED, then frozen
-- Data category: CONFIDENTIAL (DC-22): payments against named customers and the business's bank lines.
-- Rollback: tested (`pnpm db:rollback`), safe before the first import; afterwards forward fix only.

-- migrate:up
CREATE TABLE pay.settlement_report (
  id              uuid PRIMARY KEY CONSTRAINT fk_settlement_report_document REFERENCES platform.business_document (id) ON DELETE RESTRICT,
  provider        text NOT NULL CONSTRAINT ck_settlement_report_provider CHECK (provider ~ '^[A-Z][A-Z_]{1,29}$'),
  settlement_ref  text NOT NULL CONSTRAINT ck_settlement_report_ref CHECK (length(settlement_ref) BETWEEN 1 AND 60),
  settled_on      date NOT NULL,
  bank_account_id uuid NOT NULL CONSTRAINT fk_settlement_report_bank_account REFERENCES fin.bank_account (id) ON DELETE RESTRICT,
  gross_pesewas   platform.pesewas NOT NULL CONSTRAINT ck_settlement_report_gross CHECK (gross_pesewas > 0),
  fee_pesewas     platform.pesewas NOT NULL,
  net_pesewas     platform.pesewas NOT NULL,
  currency        char(3) NOT NULL DEFAULT 'GHS' CONSTRAINT ck_settlement_report_currency CHECK (currency = 'GHS'),
  file_id         uuid NOT NULL CONSTRAINT fk_settlement_report_file REFERENCES platform.stored_file (id) ON DELETE RESTRICT,
  file_sha256     bytea NOT NULL CONSTRAINT ck_settlement_report_sha256 CHECK (length(file_sha256) = 32),
  status          text NOT NULL DEFAULT 'IMPORTED' CONSTRAINT ck_settlement_report_status CHECK (status IN ('IMPORTED', 'MATCHED', 'POSTED', 'HAS_BREAKS')),
  matched_at      timestamptz NULL,
  matched_by      uuid NULL CONSTRAINT fk_settlement_report_matched_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  branch_id       uuid NOT NULL CONSTRAINT fk_settlement_report_branch REFERENCES mdm.branch (id) ON DELETE RESTRICT,
  version         integer NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid NOT NULL CONSTRAINT fk_settlement_report_created_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      uuid NOT NULL CONSTRAINT fk_settlement_report_updated_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  CONSTRAINT ck_settlement_report_net CHECK (gross_pesewas - fee_pesewas = net_pesewas),
  CONSTRAINT ck_settlement_report_matched CHECK ((status = 'IMPORTED') = (matched_at IS NULL) AND (matched_at IS NULL) = (matched_by IS NULL)),
  CONSTRAINT uq_settlement_report_ref UNIQUE (provider, settlement_ref),
  CONSTRAINT uq_settlement_report_file UNIQUE (provider, file_sha256)
);
COMMENT ON TABLE pay.settlement_report IS 'class=DOCUMENT';
CREATE INDEX ix_settlement_report_settled ON pay.settlement_report (settled_on DESC, id DESC);
CREATE INDEX ix_settlement_report_bank_account ON pay.settlement_report (bank_account_id) WHERE status IN ('POSTED', 'HAS_BREAKS');
CREATE TRIGGER trg_settlement_report_version BEFORE UPDATE ON pay.settlement_report
  FOR EACH ROW EXECUTE FUNCTION platform.touch_version();

CREATE FUNCTION pay.settlement_report_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'IMPORTED' THEN
      RAISE EXCEPTION 'pay.settlement_report %: a report is written IMPORTED', NEW.id USING ERRCODE = 'HK004', CONSTRAINT = 'ck_settlement_report_transition';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status <> 'IMPORTED' OR NEW.status NOT IN ('POSTED', 'HAS_BREAKS')
     OR (to_jsonb(NEW) - ARRAY['status', 'matched_at', 'matched_by', 'version', 'updated_at', 'updated_by'])
        IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'matched_at', 'matched_by', 'version', 'updated_at', 'updated_by']) THEN
    RAISE EXCEPTION 'pay.settlement_report %: a report is matched once and then frozen; what it says never changes', OLD.id
      USING ERRCODE = 'HK004', CONSTRAINT = 'ck_settlement_report_transition';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION pay.settlement_report_guard() FROM PUBLIC;
CREATE TRIGGER trg_settlement_report_guard BEFORE INSERT OR UPDATE ON pay.settlement_report
  FOR EACH ROW EXECUTE FUNCTION pay.settlement_report_guard();

CREATE TABLE pay.settlement_line (
  id                   uuid PRIMARY KEY,
  settlement_report_id uuid NOT NULL CONSTRAINT fk_settlement_line_report REFERENCES pay.settlement_report (id) ON DELETE RESTRICT,
  line_no              integer NOT NULL CONSTRAINT ck_settlement_line_no CHECK (line_no > 0),
  provider             text NOT NULL CONSTRAINT ck_settlement_line_provider CHECK (provider ~ '^[A-Z][A-Z_]{1,29}$'),
  provider_reference   text NOT NULL CONSTRAINT ck_settlement_line_reference CHECK (length(provider_reference) BETWEEN 1 AND 100),
  amount_pesewas       platform.pesewas NOT NULL CONSTRAINT ck_settlement_line_amount CHECK (amount_pesewas > 0),
  fee_pesewas          platform.pesewas NOT NULL DEFAULT 0,
  matched_payment_id   uuid NULL CONSTRAINT fk_settlement_line_payment REFERENCES pay.payment (id) ON DELETE RESTRICT,
  match_status         text NOT NULL DEFAULT 'UNMATCHED' CONSTRAINT ck_settlement_line_status CHECK (match_status IN ('UNMATCHED', 'MATCHED', 'AMOUNT_DIFFERS', 'NOT_FOUND')),
  match_reason         text NULL CONSTRAINT ck_settlement_line_reason CHECK (match_reason IN ('AMOUNT_DIFFERS', 'NO_PAYMENT', 'NOT_CLEARED', 'ALREADY_SETTLED')),
  branch_id            uuid NOT NULL CONSTRAINT fk_settlement_line_branch REFERENCES mdm.branch (id) ON DELETE RESTRICT,
  version              integer NOT NULL DEFAULT 1,
  created_at           timestamptz NOT NULL DEFAULT now(),
  created_by           uuid NOT NULL CONSTRAINT fk_settlement_line_created_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  updated_by           uuid NOT NULL CONSTRAINT fk_settlement_line_updated_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  CONSTRAINT ck_settlement_line_fee CHECK (fee_pesewas <= amount_pesewas),
  CONSTRAINT ck_settlement_line_match CHECK ((match_status = 'MATCHED') = (matched_payment_id IS NOT NULL) AND (match_status IN ('UNMATCHED', 'MATCHED')) = (match_reason IS NULL)),
  CONSTRAINT uq_settlement_line_no UNIQUE (settlement_report_id, line_no),
  CONSTRAINT uq_settlement_line_reference UNIQUE (provider, provider_reference)
);
COMMENT ON TABLE pay.settlement_line IS 'class=DOCUMENT';
CREATE UNIQUE INDEX uq_settlement_line_payment ON pay.settlement_line (matched_payment_id) WHERE matched_payment_id IS NOT NULL;
CREATE TRIGGER trg_settlement_line_version BEFORE UPDATE ON pay.settlement_line
  FOR EACH ROW EXECUTE FUNCTION platform.touch_version();

CREATE FUNCTION pay.settlement_line_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  paid record;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.match_status <> 'UNMATCHED' THEN
      RAISE EXCEPTION 'pay.settlement_line %: a line is written UNMATCHED', NEW.id USING ERRCODE = 'HK004', CONSTRAINT = 'ck_settlement_line_transition';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.match_status <> 'UNMATCHED' OR NEW.match_status = 'UNMATCHED'
     OR (to_jsonb(NEW) - ARRAY['match_status', 'match_reason', 'matched_payment_id', 'version', 'updated_at', 'updated_by'])
        IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['match_status', 'match_reason', 'matched_payment_id', 'version', 'updated_at', 'updated_by']) THEN
    RAISE EXCEPTION 'pay.settlement_line %: a line is matched once and then frozen; what it says never changes', OLD.id
      USING ERRCODE = 'HK004', CONSTRAINT = 'ck_settlement_line_transition';
  END IF;
  IF NEW.match_status = 'MATCHED' THEN
    SELECT status, provider, provider_reference, amount_pesewas INTO paid FROM pay.payment WHERE id = NEW.matched_payment_id;
    IF paid.status IS DISTINCT FROM 'CLEARED' OR paid.provider IS DISTINCT FROM NEW.provider
       OR paid.provider_reference IS DISTINCT FROM NEW.provider_reference OR paid.amount_pesewas IS DISTINCT FROM NEW.amount_pesewas THEN
      RAISE EXCEPTION 'pay.settlement_line %: matched only to a cleared payment of the same provider, reference and amount', OLD.id
        USING ERRCODE = 'HK004', CONSTRAINT = 'ck_settlement_line_matched_payment';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION pay.settlement_line_guard() FROM PUBLIC;
CREATE TRIGGER trg_settlement_line_guard BEFORE INSERT OR UPDATE ON pay.settlement_line
  FOR EACH ROW EXECUTE FUNCTION pay.settlement_line_guard();

CREATE TABLE pay.bank_statement (
  id              uuid PRIMARY KEY CONSTRAINT fk_bank_statement_document REFERENCES platform.business_document (id) ON DELETE RESTRICT,
  bank_account_id uuid NOT NULL CONSTRAINT fk_bank_statement_bank_account REFERENCES fin.bank_account (id) ON DELETE RESTRICT,
  period_start    date NOT NULL,
  period_end      date NOT NULL,
  opening_pesewas platform.pesewas NOT NULL,
  closing_pesewas platform.pesewas NOT NULL,
  currency        char(3) NOT NULL DEFAULT 'GHS' CONSTRAINT ck_bank_statement_currency CHECK (currency = 'GHS'),
  file_id         uuid NOT NULL CONSTRAINT fk_bank_statement_file REFERENCES platform.stored_file (id) ON DELETE RESTRICT,
  file_sha256     bytea NOT NULL CONSTRAINT ck_bank_statement_sha256 CHECK (length(file_sha256) = 32),
  status          text NOT NULL DEFAULT 'IMPORTED' CONSTRAINT ck_bank_statement_status CHECK (status IN ('IMPORTED', 'RECONCILED', 'HAS_BREAKS')),
  branch_id       uuid NOT NULL CONSTRAINT fk_bank_statement_branch REFERENCES mdm.branch (id) ON DELETE RESTRICT,
  version         integer NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid NOT NULL CONSTRAINT fk_bank_statement_created_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      uuid NOT NULL CONSTRAINT fk_bank_statement_updated_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  CONSTRAINT ck_bank_statement_period CHECK (period_end >= period_start),
  CONSTRAINT uq_bank_statement_file UNIQUE (bank_account_id, file_sha256),
  CONSTRAINT ex_bank_statement_period EXCLUDE USING gist (bank_account_id WITH =, daterange(period_start, period_end, '[]') WITH &&)
);
COMMENT ON TABLE pay.bank_statement IS 'class=DOCUMENT';
CREATE INDEX ix_bank_statement_period ON pay.bank_statement (period_end DESC, id DESC);
CREATE TRIGGER trg_bank_statement_version BEFORE UPDATE ON pay.bank_statement
  FOR EACH ROW EXECUTE FUNCTION platform.touch_version();

CREATE FUNCTION pay.bank_statement_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'IMPORTED' THEN
      RAISE EXCEPTION 'pay.bank_statement %: a statement is written IMPORTED', NEW.id USING ERRCODE = 'HK004', CONSTRAINT = 'ck_bank_statement_transition';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status = 'RECONCILED' OR NEW.status = 'IMPORTED'
     OR (to_jsonb(NEW) - ARRAY['status', 'version', 'updated_at', 'updated_by']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'version', 'updated_at', 'updated_by']) THEN
    RAISE EXCEPTION 'pay.bank_statement %: what a statement says never changes, and a reconciled statement is frozen', OLD.id
      USING ERRCODE = 'HK004', CONSTRAINT = 'ck_bank_statement_transition';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION pay.bank_statement_guard() FROM PUBLIC;
CREATE TRIGGER trg_bank_statement_guard BEFORE INSERT OR UPDATE ON pay.bank_statement
  FOR EACH ROW EXECUTE FUNCTION pay.bank_statement_guard();

CREATE TABLE pay.bank_statement_line (
  id                        uuid PRIMARY KEY,
  bank_statement_id         uuid NOT NULL CONSTRAINT fk_bank_statement_line_statement REFERENCES pay.bank_statement (id) ON DELETE RESTRICT,
  line_no                   integer NOT NULL CONSTRAINT ck_bank_statement_line_no CHECK (line_no > 0),
  bank_account_id           uuid NOT NULL CONSTRAINT fk_bank_statement_line_bank_account REFERENCES fin.bank_account (id) ON DELETE RESTRICT,
  value_date                date NOT NULL,
  direction                 text NOT NULL CONSTRAINT ck_bank_statement_line_direction CHECK (direction IN ('IN', 'OUT')),
  amount_pesewas            platform.pesewas NOT NULL CONSTRAINT ck_bank_statement_line_amount CHECK (amount_pesewas > 0),
  balance_pesewas           platform.pesewas NOT NULL,
  narration                 text NULL CONSTRAINT ck_bank_statement_line_narration CHECK (length(narration) BETWEEN 1 AND 200),
  bank_reference            text NULL CONSTRAINT ck_bank_statement_line_reference CHECK (length(bank_reference) BETWEEN 1 AND 200),
  matched_payment_id        uuid NULL CONSTRAINT fk_bank_statement_line_payment REFERENCES pay.payment (id) ON DELETE RESTRICT,
  matched_journal_entry_ref uuid NULL,
  match_status              text NOT NULL DEFAULT 'UNMATCHED' CONSTRAINT ck_bank_statement_line_status CHECK (match_status IN ('MATCHED', 'UNMATCHED')),
  matched_by                uuid NULL CONSTRAINT fk_bank_statement_line_matched_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  matched_at                timestamptz NULL,
  branch_id                 uuid NOT NULL CONSTRAINT fk_bank_statement_line_branch REFERENCES mdm.branch (id) ON DELETE RESTRICT,
  version                   integer NOT NULL DEFAULT 1,
  created_at                timestamptz NOT NULL DEFAULT now(),
  created_by                uuid NOT NULL CONSTRAINT fk_bank_statement_line_created_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  updated_at                timestamptz NOT NULL DEFAULT now(),
  updated_by                uuid NOT NULL CONSTRAINT fk_bank_statement_line_updated_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  CONSTRAINT ck_bank_statement_line_match CHECK (
    (match_status = 'MATCHED') = (num_nonnulls(matched_payment_id, matched_journal_entry_ref) = 1)
    AND (match_status = 'UNMATCHED') = (num_nonnulls(matched_payment_id, matched_journal_entry_ref) = 0)
    AND (match_status = 'MATCHED') = (matched_at IS NOT NULL) AND (matched_at IS NULL) = (matched_by IS NULL)),
  CONSTRAINT uq_bank_statement_line_no UNIQUE (bank_statement_id, line_no)
);
COMMENT ON TABLE pay.bank_statement_line IS 'class=DOCUMENT';
CREATE UNIQUE INDEX uq_bank_statement_line_payment ON pay.bank_statement_line (matched_payment_id) WHERE matched_payment_id IS NOT NULL;
CREATE UNIQUE INDEX uq_bank_statement_line_entry ON pay.bank_statement_line (matched_journal_entry_ref) WHERE matched_journal_entry_ref IS NOT NULL;
CREATE TRIGGER trg_bank_statement_line_version BEFORE UPDATE ON pay.bank_statement_line
  FOR EACH ROW EXECUTE FUNCTION platform.touch_version();

CREATE FUNCTION pay.bank_statement_line_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  paid record;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.match_status <> 'UNMATCHED' THEN
      RAISE EXCEPTION 'pay.bank_statement_line %: a line is written UNMATCHED', NEW.id USING ERRCODE = 'HK004', CONSTRAINT = 'ck_bank_statement_line_transition';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.match_status = 'MATCHED'
     OR (to_jsonb(NEW) - ARRAY['match_status', 'matched_payment_id', 'matched_journal_entry_ref', 'matched_by', 'matched_at', 'version', 'updated_at', 'updated_by'])
        IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['match_status', 'matched_payment_id', 'matched_journal_entry_ref', 'matched_by', 'matched_at', 'version', 'updated_at', 'updated_by']) THEN
    RAISE EXCEPTION 'pay.bank_statement_line %: a line is matched once and then frozen; what it says never changes', OLD.id
      USING ERRCODE = 'HK004', CONSTRAINT = 'ck_bank_statement_line_transition';
  END IF;
  IF NEW.matched_payment_id IS NOT NULL THEN
    SELECT method_kind, status, bank_account_id, amount_pesewas INTO paid FROM pay.payment WHERE id = NEW.matched_payment_id;
    IF paid.method_kind IS DISTINCT FROM 'BANK_TRANSFER' OR paid.status IS DISTINCT FROM 'PENDING' OR NEW.direction <> 'IN'
       OR paid.bank_account_id IS DISTINCT FROM NEW.bank_account_id OR paid.amount_pesewas IS DISTINCT FROM NEW.amount_pesewas THEN
      RAISE EXCEPTION 'pay.bank_statement_line %: matched only to a pending bank transfer into the same account for the same amount', OLD.id
        USING ERRCODE = 'HK004', CONSTRAINT = 'ck_bank_statement_line_matched_payment';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION pay.bank_statement_line_guard() FROM PUBLIC;
CREATE TRIGGER trg_bank_statement_line_guard BEFORE INSERT OR UPDATE ON pay.bank_statement_line
  FOR EACH ROW EXECUTE FUNCTION pay.bank_statement_line_guard();

-- FR-PAY-005: a bank transfer clears only from a matched statement line. The line is matched first, in the same
-- transaction, so the clearing finds it.
CREATE FUNCTION pay.payment_transfer_cleared() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pay.bank_statement_line l
                  WHERE l.matched_payment_id = NEW.id AND l.bank_account_id = NEW.bank_account_id AND l.amount_pesewas = NEW.amount_pesewas) THEN
    RAISE EXCEPTION 'pay.payment %: a bank transfer clears only from a statement line matched to it', NEW.id
      USING ERRCODE = 'HK004', CONSTRAINT = 'ck_payment_transfer_cleared';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION pay.payment_transfer_cleared() FROM PUBLIC;
CREATE TRIGGER trg_payment_transfer_cleared BEFORE UPDATE OF status ON pay.payment
  FOR EACH ROW WHEN (OLD.method_kind = 'BANK_TRANSFER' AND OLD.status = 'PENDING' AND NEW.status = 'CLEARED' AND OLD.reverses_payment_id IS NULL)
  EXECUTE FUNCTION pay.payment_transfer_cleared();

ALTER TABLE pay.reconciliation_break
  ADD COLUMN settlement_line_id uuid NULL CONSTRAINT fk_reconciliation_break_settlement_line REFERENCES pay.settlement_line (id) ON DELETE RESTRICT,
  ADD COLUMN bank_statement_line_id uuid NULL CONSTRAINT fk_reconciliation_break_bank_line REFERENCES pay.bank_statement_line (id) ON DELETE RESTRICT,
  ADD CONSTRAINT ck_reconciliation_break_one_line CHECK (num_nonnulls(settlement_line_id, bank_statement_line_id) <= 1);
CREATE UNIQUE INDEX uq_reconciliation_break_open_settlement_line ON pay.reconciliation_break (settlement_line_id, kind) WHERE status = 'OPEN' AND settlement_line_id IS NOT NULL;
CREATE UNIQUE INDEX uq_reconciliation_break_open_bank_line ON pay.reconciliation_break (bank_statement_line_id, kind) WHERE status = 'OPEN' AND bank_statement_line_id IS NOT NULL;
CREATE INDEX ix_reconciliation_break_list ON pay.reconciliation_break (raised_at DESC, id DESC);

CREATE TABLE pay.break_resolution (
  id                  uuid PRIMARY KEY CONSTRAINT fk_break_resolution_document REFERENCES platform.business_document (id) ON DELETE RESTRICT,
  break_id            uuid NOT NULL CONSTRAINT fk_break_resolution_break REFERENCES pay.reconciliation_break (id) ON DELETE RESTRICT,
  posting             text NOT NULL CONSTRAINT ck_break_resolution_posting CHECK (posting IN ('NONE', 'UNIDENTIFIED_RECEIPT')),
  note                text NOT NULL CONSTRAINT ck_break_resolution_note CHECK (length(btrim(note)) BETWEEN 1 AND 500),
  approval_request_id uuid NULL CONSTRAINT fk_break_resolution_approval REFERENCES iam.approval_request (id) ON DELETE RESTRICT
                        CONSTRAINT uq_break_resolution_approval UNIQUE,
  status              text NOT NULL CONSTRAINT ck_break_resolution_status CHECK (status IN ('PENDING_APPROVAL', 'APPROVED', 'REJECTED')),
  branch_id           uuid NOT NULL CONSTRAINT fk_break_resolution_branch REFERENCES mdm.branch (id) ON DELETE RESTRICT,
  version             integer NOT NULL DEFAULT 1,
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid NOT NULL CONSTRAINT fk_break_resolution_created_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  updated_by          uuid NOT NULL CONSTRAINT fk_break_resolution_updated_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  CONSTRAINT ck_break_resolution_requested CHECK (status = 'PENDING_APPROVAL' OR approval_request_id IS NOT NULL),
  CONSTRAINT ck_break_resolution_checker CHECK (status <> 'APPROVED' OR updated_by <> created_by)
);
COMMENT ON TABLE pay.break_resolution IS 'class=DOCUMENT';
CREATE UNIQUE INDEX uq_break_resolution_open ON pay.break_resolution (break_id) WHERE status = 'PENDING_APPROVAL';
CREATE UNIQUE INDEX uq_break_resolution_approved ON pay.break_resolution (break_id) WHERE status = 'APPROVED';
CREATE TRIGGER trg_break_resolution_version BEFORE UPDATE ON pay.break_resolution
  FOR EACH ROW EXECUTE FUNCTION platform.touch_version();

CREATE FUNCTION pay.break_resolution_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'PENDING_APPROVAL' THEN
      RAISE EXCEPTION 'pay.break_resolution %: a resolution is written PENDING_APPROVAL', NEW.id USING ERRCODE = 'HK004', CONSTRAINT = 'ck_break_resolution_transition';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status <> 'PENDING_APPROVAL'
     OR (NEW.status IS DISTINCT FROM OLD.status AND NEW.status NOT IN ('APPROVED', 'REJECTED'))
     OR (NEW.break_id, NEW.posting, NEW.note, NEW.branch_id, NEW.created_by, NEW.created_at)
        IS DISTINCT FROM (OLD.break_id, OLD.posting, OLD.note, OLD.branch_id, OLD.created_by, OLD.created_at)
     OR (OLD.approval_request_id IS NOT NULL AND NEW.approval_request_id IS DISTINCT FROM OLD.approval_request_id) THEN
    RAISE EXCEPTION 'pay.break_resolution %: what was asked for never changes, and a decided resolution is frozen', OLD.id
      USING ERRCODE = 'HK004', CONSTRAINT = 'ck_break_resolution_transition';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION pay.break_resolution_guard() FROM PUBLIC;
CREATE TRIGGER trg_break_resolution_guard BEFORE INSERT OR UPDATE ON pay.break_resolution
  FOR EACH ROW EXECUTE FUNCTION pay.break_resolution_guard();

-- A break is resolved only by an approved resolution (FR-PAY-017): by the person who approved it, never its maker
-- (ck_break_resolution_checker; IAM's approval holds the same rule), never by hand.
-- A failed refund's break closes when the refund is paid (ADR-0063): its own approved payout.
CREATE FUNCTION pay.reconciliation_break_resolved() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.refund_id IS NOT NULL AND NEW.kind = 'REFUND_FAILED' THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pay.break_resolution r
                  WHERE r.break_id = NEW.id AND r.status = 'APPROVED' AND r.updated_by = NEW.resolved_by AND r.created_by <> NEW.resolved_by) THEN
    RAISE EXCEPTION 'pay.reconciliation_break %: a break is resolved only through an approved resolution', NEW.id
      USING ERRCODE = 'HK004', CONSTRAINT = 'ck_reconciliation_break_approved';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION pay.reconciliation_break_resolved() FROM PUBLIC;
CREATE TRIGGER trg_reconciliation_break_resolved BEFORE UPDATE OF status ON pay.reconciliation_break
  FOR EACH ROW WHEN (OLD.status = 'OPEN' AND NEW.status = 'RESOLVED')
  EXECUTE FUNCTION pay.reconciliation_break_resolved();

CREATE OR REPLACE VIEW pay.pub_reconciliation_break AS
SELECT b.id, b.kind, b.branch_id, b.payment_id, b.refund_id, b.provider, b.reference, b.source_document_id, b.amount_pesewas,
       b.raised_at, b.status, b.resolved_at, b.resolved_by, b.created_by, b.settlement_line_id, b.bank_statement_line_id
  FROM pay.reconciliation_break b;

REVOKE ALL ON pay.settlement_report, pay.settlement_line, pay.bank_statement, pay.bank_statement_line, pay.break_resolution FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON pay.settlement_report, pay.settlement_line, pay.bank_statement, pay.bank_statement_line, pay.break_resolution TO hk_app, hk_worker;

-- migrate:down
DROP VIEW pay.pub_reconciliation_break;
CREATE VIEW pay.pub_reconciliation_break AS
SELECT b.id, b.kind, b.branch_id, b.payment_id, b.refund_id, b.provider, b.reference, b.source_document_id, b.amount_pesewas,
       b.raised_at, b.status, b.resolved_at, b.resolved_by, b.created_by
  FROM pay.reconciliation_break b;
REVOKE ALL ON pay.pub_reconciliation_break FROM PUBLIC;
GRANT SELECT ON pay.pub_reconciliation_break TO hk_app, hk_worker, hk_report;
DROP TRIGGER trg_reconciliation_break_resolved ON pay.reconciliation_break;
DROP FUNCTION pay.reconciliation_break_resolved();
DROP TABLE pay.break_resolution;
DROP FUNCTION pay.break_resolution_guard();
DROP INDEX pay.ix_reconciliation_break_list;
DROP INDEX pay.uq_reconciliation_break_open_bank_line;
DROP INDEX pay.uq_reconciliation_break_open_settlement_line;
ALTER TABLE pay.reconciliation_break DROP CONSTRAINT ck_reconciliation_break_one_line, DROP COLUMN bank_statement_line_id, DROP COLUMN settlement_line_id;
DROP TRIGGER trg_payment_transfer_cleared ON pay.payment;
DROP FUNCTION pay.payment_transfer_cleared();
DROP TABLE pay.bank_statement_line;
DROP FUNCTION pay.bank_statement_line_guard();
DROP TABLE pay.bank_statement;
DROP FUNCTION pay.bank_statement_guard();
DROP TABLE pay.settlement_line;
DROP FUNCTION pay.settlement_line_guard();
DROP TABLE pay.settlement_report;
DROP FUNCTION pay.settlement_report_guard();
