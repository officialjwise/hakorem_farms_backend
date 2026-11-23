-- 0301_iam_grant_dispatch_delivery_permissions
-- Who dispatches and who delivers (CR-056 items 1 and 3, A-337): the Manager and the Owner dispatch, read every
-- delivery of their branch and assign it; the Driver reads and records only the deliveries assigned to them (the
-- ownership rule is the application's, FR-DEL-004), records their proof and the cash collected, uploads a proof
-- photograph or a signature and nothing else, and reads the fixed reason codes (a failure's or a short collection's).
-- The Owner holds every permission of the roles they grant (FR-IAM-022), so the Driver's too: the ownership rule still
-- lets the Owner see and record only a delivery assigned to them, and an Owner may be assigned one (A-337).
-- The Storekeeper picks and packs (0296) and does not dispatch: dispatch issues the invoice and fixes the cash due, a
-- Manager's act. Every other role holds none of these.
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
INSERT INTO iam.role_permission (role_id, permission_code, created_by, updated_by)
SELECT r.id, p.code, '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001'
  FROM iam.role r JOIN (VALUES
    ('DRIVER', 'del.delivery.read.assigned'), ('DRIVER', 'del.delivery.update.assigned'), ('DRIVER', 'del.proof.create'),
    ('DRIVER', 'platform.file.upload.proof'), ('DRIVER', 'mdm.reason_code.read'),
    ('MANAGER', 'ord.fulfilment.dispatch'), ('MANAGER', 'del.delivery.read'), ('MANAGER', 'del.delivery.assign'),
    ('OWNER', 'ord.fulfilment.dispatch'), ('OWNER', 'del.delivery.read'), ('OWNER', 'del.delivery.assign'),
    ('OWNER', 'del.delivery.read.assigned'), ('OWNER', 'del.delivery.update.assigned'), ('OWNER', 'del.proof.create'), ('OWNER', 'platform.file.upload.proof')
  ) AS p (role, code) ON p.role = r.code
 WHERE r.deleted_at IS NULL
ON CONFLICT DO NOTHING;

-- migrate:down
DELETE FROM iam.role_permission rp USING iam.role r
 WHERE rp.role_id = r.id
   AND (r.code, rp.permission_code) IN (('DRIVER', 'del.delivery.read.assigned'), ('DRIVER', 'del.delivery.update.assigned'), ('DRIVER', 'del.proof.create'),
                                        ('DRIVER', 'platform.file.upload.proof'), ('DRIVER', 'mdm.reason_code.read'),
                                        ('MANAGER', 'ord.fulfilment.dispatch'), ('MANAGER', 'del.delivery.read'), ('MANAGER', 'del.delivery.assign'),
                                        ('OWNER', 'ord.fulfilment.dispatch'), ('OWNER', 'del.delivery.read'), ('OWNER', 'del.delivery.assign'),
                                        ('OWNER', 'del.delivery.read.assigned'), ('OWNER', 'del.delivery.update.assigned'), ('OWNER', 'del.proof.create'),
                                        ('OWNER', 'platform.file.upload.proof'));
