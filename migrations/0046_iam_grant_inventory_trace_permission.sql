-- 0046_iam_grant_inventory_trace_permission
-- Grants inv.trace.read to the Owner, the Manager and the Accountant, the actors of FR-INV-006 (UC-03). Every other
-- role holds none (A-133).
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
INSERT INTO iam.role_permission (role_id, permission_code, created_by, updated_by)
SELECT r.id, 'inv.trace.read', '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001'
  FROM iam.role r
 WHERE r.code IN ('OWNER', 'MANAGER', 'ACCOUNTANT') AND r.deleted_at IS NULL;

-- migrate:down
DELETE FROM iam.role_permission WHERE permission_code = 'inv.trace.read';
