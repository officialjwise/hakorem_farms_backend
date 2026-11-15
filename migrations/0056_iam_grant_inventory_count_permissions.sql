-- 0056_iam_grant_inventory_count_permissions
-- Grants the stock take permissions (A-141). FR-INV-013 names the Storekeeper as the counter and the Manager as the
-- reviewer: the Owner, the Manager and the Storekeeper read, plan, start, cancel and count; only the Owner and the
-- Manager submit and post the variances; a variance at or above the threshold then needs a different person holding
-- inv.adjustment.approve (ck_approval_request_maker_not_checker). The Accountant reads and writes nothing. Every
-- other role holds none until the owner says otherwise.
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
INSERT INTO iam.role_permission (role_id, permission_code, created_by, updated_by)
SELECT r.id, p.code, '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001'
  FROM iam.role r CROSS JOIN iam.permission p
 WHERE r.deleted_at IS NULL
   AND ((r.code IN ('OWNER', 'MANAGER', 'STOREKEEPER') AND p.code IN ('inv.stock_take.read', 'inv.stock_take.create', 'inv.stock_take.count'))
     OR (r.code IN ('OWNER', 'MANAGER') AND p.code = 'inv.stock_take.post')
     OR (r.code = 'ACCOUNTANT' AND p.code = 'inv.stock_take.read'));

-- migrate:down
DELETE FROM iam.role_permission WHERE permission_code IN ('inv.stock_take.read', 'inv.stock_take.create', 'inv.stock_take.count', 'inv.stock_take.post');
