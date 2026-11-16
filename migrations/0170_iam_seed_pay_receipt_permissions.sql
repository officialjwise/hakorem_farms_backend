-- 0170_iam_seed_pay_receipt_permissions
-- B09a continued 1b (FR-PAY-001, FR-PAY-011, FR-PAY-014, FR-PAY-015, ADR-0017, A-212): the permissions of the PAY
-- operations this session builds, as contract/openapi.yaml names them, and the PAYMENT_REVERSAL approval: every
-- reversal (a bounced cheque or a payment recorded in error) waits for a holder of pay.reversal.approve other than its
-- maker, whatever its amount, with a fresh step-up (the owner, 2026-11-16: refunds and reversals are where till fraud
-- lives). Granted to no role here; 0171 grants them. The threshold is data: a lower-risk policy is a row change.
-- A customer reads their own store credit with no permission code (ownership instead, like their own sessions).
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
INSERT INTO iam.permission (code, module, description, requires_step_up) VALUES
  ('pay.payment.create', 'pay', 'Record a cheque, a bank transfer or a store credit tender received from a customer', false),
  ('pay.payment.clear_cheque', 'pay', 'Record that a cheque awaiting clearance has cleared at the bank', false),
  ('pay.payment.reverse', 'pay', 'Ask for a payment to be reversed (a bounced cheque or a payment recorded in error); it waits for a different approver', false),
  ('pay.reversal.approve', 'pay', 'Approve a payment reversal asked for by someone else', true),
  ('pay.store_credit.read', 'pay', 'Read a customer''s store credit balance and its entries', false),
  ('pay.receivable.read', 'pay', 'Read unpaid and part-paid billing documents with their outstanding amounts', false);

INSERT INTO iam.approval_policy (id, kind, branch_id, threshold_pesewas, approver_permission, requires_evidence, requires_step_up, created_by, updated_by) VALUES
  ('01900000-0000-7000-8000-000000000422', 'PAYMENT_REVERSAL', NULL, 0, 'pay.reversal.approve', false, true,
   '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001');

-- migrate:down
DELETE FROM iam.approval_policy WHERE id = '01900000-0000-7000-8000-000000000422';
DELETE FROM iam.role_permission WHERE permission_code IN ('pay.payment.create', 'pay.payment.clear_cheque', 'pay.payment.reverse', 'pay.reversal.approve', 'pay.store_credit.read', 'pay.receivable.read');
DELETE FROM iam.permission WHERE code IN ('pay.payment.create', 'pay.payment.clear_cheque', 'pay.payment.reverse', 'pay.reversal.approve', 'pay.store_credit.read', 'pay.receivable.read');
