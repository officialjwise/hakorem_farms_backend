-- 0012_iam_seed_b4_pricing_permissions
-- The permission codes of the B4 pricing operations (contract x-permission), their grants to seeded roles (A-089),
-- and the approval policy for PRICE_LIST_ACTIVATION (ADR-0017): the checker holds mdm.price_list.approve, which
-- requires step-up, and is never the maker (iam.approval_request enforces that).
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`); refused by foreign keys once an approval request of this kind exists,
-- after which the forward fix is a migration that soft-deletes the policy.

-- migrate:up
INSERT INTO iam.permission (code, module, description, requires_step_up) VALUES
  ('mdm.price.resolve', 'mdm', 'Resolve the price of a line through the pricing engine', false),
  ('mdm.price_list.read', 'mdm', 'Read price lists, their versions and entries', false),
  ('mdm.price_list.create', 'mdm', 'Create a price list', false),
  ('mdm.price_list.update', 'mdm', 'Draft a price list version, replace its entries and submit it for approval', false),
  ('mdm.price_list.approve', 'mdm', 'Approve or reject a submitted price list version (checker)', true);

INSERT INTO iam.role_permission (role_id, permission_code, created_by)
SELECT r.id, p.code, '01900000-0000-7000-8000-000000000001'
  FROM iam.role r
  JOIN (VALUES
    ('OWNER', 'mdm.price.resolve'), ('OWNER', 'mdm.price_list.read'), ('OWNER', 'mdm.price_list.create'),
    ('OWNER', 'mdm.price_list.update'), ('OWNER', 'mdm.price_list.approve'),
    ('MANAGER', 'mdm.price.resolve'), ('MANAGER', 'mdm.price_list.read'), ('MANAGER', 'mdm.price_list.create'),
    ('MANAGER', 'mdm.price_list.update'), ('MANAGER', 'mdm.price_list.approve'),
    ('ACCOUNTANT', 'mdm.price.resolve'), ('ACCOUNTANT', 'mdm.price_list.read'),
    ('SALES', 'mdm.price.resolve'), ('SALES', 'mdm.price_list.read'),
    ('CASHIER', 'mdm.price.resolve')
  ) AS g (role_code, permission_code) ON g.role_code = r.code
  JOIN iam.permission p ON p.code = g.permission_code
 WHERE r.deleted_at IS NULL;

INSERT INTO iam.approval_policy (id, kind, branch_id, threshold_pesewas, approver_permission, requires_evidence, requires_step_up, created_by, updated_by)
VALUES ('01900000-0000-7000-8000-000000000401', 'PRICE_LIST_ACTIVATION', NULL, NULL, 'mdm.price_list.approve', false, true,
        '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001');

-- migrate:down
DELETE FROM iam.approval_policy WHERE id = '01900000-0000-7000-8000-000000000401';
DELETE FROM iam.role_permission WHERE permission_code IN (
  'mdm.price.resolve', 'mdm.price_list.read', 'mdm.price_list.create', 'mdm.price_list.update', 'mdm.price_list.approve');
DELETE FROM iam.permission WHERE code IN (
  'mdm.price.resolve', 'mdm.price_list.read', 'mdm.price_list.create', 'mdm.price_list.update', 'mdm.price_list.approve');
