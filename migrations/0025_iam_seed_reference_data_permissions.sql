-- 0025_iam_seed_reference_data_permissions
-- The permission codes of the supplier, payment method, delivery zone and reason code operations, and of archiving a
-- price list or a product (contract x-permission; FR-MDM-007, FR-MDM-009, FR-MDM-010, FR-MDM-011, FR-MDM-015,
-- FR-MDM-001). Granted to no role here: migration 0026 grants them (A-115). There is no reason code write permission:
-- the list changes only by migration (FR-MDM-011).
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
INSERT INTO iam.permission (code, module, description, requires_step_up) VALUES
  ('mdm.supplier.read', 'mdm', 'Read suppliers', false),
  ('mdm.supplier.create', 'mdm', 'Create a supplier', false),
  ('mdm.supplier.update', 'mdm', 'Change or block a supplier', false),
  ('mdm.supplier.archive', 'mdm', 'Archive a supplier', false),
  ('mdm.payment_method.read', 'mdm', 'Read payment methods', false),
  ('mdm.payment_method.manage', 'mdm', 'Enable, disable or change a payment method', false),
  ('mdm.delivery_zone.read', 'mdm', 'Read delivery zones', false),
  ('mdm.delivery_zone.create', 'mdm', 'Create a delivery zone', false),
  ('mdm.delivery_zone.update', 'mdm', 'Change a delivery zone and its fee', false),
  ('mdm.reason_code.read', 'mdm', 'Read the fixed list of reason codes', false),
  ('mdm.price_list.archive', 'mdm', 'Archive a price list that prices nothing now or later', false),
  ('mdm.product.archive', 'mdm', 'Archive a product that no live price uses', false);

-- migrate:down
DELETE FROM iam.permission WHERE code IN (
  'mdm.supplier.read', 'mdm.supplier.create', 'mdm.supplier.update', 'mdm.supplier.archive',
  'mdm.payment_method.read', 'mdm.payment_method.manage',
  'mdm.delivery_zone.read', 'mdm.delivery_zone.create', 'mdm.delivery_zone.update',
  'mdm.reason_code.read', 'mdm.price_list.archive', 'mdm.product.archive');
