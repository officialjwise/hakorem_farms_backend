-- 0101_iam_grant_supplier_register_permissions
-- Grants the B07 continued permissions (FR-PUR-001 to FR-PUR-004, A-166). Suppliers: the Owner, the Manager and the
-- Accountant read profiles, documents and scores and change terms, ask for payout changes and attach documents; only
-- the Owner and the Accountant read full payout details or approve a payout change, never their own (IAM refuses the
-- maker as checker, and so does pur.supplier_payout_change). Requisitions: the Storekeeper and the Farm hand raise them
-- (the requirement's makers), the Manager and the Owner too; the Manager and the Owner reject or convert them.
-- Every other role holds none.
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
INSERT INTO iam.role_permission (role_id, permission_code, created_by, updated_by)
SELECT r.id, p.code, '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001'
  FROM iam.role r CROSS JOIN iam.permission p
 WHERE r.deleted_at IS NULL
   AND ((r.code IN ('OWNER', 'MANAGER', 'ACCOUNTANT') AND p.code IN ('pur.supplier.read', 'pur.supplier.update'))
     OR (r.code IN ('OWNER', 'ACCOUNTANT') AND p.code IN ('pur.supplier.payout_read', 'pur.supplier.payout_approve'))
     OR (r.code IN ('OWNER', 'MANAGER', 'STOREKEEPER', 'FARM_HAND') AND p.code IN ('pur.requisition.read', 'pur.requisition.create'))
     OR (r.code IN ('OWNER', 'MANAGER') AND p.code = 'pur.requisition.approve'));

-- migrate:down
DELETE FROM iam.role_permission WHERE permission_code IN ('pur.supplier.read', 'pur.supplier.update', 'pur.supplier.payout_read', 'pur.supplier.payout_approve',
  'pur.requisition.read', 'pur.requisition.create', 'pur.requisition.approve');
