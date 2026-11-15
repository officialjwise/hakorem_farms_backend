-- 0031_iam_grant_role_admin_permissions
-- Grants migration 0030's permissions to the seeded roles (A-122). Only the Owner changes roles. The Owner, the Manager
-- and the Accountant read the approval inbox at their branches and withdraw their own pending requests; a later
-- module that makes another role a maker grants it these when it does. Deciding needs the approver permission the
-- kind's policy names, which each module grants with its kind.
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
INSERT INTO iam.role_permission (role_id, permission_code, created_by, updated_by)
SELECT r.id, p.code, '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001'
  FROM iam.role r
  JOIN iam.permission p ON
       (r.code = 'OWNER' AND p.code IN ('iam.role.manage', 'iam.approval.read', 'iam.approval.cancel.own'))
    OR (r.code IN ('MANAGER', 'ACCOUNTANT') AND p.code IN ('iam.approval.read', 'iam.approval.cancel.own'))
 WHERE r.deleted_at IS NULL;

-- migrate:down
DELETE FROM iam.role_permission WHERE permission_code IN ('iam.role.manage', 'iam.approval.read', 'iam.approval.cancel.own');
