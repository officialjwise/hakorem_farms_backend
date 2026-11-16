-- 0129_platform_add_fin_change_documents
-- B08 continued 1b (FR-FIN-005, FR-FIN-008, A-190, A-191): a manual journal and a posting rule or determination change
-- are business documents (ADR-0011), so their MANUAL_JOURNAL and POSTING_RULE_CHANGE approval requests name them as
-- their subject and the ledger entry a manual journal posts names it as its source document. Not numbered: the journal
-- entry a manual journal posts carries the gap-free JNL number, and a change is identified by what it changes.
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`), safe before the first manual journal or change.

-- migrate:up
INSERT INTO platform.document_type (code, owner_module, name, is_numbered, series_prefix) VALUES
  ('MANUAL_JOURNAL', 'fin', 'Manual journal', false, NULL),
  ('POSTING_RULE_CHANGE', 'fin', 'Posting rule or account determination change', false, NULL);

-- migrate:down
DELETE FROM platform.document_type WHERE code IN ('MANUAL_JOURNAL', 'POSTING_RULE_CHANGE');
