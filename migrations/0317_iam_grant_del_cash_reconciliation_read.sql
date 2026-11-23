-- 0317_iam_grant_del_cash_reconciliation_read
-- Who reads the driver variance report (FR-DEL-010, abuse cases 6 and 43; CR-056 item 3's Manager and Owner, who
-- dispatch and assign): the Manager and the Owner. The Cashier who receives a hand-in reads that one hand-in in the
-- answer it gets, not the report; the Driver reads only their own cash (`getMyCashSummary`). Every other role holds
-- none of it.
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
INSERT INTO iam.role_permission (role_id, permission_code, created_by, updated_by)
SELECT r.id, 'del.cash_reconciliation.read', '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001'
  FROM iam.role r
 WHERE r.code IN ('MANAGER', 'OWNER') AND r.deleted_at IS NULL
ON CONFLICT DO NOTHING;

-- migrate:down
DELETE FROM iam.role_permission rp USING iam.role r
 WHERE rp.role_id = r.id AND r.code IN ('MANAGER', 'OWNER') AND rp.permission_code = 'del.cash_reconciliation.read';
