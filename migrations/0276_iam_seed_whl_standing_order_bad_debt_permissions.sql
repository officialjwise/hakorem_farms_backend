-- 0276_iam_seed_whl_standing_order_bad_debt_permissions
-- B10 continued 3 (FR-WHL-004, FR-WHL-012, ADR-0017, ADR-0035): the permissions of the standing order and bad-debt
-- operations as contract/openapi.yaml names them, and the BAD_DEBT_WRITE_OFF approval: whatever its amount, decided by
-- a holder of whl.bad_debt.approve other than the person who asked, with a fresh step-up. Asking and approving are
-- separate permissions, so the maker (the Accountant) can never be the checker (the Owner) by grant either. Granted to
-- no role here; 0277 grants them.
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
INSERT INTO iam.permission (code, module, description, requires_step_up) VALUES
  ('whl.standing_order.read', 'whl', 'Read standing orders and their runs', false),
  ('whl.standing_order.manage', 'whl', 'Create, change, pause, resume and end standing orders', false),
  ('whl.bad_debt.write_off', 'whl', 'Ask for an unrecoverable open item to be written off as bad debt', false),
  ('whl.bad_debt.approve', 'whl', 'Approve a bad-debt write-off someone else asked for', true);

INSERT INTO iam.approval_policy (id, kind, branch_id, threshold_pesewas, approver_permission, requires_evidence, requires_step_up, created_by, updated_by) VALUES
  ('01900000-0000-7000-8000-000000000651', 'BAD_DEBT_WRITE_OFF', NULL, 0, 'whl.bad_debt.approve', false, true,
   '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001');

-- migrate:down
DELETE FROM iam.approval_policy WHERE id = '01900000-0000-7000-8000-000000000651';
DELETE FROM iam.role_permission WHERE permission_code IN ('whl.standing_order.read', 'whl.standing_order.manage', 'whl.bad_debt.write_off', 'whl.bad_debt.approve');
DELETE FROM iam.permission WHERE code IN ('whl.standing_order.read', 'whl.standing_order.manage', 'whl.bad_debt.write_off', 'whl.bad_debt.approve');
