-- 0059_iam_grant_inventory_hold_permissions
-- Grants the hold permissions (A-142). FR-INV-022 names the Manager: the Owner and the Manager place and release
-- holds, and a release is never by the person who placed the hold (ck_stock_hold_releaser). The Accountant and the
-- Storekeeper read them, since a held lot is what a storekeeper must not move. Every other role holds none until the
-- owner says otherwise.
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
INSERT INTO iam.role_permission (role_id, permission_code, created_by, updated_by)
SELECT r.id, p.code, '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001'
  FROM iam.role r CROSS JOIN iam.permission p
 WHERE r.deleted_at IS NULL
   AND ((r.code IN ('OWNER', 'MANAGER') AND p.code IN ('inv.hold.read', 'inv.hold.create', 'inv.hold.release'))
     OR (r.code IN ('ACCOUNTANT', 'STOREKEEPER') AND p.code = 'inv.hold.read'));

-- migrate:down
DELETE FROM iam.role_permission WHERE permission_code IN ('inv.hold.read', 'inv.hold.create', 'inv.hold.release');
