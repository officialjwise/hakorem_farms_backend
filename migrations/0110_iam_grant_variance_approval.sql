-- 0110_iam_grant_variance_approval
-- Who approves a supplier invoice's variance (A-172): the Owner and the Manager, who already approve supplier payments
-- (A-164(i)). The Accountant, who enters invoices and asks for a variance, does not. The approver is never the person
-- who asked nor the person who entered the invoice (domain and database, 0107).
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
INSERT INTO iam.role_permission (role_id, permission_code, created_by, updated_by)
SELECT r.id, 'pur.supplier_invoice.variance_approve', '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001'
  FROM iam.role r
 WHERE r.deleted_at IS NULL AND r.code IN ('OWNER', 'MANAGER')
ON CONFLICT DO NOTHING;

-- migrate:down
DELETE FROM iam.role_permission rp USING iam.role r
 WHERE rp.role_id = r.id AND r.code IN ('OWNER', 'MANAGER') AND rp.permission_code = 'pur.supplier_invoice.variance_approve';
