-- 0356_iam_grant_cap_permissions
-- B12 (FR-CAP-001 to FR-CAP-012, ADR-0017, UAT scenario 4): who keeps the investor books and who checks them. The
-- Accountant registers investors, records contributions, asks for withdrawals, drafts, submits, posts and pays
-- distributions; the Owner holds all of that too (a granter holds every permission of a role they grant, IAM's rule) and
-- is the only checker of withdrawals and distributions. Whoever made a withdrawal or a run never approves it: IAM, the
-- application and the database refuse it (ADR-0017). Investor data is confidential: no other staff role reads it, the
-- Manager included (A-381). The investor portal is B12 continued's.
-- Data category: none (grants).
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
INSERT INTO iam.role_permission (role_id, permission_code, created_by, updated_by)
SELECT r.id, p.code, '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001'
  FROM iam.role r JOIN (VALUES
    ('OWNER', 'cap.investor.read'), ('OWNER', 'cap.investor.manage'), ('OWNER', 'cap.capital.read'), ('OWNER', 'cap.capital.record'),
    ('OWNER', 'cap.distribution.read'), ('OWNER', 'cap.distribution.create'), ('OWNER', 'cap.distribution.post'), ('OWNER', 'cap.distribution.pay'),
    ('OWNER', 'cap.capital.approve'), ('OWNER', 'cap.distribution.approve'),
    ('ACCOUNTANT', 'cap.investor.read'), ('ACCOUNTANT', 'cap.investor.manage'),
    ('ACCOUNTANT', 'cap.capital.read'), ('ACCOUNTANT', 'cap.capital.record'),
    ('ACCOUNTANT', 'cap.distribution.read'), ('ACCOUNTANT', 'cap.distribution.create'), ('ACCOUNTANT', 'cap.distribution.post'), ('ACCOUNTANT', 'cap.distribution.pay')
  ) AS p (role, code) ON p.role = r.code
 WHERE r.deleted_at IS NULL
ON CONFLICT DO NOTHING;

-- migrate:down
DELETE FROM iam.role_permission WHERE permission_code IN ('cap.investor.read', 'cap.investor.manage', 'cap.capital.read', 'cap.capital.record', 'cap.capital.approve',
  'cap.distribution.read', 'cap.distribution.create', 'cap.distribution.approve', 'cap.distribution.post', 'cap.distribution.pay');
