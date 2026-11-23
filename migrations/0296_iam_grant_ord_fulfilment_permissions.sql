-- 0296_iam_grant_ord_fulfilment_permissions
-- Who picks and who records the customer's answer (CR-056 items 2 and 3, A-335): the Storekeeper reads pick lists, picks
-- and packs, and reads the order it picks; the Manager and the Owner, who holds every permission of the roles they grant
-- (FR-IAM-022), do the same and record the customer's answer. Every other role holds none: the most conservative reading.
-- Dispatch and the delivery permissions follow with dispatch (B11 continued).
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
INSERT INTO iam.role_permission (role_id, permission_code, created_by, updated_by)
SELECT r.id, p.code, '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001'
  FROM iam.role r JOIN (VALUES
    ('STOREKEEPER', 'ord.fulfilment.read'), ('STOREKEEPER', 'ord.fulfilment.pick'), ('STOREKEEPER', 'ord.order.read'),
    ('MANAGER', 'ord.fulfilment.read'), ('MANAGER', 'ord.fulfilment.pick'), ('MANAGER', 'ord.order.update'),
    ('OWNER', 'ord.fulfilment.read'), ('OWNER', 'ord.fulfilment.pick'), ('OWNER', 'ord.order.update')
  ) AS p (role, code) ON p.role = r.code
 WHERE r.deleted_at IS NULL
ON CONFLICT DO NOTHING;

-- migrate:down
DELETE FROM iam.role_permission rp USING iam.role r
 WHERE rp.role_id = r.id
   AND (r.code, rp.permission_code) IN (('STOREKEEPER', 'ord.fulfilment.read'), ('STOREKEEPER', 'ord.fulfilment.pick'), ('STOREKEEPER', 'ord.order.read'),
                                        ('MANAGER', 'ord.fulfilment.read'), ('MANAGER', 'ord.fulfilment.pick'), ('MANAGER', 'ord.order.update'),
                                        ('OWNER', 'ord.fulfilment.read'), ('OWNER', 'ord.fulfilment.pick'), ('OWNER', 'ord.order.update'));
