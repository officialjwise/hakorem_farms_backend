-- 0375_iam_grant_rpt_report_permissions
-- Who runs and exports the reports (CR-062 point 2, the owner on 2026-11-23, A-393): the Owner and the Manager read and
-- export; the Accountant reads and exports too (the financial statements' own fin.report.read she holds since 0140).
-- A bulk export (more than 1,000 rows, step-up) is the Owner's alone until the owner names anyone else (A-393). Which
-- report each role may run (the financial ones for the Accountant) is decided by the application with the reports.
-- The daily exception report's rules (rpt.exception_rules.manage, the checkout holding threshold) are the Owner's
-- alone (the owner, 2026-11-24: "Make the 3 a setting the Owner can change, audited, not a constant").
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
INSERT INTO iam.role_permission (role_id, permission_code, created_by, updated_by)
SELECT r.id, p.code, '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001'
  FROM iam.role r JOIN (VALUES
    ('OWNER', 'rpt.report.read'), ('OWNER', 'rpt.report.export'), ('OWNER', 'rpt.report.export.bulk'), ('OWNER', 'rpt.exception_rules.manage'),
    ('MANAGER', 'rpt.report.read'), ('MANAGER', 'rpt.report.export'),
    ('ACCOUNTANT', 'rpt.report.read'), ('ACCOUNTANT', 'rpt.report.export')
  ) AS p (role, code) ON p.role = r.code
 WHERE r.deleted_at IS NULL
ON CONFLICT DO NOTHING;

-- migrate:down
DELETE FROM iam.role_permission rp USING iam.role r
 WHERE rp.role_id = r.id AND r.code IN ('OWNER', 'MANAGER', 'ACCOUNTANT')
   AND rp.permission_code IN ('rpt.report.read', 'rpt.report.export', 'rpt.report.export.bulk', 'rpt.exception_rules.manage');
