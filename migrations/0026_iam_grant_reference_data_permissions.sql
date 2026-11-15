-- 0026_iam_grant_reference_data_permissions
-- Grants migration 0025's permissions to the seeded roles (A-115). The Owner and Manager hold all of them. The
-- Storekeeper reads, creates and changes suppliers (FR-MDM-007). The Accountant reads suppliers, payment methods,
-- delivery zones and reason codes. The Cashier and Sales read payment methods, zones and reason codes. The Farm Hand
-- reads reason codes (mortality, cull). The Driver holds none of them yet (delivery failure reasons arrive with B11).
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
INSERT INTO iam.role_permission (role_id, permission_code, created_by)
SELECT r.id, p.code, '01900000-0000-7000-8000-000000000001'
  FROM iam.role r
  JOIN iam.permission p ON
       (r.code IN ('OWNER', 'MANAGER') AND p.code IN (
          'mdm.supplier.read', 'mdm.supplier.create', 'mdm.supplier.update', 'mdm.supplier.archive',
          'mdm.payment_method.read', 'mdm.payment_method.manage',
          'mdm.delivery_zone.read', 'mdm.delivery_zone.create', 'mdm.delivery_zone.update',
          'mdm.reason_code.read', 'mdm.price_list.archive', 'mdm.product.archive'))
    OR (r.code = 'STOREKEEPER' AND p.code IN ('mdm.supplier.read', 'mdm.supplier.create', 'mdm.supplier.update', 'mdm.reason_code.read'))
    OR (r.code = 'ACCOUNTANT' AND p.code IN ('mdm.supplier.read', 'mdm.payment_method.read', 'mdm.delivery_zone.read', 'mdm.reason_code.read'))
    OR (r.code IN ('CASHIER', 'SALES') AND p.code IN ('mdm.payment_method.read', 'mdm.delivery_zone.read', 'mdm.reason_code.read'))
    OR (r.code = 'FARM_HAND' AND p.code = 'mdm.reason_code.read')
 WHERE r.deleted_at IS NULL;

-- migrate:down
DELETE FROM iam.role_permission WHERE permission_code IN (
  'mdm.supplier.read', 'mdm.supplier.create', 'mdm.supplier.update', 'mdm.supplier.archive',
  'mdm.payment_method.read', 'mdm.payment_method.manage',
  'mdm.delivery_zone.read', 'mdm.delivery_zone.create', 'mdm.delivery_zone.update',
  'mdm.reason_code.read', 'mdm.price_list.archive', 'mdm.product.archive');
