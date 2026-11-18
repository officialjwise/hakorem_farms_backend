-- 0267_iam_grant_whl_ageing_dunning_permissions
-- B10 continued 2 (CR-048's table as the owner approved it on 2026-11-18, A-318 (e)): the Owner, the Manager, Sales and
-- the Accountant read the ageing report (FR-WHL-010's actors are the Accountant and Sales) and the reminders queued; only
-- the Owner and the Manager change the reminder levels, which decide what every customer is sent. The Storekeeper and
-- the Cashier hold none of them.
-- Data category: none (grants).
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
INSERT INTO iam.role_permission (role_id, permission_code, created_by, updated_by)
SELECT r.id, p.code, '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001'
  FROM iam.role r JOIN (VALUES
    ('OWNER', 'whl.ageing.read'), ('MANAGER', 'whl.ageing.read'), ('SALES', 'whl.ageing.read'), ('ACCOUNTANT', 'whl.ageing.read'),
    ('OWNER', 'whl.dunning.read'), ('MANAGER', 'whl.dunning.read'), ('SALES', 'whl.dunning.read'), ('ACCOUNTANT', 'whl.dunning.read'),
    ('OWNER', 'whl.dunning.manage'), ('MANAGER', 'whl.dunning.manage')
  ) AS p (role, code) ON p.role = r.code
 WHERE r.deleted_at IS NULL
ON CONFLICT DO NOTHING;

-- migrate:down
DELETE FROM iam.role_permission WHERE permission_code IN ('whl.ageing.read', 'whl.dunning.read', 'whl.dunning.manage');
