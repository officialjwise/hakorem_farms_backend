-- 0128_iam_grant_fin_period_permissions
-- Who keeps the chart and the periods (FR-FIN-002, FR-FIN-009, FR-FIN-010, DC-15, A-188): the Owner and the Accountant
-- read and keep the chart, read the periods, and lock and close them. Only the Owner asks to reopen a locked period;
-- the Accountant (or a second Owner) approves it, never the Owner who asked (domain and database, ADR-0017). No other
-- role is granted anything of FIN here: the Manager's read-only access to the reports comes with the reports.
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
INSERT INTO iam.role_permission (role_id, permission_code, created_by, updated_by)
SELECT r.id, p.code, '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001'
  FROM iam.role r
  JOIN (VALUES
    ('OWNER', 'fin.account.read'), ('OWNER', 'fin.account.manage'), ('OWNER', 'fin.period.read'), ('OWNER', 'fin.period.lock'),
    ('OWNER', 'fin.period.close'), ('OWNER', 'fin.period.reopen'), ('OWNER', 'fin.period.reopen_approve'),
    ('ACCOUNTANT', 'fin.account.read'), ('ACCOUNTANT', 'fin.account.manage'), ('ACCOUNTANT', 'fin.period.read'),
    ('ACCOUNTANT', 'fin.period.lock'), ('ACCOUNTANT', 'fin.period.close'), ('ACCOUNTANT', 'fin.period.reopen_approve')
  ) AS p (role_code, code) ON p.role_code = r.code
 WHERE r.deleted_at IS NULL
ON CONFLICT DO NOTHING;

-- migrate:down
DELETE FROM iam.role_permission rp USING iam.role r
 WHERE rp.role_id = r.id AND r.code IN ('OWNER', 'ACCOUNTANT')
   AND rp.permission_code IN ('fin.account.read', 'fin.account.manage', 'fin.period.read', 'fin.period.lock', 'fin.period.close', 'fin.period.reopen', 'fin.period.reopen_approve');
