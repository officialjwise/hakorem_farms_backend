-- 0374_iam_rpt_report_permissions
-- B12 continued 4 (FR-RPT-004, FR-RPT-005, CR-062 point 2, SA-02): the report permissions, as contract/openapi.yaml
-- names them on listReportDefinitions, runReport and the report runs.
--   rpt.report.read         list the report definitions and run a report on screen
--   rpt.report.export       a report as PDF or XLSX (every export audited with its row count)
--   rpt.report.export.bulk  a report export of more than 1,000 rows (step-up; on the exception report as BULK_EXPORT)
--   rpt.exception_rules.manage  change the daily exception report's rules through AUD's updateSetting, besides
--                           aud.setting.manage: the checkout holding threshold (A-390 approved by the owner, 2026-11-24)
-- Granted to no role here; 0375 grants them (CR-062 point 2; the threshold the Owner's alone).
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
INSERT INTO iam.permission (code, module, description, requires_step_up) VALUES
  ('rpt.report.read', 'rpt', 'List the report definitions and run a report on screen', false),
  ('rpt.report.export', 'rpt', 'Export a report as PDF or XLSX', false),
  ('rpt.report.export.bulk', 'rpt', 'Export a report of more than 1,000 rows', true),
  ('rpt.exception_rules.manage', 'rpt', 'Change the daily exception report''s rules, such as the checkout holding threshold', true);

-- migrate:down
DELETE FROM iam.role_permission WHERE permission_code IN ('rpt.report.read', 'rpt.report.export', 'rpt.report.export.bulk', 'rpt.exception_rules.manage');
DELETE FROM iam.permission WHERE code IN ('rpt.report.read', 'rpt.report.export', 'rpt.report.export.bulk', 'rpt.exception_rules.manage');
