-- 0018_iam_seed_promotion_permissions
-- The permission codes of the promotion operations (contract x-permission), their grants to seeded roles (A-099),
-- and the approval policy for PROMOTION_ACTIVATION (ADR-0017, FR-MDM-018): a Manager or the Owner drafts (maker), a
-- different Manager or the Owner approves (checker), with step-up. iam.approval_request keeps maker and checker
-- apart.
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`); refused by foreign keys once an approval request of this kind exists,
-- after which the forward fix is a migration that soft-deletes the policy.

-- migrate:up
INSERT INTO iam.permission (code, module, description, requires_step_up) VALUES
  ('mdm.promotion.read', 'mdm', 'Read promotions and their coupons', false),
  ('mdm.promotion.create', 'mdm', 'Create a promotion as a draft', false),
  ('mdm.promotion.update', 'mdm', 'Change a draft promotion, submit it, end it and create its coupons', false),
  ('mdm.promotion.approve', 'mdm', 'Approve or reject a submitted promotion (checker)', true);

INSERT INTO iam.role_permission (role_id, permission_code, created_by)
SELECT r.id, p.code, '01900000-0000-7000-8000-000000000001'
  FROM iam.role r
  JOIN (VALUES
    ('OWNER', 'mdm.promotion.read'), ('OWNER', 'mdm.promotion.create'), ('OWNER', 'mdm.promotion.update'), ('OWNER', 'mdm.promotion.approve'),
    ('MANAGER', 'mdm.promotion.read'), ('MANAGER', 'mdm.promotion.create'), ('MANAGER', 'mdm.promotion.update'), ('MANAGER', 'mdm.promotion.approve'),
    ('ACCOUNTANT', 'mdm.promotion.read'),
    ('SALES', 'mdm.promotion.read')
  ) AS g (role_code, permission_code) ON g.role_code = r.code
  JOIN iam.permission p ON p.code = g.permission_code
 WHERE r.deleted_at IS NULL;

INSERT INTO iam.approval_policy (id, kind, branch_id, threshold_pesewas, approver_permission, requires_evidence, requires_step_up, created_by, updated_by)
VALUES ('01900000-0000-7000-8000-000000000403', 'PROMOTION_ACTIVATION', NULL, NULL, 'mdm.promotion.approve', false, true,
        '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001');

-- migrate:down
DELETE FROM iam.approval_policy WHERE id = '01900000-0000-7000-8000-000000000403';
DELETE FROM iam.role_permission WHERE permission_code IN ('mdm.promotion.read', 'mdm.promotion.create', 'mdm.promotion.update', 'mdm.promotion.approve');
DELETE FROM iam.permission WHERE code IN ('mdm.promotion.read', 'mdm.promotion.create', 'mdm.promotion.update', 'mdm.promotion.approve');
