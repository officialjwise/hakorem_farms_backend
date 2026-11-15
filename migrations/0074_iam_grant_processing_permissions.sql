-- 0074_iam_grant_processing_permissions
-- Grants the B6 processing permissions (A-153). The Owner, the Manager and the Storekeeper plan, process and read
-- processing orders and read yield standards; the Owner and the Manager manage the standards; the Accountant reads
-- orders and standards and writes neither. A processing order shows input cost, direct cost and allocated cost
-- (DC-11), so the Farm hand, whom the requirements name beside the Storekeeper, holds none until the owner decides
-- that they may see cost; every other role holds none.
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
INSERT INTO iam.role_permission (role_id, permission_code, created_by, updated_by)
SELECT r.id, p.code, '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001'
  FROM iam.role r CROSS JOIN iam.permission p
 WHERE r.deleted_at IS NULL
   AND ((r.code IN ('OWNER', 'MANAGER', 'STOREKEEPER') AND p.code IN ('prc.order.read', 'prc.order.create', 'prc.order.process', 'prc.yield_standard.read'))
     OR (r.code IN ('OWNER', 'MANAGER') AND p.code = 'prc.yield_standard.manage')
     OR (r.code = 'ACCOUNTANT' AND p.code IN ('prc.order.read', 'prc.yield_standard.read')));

-- migrate:down
DELETE FROM iam.role_permission WHERE permission_code IN ('prc.order.read', 'prc.order.create', 'prc.order.process', 'prc.yield_standard.read', 'prc.yield_standard.manage');
