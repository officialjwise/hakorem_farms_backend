-- 0137_platform_add_year_close_document
-- B08 continued 1c (FR-FIN-010, ADR-0058): a year close is a business document (ADR-0011), one per branch it closes, so
-- the CLOSING journal entry the ledger posts from `fin.YearClosed` names it as its source document. Not numbered: the
-- entry carries the gap-free JNL number, and a year close is identified by its year and branch.
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`), safe before the first year close.

-- migrate:up
INSERT INTO platform.document_type (code, owner_module, name, is_numbered, series_prefix) VALUES
  ('YEAR_CLOSE', 'fin', 'Year close', false, NULL);

-- migrate:down
DELETE FROM platform.document_type WHERE code = 'YEAR_CLOSE';
