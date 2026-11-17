-- 0230_iam_grant_pos_permissions
-- Who runs a till (FR-POS-015 to FR-POS-019, A-273 (f)), each the most conservative reading: the Cashier, the Manager
-- and the Owner (who must hold every permission of a role they grant, FR-IAM-022) open a shift, sell, move cash and declare
-- their own count; only the Owner and the Manager sign a count off, and never their own (ck_shift_close_checker); the
-- Owner and the Manager set tills up. The Owner, the Manager, the Accountant
-- and the Cashier read tills, shifts and their reports, a cashier only their own. The Storekeeper, Sales, the Farm
-- hand, the Driver, the Investor and the Customer hold none of them.
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
INSERT INTO iam.role_permission (role_id, permission_code, created_by, updated_by)
SELECT r.id, p.code, '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001'
  FROM iam.role r JOIN (VALUES
    ('OWNER', 'pos.register.read'), ('MANAGER', 'pos.register.read'), ('ACCOUNTANT', 'pos.register.read'), ('CASHIER', 'pos.register.read'),
    ('OWNER', 'pos.register.manage'), ('MANAGER', 'pos.register.manage'),
    ('OWNER', 'pos.shift.read'), ('MANAGER', 'pos.shift.read'), ('ACCOUNTANT', 'pos.shift.read'), ('CASHIER', 'pos.shift.read'),
    ('OWNER', 'pos.shift.report'), ('MANAGER', 'pos.shift.report'), ('ACCOUNTANT', 'pos.shift.report'), ('CASHIER', 'pos.shift.report'),
    ('OWNER', 'pos.shift.open'), ('MANAGER', 'pos.shift.open'), ('CASHIER', 'pos.shift.open'),
    ('OWNER', 'pos.cash.move'), ('MANAGER', 'pos.cash.move'), ('CASHIER', 'pos.cash.move'),
    ('OWNER', 'pos.shift.close'), ('MANAGER', 'pos.shift.close'), ('CASHIER', 'pos.shift.close'),
    ('OWNER', 'pos.sale.create'), ('MANAGER', 'pos.sale.create'), ('CASHIER', 'pos.sale.create'),
    ('OWNER', 'pos.shift.close.approve'), ('MANAGER', 'pos.shift.close.approve')
  ) AS p (role, code) ON p.role = r.code
 WHERE r.deleted_at IS NULL
ON CONFLICT DO NOTHING;

-- migrate:down
DELETE FROM iam.role_permission WHERE permission_code IN ('pos.register.read', 'pos.register.manage', 'pos.shift.read', 'pos.shift.open', 'pos.cash.move',
  'pos.shift.report', 'pos.shift.close', 'pos.shift.close.approve', 'pos.sale.create');
