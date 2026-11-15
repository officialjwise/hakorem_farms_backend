-- 0092_iam_grant_uom_conversion_permissions
-- The Owner and the Manager manage a product's alternative units (FR-MDM-003's actor), as they manage the rest of the
-- catalogue (0020); no other role does. Every role that reads products reads their conversions (`mdm.product.read`).
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
INSERT INTO iam.role_permission (role_id, permission_code, created_by, updated_by)
SELECT r.id, p.code, '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001'
  FROM iam.role r
  JOIN iam.permission p ON p.code IN ('mdm.uom_conversion.create', 'mdm.uom_conversion.archive')
 WHERE r.deleted_at IS NULL AND r.code IN ('OWNER', 'MANAGER');

-- migrate:down
DELETE FROM iam.role_permission WHERE permission_code IN ('mdm.uom_conversion.create', 'mdm.uom_conversion.archive');
