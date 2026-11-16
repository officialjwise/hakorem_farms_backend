-- 0150_iam_grant_bil_permissions
-- Who reads and corrects billing documents (FR-BIL-007, A-200): every selling and finance role reads them (Owner,
-- Manager, Accountant, Sales, Cashier); the Accountant and the Owner raise credit notes and issue debit notes; a credit
-- note is approved by the Owner or the Manager, never by the person who raised it (ADR-0017).
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
INSERT INTO iam.role_permission (role_id, permission_code, created_by, updated_by)
SELECT r.id, p.code, '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001'
  FROM iam.role r JOIN (VALUES
    ('OWNER', 'bil.document.read'), ('MANAGER', 'bil.document.read'), ('ACCOUNTANT', 'bil.document.read'), ('SALES', 'bil.document.read'), ('CASHIER', 'bil.document.read'),
    ('OWNER', 'bil.credit_note.create'), ('ACCOUNTANT', 'bil.credit_note.create'),
    ('OWNER', 'bil.credit_note.approve'), ('MANAGER', 'bil.credit_note.approve'),
    ('OWNER', 'bil.debit_note.create'), ('ACCOUNTANT', 'bil.debit_note.create')
  ) AS p (role, code) ON p.role = r.code
 WHERE r.deleted_at IS NULL
ON CONFLICT DO NOTHING;

-- migrate:down
DELETE FROM iam.role_permission WHERE permission_code IN ('bil.document.read', 'bil.credit_note.create', 'bil.credit_note.approve', 'bil.debit_note.create');
