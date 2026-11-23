-- 0320_iam_grant_del_route_permissions
-- Who plans and closes a driver's run (FR-DEL-005, CR-056 item 3): the Manager and the Owner, who dispatch and assign.
-- The Driver reads only their own run (`getMyRoute`, under `del.delivery.read.assigned`); every other role holds none
-- of it.
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
INSERT INTO iam.role_permission (role_id, permission_code, created_by, updated_by)
SELECT r.id, p.code, '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001'
  FROM iam.role r CROSS JOIN (VALUES ('del.route.read'), ('del.route.manage')) AS p (code)
 WHERE r.code IN ('MANAGER', 'OWNER') AND r.deleted_at IS NULL
ON CONFLICT DO NOTHING;

-- migrate:down
DELETE FROM iam.role_permission rp USING iam.role r
 WHERE rp.role_id = r.id AND r.code IN ('MANAGER', 'OWNER') AND rp.permission_code IN ('del.route.read', 'del.route.manage');
