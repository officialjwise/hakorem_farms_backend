-- 0140_iam_grant_fin_report_permission
-- Who reads the financial statements (DC-09, DC-15, A-195): the Owner and the Accountant, who keep the books. No other
-- role is granted anything of FIN; the Manager's report access comes with the reports (A-188 d).
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
INSERT INTO iam.role_permission (role_id, permission_code, created_by, updated_by)
SELECT r.id, 'fin.report.read', '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001'
  FROM iam.role r
 WHERE r.code IN ('OWNER', 'ACCOUNTANT') AND r.deleted_at IS NULL
ON CONFLICT DO NOTHING;

-- migrate:down
DELETE FROM iam.role_permission rp USING iam.role r
 WHERE rp.role_id = r.id AND r.code IN ('OWNER', 'ACCOUNTANT') AND rp.permission_code = 'fin.report.read';
