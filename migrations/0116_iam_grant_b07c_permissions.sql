-- 0116_iam_grant_b07c_permissions
-- Who holds B07 continued 2's permissions (A-177, the most conservative reading until B11 builds scheduling):
--   Owner, Manager  del.slot.read and del.slot.manage: the people who decide when the van goes out. The Driver, the
--                   Sales role and the rest are refused until B11 says otherwise.
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
INSERT INTO iam.role_permission (role_id, permission_code, created_by, updated_by)
SELECT r.id, p.code, '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001'
  FROM iam.role r CROSS JOIN iam.permission p
 WHERE r.deleted_at IS NULL AND r.code IN ('OWNER', 'MANAGER') AND p.code IN ('del.slot.read', 'del.slot.manage')
ON CONFLICT DO NOTHING;

-- migrate:down
DELETE FROM iam.role_permission rp USING iam.role r
 WHERE rp.role_id = r.id AND r.code IN ('OWNER', 'MANAGER') AND rp.permission_code IN ('del.slot.read', 'del.slot.manage');
