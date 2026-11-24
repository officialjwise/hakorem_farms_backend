-- 0352_platform_add_capital_documents
-- B12 (FR-CAP-003, FR-CAP-004, FR-CAP-006, ADR-0011, ADR-0015, ADR-0028): CAP's business documents.
--   CAPITAL_TRANSACTION  a contribution or withdrawal, numbered from its own series (CAP-2026-DDW-000001)
--   CAPITAL_WITHDRAWAL   a withdrawal asked for and waiting for a different person's approval, not numbered
--   DISTRIBUTION_RUN     a profit distribution for a period, numbered when it is drafted (DST-2026-DDW-000001)
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`). A type that documents were registered under is kept, and says so.

-- migrate:up
INSERT INTO platform.document_type (code, owner_module, name, is_numbered, series_prefix) VALUES
  ('CAPITAL_TRANSACTION', 'cap', 'Capital contribution or withdrawal', true, 'CAP'),
  ('CAPITAL_WITHDRAWAL', 'cap', 'Capital withdrawal awaiting approval', false, NULL),
  ('DISTRIBUTION_RUN', 'cap', 'Investor profit distribution', true, 'DST')
ON CONFLICT (code) DO NOTHING;

-- migrate:down
DO $$
BEGIN
  DELETE FROM platform.document_type WHERE code IN ('CAPITAL_TRANSACTION', 'CAPITAL_WITHDRAWAL', 'DISTRIBUTION_RUN');
EXCEPTION WHEN foreign_key_violation THEN
  RAISE NOTICE 'platform.document_type CAPITAL_TRANSACTION, CAPITAL_WITHDRAWAL and DISTRIBUTION_RUN are kept: documents were registered under them';
END
$$;
