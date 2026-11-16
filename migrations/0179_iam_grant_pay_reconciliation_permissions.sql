-- 0179_iam_grant_pay_reconciliation_permissions
-- Who reconciles (FR-PAY-016, FR-PAY-017, A-214): the Owner, the Manager and the Accountant read settlement reports,
-- statements and breaks; the Owner and the Accountant import and match them and ask for a break's resolution; the
-- Owner and the Manager approve it (never its maker, ADR-0017), so the Accountant asks and the Owner approves, or the
-- Owner asks and the Manager approves. A Cashier, Sales, the Storekeeper and the Driver hold none of them.
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
INSERT INTO iam.role_permission (role_id, permission_code, created_by, updated_by)
SELECT r.id, p.code, '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001'
  FROM iam.role r JOIN (VALUES
    ('OWNER', 'pay.reconciliation.read'), ('MANAGER', 'pay.reconciliation.read'), ('ACCOUNTANT', 'pay.reconciliation.read'),
    ('OWNER', 'pay.reconciliation.manage'), ('ACCOUNTANT', 'pay.reconciliation.manage'),
    ('OWNER', 'pay.reconciliation.approve'), ('MANAGER', 'pay.reconciliation.approve')
  ) AS p (role, code) ON p.role = r.code
 WHERE r.deleted_at IS NULL
ON CONFLICT DO NOTHING;

-- migrate:down
DELETE FROM iam.role_permission WHERE permission_code IN ('pay.reconciliation.read', 'pay.reconciliation.manage', 'pay.reconciliation.approve');
