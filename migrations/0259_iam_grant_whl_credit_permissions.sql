-- 0259_iam_grant_whl_credit_permissions
-- B10 continued (CR-048 as the owner approved it on 2026-11-18, the owner's item 5): who reads, holds, releases and
-- approves. The Owner and the Manager hold every credit permission; Sales reads accounts (and asks for an override
-- through ord.order.confirm, which it holds, never approving one); the Accountant reads accounts and may put one on hold,
-- never release it. Releasing a hold, approving a credit override and changing a credit limit are the Owner's and the
-- Manager's only, and the person who asked never decides (ADR-0017, in the application and the database).
-- Data category: none (grants).
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
INSERT INTO iam.role_permission (role_id, permission_code, created_by, updated_by)
SELECT r.id, p.code, '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001'
  FROM iam.role r JOIN (VALUES
    ('OWNER', 'whl.account.read'), ('MANAGER', 'whl.account.read'), ('SALES', 'whl.account.read'), ('ACCOUNTANT', 'whl.account.read'),
    ('OWNER', 'whl.account.manage'), ('MANAGER', 'whl.account.manage'),
    ('OWNER', 'whl.account.hold'), ('MANAGER', 'whl.account.hold'), ('ACCOUNTANT', 'whl.account.hold'),
    ('OWNER', 'whl.account.release'), ('MANAGER', 'whl.account.release'),
    ('OWNER', 'whl.credit.override'), ('MANAGER', 'whl.credit.override')
  ) AS p (role, code) ON p.role = r.code
 WHERE r.deleted_at IS NULL
ON CONFLICT DO NOTHING;

-- migrate:down
DELETE FROM iam.role_permission WHERE permission_code IN ('whl.account.read', 'whl.account.manage', 'whl.account.hold', 'whl.account.release', 'whl.credit.override');
