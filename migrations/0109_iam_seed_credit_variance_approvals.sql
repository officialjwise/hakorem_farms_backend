-- 0109_iam_seed_credit_variance_approvals
-- B07 continued 1b (A-172): a supplier credit note and an approved variance each change what a supplier is owed, so
-- each waits for a different person (ADR-0017), whatever the amount, with a fresh step-up:
--   SUPPLIER_CREDIT_NOTE        approved by a holder of pur.supplier_invoice.approve other than its maker (FR-PUR-011)
--   SUPPLIER_INVOICE_VARIANCE   approved by a holder of the new pur.supplier_invoice.variance_approve, never the person
--                               who asked or who entered the invoice (FR-PUR-010)
-- The new permission is granted to no role here; 0110 grants it.
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
INSERT INTO iam.permission (code, module, description, requires_step_up) VALUES
  ('pur.supplier_invoice.variance_approve', 'pur', 'Approve a supplier invoice''s price or levy variance asked for by someone else, so it can be paid', true);

INSERT INTO iam.approval_policy (id, kind, branch_id, threshold_pesewas, approver_permission, requires_evidence, requires_step_up, created_by, updated_by) VALUES
  ('01900000-0000-7000-8000-000000000410', 'SUPPLIER_CREDIT_NOTE', NULL, NULL, 'pur.supplier_invoice.approve', false, true,
   '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001'),
  ('01900000-0000-7000-8000-000000000411', 'SUPPLIER_INVOICE_VARIANCE', NULL, NULL, 'pur.supplier_invoice.variance_approve', false, true,
   '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001');

-- migrate:down
DELETE FROM iam.approval_policy WHERE id IN ('01900000-0000-7000-8000-000000000410', '01900000-0000-7000-8000-000000000411');
DELETE FROM iam.role_permission WHERE permission_code = 'pur.supplier_invoice.variance_approve';
DELETE FROM iam.permission WHERE code = 'pur.supplier_invoice.variance_approve';
