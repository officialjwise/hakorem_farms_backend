-- 0035_iam_grant_file_store_permissions
-- Grants migration 0034's permissions to the seeded roles (A-124). The Owner, Manager, Accountant and Storekeeper
-- upload (evidence for a write-off, supplier documents, product photographs, import files) and read what they
-- uploaded; the Owner, Manager and Accountant, who check approvals, also read files others uploaded. The Driver,
-- Cashier, Sales, farm hand, customer and investor roles get nothing yet: the session that gives them an upload
-- (proof of delivery in B11, mortality photographs in B6) grants it with the use.
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
INSERT INTO iam.role_permission (role_id, permission_code, created_by, updated_by)
SELECT r.id, p.code, '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001'
  FROM iam.role r
  JOIN iam.permission p ON
       (r.code IN ('OWNER', 'MANAGER', 'ACCOUNTANT', 'STOREKEEPER') AND p.code IN ('platform.file.upload', 'platform.file.read'))
    OR (r.code IN ('OWNER', 'MANAGER', 'ACCOUNTANT') AND p.code = 'platform.file.read.any')
 WHERE r.deleted_at IS NULL;

-- migrate:down
DELETE FROM iam.role_permission WHERE permission_code IN ('platform.file.upload', 'platform.file.read', 'platform.file.read.any');
