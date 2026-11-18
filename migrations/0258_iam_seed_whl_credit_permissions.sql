-- 0258_iam_seed_whl_credit_permissions
-- B10 continued (FR-WHL-001, FR-WHL-006 to FR-WHL-008, CR-046, CR-048, ADR-0017, ADR-0035, abuse case 14): the
-- permissions of the business account and credit control operations, as contract/openapi.yaml names them, and three
-- approvals, each whatever its amount and each decided by someone other than the person who asked, with a fresh
-- step-up: CREDIT_OVERRIDE (an order over the limit, past the terms or on hold, whl.credit.override), ACCOUNT_RELEASE
-- (a hold released, whl.account.release) and CREDIT_LIMIT_CHANGE (every change to a credit limit, up or down,
-- whl.account.manage). Releasing a hold takes its own permission, so whoever may put a hold on may not take it off
-- (CR-048). Granted to no role here; 0259 grants them. The thresholds are data.
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
INSERT INTO iam.permission (code, module, description, requires_step_up) VALUES
  ('whl.account.read', 'whl', 'Read business accounts with their limit, terms, exposure and overdue figures, and the credit overrides', false),
  ('whl.account.manage', 'whl', 'Open a business account, change its terms, ask for a new credit limit and approve one someone else asked for', false),
  ('whl.account.hold', 'whl', 'Put a business account on hold with a reason', false),
  ('whl.account.release', 'whl', 'Ask for a business account to be released from hold, and approve a release someone else asked for', false),
  ('whl.credit.override', 'whl', 'Approve a credit override someone else asked for: an order over the limit, past the terms or on hold', true);

INSERT INTO iam.approval_policy (id, kind, branch_id, threshold_pesewas, approver_permission, requires_evidence, requires_step_up, created_by, updated_by) VALUES
  ('01900000-0000-7000-8000-000000000641', 'CREDIT_OVERRIDE', NULL, 0, 'whl.credit.override', false, true,
   '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001'),
  ('01900000-0000-7000-8000-000000000642', 'ACCOUNT_RELEASE', NULL, 0, 'whl.account.release', false, true,
   '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001'),
  ('01900000-0000-7000-8000-000000000643', 'CREDIT_LIMIT_CHANGE', NULL, 0, 'whl.account.manage', false, true,
   '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001');

-- migrate:down
DELETE FROM iam.approval_policy WHERE id IN ('01900000-0000-7000-8000-000000000641', '01900000-0000-7000-8000-000000000642', '01900000-0000-7000-8000-000000000643');
DELETE FROM iam.role_permission WHERE permission_code IN ('whl.account.read', 'whl.account.manage', 'whl.account.hold', 'whl.account.release', 'whl.credit.override');
DELETE FROM iam.permission WHERE code IN ('whl.account.read', 'whl.account.manage', 'whl.account.hold', 'whl.account.release', 'whl.credit.override');
