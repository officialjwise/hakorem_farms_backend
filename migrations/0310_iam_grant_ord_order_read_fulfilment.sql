-- 0310_iam_grant_ord_order_read_fulfilment
-- Who reads an order as the store does (the owner, 2026-11-23, decision 6, A-335, A-344): the Storekeeper, and the
-- Manager and the Owner, who hold every permission of the roles they grant (FR-IAM-022). Every other role holds none.
-- The Storekeeper is still not given `ord.order.read`.
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
INSERT INTO iam.role_permission (role_id, permission_code, created_by, updated_by)
SELECT r.id, 'ord.order.read.fulfilment', '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001'
  FROM iam.role r
 WHERE r.code IN ('STOREKEEPER', 'MANAGER', 'OWNER') AND r.deleted_at IS NULL
ON CONFLICT DO NOTHING;

-- migrate:down
DELETE FROM iam.role_permission rp USING iam.role r
 WHERE rp.role_id = r.id AND r.code IN ('STOREKEEPER', 'MANAGER', 'OWNER') AND rp.permission_code = 'ord.order.read.fulfilment';
