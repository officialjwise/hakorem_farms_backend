-- 0049_iam_grant_inventory_receipt_permissions
-- Grants the stock and goods receipt permissions (A-135): the Owner, the Manager and the Storekeeper read stock and
-- receipts, and draft and post receipts (FR-INV-009's actor is the Storekeeper); the Accountant reads stock and
-- receipts and writes none. Every other role holds none until the owner says otherwise.
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
INSERT INTO iam.role_permission (role_id, permission_code, created_by, updated_by)
SELECT r.id, p.code, '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001'
  FROM iam.role r CROSS JOIN iam.permission p
 WHERE r.deleted_at IS NULL
   AND ((r.code IN ('OWNER', 'MANAGER', 'STOREKEEPER') AND p.code IN ('inv.stock.read', 'inv.goods_receipt.read', 'inv.goods_receipt.create', 'inv.goods_receipt.post'))
     OR (r.code = 'ACCOUNTANT' AND p.code IN ('inv.stock.read', 'inv.goods_receipt.read')));

-- migrate:down
DELETE FROM iam.role_permission WHERE permission_code IN ('inv.stock.read', 'inv.goods_receipt.read', 'inv.goods_receipt.create', 'inv.goods_receipt.post');
