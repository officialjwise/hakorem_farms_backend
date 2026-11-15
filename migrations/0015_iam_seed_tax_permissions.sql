-- 0015_iam_seed_tax_permissions
-- The permission codes of the tax operations (contract x-permission), their grants to seeded roles (A-095), and the
-- approval policy for TAX_SCHEME_ACTIVATION (ADR-0017, ADR-0020): the Accountant drafts (maker), the Owner approves
-- (checker), and changing tax configuration always needs step-up. iam.approval_request keeps maker and checker
-- apart.
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`); refused by foreign keys once an approval request of this kind exists,
-- after which the forward fix is a migration that soft-deletes the policy.

-- migrate:up
INSERT INTO iam.permission (code, module, description, requires_step_up) VALUES
  ('mdm.tax.read', 'mdm', 'Read tax levies, tax categories and tax scheme versions', false),
  ('mdm.tax.calculate', 'mdm', 'Calculate the levies on lines with the scheme in force', false),
  ('mdm.tax.manage', 'mdm', 'Create levies and tax categories, draft a tax scheme version and submit it', true),
  ('mdm.tax.approve', 'mdm', 'Approve or reject a submitted tax scheme version (checker)', true);

INSERT INTO iam.role_permission (role_id, permission_code, created_by)
SELECT r.id, p.code, '01900000-0000-7000-8000-000000000001'
  FROM iam.role r
  JOIN (VALUES
    ('OWNER', 'mdm.tax.read'), ('OWNER', 'mdm.tax.calculate'), ('OWNER', 'mdm.tax.manage'), ('OWNER', 'mdm.tax.approve'),
    ('ACCOUNTANT', 'mdm.tax.read'), ('ACCOUNTANT', 'mdm.tax.calculate'), ('ACCOUNTANT', 'mdm.tax.manage'),
    ('MANAGER', 'mdm.tax.read'), ('MANAGER', 'mdm.tax.calculate'),
    ('SALES', 'mdm.tax.read'), ('SALES', 'mdm.tax.calculate'),
    ('CASHIER', 'mdm.tax.calculate')
  ) AS g (role_code, permission_code) ON g.role_code = r.code
  JOIN iam.permission p ON p.code = g.permission_code
 WHERE r.deleted_at IS NULL;

INSERT INTO iam.approval_policy (id, kind, branch_id, threshold_pesewas, approver_permission, requires_evidence, requires_step_up, created_by, updated_by)
VALUES ('01900000-0000-7000-8000-000000000402', 'TAX_SCHEME_ACTIVATION', NULL, NULL, 'mdm.tax.approve', false, true,
        '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001');

-- migrate:down
DELETE FROM iam.approval_policy WHERE id = '01900000-0000-7000-8000-000000000402';
DELETE FROM iam.role_permission WHERE permission_code IN ('mdm.tax.read', 'mdm.tax.calculate', 'mdm.tax.manage', 'mdm.tax.approve');
DELETE FROM iam.permission WHERE code IN ('mdm.tax.read', 'mdm.tax.calculate', 'mdm.tax.manage', 'mdm.tax.approve');
