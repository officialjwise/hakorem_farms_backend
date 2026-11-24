-- 0362_platform_add_costing_documents
-- B12 continued 2 (FR-CST-002, ADR-0011, ADR-0102): CST's business document.
--   OVERHEAD_ALLOCATION  a period's labour or overhead spread over the animals, the source document of the value-only
--                        movements it posts; not numbered (the contract names a run by its id)
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`). A type that documents were registered under is kept, and says so.

-- migrate:up
INSERT INTO platform.document_type (code, owner_module, name, is_numbered, series_prefix) VALUES
  ('OVERHEAD_ALLOCATION', 'cst', 'Labour or overhead allocation run', false, NULL)
ON CONFLICT (code) DO NOTHING;

-- migrate:down
DO $$
BEGIN
  DELETE FROM platform.document_type WHERE code = 'OVERHEAD_ALLOCATION';
EXCEPTION WHEN foreign_key_violation THEN
  RAISE NOTICE 'platform.document_type OVERHEAD_ALLOCATION is kept: documents were registered under it';
END
$$;
