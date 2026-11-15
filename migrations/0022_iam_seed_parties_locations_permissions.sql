-- 0022_iam_seed_parties_locations_permissions
-- The permission codes of the branch, location, customer and customer price list operations (contract
-- x-permission; FR-MDM-006, FR-MDM-008, FR-MDM-021). Granted to no role here: migration 0023 grants them (A-109).
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
INSERT INTO iam.permission (code, module, description, requires_step_up) VALUES
  ('mdm.branch.read', 'mdm', 'Read branches', false),
  ('mdm.branch.create', 'mdm', 'Create a branch, with its virtual locations', false),
  ('mdm.branch.update', 'mdm', 'Change or close a branch', false),
  ('mdm.location.read', 'mdm', 'Read stock locations', false),
  ('mdm.location.create', 'mdm', 'Create a physical stock location', false),
  ('mdm.location.update', 'mdm', 'Change a physical stock location', false),
  ('mdm.location.archive', 'mdm', 'Archive a physical stock location that nothing live sits below', false),
  ('mdm.customer.read', 'mdm', 'Read customers, their tiers and addresses', false),
  ('mdm.customer.create', 'mdm', 'Create a customer or a customer tier', false),
  ('mdm.customer.update', 'mdm', 'Change a customer and their addresses', false),
  ('mdm.customer.archive', 'mdm', 'Archive a customer', false),
  ('mdm.price_list.assign', 'mdm', 'Assign a contract price list to a customer', false);

-- migrate:down
DELETE FROM iam.permission WHERE code IN (
  'mdm.branch.read', 'mdm.branch.create', 'mdm.branch.update',
  'mdm.location.read', 'mdm.location.create', 'mdm.location.update', 'mdm.location.archive',
  'mdm.customer.read', 'mdm.customer.create', 'mdm.customer.update', 'mdm.customer.archive',
  'mdm.price_list.assign');
