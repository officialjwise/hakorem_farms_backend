-- 0355_iam_seed_cap_permissions
-- B12 (FR-CAP-001 to FR-CAP-012, ADR-0017, ADR-0028, contract x-permission): the permissions of the investor register,
-- capital and distributions, granted to no role here (0356 grants them). Six need a fresh step-up: as the contract
-- planned them, changing the register (cap.investor.manage), recording capital (cap.capital.record) and posting a run
-- (cap.distribution.post); recording a payment to an investor (cap.distribution.pay, A-381: money leaving the farm,
-- abuse case 68); and the checker's two, approving a capital withdrawal (cap.capital.approve) and approving a
-- distribution run (cap.distribution.approve).
-- The approval policies (ADR-0017): every withdrawal, whatever its amount, needs a different person holding
-- cap.capital.approve (CAPITAL_WITHDRAWAL); every distribution run needs a different person holding
-- cap.distribution.approve (INVESTOR_DISTRIBUTION); both with a step-up within five minutes (FR-CAP-010).
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
INSERT INTO iam.permission (code, module, description, requires_step_up) VALUES
  ('cap.investor.read', 'cap', 'Read the investor register: investors, their units and shares (confidential)', false),
  ('cap.investor.manage', 'cap', 'Register an investor and change their contact details or status', true),
  ('cap.capital.read', 'cap', 'Read capital contributions and withdrawals and the capital register as at a date', false),
  ('cap.capital.record', 'cap', 'Record a capital contribution, and ask for a capital withdrawal', true),
  ('cap.capital.approve', 'cap', 'Approve a capital withdrawal asked for by someone else', true),
  ('cap.distribution.read', 'cap', 'Read profit distribution runs, their lines and schedules', false),
  ('cap.distribution.create', 'cap', 'Draft, recompute and submit a profit distribution run', false),
  ('cap.distribution.approve', 'cap', 'Approve a profit distribution run drafted by someone else', true),
  ('cap.distribution.post', 'cap', 'Post an approved distribution run to the ledger', true),
  ('cap.distribution.pay', 'cap', 'Record a payment to an investor against a posted distribution', true);

INSERT INTO iam.approval_policy (id, kind, branch_id, threshold_pesewas, approver_permission, requires_evidence, requires_step_up, created_by, updated_by) VALUES
  ('01900000-0000-7000-8000-000000000661', 'CAPITAL_WITHDRAWAL', NULL, 0, 'cap.capital.approve', false, true,
   '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001'),
  ('01900000-0000-7000-8000-000000000662', 'INVESTOR_DISTRIBUTION', NULL, 0, 'cap.distribution.approve', false, true,
   '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001');

-- migrate:down
DELETE FROM iam.approval_policy WHERE id IN ('01900000-0000-7000-8000-000000000661', '01900000-0000-7000-8000-000000000662');
DELETE FROM iam.role_permission WHERE permission_code IN ('cap.investor.read', 'cap.investor.manage', 'cap.capital.read', 'cap.capital.record', 'cap.capital.approve',
  'cap.distribution.read', 'cap.distribution.create', 'cap.distribution.approve', 'cap.distribution.post', 'cap.distribution.pay');
DELETE FROM iam.permission WHERE code IN ('cap.investor.read', 'cap.investor.manage', 'cap.capital.read', 'cap.capital.record', 'cap.capital.approve',
  'cap.distribution.read', 'cap.distribution.create', 'cap.distribution.approve', 'cap.distribution.post', 'cap.distribution.pay');
