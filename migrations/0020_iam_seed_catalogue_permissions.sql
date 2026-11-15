-- 0020_iam_seed_catalogue_permissions
-- The permission codes of the catalogue administration operations (contract x-permission) and their grants to
-- seeded roles (A-105): the Owner and Manager read and write categories, species, grades, weight bands and products;
-- the Accountant, Storekeeper, Cashier, Sales and Farm Hand read them; the Driver holds none of them.
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
INSERT INTO iam.permission (code, module, description, requires_step_up) VALUES
  ('mdm.category.read', 'mdm', 'Read product categories', false),
  ('mdm.category.create', 'mdm', 'Create a product category', false),
  ('mdm.category.update', 'mdm', 'Change a product category', false),
  ('mdm.category.archive', 'mdm', 'Archive a product category that nothing live uses', false),
  ('mdm.species.read', 'mdm', 'Read species', false),
  ('mdm.species.create', 'mdm', 'Create a species', false),
  ('mdm.species.update', 'mdm', 'Rename a species', false),
  ('mdm.grade.read', 'mdm', 'Read grades', false),
  ('mdm.grade.create', 'mdm', 'Create a grade', false),
  ('mdm.grade.update', 'mdm', 'Change a grade', false),
  ('mdm.grade.archive', 'mdm', 'Archive a grade that no live price uses', false),
  ('mdm.weight_band.read', 'mdm', 'Read weight bands', false),
  ('mdm.weight_band.create', 'mdm', 'Create a weight band', false),
  ('mdm.weight_band.update', 'mdm', 'Change the range of a weight band', false),
  ('mdm.weight_band.archive', 'mdm', 'Archive a weight band that no live price uses', false),
  ('mdm.product.update', 'mdm', 'Change a product, including its status', false);

INSERT INTO iam.role_permission (role_id, permission_code, created_by)
SELECT r.id, p.code, '01900000-0000-7000-8000-000000000001'
  FROM iam.role r
  JOIN iam.permission p ON p.code IN (
         'mdm.category.read', 'mdm.category.create', 'mdm.category.update', 'mdm.category.archive',
         'mdm.species.read', 'mdm.species.create', 'mdm.species.update',
         'mdm.grade.read', 'mdm.grade.create', 'mdm.grade.update', 'mdm.grade.archive',
         'mdm.weight_band.read', 'mdm.weight_band.create', 'mdm.weight_band.update', 'mdm.weight_band.archive',
         'mdm.product.update')
 WHERE r.code IN ('OWNER', 'MANAGER') AND r.deleted_at IS NULL;

INSERT INTO iam.role_permission (role_id, permission_code, created_by)
SELECT r.id, p.code, '01900000-0000-7000-8000-000000000001'
  FROM iam.role r
  JOIN iam.permission p ON p.code IN ('mdm.category.read', 'mdm.species.read', 'mdm.grade.read', 'mdm.weight_band.read')
 WHERE r.code IN ('ACCOUNTANT', 'STOREKEEPER', 'CASHIER', 'SALES', 'FARM_HAND') AND r.deleted_at IS NULL;

-- migrate:down
DELETE FROM iam.role_permission WHERE permission_code IN (
  'mdm.category.read', 'mdm.category.create', 'mdm.category.update', 'mdm.category.archive',
  'mdm.species.read', 'mdm.species.create', 'mdm.species.update',
  'mdm.grade.read', 'mdm.grade.create', 'mdm.grade.update', 'mdm.grade.archive',
  'mdm.weight_band.read', 'mdm.weight_band.create', 'mdm.weight_band.update', 'mdm.weight_band.archive',
  'mdm.product.update');
DELETE FROM iam.permission WHERE code IN (
  'mdm.category.read', 'mdm.category.create', 'mdm.category.update', 'mdm.category.archive',
  'mdm.species.read', 'mdm.species.create', 'mdm.species.update',
  'mdm.grade.read', 'mdm.grade.create', 'mdm.grade.update', 'mdm.grade.archive',
  'mdm.weight_band.read', 'mdm.weight_band.create', 'mdm.weight_band.update', 'mdm.weight_band.archive',
  'mdm.product.update');
