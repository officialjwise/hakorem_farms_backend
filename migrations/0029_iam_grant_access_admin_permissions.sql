-- 0029_iam_grant_access_admin_permissions
-- Grants migration 0028's permissions to the seeded roles (A-120). The Owner and Manager hold all nine: a Manager still
-- cannot grant a role holding a permission they lack (the Owner role), nor anything to themselves (FR-IAM-022). The
-- Accountant reads users, roles and grants, for the permission-change review. No other role holds any of them.
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
INSERT INTO iam.role_permission (role_id, permission_code, created_by)
SELECT r.id, p.code, '01900000-0000-7000-8000-000000000001'
  FROM iam.role r
  JOIN iam.permission p ON
       (r.code IN ('OWNER', 'MANAGER') AND p.code IN (
          'iam.user.read', 'iam.user.create', 'iam.user.update', 'iam.user.disable', 'iam.user.unlock', 'iam.user.reset_password',
          'iam.role.read', 'iam.grant.read', 'iam.grant.manage'))
    OR (r.code = 'ACCOUNTANT' AND p.code IN ('iam.user.read', 'iam.role.read', 'iam.grant.read'))
 WHERE r.deleted_at IS NULL;

-- migrate:down
DELETE FROM iam.role_permission WHERE permission_code IN (
  'iam.user.read', 'iam.user.create', 'iam.user.update', 'iam.user.disable', 'iam.user.unlock', 'iam.user.reset_password',
  'iam.role.read', 'iam.grant.read', 'iam.grant.manage');
