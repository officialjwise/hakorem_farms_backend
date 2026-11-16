-- 0178_iam_seed_pay_reconciliation_permissions
-- B09a continued 1c (FR-PAY-016, FR-PAY-017, ADR-0017, ADR-0065, A-214): the permissions of the reconciliation
-- operations, as contract/openapi.yaml names them, and the RECONCILIATION_BREAK approval. Reconciliation never
-- corrects (the shared brief): every break is resolved through a holder of pay.reconciliation.approve other than the
-- person who asked, whatever its amount, with a fresh step-up, and its one posting (an unidentified receipt held in
-- 2290) takes effect only on that approval. Granted to no role here; 0179 grants them. The threshold is data.
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
INSERT INTO iam.permission (code, module, description, requires_step_up) VALUES
  ('pay.reconciliation.read', 'pay', 'Read provider settlement reports, bank statements and the reconciliation break queue', false),
  ('pay.reconciliation.manage', 'pay', 'Import and match settlement reports and bank statements, and ask for a break to be resolved', false),
  ('pay.reconciliation.approve', 'pay', 'Approve the resolution of a reconciliation break asked for by someone else', true);

INSERT INTO iam.approval_policy (id, kind, branch_id, threshold_pesewas, approver_permission, requires_evidence, requires_step_up, created_by, updated_by) VALUES
  ('01900000-0000-7000-8000-000000000423', 'RECONCILIATION_BREAK', NULL, 0, 'pay.reconciliation.approve', false, true,
   '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001');

-- migrate:down
DELETE FROM iam.approval_policy WHERE id = '01900000-0000-7000-8000-000000000423';
DELETE FROM iam.role_permission WHERE permission_code IN ('pay.reconciliation.read', 'pay.reconciliation.manage', 'pay.reconciliation.approve');
DELETE FROM iam.permission WHERE code IN ('pay.reconciliation.read', 'pay.reconciliation.manage', 'pay.reconciliation.approve');
