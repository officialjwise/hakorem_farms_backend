-- 0135_iam_seed_fin_bank_account_permissions
-- B08 continued 1b2 (ADR-0017, ADR-0057, A-194): the permissions of the business's bank accounts, as
-- contract/openapi.yaml names them. Managing an account (adding one, renaming or deactivating it) needs a fresh step-up
-- every time: an account added is where money can be recorded as leaving from, and the contract marks both writes
-- (x-requires-step-up on createBankAccount and updateBankAccount, CR-007's rule that the marker equals the permission's).
-- Granted to no role here; 0136 grants them.
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
INSERT INTO iam.permission (code, module, description, requires_step_up) VALUES
  ('fin.bank_account.read', 'fin', 'Read the business''s bank accounts and wallets, each number shown as its last four digits', false),
  ('fin.bank_account.manage', 'fin', 'Add a bank account or wallet, rename it or deactivate it', true);

-- migrate:down
DELETE FROM iam.role_permission WHERE permission_code IN ('fin.bank_account.read', 'fin.bank_account.manage');
DELETE FROM iam.permission WHERE code IN ('fin.bank_account.read', 'fin.bank_account.manage');
