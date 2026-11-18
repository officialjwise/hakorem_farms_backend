-- 0246_iam_grant_manager_supplier_invoice_approve
-- B09u, F10g (the owner, 2026-11-17; this grant is the parent session's leave in lane A's IAM): an Owner or a Manager
-- approves a supplier credit note, as with a customer's (`bil.credit_note.approve`, 0174), never the person who raised
-- the claim or drafted it. Before this grant only the Owner and the Accountant held `pur.supplier_invoice.approve`, the
-- SUPPLIER_CREDIT_NOTE approver permission (0109), so nobody could approve a credit note the Owner's claim raised and
-- the Accountant drafted. The one additive grant: the Manager holds `pur.supplier_invoice.approve`, which also lets a
-- Manager approve an invoice for payment, never one they entered (0245) (A-301).
-- Data category: none (a lookup row).
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
INSERT INTO iam.role_permission (role_id, permission_code, created_by, updated_by)
SELECT r.id, 'pur.supplier_invoice.approve', '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001'
  FROM iam.role r
 WHERE r.code = 'MANAGER' AND r.deleted_at IS NULL
ON CONFLICT DO NOTHING;

-- migrate:down
DELETE FROM iam.role_permission
 WHERE permission_code = 'pur.supplier_invoice.approve' AND role_id IN (SELECT id FROM iam.role WHERE code = 'MANAGER');
