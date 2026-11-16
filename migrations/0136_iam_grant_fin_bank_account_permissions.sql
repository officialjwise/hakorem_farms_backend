-- 0136_iam_grant_fin_bank_account_permissions
-- Who reads and keeps the business's bank accounts (DC-15, DC-40, A-194): the Owner and the Accountant, who also prepare
-- supplier payments (A-164) and so name the account a payment leaves from. No other role is granted anything of FIN.
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
INSERT INTO iam.role_permission (role_id, permission_code, created_by, updated_by)
SELECT r.id, p.code, '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001'
  FROM iam.role r
  CROSS JOIN (VALUES ('fin.bank_account.read'), ('fin.bank_account.manage')) AS p (code)
 WHERE r.code IN ('OWNER', 'ACCOUNTANT') AND r.deleted_at IS NULL
ON CONFLICT DO NOTHING;

-- migrate:down
DELETE FROM iam.role_permission rp USING iam.role r
 WHERE rp.role_id = r.id AND r.code IN ('OWNER', 'ACCOUNTANT')
   AND rp.permission_code IN ('fin.bank_account.read', 'fin.bank_account.manage');
