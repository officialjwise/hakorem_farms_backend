-- 0095_iam_seed_purchasing_permissions
-- The permissions of the purchase-to-pay operations B7 builds in PUR (contract x-permission, A-164): purchase orders
-- (read, create and submit, approve, send, close and cancel), supplier invoices (read, create and cancel, match,
-- approve) and supplier payments (read, create and submit, approve, mark paid). Granted to no role here; 0096 grants
-- them.
-- The two approval policies (ADR-0017): a purchase order above 200,000 pesewas (FR-PUR-005's seed; judged "at or above"
-- 200,001, so 200,000 itself is approved on submit) needs a different person holding pur.purchase_order.approve; every
-- supplier payment (no threshold) needs a different person holding pur.supplier_payment.approve (FR-PUR-012). Both ask
-- for a fresh step-up, as every other approval policy does.
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
INSERT INTO iam.permission (code, module, description, requires_step_up) VALUES
  ('pur.purchase_order.read', 'pur', 'Read purchase orders', false),
  ('pur.purchase_order.create', 'pur', 'Draft, change and submit purchase orders', false),
  ('pur.purchase_order.approve', 'pur', 'Approve a purchase order above the approval limit', true),
  ('pur.purchase_order.send', 'pur', 'Send an approved purchase order to its supplier', false),
  ('pur.purchase_order.close', 'pur', 'Close or cancel a purchase order', false),
  ('pur.supplier_invoice.read', 'pur', 'Read supplier invoices', false),
  ('pur.supplier_invoice.create', 'pur', 'Enter, change and cancel supplier invoices', false),
  ('pur.supplier_invoice.match', 'pur', 'Run the three-way match on a supplier invoice', false),
  ('pur.supplier_invoice.approve', 'pur', 'Approve a matched supplier invoice for payment', false),
  ('pur.supplier_payment.read', 'pur', 'Read supplier payments', false),
  ('pur.supplier_payment.create', 'pur', 'Prepare, submit and cancel supplier payments', false),
  ('pur.supplier_payment.approve', 'pur', 'Approve a supplier payment prepared by someone else', true),
  ('pur.supplier_payment.pay', 'pur', 'Record an approved supplier payment as paid', false);

INSERT INTO iam.approval_policy (id, kind, branch_id, threshold_pesewas, approver_permission, requires_evidence, requires_step_up, created_by, updated_by) VALUES
  ('01900000-0000-7000-8000-000000000407', 'PURCHASE_ORDER', NULL, 200001, 'pur.purchase_order.approve', false, true,
   '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001'),
  ('01900000-0000-7000-8000-000000000408', 'SUPPLIER_PAYMENT', NULL, NULL, 'pur.supplier_payment.approve', false, true,
   '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001');

-- migrate:down
DELETE FROM iam.approval_policy WHERE id IN ('01900000-0000-7000-8000-000000000407', '01900000-0000-7000-8000-000000000408');
DELETE FROM iam.permission WHERE code IN ('pur.purchase_order.read', 'pur.purchase_order.create', 'pur.purchase_order.approve', 'pur.purchase_order.send',
  'pur.purchase_order.close', 'pur.supplier_invoice.read', 'pur.supplier_invoice.create', 'pur.supplier_invoice.match', 'pur.supplier_invoice.approve',
  'pur.supplier_payment.read', 'pur.supplier_payment.create', 'pur.supplier_payment.approve', 'pur.supplier_payment.pay');
