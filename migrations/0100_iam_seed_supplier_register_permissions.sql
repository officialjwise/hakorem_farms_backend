-- 0100_iam_seed_supplier_register_permissions
-- The permissions of the supplier register and requisitions B07 continued builds in PUR (contract x-permission,
-- A-166): supplier profiles, documents and scores (read, update), the full payout details (read, decrypted and audited,
-- with a fresh step-up), the approval of a payout change, and purchase requisitions (read, create and submit, reject
-- or convert). Granted to no role here; 0101 grants them.
-- The approval policy (ADR-0017): every change of a supplier's payout details, whatever the amount, needs a different
-- person holding pur.supplier.payout_approve, with a fresh step-up (FR-PUR-002).
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
INSERT INTO iam.permission (code, module, description, requires_step_up) VALUES
  ('pur.supplier.read', 'pur', 'Read supplier terms, masked payout details, documents and scores', false),
  ('pur.supplier.update', 'pur', 'Change supplier terms, ask for a payout detail change and attach supplier documents', false),
  ('pur.supplier.payout_read', 'pur', 'Read a supplier''s full payout details, decrypted and audited', true),
  ('pur.supplier.payout_approve', 'pur', 'Approve a change of supplier payout details asked for by someone else', true),
  ('pur.requisition.read', 'pur', 'Read purchase requisitions', false),
  ('pur.requisition.create', 'pur', 'Raise, change and submit purchase requisitions', false),
  ('pur.requisition.approve', 'pur', 'Reject a purchase requisition or convert it into a purchase order', false);

INSERT INTO iam.approval_policy (id, kind, branch_id, threshold_pesewas, approver_permission, requires_evidence, requires_step_up, created_by, updated_by) VALUES
  ('01900000-0000-7000-8000-000000000409', 'SUPPLIER_PAYOUT_CHANGE', NULL, NULL, 'pur.supplier.payout_approve', false, true,
   '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001');

-- migrate:down
DELETE FROM iam.approval_policy WHERE id = '01900000-0000-7000-8000-000000000409';
DELETE FROM iam.permission WHERE code IN ('pur.supplier.read', 'pur.supplier.update', 'pur.supplier.payout_read', 'pur.supplier.payout_approve',
  'pur.requisition.read', 'pur.requisition.create', 'pur.requisition.approve');
