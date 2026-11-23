-- 0325_iam_grant_van_way_out_permissions
-- Who takes goods off a van other than by delivering them (FR-DEL-011: "the manager either reschedules or returns the
-- stock"): the Manager and the Owner, who plan and close the runs. Never the Driver, whose van it is (abuse case 48).
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
INSERT INTO iam.role_permission (role_id, permission_code, created_by, updated_by)
SELECT r.id, p.code, '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001'
  FROM iam.role r CROSS JOIN (VALUES ('del.delivery.return'), ('del.delivery.write_off')) AS p (code)
 WHERE r.code IN ('MANAGER', 'OWNER') AND r.deleted_at IS NULL
ON CONFLICT DO NOTHING;

-- migrate:down
DELETE FROM iam.role_permission rp USING iam.role r
 WHERE rp.role_id = r.id AND r.code IN ('MANAGER', 'OWNER') AND rp.permission_code IN ('del.delivery.return', 'del.delivery.write_off');
