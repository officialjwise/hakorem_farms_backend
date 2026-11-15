-- 0106_iam_grant_payout_cross_approval
-- The owner's answer of 2026-11-15 (A-171): payout changes are cross-approved. A change the Owner makes is approved by
-- a Manager or an Accountant; a change a Manager or an Accountant makes is approved by the Owner (or the other). The
-- approver is always a different person (IAM and `ck_supplier_payout_change_checker`), and the maker of a change never
-- approves the first payment after it (0105). So the Manager and the Accountant gain asking for and approving payout
-- changes; the Manager also gains reading full payout details (to check a change it approves) and preparing supplier
-- payments (the smallest team: the Owner and one Manager). The Owner already holds every permission (A-120, ADR-0043).
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
INSERT INTO iam.role_permission (role_id, permission_code, created_by, updated_by)
SELECT r.id, p.code, '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001'
  FROM iam.role r CROSS JOIN iam.permission p
 WHERE r.deleted_at IS NULL
   AND ((r.code IN ('MANAGER', 'ACCOUNTANT') AND p.code IN ('pur.supplier.payout_change', 'pur.supplier.payout_approve'))
     OR (r.code = 'MANAGER' AND p.code IN ('pur.supplier.payout_read', 'pur.supplier_payment.create')))
ON CONFLICT DO NOTHING;

-- migrate:down
DELETE FROM iam.role_permission rp USING iam.role r
 WHERE rp.role_id = r.id
   AND ((r.code IN ('MANAGER', 'ACCOUNTANT') AND rp.permission_code IN ('pur.supplier.payout_change', 'pur.supplier.payout_approve'))
     OR (r.code = 'MANAGER' AND rp.permission_code IN ('pur.supplier.payout_read', 'pur.supplier_payment.create')));
