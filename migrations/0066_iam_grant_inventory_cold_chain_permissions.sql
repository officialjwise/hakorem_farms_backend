-- 0066_iam_grant_inventory_cold_chain_permissions
-- Grants the B05 continued 4 permissions (A-147). FR-INV-015 names the Storekeeper and the Manager for reorder rules,
-- FR-INV-007 the Storekeeper for temperature readings: the Owner, the Manager and the Storekeeper manage rules and
-- record readings; the Accountant reads both. Opening stock creates stock value from nothing, so only the Owner loads
-- it. Every other role holds none until the owner says otherwise.
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
INSERT INTO iam.role_permission (role_id, permission_code, created_by, updated_by)
SELECT r.id, p.code, '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001'
  FROM iam.role r CROSS JOIN iam.permission p
 WHERE r.deleted_at IS NULL
   AND ((r.code IN ('OWNER', 'MANAGER', 'STOREKEEPER') AND p.code IN ('inv.reorder_rule.read', 'inv.reorder_rule.manage', 'inv.cold_chain.read', 'inv.cold_chain.record'))
     OR (r.code = 'ACCOUNTANT' AND p.code IN ('inv.reorder_rule.read', 'inv.cold_chain.read'))
     OR (r.code = 'OWNER' AND p.code = 'inv.opening_stock.load'));

-- migrate:down
DELETE FROM iam.role_permission WHERE permission_code IN ('inv.reorder_rule.read', 'inv.reorder_rule.manage', 'inv.cold_chain.read', 'inv.cold_chain.record', 'inv.opening_stock.load');
