-- 0139_iam_seed_fin_report_permission
-- B08 continued 1c (FR-FIN-011 to FR-FIN-013, ADR-0017): reading the financial statements (trial balance, profit and
-- loss, balance sheet, cash flow), as contract/openapi.yaml names it. Granted to no role here; 0140 grants it.
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
INSERT INTO iam.permission (code, module, description, requires_step_up) VALUES
  ('fin.report.read', 'fin', 'Read the financial statements: trial balance, profit and loss, balance sheet and cash flow', false);

-- migrate:down
DELETE FROM iam.role_permission WHERE permission_code = 'fin.report.read';
DELETE FROM iam.permission WHERE code = 'fin.report.read';
