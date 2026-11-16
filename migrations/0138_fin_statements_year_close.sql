-- 0138_fin_statements_year_close
-- B08 continued 1c (FR-FIN-010 to FR-FIN-013, ADR-0003, ADR-0005, ADR-0058, A-195, A-196): the period balance
-- projection, the year close and the published cash balance view. The database holds:
--   period balances            `fin.period_balance` (PROJECTION) is the exact sum of a period's lines per account, branch,
--                              party and whether a year close entry posted them; written only by fin.refresh_period_balance(),
--                              which a trigger calls whenever a period becomes LOCKED or CLOSED (whoever changes it), and the
--                              nightly job for open periods
--   ck_journal_period_open     now admits exactly one exception: a CLOSING entry dated the last day of the year, into
--                              that year's last period while it is LOCKED (the year close closes it in the same transaction)
--   ck_journal_entry_closing   a CLOSING entry is posted only from fin.YearClosed, and fin.YearClosed posts only CLOSING
--                              entries
--   uq_journal_entry_closing   one year close entry per period and branch, ever
--   ck_journal_closing_period  at commit: a CLOSING entry's period is CLOSED, so a year close commits only with the close
--   ck_posting_rule_closed_account  only fin.YearClosed posts to the account whose balance it closes, and only on the
--                              closed side of its four closing amounts; the other sides name 3200 or 3100 (ADR-0003)
-- Seeded: the event type fin.YearClosed with its twelve rules. Published: `fin.pub_cash_balance`, the balance of each
-- cash and bank account (1000 to 1130) per branch, for RPT's dashboard (ADR-0011, A-196).
-- Data category: CONFIDENTIAL (DC-09): the farm's books.
-- Rollback: tested (`pnpm db:rollback`), safe before the first year close; afterwards forward fix only (a closing entry
-- is never removed).

-- migrate:up
CREATE TABLE fin.period_balance (
  period_id            uuid NOT NULL CONSTRAINT fk_period_balance_period REFERENCES fin.accounting_period (id) ON DELETE RESTRICT,
  account_id           uuid NOT NULL CONSTRAINT fk_period_balance_account REFERENCES fin.account (id) ON DELETE RESTRICT,
  branch_id            uuid NOT NULL CONSTRAINT fk_period_balance_branch REFERENCES mdm.branch (id) ON DELETE RESTRICT,
  subledger_party_id   uuid NULL CONSTRAINT fk_period_balance_party REFERENCES fin.subledger_party (id) ON DELETE RESTRICT,
  is_closing           boolean NOT NULL,
  debit_total_pesewas  platform.pesewas NOT NULL,
  credit_total_pesewas platform.pesewas NOT NULL,
  computed_at          timestamptz NOT NULL,
  CONSTRAINT uq_period_balance UNIQUE NULLS NOT DISTINCT (period_id, account_id, branch_id, subledger_party_id, is_closing)
);
COMMENT ON TABLE fin.period_balance IS 'class=PROJECTION';

-- Recomputes one period's balances from its journal lines, in the caller's transaction. Exact: sums of pesewas.
CREATE FUNCTION fin.refresh_period_balance(p_period_id uuid) RETURNS integer
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
DECLARE
  written integer;
BEGIN
  DELETE FROM fin.period_balance WHERE period_id = p_period_id;
  INSERT INTO fin.period_balance (period_id, account_id, branch_id, subledger_party_id, is_closing, debit_total_pesewas, credit_total_pesewas, computed_at)
  SELECT e.period_id, l.account_id, l.branch_id, l.subledger_party_id, e.kind = 'CLOSING',
         COALESCE(sum(l.amount_pesewas) FILTER (WHERE l.side = 'D'), 0), COALESCE(sum(l.amount_pesewas) FILTER (WHERE l.side = 'C'), 0), now()
    FROM fin.journal_entry e JOIN fin.journal_line l ON l.journal_entry_id = e.id
   WHERE e.period_id = p_period_id
   GROUP BY e.period_id, l.account_id, l.branch_id, l.subledger_party_id, e.kind = 'CLOSING';
  GET DIAGNOSTICS written = ROW_COUNT;
  RETURN written;
END
$$;
REVOKE ALL ON FUNCTION fin.refresh_period_balance(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fin.refresh_period_balance(uuid) TO hk_app, hk_worker;

-- A period's balances are computed whenever it becomes LOCKED or CLOSED, in that transaction (ADR-0058).
CREATE FUNCTION fin.period_balance_at_lock() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
BEGIN
  PERFORM fin.refresh_period_balance(NEW.id);
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION fin.period_balance_at_lock() FROM PUBLIC;
CREATE TRIGGER trg_accounting_period_balance AFTER UPDATE OF status ON fin.accounting_period
  FOR EACH ROW WHEN (NEW.status IN ('LOCKED', 'CLOSED') AND OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION fin.period_balance_at_lock();

-- The year close's one exception to "nothing posts into a period that is not open".
CREATE OR REPLACE FUNCTION fin.assert_period_open() RETURNS trigger
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
  IF period.status <> 'OPEN'
     AND NOT (NEW.kind = 'CLOSING' AND period.status = 'LOCKED' AND period.period_no = 12 AND NEW.posting_date = period.end_date) THEN
    PERFORM fin.refuse('ck_journal_period_open', format('journal entry %s: period %s-%s is %s; nothing posts into it', NEW.id, period.fiscal_year, period.period_no, period.status));
  END IF;
  RETURN NEW;
END
$$;

ALTER TABLE fin.journal_entry ADD CONSTRAINT ck_journal_entry_closing
  CHECK ((kind = 'CLOSING') = (event_code IS NOT DISTINCT FROM 'fin.YearClosed') AND (kind <> 'CLOSING' OR event_id IS NOT NULL));
CREATE UNIQUE INDEX uq_journal_entry_closing ON fin.journal_entry (period_id, branch_id) WHERE kind = 'CLOSING';

CREATE FUNCTION fin.assert_closing_period_closed() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM fin.accounting_period p WHERE p.id = NEW.period_id AND p.status = 'CLOSED') THEN
    PERFORM fin.refuse('ck_journal_closing_period', format('journal entry %s: a year close entry commits only with the close of its period', NEW.id));
  END IF;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION fin.assert_closing_period_closed() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER trg_journal_entry_closing_closed AFTER INSERT ON fin.journal_entry
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.kind = 'CLOSING') EXECUTE FUNCTION fin.assert_closing_period_closed();

ALTER TABLE fin.posting_rule DROP CONSTRAINT ck_posting_rule_determinant_type;
ALTER TABLE fin.posting_rule ADD CONSTRAINT ck_posting_rule_determinant_type
  CHECK (determinant_type IN ('GL_GROUP', 'PAYMENT_METHOD_KIND', 'TAX_LEVY', 'LOSS_GROUP', 'EXPENSE_CATEGORY', 'ASSET_CATEGORY', 'ENTERED', 'CLOSED_ACCOUNT'));
ALTER TABLE fin.posting_rule ADD CONSTRAINT ck_posting_rule_closed_account
  CHECK ((determinant_type IS NOT DISTINCT FROM 'CLOSED_ACCOUNT') = (event_code = 'fin.YearClosed' AND (
    (amount_key IN ('closeDebitToCurrent', 'closeDebitToRetained') AND side = 'C') OR (amount_key IN ('closeCreditToCurrent', 'closeCreditToRetained') AND side = 'D'))));

INSERT INTO fin.posting_event_type (code, owner_module, description, amount_keys) VALUES
  ('fin.YearClosed', 'fin', 'Year close: income, cost and expense accounts to current year earnings, then to retained earnings',
   ARRAY['closeDebitToCurrent', 'closeCreditToCurrent', 'closeDebitToRetained', 'closeCreditToRetained', 'earningsToRetained', 'lossToRetained']);

INSERT INTO fin.posting_rule (id, event_code, amount_key, side, account_id, determinant_type, determinant_role, valid_from, created_by, updated_by)
SELECT ('01900000-0000-7000-8300-' || lpad(r.n::text, 12, '0'))::uuid, 'fin.YearClosed', r.amount, r.side,
       CASE WHEN r.code IS NULL THEN NULL ELSE ('01900000-0000-7000-8100-00000000' || r.code)::uuid END,
       CASE WHEN r.code IS NULL THEN 'CLOSED_ACCOUNT' END, CASE WHEN r.code IS NULL THEN 'CLOSED' END,
       DATE '2020-01-01', '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001'
  FROM (VALUES
    (51, 'closeDebitToCurrent', 'D', '3200'),
    (52, 'closeDebitToCurrent', 'C', NULL),
    (53, 'closeCreditToCurrent', 'D', NULL),
    (54, 'closeCreditToCurrent', 'C', '3200'),
    (55, 'closeDebitToRetained', 'D', '3100'),
    (56, 'closeDebitToRetained', 'C', NULL),
    (57, 'closeCreditToRetained', 'D', NULL),
    (58, 'closeCreditToRetained', 'C', '3100'),
    (59, 'earningsToRetained', 'D', '3200'),
    (60, 'earningsToRetained', 'C', '3100'),
    (61, 'lossToRetained', 'D', '3100'),
    (62, 'lossToRetained', 'C', '3200')
  ) AS r (n, amount, side, code);

-- The balance of each cash and bank account per branch (A-196), published for RPT's dashboard (ADR-0011).
CREATE VIEW fin.pub_cash_balance AS
SELECT l.branch_id, a.code AS account_code, a.name AS account_name,
       sum(CASE l.side WHEN 'D' THEN l.amount_pesewas ELSE -l.amount_pesewas END)::bigint AS balance_pesewas
  FROM fin.journal_line l JOIN fin.account a ON a.id = l.account_id
 WHERE a.code BETWEEN '1000' AND '1130'
 GROUP BY l.branch_id, a.code, a.name;

REVOKE ALL ON fin.period_balance, fin.pub_cash_balance FROM PUBLIC;
GRANT SELECT ON fin.period_balance TO hk_app, hk_worker, hk_report;
GRANT SELECT ON fin.pub_cash_balance TO hk_app, hk_worker, hk_report;

-- migrate:down
DROP VIEW fin.pub_cash_balance;
DELETE FROM fin.posting_rule WHERE event_code = 'fin.YearClosed';
DELETE FROM fin.posting_event_type WHERE code = 'fin.YearClosed';
ALTER TABLE fin.posting_rule DROP CONSTRAINT ck_posting_rule_closed_account;
ALTER TABLE fin.posting_rule DROP CONSTRAINT ck_posting_rule_determinant_type;
ALTER TABLE fin.posting_rule ADD CONSTRAINT ck_posting_rule_determinant_type
  CHECK (determinant_type IN ('GL_GROUP', 'PAYMENT_METHOD_KIND', 'TAX_LEVY', 'LOSS_GROUP', 'EXPENSE_CATEGORY', 'ASSET_CATEGORY', 'ENTERED'));
DROP TRIGGER trg_journal_entry_closing_closed ON fin.journal_entry;
DROP FUNCTION fin.assert_closing_period_closed();
DROP INDEX fin.uq_journal_entry_closing;
ALTER TABLE fin.journal_entry DROP CONSTRAINT ck_journal_entry_closing;
CREATE OR REPLACE FUNCTION fin.assert_period_open() RETURNS trigger
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
DROP TRIGGER trg_accounting_period_balance ON fin.accounting_period;
DROP FUNCTION fin.period_balance_at_lock();
DROP FUNCTION fin.refresh_period_balance(uuid);
DROP TABLE fin.period_balance;
