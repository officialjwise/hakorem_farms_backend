-- 0041_iam_grant_import_export_permissions
-- Grants migration 0040's permissions to the seeded roles (A-128): the Owner and Manager import (create, apply, read)
-- and export; the Accountant exports and reads the job list, which shows exports too. Every other role holds none.
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
INSERT INTO iam.role_permission (role_id, permission_code, created_by, updated_by)
SELECT r.id, p.code, '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001'
  FROM iam.role r
  JOIN iam.permission p ON
       (r.code IN ('OWNER', 'MANAGER') AND p.code IN ('mdm.import.read', 'mdm.import.create', 'mdm.import.apply', 'mdm.export.create'))
    OR (r.code = 'ACCOUNTANT' AND p.code IN ('mdm.import.read', 'mdm.export.create'))
 WHERE r.deleted_at IS NULL;

-- migrate:down
DELETE FROM iam.role_permission WHERE permission_code IN ('mdm.import.read', 'mdm.import.create', 'mdm.import.apply', 'mdm.export.create');
