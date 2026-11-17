-- 0190_iam_seed_ord_reversal_permissions
-- B09a continued 2c (FR-ORD-002, FR-ORD-014, ADR-0017, ADR-0035, abuse case 1, A-226): the permissions of cancelling an
-- order and voiding a completed sale, as contract/openapi.yaml names them, and the SALE_VOID approval: every void waits
-- for a holder of ord.void.approve who is neither its maker nor the cashier who made the sale, whatever its amount,
-- with a fresh step-up (the owner, 2026-11-16: refunds and reversals are where till fraud lives). Granted to no role
-- here; 0191 grants them. The threshold is data.
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
INSERT INTO iam.permission (code, module, description, requires_step_up) VALUES
  ('ord.order.cancel', 'ord', 'Cancel an order before fulfilment: release its stock and ask for the refund of what it was paid', false),
  ('ord.order.void', 'ord', 'Ask for a completed counter sale to be voided; it waits for a supervisor who is not the cashier', false),
  ('ord.void.approve', 'ord', 'Approve the void of a sale someone else made and someone else asked to void', true);

INSERT INTO iam.approval_policy (id, kind, branch_id, threshold_pesewas, approver_permission, requires_evidence, requires_step_up, created_by, updated_by) VALUES
  ('01900000-0000-7000-8000-000000000424', 'SALE_VOID', NULL, 0, 'ord.void.approve', false, true,
   '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001');

-- migrate:down
DELETE FROM iam.approval_policy WHERE id = '01900000-0000-7000-8000-000000000424';
DELETE FROM iam.role_permission WHERE permission_code IN ('ord.order.cancel', 'ord.order.void', 'ord.void.approve');
DELETE FROM iam.permission WHERE code IN ('ord.order.cancel', 'ord.order.void', 'ord.void.approve');
