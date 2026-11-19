-- 0277_iam_grant_whl_standing_order_bad_debt_permissions
-- B10 continued 3 (FR-WHL-004, FR-WHL-012, A-320, A-321): who keeps standing orders and who writes off bad debt.
-- Standing orders: Sales (FR-WHL-004's actor), the Manager and the Owner manage them; the Accountant reads them.
-- Bad debt: the Accountant asks (FR-WHL-012's maker), the Owner approves (its checker). The Owner also holds the
-- asking permission, because an Owner may grant only a role whose permissions it holds itself (IAM's granting rule);
-- an Owner who asks is checked by another Owner, never by itself (in IAM, in WHL and in the database, A-321 (b)).
-- Data category: none (grants).
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
INSERT INTO iam.role_permission (role_id, permission_code, created_by, updated_by)
SELECT r.id, p.code, '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001'
  FROM iam.role r JOIN (VALUES
    ('OWNER', 'whl.standing_order.read'), ('MANAGER', 'whl.standing_order.read'), ('SALES', 'whl.standing_order.read'), ('ACCOUNTANT', 'whl.standing_order.read'),
    ('OWNER', 'whl.standing_order.manage'), ('MANAGER', 'whl.standing_order.manage'), ('SALES', 'whl.standing_order.manage'),
    ('ACCOUNTANT', 'whl.bad_debt.write_off'), ('OWNER', 'whl.bad_debt.write_off'),
    ('OWNER', 'whl.bad_debt.approve')
  ) AS p (role, code) ON p.role = r.code
 WHERE r.deleted_at IS NULL
ON CONFLICT DO NOTHING;

-- migrate:down
DELETE FROM iam.role_permission WHERE permission_code IN ('whl.standing_order.read', 'whl.standing_order.manage', 'whl.bad_debt.write_off', 'whl.bad_debt.approve');
