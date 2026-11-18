-- 0234_iam_grant_pos_device_permissions
-- Who enrols a till's devices and recovers a till (A-274), the most conservative reading: only the Owner and the Manager
-- enrol, read and revoke devices, and only they may record cash or pay a refund out of another cashier's open shift (the
-- manager recovering a till, OFFLINE_SYNC 6.5, A-273 (f)). The Cashier and every other role hold none of them.
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
INSERT INTO iam.role_permission (role_id, permission_code, created_by, updated_by)
SELECT r.id, p.code, '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001'
  FROM iam.role r JOIN (VALUES
    ('OWNER', 'pos.device.read'), ('MANAGER', 'pos.device.read'),
    ('OWNER', 'pos.device.enrol'), ('MANAGER', 'pos.device.enrol'),
    ('OWNER', 'pos.shift.force_close'), ('MANAGER', 'pos.shift.force_close')
  ) AS p (role, code) ON p.role = r.code
 WHERE r.deleted_at IS NULL
ON CONFLICT DO NOTHING;

-- migrate:down
DELETE FROM iam.role_permission WHERE permission_code IN ('pos.device.read', 'pos.device.enrol', 'pos.shift.force_close');
