-- 0124_fin_journal_entry_written_xact
-- B08 continued: a latent false refusal in 0123's `fin.assert_line_valid()`. It decided that a line joins "an entry
-- written in its own transaction" by `e.xmin = pg_current_xact_id()::xid`. A row inserted inside a SAVEPOINT (a
-- subtransaction: drizzle's nested `transaction()`, or an explicit SAVEPOINT as PRC's processing store uses) carries the
-- subtransaction's xid as its xmin, while `pg_current_xact_id()` names the top-level transaction, so an entry written
-- inside a savepoint had its own lines refused as ck_journal_line_entry. The rule itself is unchanged: lines are written
-- only in the transaction that wrote their entry, never added later to an entry an earlier transaction committed.
--
-- The entry now records the top-level transaction that wrote it, `written_xact_id` (`pg_current_xact_id()` names the
-- top-level transaction even inside a subtransaction, and an xid8 never wraps), set by a BEFORE INSERT trigger whatever
-- the writer supplies; the entry is insert-only (platform.reject_change), so it can never be changed afterwards. The
-- line trigger compares that column with the current transaction instead of xmin. Entries written before this
-- migration carry NULL, which no transaction matches: they were all committed by earlier transactions. NULL fails
-- closed (no line can join such an entry), so the column needs no NOT NULL check of its own; a superuser who disables
-- the triggers is the nightly reconciliation's case (FR-FIN-016), not this rule's.
-- Additions to docs/data-model/fin.md: `fin.journal_entry.written_xact_id`.
-- Data category: CONFIDENTIAL (DC-09), unchanged.
-- Rollback: tested (`pnpm db:rollback`): restores 0123's function and drops the trigger and the column. Safe at
-- any time; the column is read only by the line trigger.

-- migrate:up
ALTER TABLE fin.journal_entry ADD COLUMN written_xact_id xid8 NULL;

CREATE FUNCTION fin.record_written_xact() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
BEGIN
  NEW.written_xact_id := pg_current_xact_id();
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION fin.record_written_xact() FROM PUBLIC;
CREATE TRIGGER trg_journal_entry_written_xact BEFORE INSERT ON fin.journal_entry
  FOR EACH ROW EXECUTE FUNCTION fin.record_written_xact();

-- A line joins only an entry written in its own (top-level) transaction, carries the entry's date, and goes to a
-- postable, active account; it names a subledger party exactly when the account has a subledger, and a party of that kind.
CREATE OR REPLACE FUNCTION fin.assert_line_valid() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
DECLARE
  entry record;
  acct record;
  party_kind text;
BEGIN
  SELECT e.posting_date, COALESCE(e.written_xact_id = pg_current_xact_id(), false) AS is_new INTO entry FROM fin.journal_entry e WHERE e.id = NEW.journal_entry_id;
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

-- migrate:down
CREATE OR REPLACE FUNCTION fin.assert_line_valid() RETURNS trigger
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
DROP TRIGGER trg_journal_entry_written_xact ON fin.journal_entry;
DROP FUNCTION fin.record_written_xact();
ALTER TABLE fin.journal_entry DROP COLUMN written_xact_id;
