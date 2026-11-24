-- 0331_iam_grant_delivery_fee_add_permission
-- Who charges a customer for an extra delivery (the owner, 2026-11-23): the Manager and the Owner, who dispatch and so
-- issue the document the fee goes on (A-337 (d)). Never the Storekeeper, Sales, the Cashier or the Driver.
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
INSERT INTO iam.role_permission (role_id, permission_code, created_by, updated_by)
SELECT r.id, 'ord.delivery_fee.add', '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001'
  FROM iam.role r
 WHERE r.code IN ('MANAGER', 'OWNER') AND r.deleted_at IS NULL
ON CONFLICT DO NOTHING;

-- migrate:down
DELETE FROM iam.role_permission rp USING iam.role r
 WHERE rp.role_id = r.id AND r.code IN ('MANAGER', 'OWNER') AND rp.permission_code = 'ord.delivery_fee.add';
