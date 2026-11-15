-- 0040_iam_import_export_permissions
-- The permission codes of MDM's imports and exports (contract x-permission; FR-MDM-019, FR-MDM-020, SEC-009),
-- granted to no role here: migration 0041 grants them (A-128). Every export needs a step-up (the contract's
-- x-requires-step-up on createExportJob, ADR-0016): the bulk threshold of 100 rows marks an export for the daily
-- exception report; it does not waive the step-up below it.
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
INSERT INTO iam.permission (code, module, description, requires_step_up) VALUES
  ('mdm.import.read', 'mdm', 'Read master data import and export jobs and their row errors', false),
  ('mdm.import.create', 'mdm', 'Upload a master data spreadsheet as a dry run, and cancel an import not yet applied', false),
  ('mdm.import.apply', 'mdm', 'Apply a validated master data import, all rows or none', false),
  ('mdm.export.create', 'mdm', 'Export master data to a spreadsheet; audited with its row count', true);

-- migrate:down
DELETE FROM iam.permission WHERE code IN ('mdm.import.read', 'mdm.import.create', 'mdm.import.apply', 'mdm.export.create');
