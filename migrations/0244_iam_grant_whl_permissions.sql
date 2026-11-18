-- 0244_iam_grant_whl_permissions
-- Who produces and reads customer statements (FR-WHL-009, A-300 (f)), each the most conservative reading: FR-WHL-009's
-- actors, the Accountant and Sales, produce and read them, and so do the Owner and the Manager, who must hold every
-- permission of a role they grant (FR-IAM-022: the Owner grants every role, the Manager grants Sales). The Storekeeper,
-- the Cashier, the Farm hand, the Driver, the Investor and the Customer hold neither.
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
INSERT INTO iam.role_permission (role_id, permission_code, created_by, updated_by)
SELECT r.id, p.code, '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001'
  FROM iam.role r JOIN (VALUES
    ('OWNER', 'whl.statement.read'), ('MANAGER', 'whl.statement.read'), ('ACCOUNTANT', 'whl.statement.read'), ('SALES', 'whl.statement.read'),
    ('OWNER', 'whl.statement.create'), ('MANAGER', 'whl.statement.create'), ('ACCOUNTANT', 'whl.statement.create'), ('SALES', 'whl.statement.create')
  ) AS p (role, code) ON p.role = r.code
 WHERE r.deleted_at IS NULL
ON CONFLICT DO NOTHING;

-- migrate:down
DELETE FROM iam.role_permission WHERE permission_code IN ('whl.statement.read', 'whl.statement.create');
