-- 0130_fin_manual_journals_rule_changes
-- B08 continued 1b (FR-FIN-004, FR-FIN-005, FR-FIN-008, ADR-0003, ADR-0017, A-190, A-191).
--
-- Manual journals. `fin.manual_journal` and its lines hold a journal a person enters (kind MANUAL, or OPENING for the
-- opening balance journal against 3900, A-005) while it is drafted and approved. It posts nothing until a different
-- person approves it (MANUAL_JOURNAL); the approval publishes `fin.ManualJournalApproved` and the ledger posts it through
-- the same path as every other event (numbering, the period rule, the line and balance triggers of 0123). Its rules post
-- each amount to the account entered for it: the new determinant `ENTERED` (ADR-0003's "As entered"). The database holds:
--   ck_manual_journal_posted       a posted journal names its approval and its journal entry, and only a posted one an entry
--   uq_manual_journal_opening      one opening balance journal ever, pending or posted (OPENING_ALREADY_POSTED)
--   ck_manual_journal_line_draft   lines are written only while the journal is a draft, under its current revision
--   ck_manual_journal_entry        the entry a journal is posted with is its own, of its kind and date, line for line as entered
--   ck_journal_entry_manual        a MANUAL or OPENING journal entry is only ever posted from fin.ManualJournalApproved
--   ck_posting_rule_entered        only fin.ManualJournalApproved posts as entered, and its rules never stop doing so
-- A draft's lines are never updated or deleted: a change writes the whole set again under the next `revision`, so every
-- set of lines ever proposed stays readable. A submitted journal is frozen except its decision; a decided one entirely.
--
-- Posting rule and determination changes. `fin.posting_rule_change` is the subject of a POSTING_RULE_CHANGE approval:
-- the rule or determination asked for, waiting until a different person approves with step-up. On approval the rule in
-- force is end-dated and the new one starts, never before the approval day; nothing posted is touched or re-posted.
-- `fin.account_determination` gains `approval_request_id`, NULL only for a row seeded by the System principal, as
-- `fin.posting_rule` already has (`ck_account_determination_approved`).
-- Data category: internal (amounts and descriptions entered by the accountant).
-- Rollback: tested (`pnpm db:rollback`), safe before the first manual journal or change; afterwards forward fix only.

-- migrate:up
ALTER TABLE fin.posting_rule DROP CONSTRAINT ck_posting_rule_determinant_type;
ALTER TABLE fin.posting_rule ADD CONSTRAINT ck_posting_rule_determinant_type
  CHECK (determinant_type IN ('GL_GROUP', 'PAYMENT_METHOD_KIND', 'TAX_LEVY', 'LOSS_GROUP', 'EXPENSE_CATEGORY', 'ASSET_CATEGORY', 'ENTERED'));
ALTER TABLE fin.posting_rule ADD CONSTRAINT ck_posting_rule_entered
  CHECK ((determinant_type IS NOT DISTINCT FROM 'ENTERED') = (event_code = 'fin.ManualJournalApproved'));

ALTER TABLE fin.account_determination
  ADD COLUMN approval_request_id uuid NULL CONSTRAINT fk_account_determination_approval REFERENCES iam.approval_request (id) ON DELETE RESTRICT;
ALTER TABLE fin.account_determination ADD CONSTRAINT ck_account_determination_approved
  CHECK (approval_request_id IS NOT NULL OR created_by = '01900000-0000-7000-8000-000000000001');

INSERT INTO fin.posting_event_type (code, owner_module, description, amount_keys) VALUES
  ('fin.ManualJournalApproved', 'fin', 'A manual journal approved by a second person, posted as entered', ARRAY['debit', 'credit']);
INSERT INTO fin.posting_rule (id, event_code, amount_key, side, account_id, determinant_type, determinant_role, valid_from, created_by, updated_by) VALUES
  ('01900000-0000-7000-8300-000000000049', 'fin.ManualJournalApproved', 'debit', 'D', NULL, 'ENTERED', 'AS_ENTERED', DATE '2020-01-01',
   '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001'),
  ('01900000-0000-7000-8300-000000000050', 'fin.ManualJournalApproved', 'credit', 'C', NULL, 'ENTERED', 'AS_ENTERED', DATE '2020-01-01',
   '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001');

ALTER TABLE fin.journal_entry ADD CONSTRAINT ck_journal_entry_manual
  CHECK (kind NOT IN ('MANUAL', 'OPENING') OR (event_code = 'fin.ManualJournalApproved' AND event_id IS NOT NULL));

-- A journal entered by a person (FR-FIN-008).
CREATE TABLE fin.manual_journal (
  id                  uuid PRIMARY KEY CONSTRAINT fk_manual_journal_document REFERENCES platform.business_document (id) ON DELETE RESTRICT,
  kind                text NOT NULL CONSTRAINT ck_manual_journal_kind CHECK (kind IN ('MANUAL', 'OPENING')),
  posting_date        date NOT NULL,
  description         text NOT NULL CONSTRAINT ck_manual_journal_description CHECK (length(btrim(description)) BETWEEN 1 AND 300),
  branch_id           uuid NOT NULL CONSTRAINT fk_manual_journal_branch REFERENCES mdm.branch (id) ON DELETE RESTRICT,
  status              text NOT NULL CONSTRAINT ck_manual_journal_status CHECK (status IN ('DRAFT', 'PENDING_APPROVAL', 'POSTED', 'REJECTED')),
  revision            integer NOT NULL DEFAULT 1 CONSTRAINT ck_manual_journal_revision CHECK (revision > 0),
  approval_request_id uuid NULL CONSTRAINT fk_manual_journal_approval REFERENCES iam.approval_request (id) ON DELETE RESTRICT,
  journal_entry_id    uuid NULL CONSTRAINT uq_manual_journal_entry UNIQUE CONSTRAINT fk_manual_journal_entry REFERENCES fin.journal_entry (id) ON DELETE RESTRICT,
  decided_at          timestamptz NULL,
  decided_by          uuid NULL CONSTRAINT fk_manual_journal_decided_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  version             integer NOT NULL DEFAULT 1,
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid NOT NULL CONSTRAINT fk_manual_journal_created_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  updated_by          uuid NOT NULL CONSTRAINT fk_manual_journal_updated_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  CONSTRAINT ck_manual_journal_posted CHECK (
    (status = 'DRAFT') = (approval_request_id IS NULL)
    AND (status = 'POSTED') = (journal_entry_id IS NOT NULL)
    AND (status IN ('DRAFT', 'PENDING_APPROVAL')) = (decided_at IS NULL)
    AND (decided_at IS NULL) = (decided_by IS NULL)
  )
);
COMMENT ON TABLE fin.manual_journal IS 'class=DOCUMENT';
CREATE UNIQUE INDEX uq_manual_journal_opening ON fin.manual_journal (kind) WHERE kind = 'OPENING' AND status IN ('PENDING_APPROVAL', 'POSTED');
CREATE INDEX ix_manual_journal_status ON fin.manual_journal (status, id);
CREATE INDEX ix_journal_entry_posting_date ON fin.journal_entry (posting_date, id);
CREATE TRIGGER trg_manual_journal_version BEFORE UPDATE ON fin.manual_journal
  FOR EACH ROW EXECUTE FUNCTION platform.touch_version();
CREATE TRIGGER trg_manual_journal_freeze BEFORE UPDATE ON fin.manual_journal
  FOR EACH ROW EXECUTE FUNCTION platform.freeze_posted('POSTED,REJECTED');
CREATE TRIGGER trg_manual_journal_freeze_pending BEFORE UPDATE ON fin.manual_journal
  FOR EACH ROW EXECUTE FUNCTION platform.freeze_posted('PENDING_APPROVAL', 'status', 'journal_entry_id', 'decided_at', 'decided_by', 'updated_at', 'updated_by', 'version');

-- The lines of one revision of a manual journal. Written only while it is a draft; never updated or deleted.
CREATE TABLE fin.manual_journal_line (
  id                 uuid PRIMARY KEY,
  manual_journal_id  uuid NOT NULL CONSTRAINT fk_manual_journal_line_journal REFERENCES fin.manual_journal (id) ON DELETE RESTRICT,
  revision           integer NOT NULL CONSTRAINT ck_manual_journal_line_revision CHECK (revision > 0),
  line_no            integer NOT NULL CONSTRAINT ck_manual_journal_line_no CHECK (line_no > 0),
  account_id         uuid NOT NULL CONSTRAINT fk_manual_journal_line_account REFERENCES fin.account (id) ON DELETE RESTRICT,
  side               char(1) NOT NULL CONSTRAINT ck_manual_journal_line_side CHECK (side IN ('D', 'C')),
  amount_pesewas     platform.pesewas NOT NULL CONSTRAINT ck_manual_journal_line_amount CHECK (amount_pesewas > 0),
  subledger_party_id uuid NULL CONSTRAINT fk_manual_journal_line_subledger REFERENCES fin.subledger_party (id) ON DELETE RESTRICT,
  memo               text NULL CONSTRAINT ck_manual_journal_line_memo CHECK (memo IS NULL OR length(memo) <= 300),
  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid NOT NULL CONSTRAINT fk_manual_journal_line_created_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  CONSTRAINT uq_manual_journal_line UNIQUE (manual_journal_id, revision, line_no)
);
COMMENT ON TABLE fin.manual_journal_line IS 'class=DOCUMENT';
CREATE TRIGGER trg_manual_journal_line_immutable BEFORE UPDATE OR DELETE ON fin.manual_journal_line
  FOR EACH ROW EXECUTE FUNCTION platform.reject_change();
CREATE TRIGGER trg_manual_journal_line_no_truncate BEFORE TRUNCATE ON fin.manual_journal_line
  FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_change();

CREATE FUNCTION fin.manual_journal_line_guard() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
DECLARE
  journal record;
BEGIN
  SELECT j.status, j.revision INTO journal FROM fin.manual_journal j WHERE j.id = NEW.manual_journal_id FOR SHARE;
  IF journal.status IS DISTINCT FROM 'DRAFT' OR journal.revision IS DISTINCT FROM NEW.revision THEN
    PERFORM fin.refuse('ck_manual_journal_line_draft', format('manual journal %s takes lines only as a draft, under its revision %s (not %s)',
                                                              NEW.manual_journal_id, journal.revision, NEW.revision));
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION fin.manual_journal_line_guard() FROM PUBLIC;
CREATE TRIGGER trg_manual_journal_line_guard BEFORE INSERT ON fin.manual_journal_line
  FOR EACH ROW EXECUTE FUNCTION fin.manual_journal_line_guard();

-- A journal becomes POSTED only with the entry the ledger posted for it: its own source document, its kind and date,
-- and the lines of its current revision exactly, in order (account, side, amount, party). Nothing else can stand in.
CREATE FUNCTION fin.manual_journal_posted_guard() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
DECLARE
  entry record;
  differs boolean;
BEGIN
  IF NEW.status <> 'POSTED' OR OLD.status = 'POSTED' THEN
    RETURN NEW;
  END IF;
  SELECT e.source_document_id, e.kind, e.posting_date INTO entry FROM fin.journal_entry e WHERE e.id = NEW.journal_entry_id;
  IF entry.source_document_id IS DISTINCT FROM NEW.id OR entry.kind IS DISTINCT FROM NEW.kind OR entry.posting_date IS DISTINCT FROM NEW.posting_date THEN
    PERFORM fin.refuse('ck_manual_journal_entry', format('manual journal %s is not what entry %s posted', NEW.id, NEW.journal_entry_id));
  END IF;
  SELECT EXISTS (
    (SELECT line_no, account_id, side, amount_pesewas, subledger_party_id FROM fin.manual_journal_line
      WHERE manual_journal_id = NEW.id AND revision = NEW.revision
     EXCEPT ALL
     SELECT line_no, account_id, side, amount_pesewas, subledger_party_id FROM fin.journal_line WHERE journal_entry_id = NEW.journal_entry_id)
    UNION ALL
    (SELECT line_no, account_id, side, amount_pesewas, subledger_party_id FROM fin.journal_line WHERE journal_entry_id = NEW.journal_entry_id
     EXCEPT ALL
     SELECT line_no, account_id, side, amount_pesewas, subledger_party_id FROM fin.manual_journal_line
      WHERE manual_journal_id = NEW.id AND revision = NEW.revision)
  ) INTO differs;
  IF differs THEN
    PERFORM fin.refuse('ck_manual_journal_entry', format('entry %s does not carry the lines of manual journal %s as entered', NEW.journal_entry_id, NEW.id));
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION fin.manual_journal_posted_guard() FROM PUBLIC;
CREATE TRIGGER trg_manual_journal_posted_guard BEFORE UPDATE ON fin.manual_journal
  FOR EACH ROW EXECUTE FUNCTION fin.manual_journal_posted_guard();

-- A change to one posting rule or one account determination, waiting for its POSTING_RULE_CHANGE approval (A-191).
CREATE TABLE fin.posting_rule_change (
  id                        uuid PRIMARY KEY CONSTRAINT fk_posting_rule_change_document REFERENCES platform.business_document (id) ON DELETE RESTRICT,
  branch_id                 uuid NOT NULL CONSTRAINT fk_posting_rule_change_branch REFERENCES mdm.branch (id) ON DELETE RESTRICT,
  target                    text NOT NULL CONSTRAINT ck_posting_rule_change_target CHECK (target IN ('RULE', 'DETERMINATION')),
  event_code                text NULL CONSTRAINT fk_posting_rule_change_event REFERENCES fin.posting_event_type (code) ON DELETE RESTRICT,
  amount_key                text NULL,
  side                      char(1) NULL CONSTRAINT ck_posting_rule_change_side CHECK (side IN ('D', 'C')),
  account_id                uuid NULL CONSTRAINT fk_posting_rule_change_account REFERENCES fin.account (id) ON DELETE RESTRICT,
  determinant_type          text NULL CONSTRAINT ck_posting_rule_change_determinant_type
                              CHECK (determinant_type IN ('GL_GROUP', 'PAYMENT_METHOD_KIND', 'TAX_LEVY', 'LOSS_GROUP', 'EXPENSE_CATEGORY', 'ASSET_CATEGORY')),
  determinant_role          text NULL CONSTRAINT ck_posting_rule_change_role
                              CHECK (determinant_role IN ('INVENTORY', 'SALES', 'COST_OF_SALES', 'TENDER', 'PAYOUT', 'OUTPUT', 'INPUT', 'LOSS', 'EXPENSE')),
  determinant_key           text NULL CONSTRAINT ck_posting_rule_change_key CHECK (determinant_key ~ '^(\*|[A-Z][A-Z0-9_]{0,59})$'),
  subledger_from            text NULL CONSTRAINT ck_posting_rule_change_subledger_from CHECK (subledger_from IS NULL OR length(subledger_from) <= 60),
  valid_from                date NOT NULL,
  status                    text NOT NULL CONSTRAINT ck_posting_rule_change_status CHECK (status IN ('PENDING_APPROVAL', 'POSTED', 'REJECTED')),
  approval_request_id       uuid NOT NULL CONSTRAINT fk_posting_rule_change_approval REFERENCES iam.approval_request (id) ON DELETE RESTRICT,
  effective_from            date NULL,
  posting_rule_id           uuid NULL CONSTRAINT fk_posting_rule_change_rule REFERENCES fin.posting_rule (id) ON DELETE RESTRICT,
  account_determination_id  uuid NULL CONSTRAINT fk_posting_rule_change_determination REFERENCES fin.account_determination (id) ON DELETE RESTRICT,
  decided_at                timestamptz NULL,
  decided_by                uuid NULL CONSTRAINT fk_posting_rule_change_decided_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  version                   integer NOT NULL DEFAULT 1,
  created_at                timestamptz NOT NULL DEFAULT now(),
  created_by                uuid NOT NULL CONSTRAINT fk_posting_rule_change_created_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  updated_at                timestamptz NOT NULL DEFAULT now(),
  updated_by                uuid NOT NULL CONSTRAINT fk_posting_rule_change_updated_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  CONSTRAINT ck_posting_rule_change_shape CHECK (
    (target = 'RULE' AND event_code IS NOT NULL AND amount_key IS NOT NULL AND side IS NOT NULL AND determinant_key IS NULL
       AND (account_id IS NULL) <> (determinant_type IS NULL) AND (determinant_type IS NULL) = (determinant_role IS NULL))
    OR (target = 'DETERMINATION' AND event_code IS NULL AND amount_key IS NULL AND side IS NULL AND subledger_from IS NULL
       AND account_id IS NOT NULL AND determinant_type IS NOT NULL AND determinant_role IS NOT NULL AND determinant_key IS NOT NULL)
  ),
  CONSTRAINT ck_posting_rule_change_decided CHECK (
    (status = 'PENDING_APPROVAL') = (decided_at IS NULL) AND (decided_at IS NULL) = (decided_by IS NULL)
    AND (status = 'POSTED') = (effective_from IS NOT NULL AND effective_from >= valid_from)
    AND (status = 'POSTED') = ((CASE WHEN target = 'RULE' THEN posting_rule_id ELSE account_determination_id END) IS NOT NULL)
    AND (target = 'RULE' OR posting_rule_id IS NULL) AND (target = 'DETERMINATION' OR account_determination_id IS NULL)
  )
);
COMMENT ON TABLE fin.posting_rule_change IS 'class=DOCUMENT';
CREATE UNIQUE INDEX uq_posting_rule_change_rule_pending ON fin.posting_rule_change (event_code, amount_key, side)
  WHERE target = 'RULE' AND status = 'PENDING_APPROVAL';
CREATE UNIQUE INDEX uq_posting_rule_change_determination_pending ON fin.posting_rule_change (determinant_type, determinant_key, determinant_role)
  WHERE target = 'DETERMINATION' AND status = 'PENDING_APPROVAL';
CREATE TRIGGER trg_posting_rule_change_version BEFORE UPDATE ON fin.posting_rule_change
  FOR EACH ROW EXECUTE FUNCTION platform.touch_version();
CREATE TRIGGER trg_posting_rule_change_freeze BEFORE UPDATE ON fin.posting_rule_change
  FOR EACH ROW EXECUTE FUNCTION platform.freeze_posted('POSTED,REJECTED');

REVOKE ALL ON fin.manual_journal, fin.manual_journal_line, fin.posting_rule_change FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON fin.manual_journal, fin.manual_journal_line, fin.posting_rule_change TO hk_app, hk_worker;

-- migrate:down
DROP TABLE fin.posting_rule_change;
DROP TRIGGER trg_manual_journal_posted_guard ON fin.manual_journal;
DROP FUNCTION fin.manual_journal_posted_guard();
DROP TABLE fin.manual_journal_line;
DROP FUNCTION fin.manual_journal_line_guard();
DROP TABLE fin.manual_journal;
ALTER TABLE fin.journal_entry DROP CONSTRAINT ck_journal_entry_manual;
DELETE FROM fin.posting_rule WHERE event_code = 'fin.ManualJournalApproved';
DELETE FROM fin.posting_event_type WHERE code = 'fin.ManualJournalApproved';
ALTER TABLE fin.account_determination DROP CONSTRAINT ck_account_determination_approved;
ALTER TABLE fin.account_determination DROP COLUMN approval_request_id;
ALTER TABLE fin.posting_rule DROP CONSTRAINT ck_posting_rule_entered;
ALTER TABLE fin.posting_rule DROP CONSTRAINT ck_posting_rule_determinant_type;
ALTER TABLE fin.posting_rule ADD CONSTRAINT ck_posting_rule_determinant_type
  CHECK (determinant_type IN ('GL_GROUP', 'PAYMENT_METHOD_KIND', 'TAX_LEVY', 'LOSS_GROUP', 'EXPENSE_CATEGORY', 'ASSET_CATEGORY'));
