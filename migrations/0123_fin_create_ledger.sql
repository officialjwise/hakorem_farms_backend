-- 0123_fin_create_ledger
-- The general ledger's core (docs/data-model/fin.md, ADR-0003, ADR-0005, ADR-0056): the chart of accounts, subledger
-- parties, accounting periods, the catalogue of posting events, posting rules and account determination as data, and
-- the insert-only journal. Bank accounts, manual journals, period balances and fixed assets arrive with their
-- workflows (B08 continued).
--
-- The database refuses every journal rule itself, whoever writes (FR-FIN-003, FR-FIN-004, FR-FIN-009). A refusal by a
-- trigger is SQLSTATE HK012 with the rule as its constraint name:
--   ck_journal_lines            at commit: an entry has fewer than two lines
--   ck_journal_balanced         at commit: an entry's debits do not equal its credits
--   ck_journal_period           an entry's posting date is not inside the period it names
--   ck_journal_period_open      an entry is posted into a period that is not OPEN
--   ck_journal_line_entry       a line joins an entry written by an earlier transaction, or its date differs
--   ck_journal_line_account     a line on an account that is missing, a header, closed or archived
--   ck_journal_line_subledger   a line names a subledger party exactly when its account has a subledger, of that kind
--   ck_account_change           a used account's code, type, side or subledger changed, or a used account archived
--   ck_period_change            a period's dates changed, or a CLOSED period changed at all
-- Sign and shape are CHECK constraints (SQLSTATE 23514): `amount_pesewas > 0` and `side IN ('D', 'C')`, so a zero line
-- or a line that is both debit and credit cannot be written. UPDATE, DELETE and TRUNCATE on the journal are refused for
-- every role by platform.reject_change() (HK001). The balance check is a deferred constraint trigger: it runs at commit,
-- so it holds for direct SQL and scripts as much as for the application.
-- The trigger functions are SECURITY DEFINER owned by hk_owner with a fixed search_path.
-- Seeded: the chart of ADR-0003 (A-029), account determination, the posting events published today with their rules
-- (A-182), and monthly periods for the calendar years 2026 to 2030, OPEN (A-028, A-183).
-- Data category: CONFIDENTIAL (DC-09): the farm's books; no personal data beyond a party's display name.
-- Rollback: tested (`pnpm db:rollback`), safe before the first journal; afterwards forward fix only (the ledger is
-- never rewritten).

-- migrate:up
CREATE SCHEMA fin AUTHORIZATION hk_owner;
REVOKE ALL ON SCHEMA fin FROM PUBLIC;
GRANT USAGE ON SCHEMA fin TO hk_app, hk_worker, hk_report;

CREATE FUNCTION fin.refuse(rule text, message text) RETURNS void
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION '%', message USING ERRCODE = 'HK012', CONSTRAINT = rule;
END
$$;
REVOKE ALL ON FUNCTION fin.refuse(text, text) FROM PUBLIC;

-- The chart of accounts.
CREATE TABLE fin.account (
  id                 uuid PRIMARY KEY,
  code               text NOT NULL CONSTRAINT ck_account_code CHECK (code ~ '^[1-6][0-9]{3}$'),
  name               text NOT NULL CONSTRAINT ck_account_name CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  type               text NOT NULL CONSTRAINT ck_account_type CHECK (type IN ('ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'COST_OF_SALES', 'EXPENSE')),
  normal_side        char(1) NOT NULL CONSTRAINT ck_account_normal_side CHECK (normal_side IN ('D', 'C')),
  parent_id          uuid NULL CONSTRAINT fk_account_parent REFERENCES fin.account (id) ON DELETE RESTRICT,
  is_postable        boolean NOT NULL,
  subledger_kind     text NULL CONSTRAINT ck_account_subledger_kind CHECK (subledger_kind IN ('CUSTOMER', 'SUPPLIER', 'INVESTOR', 'TAX_LEVY', 'REGISTER', 'DRIVER', 'BANK_ACCOUNT', 'PROVIDER')),
  cash_flow_category text NULL CONSTRAINT ck_account_cash_flow CHECK (cash_flow_category IN ('OPERATING', 'INVESTING', 'FINANCING')),
  status             text NOT NULL CONSTRAINT ck_account_status CHECK (status IN ('ACTIVE', 'CLOSED')),
  version            integer NOT NULL DEFAULT 1,
  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid NOT NULL CONSTRAINT fk_account_created_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  updated_by         uuid NOT NULL CONSTRAINT fk_account_updated_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  deleted_at         timestamptz NULL,
  deleted_by         uuid NULL CONSTRAINT fk_account_deleted_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  delete_reason      text NULL,
  -- The first digit gives the class (ADR-0003): 1 assets, 2 liabilities, 3 equity, 4 income, 5 cost of sales, 6 expenses.
  CONSTRAINT ck_account_class CHECK (
    (left(code, 1) = '1' AND type = 'ASSET') OR (left(code, 1) = '2' AND type = 'LIABILITY') OR (left(code, 1) = '3' AND type = 'EQUITY')
    OR (left(code, 1) = '4' AND type = 'INCOME') OR (left(code, 1) = '5' AND type = 'COST_OF_SALES') OR (left(code, 1) = '6' AND type = 'EXPENSE')),
  CONSTRAINT ck_account_soft_delete CHECK ((deleted_at IS NULL) = (deleted_by IS NULL) AND (deleted_at IS NULL) = (delete_reason IS NULL))
);
COMMENT ON TABLE fin.account IS 'class=MASTER';
CREATE UNIQUE INDEX uq_account_code ON fin.account (code) WHERE deleted_at IS NULL;
CREATE TRIGGER trg_account_version BEFORE UPDATE ON fin.account
  FOR EACH ROW EXECUTE FUNCTION platform.touch_version();

-- Registry of the parties a control account breaks down by (customer, supplier, levy, ...), so a line's subledger
-- reference is a real foreign key without FIN referencing a higher module. Written by the posting handler on first use.
CREATE TABLE fin.subledger_party (
  id           uuid PRIMARY KEY,
  kind         text NOT NULL CONSTRAINT ck_subledger_party_kind CHECK (kind IN ('CUSTOMER', 'SUPPLIER', 'INVESTOR', 'TAX_LEVY', 'REGISTER', 'DRIVER', 'BANK_ACCOUNT', 'PROVIDER')),
  ref_id       uuid NOT NULL,
  display_name text NOT NULL CONSTRAINT ck_subledger_party_name CHECK (length(btrim(display_name)) BETWEEN 1 AND 200),
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_subledger_party_ref UNIQUE (kind, ref_id)
);
COMMENT ON TABLE fin.subledger_party IS 'class=MASTER';

-- Accounting periods: twelve a calendar year (A-028), contiguous and never overlapping.
CREATE TABLE fin.accounting_period (
  id          uuid PRIMARY KEY,
  fiscal_year integer NOT NULL CONSTRAINT ck_accounting_period_year CHECK (fiscal_year BETWEEN 2020 AND 2100),
  period_no   integer NOT NULL CONSTRAINT ck_accounting_period_no CHECK (period_no BETWEEN 1 AND 12),
  start_date  date NOT NULL,
  end_date    date NOT NULL,
  status      text NOT NULL CONSTRAINT ck_accounting_period_status CHECK (status IN ('FUTURE', 'OPEN', 'LOCKED', 'CLOSED')),
  locked_at   timestamptz NULL,
  locked_by   uuid NULL CONSTRAINT fk_accounting_period_locked_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  closed_at   timestamptz NULL,
  closed_by   uuid NULL CONSTRAINT fk_accounting_period_closed_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  version     integer NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid NOT NULL CONSTRAINT fk_accounting_period_created_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  uuid NOT NULL CONSTRAINT fk_accounting_period_updated_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  CONSTRAINT ck_accounting_period_dates CHECK (end_date >= start_date),
  CONSTRAINT ck_accounting_period_locked CHECK ((locked_at IS NULL) = (locked_by IS NULL)),
  CONSTRAINT ck_accounting_period_closed CHECK ((closed_at IS NULL) = (closed_by IS NULL) AND (status = 'CLOSED') = (closed_at IS NOT NULL)),
  CONSTRAINT uq_accounting_period_no UNIQUE (fiscal_year, period_no),
  CONSTRAINT ex_accounting_period_no_overlap EXCLUDE USING gist (daterange(start_date, end_date, '[]') WITH &&)
);
COMMENT ON TABLE fin.accounting_period IS 'class=DOCUMENT';
CREATE INDEX ix_accounting_period_start ON fin.accounting_period (start_date);
CREATE TRIGGER trg_accounting_period_version BEFORE UPDATE ON fin.accounting_period
  FOR EACH ROW EXECUTE FUNCTION platform.touch_version();

CREATE FUNCTION fin.accounting_period_guard() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
BEGIN
  IF OLD.status = 'CLOSED' THEN
    PERFORM fin.refuse('ck_period_change', format('accounting period %s-%s is CLOSED and never changes', OLD.fiscal_year, OLD.period_no));
  END IF;
  IF (NEW.fiscal_year, NEW.period_no, NEW.start_date, NEW.end_date) IS DISTINCT FROM (OLD.fiscal_year, OLD.period_no, OLD.start_date, OLD.end_date) THEN
    PERFORM fin.refuse('ck_period_change', format('accounting period %s-%s keeps its dates', OLD.fiscal_year, OLD.period_no));
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION fin.accounting_period_guard() FROM PUBLIC;
CREATE TRIGGER trg_accounting_period_guard BEFORE UPDATE ON fin.accounting_period
  FOR EACH ROW EXECUTE FUNCTION fin.accounting_period_guard();

-- The events the ledger posts from, with the named amounts each carries. The boot assertion checks every row has a
-- handler and a rule for each amount, and every event a module declares as posting has a row (ADR-0003).
CREATE TABLE fin.posting_event_type (
  code         text PRIMARY KEY CONSTRAINT ck_posting_event_type_code CHECK (code ~ '^[a-z]{3}\.[A-Z][A-Za-z]+$'),
  owner_module text NOT NULL CONSTRAINT ck_posting_event_type_owner CHECK (owner_module ~ '^[a-z]{3}$' AND owner_module = split_part(code, '.', 1)),
  description  text NOT NULL,
  amount_keys  text[] NOT NULL CONSTRAINT ck_posting_event_type_keys CHECK (cardinality(amount_keys) > 0)
);
COMMENT ON TABLE fin.posting_event_type IS 'class=LOOKUP';

-- How one named amount of one event becomes one journal line, effective-dated. A seeded rule (created by the System
-- principal in this migration) carries no approval; every later rule needs one (POSTING_RULE_CHANGE, A-182).
CREATE TABLE fin.posting_rule (
  id                  uuid PRIMARY KEY,
  event_code          text NOT NULL CONSTRAINT fk_posting_rule_event REFERENCES fin.posting_event_type (code) ON DELETE RESTRICT,
  amount_key          text NOT NULL CONSTRAINT ck_posting_rule_amount_key CHECK (amount_key ~ '^[a-z][A-Za-z]{0,39}$'),
  side                char(1) NOT NULL CONSTRAINT ck_posting_rule_side CHECK (side IN ('D', 'C')),
  account_id          uuid NULL CONSTRAINT fk_posting_rule_account REFERENCES fin.account (id) ON DELETE RESTRICT,
  determinant_type    text NULL CONSTRAINT ck_posting_rule_determinant_type CHECK (determinant_type IN ('GL_GROUP', 'PAYMENT_METHOD_KIND', 'TAX_LEVY', 'LOSS_GROUP', 'EXPENSE_CATEGORY', 'ASSET_CATEGORY')),
  determinant_role    text NULL,
  subledger_from      text NULL,
  valid_from          date NOT NULL,
  valid_to            date NULL,
  approval_request_id uuid NULL CONSTRAINT fk_posting_rule_approval REFERENCES iam.approval_request (id) ON DELETE RESTRICT,
  version             integer NOT NULL DEFAULT 1,
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid NOT NULL CONSTRAINT fk_posting_rule_created_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  updated_by          uuid NOT NULL CONSTRAINT fk_posting_rule_updated_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  deleted_at          timestamptz NULL,
  deleted_by          uuid NULL CONSTRAINT fk_posting_rule_deleted_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  delete_reason       text NULL,
  CONSTRAINT ck_posting_rule_target CHECK ((account_id IS NULL) <> (determinant_type IS NULL) AND (determinant_type IS NULL) = (determinant_role IS NULL)),
  CONSTRAINT ck_posting_rule_validity CHECK (valid_to IS NULL OR valid_to > valid_from),
  CONSTRAINT ck_posting_rule_approved CHECK (approval_request_id IS NOT NULL OR created_by = '01900000-0000-7000-8000-000000000001'),
  CONSTRAINT ck_posting_rule_soft_delete CHECK ((deleted_at IS NULL) = (deleted_by IS NULL) AND (deleted_at IS NULL) = (delete_reason IS NULL)),
  CONSTRAINT ex_posting_rule_no_overlap EXCLUDE USING gist (event_code WITH =, amount_key WITH =, side WITH =, daterange(valid_from, valid_to, '[)') WITH &&)
    WHERE (deleted_at IS NULL)
);
COMMENT ON TABLE fin.posting_rule IS 'class=MASTER';
CREATE TRIGGER trg_posting_rule_version BEFORE UPDATE ON fin.posting_rule
  FOR EACH ROW EXECUTE FUNCTION platform.touch_version();

-- Maps a determinant value (a product's GL group, a payment method, a levy, a loss group, an expense category) to an
-- account, per role. `*` is the default for a key with no row of its own.
CREATE TABLE fin.account_determination (
  id               uuid PRIMARY KEY,
  determinant_type text NOT NULL CONSTRAINT ck_account_determination_type CHECK (determinant_type IN ('GL_GROUP', 'PAYMENT_METHOD_KIND', 'TAX_LEVY', 'LOSS_GROUP', 'EXPENSE_CATEGORY', 'ASSET_CATEGORY')),
  determinant_key  text NOT NULL CONSTRAINT ck_account_determination_key CHECK (determinant_key ~ '^(\*|[A-Z][A-Z0-9_]{0,59})$'),
  role             text NOT NULL CONSTRAINT ck_account_determination_role CHECK (role IN ('INVENTORY', 'SALES', 'COST_OF_SALES', 'TENDER', 'PAYOUT', 'OUTPUT', 'INPUT', 'LOSS', 'EXPENSE')),
  account_id       uuid NOT NULL CONSTRAINT fk_account_determination_account REFERENCES fin.account (id) ON DELETE RESTRICT,
  valid_from       date NOT NULL,
  valid_to         date NULL,
  version          integer NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid NOT NULL CONSTRAINT fk_account_determination_created_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       uuid NOT NULL CONSTRAINT fk_account_determination_updated_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  deleted_at       timestamptz NULL,
  deleted_by       uuid NULL CONSTRAINT fk_account_determination_deleted_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  delete_reason    text NULL,
  CONSTRAINT ck_account_determination_validity CHECK (valid_to IS NULL OR valid_to > valid_from),
  CONSTRAINT ck_account_determination_soft_delete CHECK ((deleted_at IS NULL) = (deleted_by IS NULL) AND (deleted_at IS NULL) = (delete_reason IS NULL)),
  CONSTRAINT ex_account_determination_no_overlap EXCLUDE USING gist (determinant_type WITH =, determinant_key WITH =, role WITH =, daterange(valid_from, valid_to, '[)') WITH &&)
    WHERE (deleted_at IS NULL)
);
COMMENT ON TABLE fin.account_determination IS 'class=MASTER';
CREATE TRIGGER trg_account_determination_version BEFORE UPDATE ON fin.account_determination
  FOR EACH ROW EXECUTE FUNCTION platform.touch_version();

-- The journal: a numbered business document per entry, insert-only.
CREATE TABLE fin.journal_entry (
  id                 uuid PRIMARY KEY CONSTRAINT fk_journal_entry_document REFERENCES platform.business_document (id) ON DELETE RESTRICT,
  entry_no           text NOT NULL CONSTRAINT uq_journal_entry_no UNIQUE,
  posting_date       date NOT NULL,
  period_id          uuid NOT NULL CONSTRAINT fk_journal_entry_period REFERENCES fin.accounting_period (id) ON DELETE RESTRICT,
  branch_id          uuid NOT NULL CONSTRAINT fk_journal_entry_branch REFERENCES mdm.branch (id) ON DELETE RESTRICT,
  kind               text NOT NULL CONSTRAINT ck_journal_entry_kind CHECK (kind IN ('AUTO', 'MANUAL', 'OPENING', 'CLOSING', 'REVERSAL')),
  event_code         text NULL CONSTRAINT fk_journal_entry_event REFERENCES fin.posting_event_type (code) ON DELETE RESTRICT,
  event_id           uuid NULL CONSTRAINT uq_journal_entry_event UNIQUE,
  event_subject_id   uuid NULL,
  source_document_id uuid NOT NULL CONSTRAINT fk_journal_entry_source_document REFERENCES platform.business_document (id) ON DELETE RESTRICT,
  posting_group_id   uuid NOT NULL,
  description        text NOT NULL CONSTRAINT ck_journal_entry_description CHECK (length(btrim(description)) BETWEEN 1 AND 300),
  currency           char(3) NOT NULL DEFAULT 'GHS' CONSTRAINT ck_journal_entry_currency CHECK (currency = 'GHS'),
  reverses_entry_id  uuid NULL CONSTRAINT uq_journal_entry_reverses UNIQUE CONSTRAINT fk_journal_entry_reverses REFERENCES fin.journal_entry (id) ON DELETE RESTRICT,
  occurred_at        timestamptz NOT NULL,
  recorded_at        timestamptz NOT NULL DEFAULT now(),
  actor_id           uuid NOT NULL CONSTRAINT fk_journal_entry_actor REFERENCES iam.principal (id) ON DELETE RESTRICT,
  CONSTRAINT ck_journal_entry_event CHECK (kind NOT IN ('AUTO', 'REVERSAL') OR (event_code IS NOT NULL AND event_id IS NOT NULL)),
  CONSTRAINT ck_journal_entry_reversal CHECK ((kind = 'REVERSAL') = (reverses_entry_id IS NOT NULL))
);
COMMENT ON TABLE fin.journal_entry IS 'class=LEDGER';
CREATE INDEX ix_journal_entry_period_date ON fin.journal_entry (period_id, posting_date);
CREATE INDEX ix_journal_entry_source_document ON fin.journal_entry (source_document_id);
CREATE INDEX ix_journal_entry_posting_group ON fin.journal_entry (posting_group_id);
CREATE INDEX ix_journal_entry_event_subject ON fin.journal_entry (event_subject_id) WHERE event_subject_id IS NOT NULL;
CREATE TRIGGER trg_journal_entry_immutable BEFORE UPDATE OR DELETE ON fin.journal_entry
  FOR EACH ROW EXECUTE FUNCTION platform.reject_change();
CREATE TRIGGER trg_journal_entry_no_truncate BEFORE TRUNCATE ON fin.journal_entry
  FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_change();

CREATE TABLE fin.journal_line (
  journal_entry_id   uuid NOT NULL CONSTRAINT fk_journal_line_entry REFERENCES fin.journal_entry (id) ON DELETE RESTRICT,
  line_no            integer NOT NULL CONSTRAINT ck_journal_line_no CHECK (line_no > 0),
  account_id         uuid NOT NULL CONSTRAINT fk_journal_line_account REFERENCES fin.account (id) ON DELETE RESTRICT,
  side               char(1) NOT NULL CONSTRAINT ck_journal_line_side CHECK (side IN ('D', 'C')),
  amount_pesewas     platform.pesewas NOT NULL CONSTRAINT ck_journal_line_amount CHECK (amount_pesewas > 0),
  branch_id          uuid NOT NULL CONSTRAINT fk_journal_line_branch REFERENCES mdm.branch (id) ON DELETE RESTRICT,
  subledger_party_id uuid NULL CONSTRAINT fk_journal_line_subledger REFERENCES fin.subledger_party (id) ON DELETE RESTRICT,
  product_line       text NULL,
  cost_object_id     uuid NULL,
  memo               text NULL CONSTRAINT ck_journal_line_memo CHECK (memo IS NULL OR length(memo) <= 300),
  posting_date       date NOT NULL,
  recorded_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_journal_line PRIMARY KEY (journal_entry_id, line_no)
);
COMMENT ON TABLE fin.journal_line IS 'class=LEDGER';
CREATE INDEX ix_journal_line_account_date ON fin.journal_line (account_id, posting_date);
CREATE INDEX ix_journal_line_subledger ON fin.journal_line (subledger_party_id, account_id, posting_date) WHERE subledger_party_id IS NOT NULL;
CREATE TRIGGER trg_journal_line_immutable BEFORE UPDATE OR DELETE ON fin.journal_line
  FOR EACH ROW EXECUTE FUNCTION platform.reject_change();
CREATE TRIGGER trg_journal_line_no_truncate BEFORE TRUNCATE ON fin.journal_line
  FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_change();

-- An entry is posted only into an OPEN period that contains its date. The period row is read FOR SHARE, so a lock or
-- close waits for the posting to commit, and a posting racing a close fails and retries (ADR-0005).
CREATE FUNCTION fin.assert_period_open() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
DECLARE
  period record;
BEGIN
  SELECT p.status, p.start_date, p.end_date, p.fiscal_year, p.period_no INTO period
    FROM fin.accounting_period p WHERE p.id = NEW.period_id FOR SHARE;
  IF NOT FOUND OR NEW.posting_date < period.start_date OR NEW.posting_date > period.end_date THEN
    PERFORM fin.refuse('ck_journal_period', format('journal entry %s: posting date %s is not in the period it names', NEW.id, NEW.posting_date));
  END IF;
  IF period.status <> 'OPEN' THEN
    PERFORM fin.refuse('ck_journal_period_open', format('journal entry %s: period %s-%s is %s; nothing posts into it', NEW.id, period.fiscal_year, period.period_no, period.status));
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION fin.assert_period_open() FROM PUBLIC;
CREATE TRIGGER trg_journal_entry_period_open BEFORE INSERT ON fin.journal_entry
  FOR EACH ROW EXECUTE FUNCTION fin.assert_period_open();

-- A line joins only an entry written in its own transaction, carries the entry's date, and goes to a postable, active
-- account; it names a subledger party exactly when the account has a subledger, and a party of that kind.
CREATE FUNCTION fin.assert_line_valid() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
DECLARE
  entry record;
  acct record;
  party_kind text;
BEGIN
  SELECT e.posting_date, (e.xmin = pg_current_xact_id()::xid) AS is_new INTO entry FROM fin.journal_entry e WHERE e.id = NEW.journal_entry_id;
  IF NOT FOUND OR NOT entry.is_new THEN
    PERFORM fin.refuse('ck_journal_line_entry', format('journal entry %s: lines are written only in the transaction that writes the entry', NEW.journal_entry_id));
  END IF;
  IF NEW.posting_date IS DISTINCT FROM entry.posting_date THEN
    PERFORM fin.refuse('ck_journal_line_entry', format('journal entry %s line %s: the line carries its entry''s posting date %s', NEW.journal_entry_id, NEW.line_no, entry.posting_date));
  END IF;
  SELECT a.code, a.is_postable, a.status, a.deleted_at, a.subledger_kind INTO acct FROM fin.account a WHERE a.id = NEW.account_id;
  IF NOT FOUND OR NOT acct.is_postable OR acct.status <> 'ACTIVE' OR acct.deleted_at IS NOT NULL THEN
    PERFORM fin.refuse('ck_journal_line_account', format('journal entry %s line %s: account %s takes no lines', NEW.journal_entry_id, NEW.line_no, COALESCE(acct.code, NEW.account_id::text)));
  END IF;
  IF NEW.subledger_party_id IS NULL THEN
    IF acct.subledger_kind IS NOT NULL THEN
      PERFORM fin.refuse('ck_journal_line_subledger', format('journal entry %s line %s: account %s needs a %s subledger party', NEW.journal_entry_id, NEW.line_no, acct.code, acct.subledger_kind));
    END IF;
  ELSE
    SELECT s.kind INTO party_kind FROM fin.subledger_party s WHERE s.id = NEW.subledger_party_id;
    IF acct.subledger_kind IS NULL OR party_kind IS DISTINCT FROM acct.subledger_kind THEN
      PERFORM fin.refuse('ck_journal_line_subledger', format('journal entry %s line %s: account %s takes %s, not a %s party', NEW.journal_entry_id, NEW.line_no, acct.code,
                                                         COALESCE(acct.subledger_kind, 'no subledger party'), party_kind));
    END IF;
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION fin.assert_line_valid() FROM PUBLIC;
CREATE TRIGGER trg_journal_line_valid BEFORE INSERT ON fin.journal_line
  FOR EACH ROW EXECUTE FUNCTION fin.assert_line_valid();

-- FR-FIN-003: at commit, every entry the transaction wrote has at least two lines and its debits equal its credits.
-- Deferred, so an entry is checked once all its lines are in; fired by the entry (an entry with no lines) and by each line.
CREATE FUNCTION fin.assert_balanced() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
DECLARE
  entry_id uuid;
  line_count integer;
  debits numeric;
  credits numeric;
BEGIN
  -- Each branch is planned only when it runs, so each table's row is read by its own column.
  IF TG_TABLE_NAME = 'journal_entry' THEN
    entry_id := NEW.id;
  ELSE
    entry_id := NEW.journal_entry_id;
  END IF;
  SELECT count(*), COALESCE(sum(l.amount_pesewas) FILTER (WHERE l.side = 'D'), 0), COALESCE(sum(l.amount_pesewas) FILTER (WHERE l.side = 'C'), 0)
    INTO line_count, debits, credits
    FROM fin.journal_line l WHERE l.journal_entry_id = entry_id;
  IF line_count < 2 THEN
    PERFORM fin.refuse('ck_journal_lines', format('journal entry %s has %s line(s); an entry has at least two', entry_id, line_count));
  END IF;
  IF debits <> credits THEN
    PERFORM fin.refuse('ck_journal_balanced', format('journal entry %s is unbalanced: debits %s, credits %s', entry_id, debits, credits));
  END IF;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION fin.assert_balanced() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER trg_journal_entry_balanced AFTER INSERT ON fin.journal_entry
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fin.assert_balanced();
CREATE CONSTRAINT TRIGGER trg_journal_line_balanced AFTER INSERT ON fin.journal_line
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fin.assert_balanced();

-- FR-FIN-002: an account with lines keeps its code, type, normal side and subledger, and is never archived.
CREATE FUNCTION fin.account_guard() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
BEGIN
  IF ((NEW.code, NEW.type, NEW.normal_side, NEW.subledger_kind) IS DISTINCT FROM (OLD.code, OLD.type, OLD.normal_side, OLD.subledger_kind)
      OR (NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL))
     AND EXISTS (SELECT 1 FROM fin.journal_line l WHERE l.account_id = OLD.id) THEN
    PERFORM fin.refuse('ck_account_change', format('account %s has journal lines: its code, type, side and subledger stay, and it is never archived', OLD.code));
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION fin.account_guard() FROM PUBLIC;
CREATE TRIGGER trg_account_guard BEFORE UPDATE ON fin.account
  FOR EACH ROW EXECUTE FUNCTION fin.account_guard();

-- Seed: the chart of accounts of ADR-0003 (A-029). Ids are fixed so later migrations can name them.
INSERT INTO fin.account (id, code, name, type, normal_side, is_postable, subledger_kind, cash_flow_category, status, created_by, updated_by)
SELECT ('01900000-0000-7000-8100-00000000' || a.code)::uuid, a.code, a.name, a.type, a.side, true, a.subledger, a.cash_flow, 'ACTIVE',
       '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001'
  FROM (VALUES
    ('1000', 'Cash on hand, tills', 'ASSET', 'D', 'REGISTER', NULL),
    ('1010', 'Cash, safe', 'ASSET', 'D', NULL, NULL),
    ('1020', 'Cash held by drivers', 'ASSET', 'D', 'DRIVER', NULL),
    ('1100', 'Bank accounts', 'ASSET', 'D', 'BANK_ACCOUNT', NULL),
    ('1110', 'Mobile money wallets', 'ASSET', 'D', 'BANK_ACCOUNT', NULL),
    ('1120', 'Payment provider clearing', 'ASSET', 'D', 'PROVIDER', NULL),
    ('1130', 'Cheques awaiting clearance', 'ASSET', 'D', NULL, NULL),
    ('1200', 'Trade receivables', 'ASSET', 'D', 'CUSTOMER', 'OPERATING'),
    ('1300', 'Inventory, feed and medication', 'ASSET', 'D', NULL, 'OPERATING'),
    ('1310', 'Inventory, live animals', 'ASSET', 'D', NULL, 'OPERATING'),
    ('1320', 'Inventory, meat', 'ASSET', 'D', NULL, 'OPERATING'),
    ('1325', 'Inventory, offal and by-products', 'ASSET', 'D', NULL, 'OPERATING'),
    ('1330', 'Inventory, produce and eggs', 'ASSET', 'D', NULL, 'OPERATING'),
    ('1340', 'Processing work in progress', 'ASSET', 'D', NULL, 'OPERATING'),
    ('1360', 'Inventory, packaging and supplies', 'ASSET', 'D', NULL, 'OPERATING'),
    ('1400', 'Input VAT and levies recoverable', 'ASSET', 'D', 'TAX_LEVY', 'OPERATING'),
    ('1510', 'Vehicles at cost', 'ASSET', 'D', NULL, 'INVESTING'),
    ('1520', 'Cold rooms at cost', 'ASSET', 'D', NULL, 'INVESTING'),
    ('1530', 'Housing at cost', 'ASSET', 'D', NULL, 'INVESTING'),
    ('1540', 'Equipment at cost', 'ASSET', 'D', NULL, 'INVESTING'),
    ('1590', 'Accumulated depreciation', 'ASSET', 'C', NULL, 'INVESTING'),
    ('2000', 'Trade payables', 'LIABILITY', 'C', 'SUPPLIER', 'OPERATING'),
    ('2010', 'Goods received not invoiced', 'LIABILITY', 'C', NULL, 'OPERATING'),
    ('2020', 'Accrued processing and other costs', 'LIABILITY', 'C', NULL, 'OPERATING'),
    ('2100', 'Output VAT and levies payable', 'LIABILITY', 'C', 'TAX_LEVY', 'OPERATING'),
    ('2200', 'Customer deposits and unallocated receipts', 'LIABILITY', 'C', 'CUSTOMER', 'OPERATING'),
    ('2210', 'Store credit', 'LIABILITY', 'C', 'CUSTOMER', 'OPERATING'),
    ('2290', 'Suspense, unidentified receipts', 'LIABILITY', 'C', NULL, 'OPERATING'),
    ('2300', 'Distributions payable', 'LIABILITY', 'C', 'INVESTOR', 'FINANCING'),
    ('2310', 'Withholding tax payable', 'LIABILITY', 'C', NULL, 'FINANCING'),
    ('2400', 'Loans payable', 'LIABILITY', 'C', 'INVESTOR', 'FINANCING'),
    ('2410', 'Accrued interest', 'LIABILITY', 'C', NULL, 'FINANCING'),
    ('2450', 'Deferred grant income', 'LIABILITY', 'C', NULL, 'FINANCING'),
    ('3000', 'Investor capital', 'EQUITY', 'C', 'INVESTOR', 'FINANCING'),
    ('3100', 'Retained earnings', 'EQUITY', 'C', NULL, 'FINANCING'),
    ('3200', 'Current year earnings', 'EQUITY', 'C', NULL, 'FINANCING'),
    ('3300', 'Distributions declared', 'EQUITY', 'D', 'INVESTOR', 'FINANCING'),
    ('3900', 'Opening balance equity', 'EQUITY', 'C', NULL, 'FINANCING'),
    ('4000', 'Sales, live animals', 'INCOME', 'C', NULL, 'OPERATING'),
    ('4010', 'Sales, meat', 'INCOME', 'C', NULL, 'OPERATING'),
    ('4020', 'Sales, produce and eggs', 'INCOME', 'C', NULL, 'OPERATING'),
    ('4030', 'Sales, by-products and other goods', 'INCOME', 'C', NULL, 'OPERATING'),
    ('4100', 'Delivery fee income', 'INCOME', 'C', NULL, 'OPERATING'),
    ('4200', 'Sales returns and allowances', 'INCOME', 'D', NULL, 'OPERATING'),
    ('4210', 'Price variance, overrides and negotiated prices', 'INCOME', 'D', NULL, 'OPERATING'),
    ('4220', 'Promotional discounts', 'INCOME', 'D', NULL, 'OPERATING'),
    ('4910', 'Grant income', 'INCOME', 'C', NULL, 'OPERATING'),
    ('5000', 'Cost of sales, live animals', 'COST_OF_SALES', 'D', NULL, 'OPERATING'),
    ('5010', 'Cost of sales, meat', 'COST_OF_SALES', 'D', NULL, 'OPERATING'),
    ('5020', 'Cost of sales, produce and eggs', 'COST_OF_SALES', 'D', NULL, 'OPERATING'),
    ('5030', 'Cost of sales, by-products and other goods', 'COST_OF_SALES', 'D', NULL, 'OPERATING'),
    ('5100', 'Mortality and cull losses', 'COST_OF_SALES', 'D', NULL, 'OPERATING'),
    ('5110', 'Shrinkage and stock adjustments', 'COST_OF_SALES', 'D', NULL, 'OPERATING'),
    ('5120', 'Wastage and expired stock', 'COST_OF_SALES', 'D', NULL, 'OPERATING'),
    ('5140', 'Purchase price variance', 'COST_OF_SALES', 'D', NULL, 'OPERATING'),
    ('5200', 'Breeding herd upkeep', 'COST_OF_SALES', 'D', NULL, 'OPERATING'),
    ('5210', 'Own production capitalised', 'COST_OF_SALES', 'C', NULL, 'OPERATING'),
    ('6000', 'Wages', 'EXPENSE', 'D', NULL, 'OPERATING'),
    ('6100', 'Delivery and vehicles', 'EXPENSE', 'D', NULL, 'OPERATING'),
    ('6200', 'Utilities and cold chain', 'EXPENSE', 'D', NULL, 'OPERATING'),
    ('6300', 'Repairs and maintenance', 'EXPENSE', 'D', NULL, 'OPERATING'),
    ('6400', 'Marketing', 'EXPENSE', 'D', NULL, 'OPERATING'),
    ('6500', 'Depreciation', 'EXPENSE', 'D', NULL, 'OPERATING'),
    ('6800', 'Administration', 'EXPENSE', 'D', NULL, 'OPERATING'),
    ('6900', 'Cash over and short', 'EXPENSE', 'D', NULL, 'OPERATING'),
    ('6910', 'Payment provider fees', 'EXPENSE', 'D', NULL, 'OPERATING'),
    ('6920', 'Bank charges', 'EXPENSE', 'D', NULL, 'OPERATING'),
    ('6930', 'Interest expense', 'EXPENSE', 'D', NULL, 'FINANCING'),
    ('6940', 'Bad debts', 'EXPENSE', 'D', NULL, 'OPERATING')
  ) AS a (code, name, type, side, subledger, cash_flow);

-- Seed: account determination (A-182). A key with no row of its own takes the `*` row of its type and role.
INSERT INTO fin.account_determination (id, determinant_type, determinant_key, role, account_id, valid_from, created_by, updated_by)
SELECT ('01900000-0000-7000-8200-' || lpad(d.n::text, 12, '0'))::uuid, d.type, d.key, d.role, ('01900000-0000-7000-8100-00000000' || d.code)::uuid,
       DATE '2020-01-01', '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001'
  FROM (VALUES
    (1, 'GL_GROUP', 'LIVE_ANIMALS', 'INVENTORY', '1310'),
    (2, 'GL_GROUP', 'MEAT', 'INVENTORY', '1320'),
    (3, 'GL_GROUP', 'OFFAL', 'INVENTORY', '1325'),
    (4, 'GL_GROUP', 'PRODUCE_EGGS', 'INVENTORY', '1330'),
    (5, 'GL_GROUP', 'FEED_MEDICATION', 'INVENTORY', '1300'),
    (6, 'GL_GROUP', 'SUPPLIES', 'INVENTORY', '1360'),
    (7, 'GL_GROUP', 'LIVE_ANIMALS', 'COST_OF_SALES', '5000'),
    (8, 'GL_GROUP', 'MEAT', 'COST_OF_SALES', '5010'),
    (9, 'GL_GROUP', 'PRODUCE_EGGS', 'COST_OF_SALES', '5020'),
    (10, 'GL_GROUP', 'OFFAL', 'COST_OF_SALES', '5030'),
    (11, 'GL_GROUP', '*', 'COST_OF_SALES', '5030'),
    (12, 'GL_GROUP', 'LIVE_ANIMALS', 'SALES', '4000'),
    (13, 'GL_GROUP', 'MEAT', 'SALES', '4010'),
    (14, 'GL_GROUP', 'PRODUCE_EGGS', 'SALES', '4020'),
    (15, 'GL_GROUP', 'OFFAL', 'SALES', '4030'),
    (16, 'GL_GROUP', '*', 'SALES', '4030'),
    (17, 'LOSS_GROUP', 'MORTALITY', 'LOSS', '5100'),
    (18, 'LOSS_GROUP', 'SHRINKAGE', 'LOSS', '5110'),
    (19, 'LOSS_GROUP', 'WASTAGE', 'LOSS', '5120'),
    (20, 'LOSS_GROUP', '*', 'LOSS', '5110'),
    (21, 'EXPENSE_CATEGORY', '*', 'EXPENSE', '6800'),
    (22, 'TAX_LEVY', '*', 'INPUT', '1400'),
    (23, 'TAX_LEVY', '*', 'OUTPUT', '2100'),
    (24, 'PAYMENT_METHOD_KIND', 'CASH', 'PAYOUT', '1010'),
    (25, 'PAYMENT_METHOD_KIND', 'BANK', 'PAYOUT', '1100'),
    (26, 'PAYMENT_METHOD_KIND', 'MOBILE_MONEY', 'PAYOUT', '1110'),
    (27, 'PAYMENT_METHOD_KIND', 'CHEQUE', 'PAYOUT', '1100')
  ) AS d (n, type, key, role, code);

-- Seed: the posting events modules publish today (ADR-0003's matrix, A-182). Events of modules not yet built are
-- added, with their rules, by the session that publishes them.
INSERT INTO fin.posting_event_type (code, owner_module, description, amount_keys) VALUES
  ('inv.GoodsReceived', 'inv', 'Goods received from a supplier, at receipt value', ARRAY['value']),
  ('inv.ProductionReceived', 'inv', 'Harvest or lay received at standard cost (no entry at zero)', ARRAY['value']),
  ('inv.OpeningStockLoaded', 'inv', 'Opening stock loaded at its value', ARRAY['value']),
  ('inv.CostCapitalised', 'inv', 'Feed or medication cost capitalised onto growing stock', ARRAY['value']),
  ('inv.UpkeepExpensed', 'inv', 'Feed or medication cost expensed for breeding stock', ARRAY['value']),
  ('inv.StockConsumedInProcessing', 'inv', 'Stock consumed by a processing order', ARRAY['value']),
  ('inv.ProcessingOutputReceived', 'inv', 'Output of a processing order received at its allocated cost', ARRAY['value']),
  ('inv.StockIssuedForSale', 'inv', 'Stock issued for a sale, at its cost', ARRAY['value']),
  ('inv.SaleReturnReceived', 'inv', 'A customer return received back into stock', ARRAY['value']),
  ('inv.StockWrittenOff', 'inv', 'Mortality, cull, shrinkage, wastage, expiry or count loss', ARRAY['value']),
  ('inv.StockGainRecorded', 'inv', 'An adjustment or count gain', ARRAY['value']),
  ('inv.SupplierReturnIssued', 'inv', 'Goods returned to a supplier, at their cost', ARRAY['value']),
  ('prc.DirectCostIncurred', 'prc', 'A direct processing cost entered work in progress', ARRAY['value']),
  ('prc.ProcessingOrderReversed', 'prc', 'The direct cost a processing reversal takes out of stock', ARRAY['directCost']),
  ('pur.SupplierInvoiceMatched', 'pur', 'A supplier invoice matched to its order and approved for payment',
   ARRAY['receiptValue', 'expense', 'reclaimableLevy', 'priceVarianceUnfavourable', 'priceVarianceFavourable', 'gross']),
  ('pur.ExpenseInvoiceApproved', 'pur', 'A supplier invoice with no order approved for payment',
   ARRAY['receiptValue', 'expense', 'reclaimableLevy', 'priceVarianceUnfavourable', 'priceVarianceFavourable', 'gross']),
  ('pur.SupplierCreditNoteApproved', 'pur', 'A supplier credit note approved by a second person',
   ARRAY['gross', 'returnCost', 'expense', 'reclaimableLevy', 'priceVarianceFavourable', 'priceVarianceUnfavourable']),
  ('pur.SupplierPaymentMade', 'pur', 'An approved payment left the farm', ARRAY['amount']);

INSERT INTO fin.posting_rule (id, event_code, amount_key, side, account_id, determinant_type, determinant_role, subledger_from, valid_from, created_by, updated_by)
SELECT ('01900000-0000-7000-8300-' || lpad(r.n::text, 12, '0'))::uuid, r.event, r.amount, r.side,
       CASE WHEN r.code IS NULL THEN NULL ELSE ('01900000-0000-7000-8100-00000000' || r.code)::uuid END,
       r.det_type, r.det_role, r.subledger, DATE '2020-01-01', '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001'
  FROM (VALUES
    (1, 'inv.GoodsReceived', 'value', 'D', NULL, 'GL_GROUP', 'INVENTORY', NULL),
    (2, 'inv.GoodsReceived', 'value', 'C', '2010', NULL, NULL, NULL),
    (3, 'inv.ProductionReceived', 'value', 'D', NULL, 'GL_GROUP', 'INVENTORY', NULL),
    (4, 'inv.ProductionReceived', 'value', 'C', '5210', NULL, NULL, NULL),
    (5, 'inv.OpeningStockLoaded', 'value', 'D', NULL, 'GL_GROUP', 'INVENTORY', NULL),
    (6, 'inv.OpeningStockLoaded', 'value', 'C', '3900', NULL, NULL, NULL),
    (7, 'inv.CostCapitalised', 'value', 'D', NULL, 'GL_GROUP', 'INVENTORY', NULL),
    (8, 'inv.CostCapitalised', 'value', 'C', '1300', NULL, NULL, NULL),
    (9, 'inv.UpkeepExpensed', 'value', 'D', '5200', NULL, NULL, NULL),
    (10, 'inv.UpkeepExpensed', 'value', 'C', '1300', NULL, NULL, NULL),
    (11, 'inv.StockConsumedInProcessing', 'value', 'D', '1340', NULL, NULL, NULL),
    (12, 'inv.StockConsumedInProcessing', 'value', 'C', NULL, 'GL_GROUP', 'INVENTORY', NULL),
    (13, 'inv.ProcessingOutputReceived', 'value', 'D', NULL, 'GL_GROUP', 'INVENTORY', NULL),
    (14, 'inv.ProcessingOutputReceived', 'value', 'C', '1340', NULL, NULL, NULL),
    (15, 'inv.StockIssuedForSale', 'value', 'D', NULL, 'GL_GROUP', 'COST_OF_SALES', NULL),
    (16, 'inv.StockIssuedForSale', 'value', 'C', NULL, 'GL_GROUP', 'INVENTORY', NULL),
    (17, 'inv.SaleReturnReceived', 'value', 'D', NULL, 'GL_GROUP', 'INVENTORY', NULL),
    (18, 'inv.SaleReturnReceived', 'value', 'C', NULL, 'GL_GROUP', 'COST_OF_SALES', NULL),
    (19, 'inv.StockWrittenOff', 'value', 'D', NULL, 'LOSS_GROUP', 'LOSS', NULL),
    (20, 'inv.StockWrittenOff', 'value', 'C', NULL, 'GL_GROUP', 'INVENTORY', NULL),
    (21, 'inv.StockGainRecorded', 'value', 'D', NULL, 'GL_GROUP', 'INVENTORY', NULL),
    (22, 'inv.StockGainRecorded', 'value', 'C', '5110', NULL, NULL, NULL),
    (23, 'inv.SupplierReturnIssued', 'value', 'D', '2010', NULL, NULL, NULL),
    (24, 'inv.SupplierReturnIssued', 'value', 'C', NULL, 'GL_GROUP', 'INVENTORY', NULL),
    (25, 'prc.DirectCostIncurred', 'value', 'D', '1340', NULL, NULL, NULL),
    (26, 'prc.DirectCostIncurred', 'value', 'C', '2020', NULL, NULL, NULL),
    (27, 'prc.ProcessingOrderReversed', 'directCost', 'D', '5110', NULL, NULL, NULL),
    (28, 'prc.ProcessingOrderReversed', 'directCost', 'C', '1340', NULL, NULL, NULL),
    (29, 'pur.SupplierInvoiceMatched', 'receiptValue', 'D', '2010', NULL, NULL, NULL),
    (30, 'pur.SupplierInvoiceMatched', 'expense', 'D', NULL, 'EXPENSE_CATEGORY', 'EXPENSE', NULL),
    (31, 'pur.SupplierInvoiceMatched', 'reclaimableLevy', 'D', NULL, 'TAX_LEVY', 'INPUT', 'levies.levyId'),
    (32, 'pur.SupplierInvoiceMatched', 'priceVarianceUnfavourable', 'D', '5140', NULL, NULL, NULL),
    (33, 'pur.SupplierInvoiceMatched', 'priceVarianceFavourable', 'C', '5140', NULL, NULL, NULL),
    (34, 'pur.SupplierInvoiceMatched', 'gross', 'C', '2000', NULL, NULL, 'supplierId'),
    (35, 'pur.ExpenseInvoiceApproved', 'expense', 'D', NULL, 'EXPENSE_CATEGORY', 'EXPENSE', NULL),
    (36, 'pur.ExpenseInvoiceApproved', 'reclaimableLevy', 'D', NULL, 'TAX_LEVY', 'INPUT', 'levies.levyId'),
    (37, 'pur.ExpenseInvoiceApproved', 'gross', 'C', '2000', NULL, NULL, 'supplierId'),
    (38, 'pur.SupplierCreditNoteApproved', 'gross', 'D', '2000', NULL, NULL, 'supplierId'),
    (39, 'pur.SupplierCreditNoteApproved', 'returnCost', 'C', '2010', NULL, NULL, NULL),
    (40, 'pur.SupplierCreditNoteApproved', 'expense', 'C', NULL, 'EXPENSE_CATEGORY', 'EXPENSE', NULL),
    (41, 'pur.SupplierCreditNoteApproved', 'reclaimableLevy', 'C', NULL, 'TAX_LEVY', 'INPUT', 'levies.levyId'),
    (42, 'pur.SupplierCreditNoteApproved', 'priceVarianceFavourable', 'C', '5140', NULL, NULL, NULL),
    (43, 'pur.SupplierCreditNoteApproved', 'priceVarianceUnfavourable', 'D', '5140', NULL, NULL, NULL),
    (44, 'pur.SupplierPaymentMade', 'amount', 'D', '2000', NULL, NULL, 'supplierId'),
    (45, 'pur.SupplierPaymentMade', 'amount', 'C', NULL, 'PAYMENT_METHOD_KIND', 'PAYOUT', NULL),
    -- An expense invoice has no order line, so these stay zero; they keep its rule set the same shape as a matched one's.
    (46, 'pur.ExpenseInvoiceApproved', 'receiptValue', 'D', '2010', NULL, NULL, NULL),
    (47, 'pur.ExpenseInvoiceApproved', 'priceVarianceUnfavourable', 'D', '5140', NULL, NULL, NULL),
    (48, 'pur.ExpenseInvoiceApproved', 'priceVarianceFavourable', 'C', '5140', NULL, NULL, NULL)
  ) AS r (n, event, amount, side, code, det_type, det_role, subledger);

-- Seed: twelve monthly periods for each calendar year 2026 to 2030, OPEN (A-028, A-183).
INSERT INTO fin.accounting_period (id, fiscal_year, period_no, start_date, end_date, status, created_by, updated_by)
SELECT ('01900000-0000-7000-8400-' || lpad((y * 100 + m)::text, 12, '0'))::uuid, y, m, make_date(y, m, 1), (make_date(y, m, 1) + interval '1 month' - interval '1 day')::date,
       'OPEN', '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001'
  FROM generate_series(2026, 2030) AS y, generate_series(1, 12) AS m;

REVOKE ALL ON ALL TABLES IN SCHEMA fin FROM PUBLIC;
GRANT SELECT ON fin.posting_event_type TO hk_app, hk_worker;
GRANT SELECT, INSERT, UPDATE ON fin.account, fin.subledger_party, fin.accounting_period, fin.posting_rule, fin.account_determination TO hk_app, hk_worker;
GRANT SELECT, INSERT ON fin.journal_entry, fin.journal_line TO hk_app, hk_worker;

-- migrate:down
DROP TRIGGER trg_account_guard ON fin.account;
DROP FUNCTION fin.account_guard();
DROP TRIGGER trg_journal_line_balanced ON fin.journal_line;
DROP TRIGGER trg_journal_entry_balanced ON fin.journal_entry;
DROP FUNCTION fin.assert_balanced();
DROP TRIGGER trg_journal_line_valid ON fin.journal_line;
DROP FUNCTION fin.assert_line_valid();
DROP TRIGGER trg_journal_entry_period_open ON fin.journal_entry;
DROP FUNCTION fin.assert_period_open();
DROP TABLE fin.journal_line;
DROP TABLE fin.journal_entry;
DROP TABLE fin.account_determination;
DROP TABLE fin.posting_rule;
DROP TABLE fin.posting_event_type;
DROP TRIGGER trg_accounting_period_guard ON fin.accounting_period;
DROP FUNCTION fin.accounting_period_guard();
DROP TABLE fin.accounting_period;
DROP TABLE fin.subledger_party;
DROP TABLE fin.account;
DROP FUNCTION fin.refuse(text, text);
DROP SCHEMA fin;
