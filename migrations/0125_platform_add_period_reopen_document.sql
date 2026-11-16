-- 0125_platform_add_period_reopen_document
-- B08 continued (FR-FIN-010, A-188): asking to reopen a locked accounting period is a business document (ADR-0011), so
-- the PERIOD_REOPEN approval request names it as its subject and the reopen keeps its reason and outcome. Not
-- numbered: the period it names identifies it.
-- Data category: none (lookup row).
-- Rollback: tested (`pnpm db:rollback`), safe before the first reopen request.

-- migrate:up
INSERT INTO platform.document_type (code, owner_module, name, is_numbered, series_prefix) VALUES
  ('PERIOD_REOPEN', 'fin', 'Accounting period reopen', false, NULL);

-- migrate:down
DELETE FROM platform.document_type WHERE code = 'PERIOD_REOPEN';
