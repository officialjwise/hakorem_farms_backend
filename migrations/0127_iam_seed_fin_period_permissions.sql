-- 0127_iam_seed_fin_period_permissions
-- B08 continued (FR-FIN-002, FR-FIN-009, FR-FIN-010, A-188): the permissions of FIN's chart of accounts and accounting
-- periods, as contract/openapi.yaml names them, and the PERIOD_REOPEN approval: a locked period is reopened only when
-- the Owner asks with a reason and a different person holding the new fin.period.reopen_approve approves it, whatever
-- the amount, with a fresh step-up (ADR-0017). Closing and reopening are final or near it, so both need step-up.
-- Granted to no role here; 0128 grants them.
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
INSERT INTO iam.permission (code, module, description, requires_step_up) VALUES
  ('fin.account.read', 'fin', 'Read the chart of accounts', false),
  ('fin.account.manage', 'fin', 'Add an account to the chart, rename it, or close or reopen it', false),
  ('fin.period.read', 'fin', 'Read the accounting periods and their status', false),
  ('fin.period.lock', 'fin', 'Lock an open accounting period against posting', false),
  ('fin.period.close', 'fin', 'Close a locked accounting period permanently', true),
  ('fin.period.reopen', 'fin', 'Ask to reopen a locked accounting period, with a reason', true),
  ('fin.period.reopen_approve', 'fin', 'Approve the reopening of a locked accounting period asked for by someone else', true);

INSERT INTO iam.approval_policy (id, kind, branch_id, threshold_pesewas, approver_permission, requires_evidence, requires_step_up, created_by, updated_by) VALUES
  ('01900000-0000-7000-8000-000000000414', 'PERIOD_REOPEN', NULL, NULL, 'fin.period.reopen_approve', false, true,
   '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001');

-- migrate:down
DELETE FROM iam.approval_policy WHERE id = '01900000-0000-7000-8000-000000000414';
DELETE FROM iam.role_permission WHERE permission_code IN ('fin.account.read', 'fin.account.manage', 'fin.period.read', 'fin.period.lock', 'fin.period.close', 'fin.period.reopen', 'fin.period.reopen_approve');
DELETE FROM iam.permission WHERE code IN ('fin.account.read', 'fin.account.manage', 'fin.period.read', 'fin.period.lock', 'fin.period.close', 'fin.period.reopen', 'fin.period.reopen_approve');
