-- 0312_platform_add_driver_cash_reconciliation_document
-- B11 continued 2 (FR-DEL-010, CR-057, ADR-0011, ADR-0092): a driver's cash handed in at a till shift is a business
-- document of DEL's, the driver variance report's row. It carries no number of its own: the till shift and the
-- deliveries it counts name it.
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`), safe before the first hand-in; afterwards forward fix only.

-- migrate:up
INSERT INTO platform.document_type (code, owner_module, name, is_numbered, series_prefix) VALUES
  ('DRIVER_CASH_RECONCILIATION', 'del', 'A driver''s cash on delivery handed in at a till shift', false, NULL);

-- migrate:down
DELETE FROM platform.document_type WHERE code = 'DRIVER_CASH_RECONCILIATION';
