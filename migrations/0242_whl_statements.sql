-- 0242_whl_statements
-- B08 continued 2d (FR-WHL-009, FR-DOC-001 to FR-DOC-003, ADR-0011, ADR-0015, ADR-0085, A-300): the WHL schema with
-- customer statements only. A statement is the customer's trade receivables (1200) at one branch for a period, read
-- from the ledger through FIN's door, each line named by its source document; business accounts, credit control,
-- standing orders, ageing and dunning are B10's.
--   whl.statement       DOCUMENT, registered as a STATEMENT business document. Written once, DRAFT (a preview, no number)
--                       or ISSUED (numbered from the STATEMENT series, platform.allocate_number); afterwards only its
--                       archived rendering is set, once, by WHL's subscriber to doc.DocumentArchived (HK004
--                       ck_statement_frozen). The balance identity holds on every row (ck_statement_balances): opening
--                       less opening credit, plus invoices and debit notes and other charges, less credit notes, payments
--                       and other credits, is closing less closing credit; a balance is owed by the customer or held
--                       for them, never both (ck_statement_opening, ck_statement_closing). One issued statement per
--                       customer, branch and period (uq_statement_issued_period): asking again answers the first.
--   whl.statement_line  LEDGER, insert-only: the brought-forward line first, then each 1200 line in ledger order with
--                       its running balance. At commit the header's totals are the sums of its lines by kind and every
--                       running balance follows from the opening (ck_statement_totals, deferred, HK010); an issued
--                       statement's number is the one the platform allocated to it (ck_statement_number).
-- Additions to docs/data-model/whl.md: the credit columns, the other charges and credits, the issue columns and
-- whl.statement_line, as built.
-- Data category: CONFIDENTIAL (DC-11: what a customer owes and paid).
-- Rollback: tested (`pnpm db:rollback`), safe before the first statement; afterwards forward fix only (an issued
-- statement is a record sent to a customer and is never removed).

-- migrate:up
CREATE SCHEMA whl AUTHORIZATION hk_owner;
REVOKE ALL ON SCHEMA whl FROM PUBLIC;
GRANT USAGE ON SCHEMA whl TO hk_app, hk_worker, hk_report;

CREATE TABLE whl.statement (
  id                     uuid PRIMARY KEY CONSTRAINT fk_statement_document REFERENCES platform.business_document (id) ON DELETE RESTRICT,
  statement_no           text NULL CONSTRAINT uq_statement_no UNIQUE,
  customer_id            uuid NOT NULL CONSTRAINT fk_statement_customer REFERENCES mdm.customer (id) ON DELETE RESTRICT,
  period_start           date NOT NULL,
  period_end             date NOT NULL,
  opening_pesewas        platform.pesewas NOT NULL,
  opening_credit_pesewas platform.pesewas NOT NULL,
  invoiced_pesewas       platform.pesewas NOT NULL,
  credited_pesewas       platform.pesewas NOT NULL,
  paid_pesewas           platform.pesewas NOT NULL,
  other_charges_pesewas  platform.pesewas NOT NULL,
  other_credits_pesewas  platform.pesewas NOT NULL,
  closing_pesewas        platform.pesewas NOT NULL,
  closing_credit_pesewas platform.pesewas NOT NULL,
  issue_date             date NULL,
  archived_document_id   uuid NULL CONSTRAINT fk_statement_archived_document REFERENCES doc.archived_document (id) ON DELETE RESTRICT,
  currency               char(3) NOT NULL DEFAULT 'GHS' CONSTRAINT ck_statement_currency CHECK (currency = 'GHS'),
  status                 text NOT NULL CONSTRAINT ck_statement_status CHECK (status IN ('DRAFT', 'ISSUED')),
  branch_id              uuid NOT NULL CONSTRAINT fk_statement_branch REFERENCES mdm.branch (id) ON DELETE RESTRICT,
  version                integer NOT NULL DEFAULT 1,
  created_at             timestamptz NOT NULL,
  created_by             uuid NOT NULL CONSTRAINT fk_statement_created_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  updated_at             timestamptz NOT NULL,
  updated_by             uuid NOT NULL CONSTRAINT fk_statement_updated_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  posted_at              timestamptz NULL,
  posted_by              uuid NULL CONSTRAINT fk_statement_posted_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  CONSTRAINT ck_statement_period CHECK (period_start <= period_end),
  CONSTRAINT ck_statement_opening CHECK (opening_pesewas = 0 OR opening_credit_pesewas = 0),
  CONSTRAINT ck_statement_closing CHECK (closing_pesewas = 0 OR closing_credit_pesewas = 0),
  CONSTRAINT ck_statement_balances CHECK (
    opening_pesewas::numeric - opening_credit_pesewas + invoiced_pesewas + other_charges_pesewas - credited_pesewas - paid_pesewas - other_credits_pesewas
      = closing_pesewas::numeric - closing_credit_pesewas),
  CONSTRAINT ck_statement_issued CHECK ((status = 'ISSUED') = (statement_no IS NOT NULL)
    AND (status = 'ISSUED') = (issue_date IS NOT NULL AND posted_at IS NOT NULL AND posted_by IS NOT NULL)),
  CONSTRAINT ck_statement_archive CHECK (archived_document_id IS NULL OR status = 'ISSUED')
);
COMMENT ON TABLE whl.statement IS 'class=DOCUMENT';
CREATE UNIQUE INDEX uq_statement_issued_period ON whl.statement (customer_id, branch_id, period_start, period_end) WHERE status = 'ISSUED';
CREATE UNIQUE INDEX uq_statement_archived_document ON whl.statement (archived_document_id) WHERE archived_document_id IS NOT NULL;
CREATE INDEX ix_statement_branch ON whl.statement (branch_id, id);
CREATE INDEX ix_statement_customer ON whl.statement (customer_id, period_end);

-- Written once: nothing changes afterwards but the archived rendering, set once on an issued statement.
CREATE FUNCTION whl.statement_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.archived_document_id IS NOT NULL THEN
      RAISE EXCEPTION 'whl.statement %: a statement is archived after it is written', NEW.id USING ERRCODE = 'HK004', CONSTRAINT = 'ck_statement_frozen';
    END IF;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - ARRAY['archived_document_id', 'version', 'updated_at', 'updated_by']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['archived_document_id', 'version', 'updated_at', 'updated_by'])
     OR (OLD.archived_document_id IS NOT NULL AND NEW.archived_document_id IS DISTINCT FROM OLD.archived_document_id)
     OR NEW.archived_document_id IS NULL AND OLD.archived_document_id IS NULL THEN
    RAISE EXCEPTION 'whl.statement % is written once; only its archived rendering is set, once', OLD.id USING ERRCODE = 'HK004', CONSTRAINT = 'ck_statement_frozen';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION whl.statement_guard() FROM PUBLIC;
CREATE TRIGGER trg_statement_guard BEFORE INSERT OR UPDATE ON whl.statement
  FOR EACH ROW EXECUTE FUNCTION whl.statement_guard();

CREATE TABLE whl.statement_line (
  statement_id       uuid NOT NULL CONSTRAINT fk_statement_line_statement REFERENCES whl.statement (id) ON DELETE RESTRICT,
  line_no            integer NOT NULL CONSTRAINT ck_statement_line_no CHECK (line_no > 0),
  line_date          date NOT NULL,
  kind               text NOT NULL CONSTRAINT ck_statement_line_kind
                       CHECK (kind IN ('OPENING', 'INVOICE', 'PAYMENT', 'CREDIT_NOTE', 'DEBIT_NOTE', 'REFUND', 'PAYMENT_REVERSAL', 'ADJUSTMENT')),
  reference          text NOT NULL CONSTRAINT ck_statement_line_reference CHECK (length(btrim(reference)) BETWEEN 1 AND 120),
  debit_pesewas      platform.pesewas NOT NULL,
  credit_pesewas     platform.pesewas NOT NULL,
  balance_pesewas    platform.pesewas NOT NULL,
  balance_side       char(1) NOT NULL CONSTRAINT ck_statement_line_balance_side CHECK (balance_side IN ('D', 'C')),
  source_document_id uuid NULL CONSTRAINT fk_statement_line_source REFERENCES platform.business_document (id) ON DELETE RESTRICT,
  recorded_at        timestamptz NOT NULL,
  actor_id           uuid NOT NULL CONSTRAINT fk_statement_line_actor REFERENCES iam.principal (id) ON DELETE RESTRICT,
  CONSTRAINT pk_statement_line PRIMARY KEY (statement_id, line_no),
  -- The brought-forward line moves nothing and names no document; every other line is one debit or one credit of its source.
  CONSTRAINT ck_statement_line_amounts CHECK (
    (kind = 'OPENING' AND debit_pesewas = 0 AND credit_pesewas = 0 AND source_document_id IS NULL)
    OR (kind <> 'OPENING' AND (debit_pesewas > 0) <> (credit_pesewas > 0) AND source_document_id IS NOT NULL)),
  -- Charges are debits and settlements credits; an adjustment may be either.
  CONSTRAINT ck_statement_line_direction CHECK (
    (kind NOT IN ('INVOICE', 'DEBIT_NOTE', 'REFUND', 'PAYMENT_REVERSAL') OR credit_pesewas = 0)
    AND (kind NOT IN ('CREDIT_NOTE', 'PAYMENT') OR debit_pesewas = 0)),
  CONSTRAINT ck_statement_line_zero_side CHECK (balance_pesewas > 0 OR balance_side = 'D')
);
COMMENT ON TABLE whl.statement_line IS 'class=LEDGER';
CREATE TRIGGER trg_statement_line_immutable BEFORE UPDATE OR DELETE ON whl.statement_line
  FOR EACH ROW EXECUTE FUNCTION platform.reject_change();
CREATE TRIGGER trg_statement_line_no_truncate BEFORE TRUNCATE ON whl.statement_line
  FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_change();

-- At commit: the header's totals are its lines' by kind, the first line brings the opening forward, every running
-- balance follows from the one before, the last is the closing; an issued statement carries the number allocated to it.
-- It runs for the header and for every line, so a line added to a statement later breaks it and is refused.
CREATE FUNCTION whl.statement_check() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  sid uuid := COALESCE(to_jsonb(NEW)->>'statement_id', to_jsonb(NEW)->>'id')::uuid;
  s whl.statement;
  openings integer;
  first_kind text;
  invoiced numeric;
  credited numeric;
  paid numeric;
  other_charges numeric;
  other_credits numeric;
  off_balance integer;
  last_signed numeric;
BEGIN
  SELECT * INTO s FROM whl.statement x WHERE x.id = sid;
  SELECT count(*) FILTER (WHERE l.kind = 'OPENING'),
         COALESCE(sum(l.debit_pesewas) FILTER (WHERE l.kind IN ('INVOICE', 'DEBIT_NOTE')), 0),
         COALESCE(sum(l.credit_pesewas) FILTER (WHERE l.kind = 'CREDIT_NOTE'), 0),
         COALESCE(sum(l.credit_pesewas) FILTER (WHERE l.kind = 'PAYMENT'), 0),
         COALESCE(sum(l.debit_pesewas) FILTER (WHERE l.kind IN ('REFUND', 'PAYMENT_REVERSAL', 'ADJUSTMENT')), 0),
         COALESCE(sum(l.credit_pesewas) FILTER (WHERE l.kind = 'ADJUSTMENT'), 0)
    INTO openings, invoiced, credited, paid, other_charges, other_credits
    FROM whl.statement_line l WHERE l.statement_id = sid;
  SELECT l.kind INTO first_kind FROM whl.statement_line l WHERE l.statement_id = sid AND l.line_no = 1;
  WITH running AS (
    SELECT l.line_no, CASE l.balance_side WHEN 'C' THEN -l.balance_pesewas::numeric ELSE l.balance_pesewas::numeric END AS signed,
           s.opening_pesewas::numeric - s.opening_credit_pesewas
             + sum(l.debit_pesewas::numeric - l.credit_pesewas) OVER (ORDER BY l.line_no ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS expected,
           row_number() OVER (ORDER BY l.line_no) AS position
      FROM whl.statement_line l WHERE l.statement_id = sid
  )
  SELECT count(*) FILTER (WHERE signed <> expected OR position <> line_no), (SELECT r.signed FROM running r ORDER BY r.line_no DESC LIMIT 1)
    INTO off_balance, last_signed FROM running;
  IF openings <> 1 OR first_kind IS DISTINCT FROM 'OPENING' OR off_balance > 0
     OR last_signed IS DISTINCT FROM s.closing_pesewas::numeric - s.closing_credit_pesewas
     OR invoiced <> s.invoiced_pesewas OR credited <> s.credited_pesewas OR paid <> s.paid_pesewas
     OR other_charges <> s.other_charges_pesewas OR other_credits <> s.other_credits_pesewas THEN
    RAISE EXCEPTION 'whl.statement %: its totals and balances are not those of its lines', sid USING ERRCODE = 'HK010', CONSTRAINT = 'ck_statement_totals';
  END IF;
  IF s.status = 'ISSUED' AND NOT platform.number_allocated(s.id, s.statement_no, 'STATEMENT') THEN
    RAISE EXCEPTION 'whl.statement %: % was not allocated to it', s.id, s.statement_no USING ERRCODE = 'HK010', CONSTRAINT = 'ck_statement_number';
  END IF;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION whl.statement_check() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER trg_statement_check AFTER INSERT ON whl.statement
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whl.statement_check();
CREATE CONSTRAINT TRIGGER trg_statement_line_check AFTER INSERT ON whl.statement_line
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whl.statement_check();

REVOKE ALL ON ALL TABLES IN SCHEMA whl FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON whl.statement TO hk_app, hk_worker;
GRANT SELECT, INSERT ON whl.statement_line TO hk_app, hk_worker;

-- migrate:down
DROP TABLE whl.statement_line;
DROP TABLE whl.statement;
DROP FUNCTION whl.statement_check();
DROP FUNCTION whl.statement_guard();
DROP SCHEMA whl;
