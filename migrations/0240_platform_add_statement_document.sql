-- 0240_platform_add_statement_document
-- B08 continued 2d (FR-WHL-009, FR-DOC-002, ADR-0011, ADR-0015, ADR-0085): a customer statement is a business
-- document of its own, owned by WHL, rendered and archived by DOC. An issued statement is numbered from its own
-- gap-free series per branch and year of its issue date: STM-2026-DDW-000031. A draft takes no number.
-- Data category: none (a lookup row).
-- Rollback: tested (`pnpm db:rollback`). Once a statement has been registered the type stays: the registry, the number
-- series and the archive are insert-only and name it, so the down step keeps it and says so, and applying again finds
-- it (ON CONFLICT DO NOTHING). Walked over an archived statement by `bil/archive-link-rollback`.

-- migrate:up
INSERT INTO platform.document_type (code, owner_module, name, is_numbered, series_prefix) VALUES
  ('STATEMENT', 'whl', 'Customer statement', true, 'STM')
ON CONFLICT (code) DO NOTHING;

-- migrate:down
DO $$
BEGIN
  DELETE FROM platform.document_type WHERE code = 'STATEMENT';
EXCEPTION WHEN foreign_key_violation THEN
  RAISE NOTICE 'platform.document_type STATEMENT is kept: statements were registered, numbered or archived under it';
END
$$;
