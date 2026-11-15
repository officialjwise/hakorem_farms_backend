-- 0023_iam_grant_parties_locations_permissions
-- Grants migration 0022's permissions to the seeded roles (A-109): the Owner and Manager hold all of them. Sales
-- reads branches and locations and reads, creates and changes customers and assigns their contract lists
-- (FR-MDM-008, FR-MDM-021). The Accountant and Cashier read branches, locations and customers; the Storekeeper and
-- Farm Hand read branches and locations. The Driver holds none of them.
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
INSERT INTO iam.role_permission (role_id, permission_code, created_by)
SELECT r.id, p.code, '01900000-0000-7000-8000-000000000001'
  FROM iam.role r
  JOIN iam.permission p ON
       (r.code IN ('OWNER', 'MANAGER') AND p.code IN (
          'mdm.branch.read', 'mdm.branch.create', 'mdm.branch.update',
          'mdm.location.read', 'mdm.location.create', 'mdm.location.update', 'mdm.location.archive',
          'mdm.customer.read', 'mdm.customer.create', 'mdm.customer.update', 'mdm.customer.archive',
          'mdm.price_list.assign'))
    OR (r.code = 'SALES' AND p.code IN ('mdm.branch.read', 'mdm.location.read', 'mdm.customer.read', 'mdm.customer.create', 'mdm.customer.update', 'mdm.price_list.assign'))
    OR (r.code IN ('ACCOUNTANT', 'CASHIER') AND p.code IN ('mdm.branch.read', 'mdm.location.read', 'mdm.customer.read'))
    OR (r.code IN ('STOREKEEPER', 'FARM_HAND') AND p.code IN ('mdm.branch.read', 'mdm.location.read'))
 WHERE r.deleted_at IS NULL;

-- migrate:down
DELETE FROM iam.role_permission WHERE permission_code IN (
  'mdm.branch.read', 'mdm.branch.create', 'mdm.branch.update',
  'mdm.location.read', 'mdm.location.create', 'mdm.location.update', 'mdm.location.archive',
  'mdm.customer.read', 'mdm.customer.create', 'mdm.customer.update', 'mdm.customer.archive',
  'mdm.price_list.assign');
