-- 0103_iam_regrant_procurement_segregation
-- The owner's condition on the procurement grants (2026-11-15, A-169): no single role can both change a supplier's
-- payout details and approve or record a payment to that supplier. Before this migration the Accountant held both
-- (approving payout changes, and preparing and paying payments, 0096 and 0101), and so did the Owner. The split:
--   payout side   the Owner asks for and approves payout changes (a different Owner approves an Owner's request).
--                 No other role can take a payout permission: a Manager must hold every permission of the roles it
--                 grants (A-120), so a payout permission on the Storekeeper would put it on the Manager, who approves
--                 payments
--   payment side  the Accountant prepares and records payments; the Manager approves them
-- So the Accountant gives up approving payout changes. Reading full payout details (pur.supplier.payout_read) is neither
-- side: the Accountant keeps it to make the transfer, the Owner to check a change.
-- The Owner still holds both sides, and must: nobody may grant a role holding a permission they do not hold (A-120,
-- ADR-0043), and the Owner grants every other role. That is reported to the owner for a decision (A-169); until then
-- maker and checker stay different people on both a payout change and a payment.
-- The setting administration (aud.setting.manage, A-168) goes to the Owner.
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`); restores the grants of 0101 exactly.

-- migrate:up
DELETE FROM iam.role_permission rp USING iam.role r
 WHERE rp.role_id = r.id AND r.code = 'ACCOUNTANT' AND rp.permission_code = 'pur.supplier.payout_approve';

INSERT INTO iam.role_permission (role_id, permission_code, created_by, updated_by)
SELECT r.id, p.code, '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001'
  FROM iam.role r CROSS JOIN iam.permission p
 WHERE r.deleted_at IS NULL
   AND r.code = 'OWNER' AND p.code IN ('pur.supplier.payout_change', 'aud.setting.manage');

-- migrate:down
DELETE FROM iam.role_permission WHERE permission_code IN ('pur.supplier.payout_change', 'aud.setting.manage');
INSERT INTO iam.role_permission (role_id, permission_code, created_by, updated_by)
SELECT r.id, p.code, '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001'
  FROM iam.role r CROSS JOIN iam.permission p
 WHERE r.deleted_at IS NULL AND r.code = 'ACCOUNTANT' AND p.code = 'pur.supplier.payout_approve';
