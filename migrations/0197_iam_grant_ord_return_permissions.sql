-- 0197_iam_grant_ord_return_permissions
-- Who takes a return and who approves it (FR-ORD-015, ADR-0066, abuse case 12, A-228), each the most conservative
-- reading: a return is made by those who sell (FR-ORD-015's actors, the Cashier and Sales, with the Owner and the
-- Manager), read by those who read orders (adding the Accountant), and approved only by a supervisor (the Owner, the
-- Manager) who did not make it (held by IAM and by the database). The Accountant corrects money through credit notes,
-- never by taking goods back. Nobody else holds any of them.
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
INSERT INTO iam.role_permission (role_id, permission_code, created_by, updated_by)
SELECT r.id, p.code, '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001'
  FROM iam.role r JOIN (VALUES
    ('OWNER', 'ord.return.read'), ('MANAGER', 'ord.return.read'), ('ACCOUNTANT', 'ord.return.read'), ('SALES', 'ord.return.read'), ('CASHIER', 'ord.return.read'),
    ('OWNER', 'ord.return.create'), ('MANAGER', 'ord.return.create'), ('SALES', 'ord.return.create'), ('CASHIER', 'ord.return.create'),
    ('OWNER', 'ord.return.approve'), ('MANAGER', 'ord.return.approve')
  ) AS p (role, code) ON p.role = r.code
 WHERE r.deleted_at IS NULL
ON CONFLICT DO NOTHING;

-- migrate:down
DELETE FROM iam.role_permission WHERE permission_code IN ('ord.return.read', 'ord.return.create', 'ord.return.approve');
