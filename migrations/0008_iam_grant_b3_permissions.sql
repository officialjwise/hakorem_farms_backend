-- 0008_iam_grant_b3_permissions
-- Which seeded roles hold the B3 permissions (A-081). Every staff role reads the catalogue and manages its own
-- sessions; Owner and Manager create products and may list and revoke anyone's session. Investor and Customer
-- hold none of these: their access is by ownership in their own realms.
-- Data category: none (lookup rows).

-- migrate:up
INSERT INTO iam.role_permission (role_id, permission_code, created_by)
SELECT r.id, p.code, '01900000-0000-7000-8000-000000000001'
  FROM iam.role r
  JOIN (VALUES
    ('OWNER', 'iam.session.read'), ('OWNER', 'iam.session.read.any'), ('OWNER', 'iam.session.revoke'),
    ('OWNER', 'iam.session.revoke.any'), ('OWNER', 'mdm.product.read'), ('OWNER', 'mdm.product.create'),
    ('MANAGER', 'iam.session.read'), ('MANAGER', 'iam.session.read.any'), ('MANAGER', 'iam.session.revoke'),
    ('MANAGER', 'iam.session.revoke.any'), ('MANAGER', 'mdm.product.read'), ('MANAGER', 'mdm.product.create'),
    ('ACCOUNTANT', 'iam.session.read'), ('ACCOUNTANT', 'iam.session.revoke'), ('ACCOUNTANT', 'mdm.product.read'),
    ('STOREKEEPER', 'iam.session.read'), ('STOREKEEPER', 'iam.session.revoke'), ('STOREKEEPER', 'mdm.product.read'),
    ('CASHIER', 'iam.session.read'), ('CASHIER', 'iam.session.revoke'), ('CASHIER', 'mdm.product.read'),
    ('SALES', 'iam.session.read'), ('SALES', 'iam.session.revoke'), ('SALES', 'mdm.product.read'),
    ('FARM_HAND', 'iam.session.read'), ('FARM_HAND', 'iam.session.revoke'), ('FARM_HAND', 'mdm.product.read'),
    ('DRIVER', 'iam.session.read'), ('DRIVER', 'iam.session.revoke'), ('DRIVER', 'mdm.product.read')
  ) AS g (role_code, permission_code) ON g.role_code = r.code
  JOIN iam.permission p ON p.code = g.permission_code
 WHERE r.deleted_at IS NULL;

-- migrate:down
DELETE FROM iam.role_permission WHERE permission_code IN (
  'iam.session.read', 'iam.session.read.any', 'iam.session.revoke', 'iam.session.revoke.any',
  'mdm.product.read', 'mdm.product.create');
