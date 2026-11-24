-- 0337_iam_grant_ntf_permissions
-- Who reads and changes what customers are sent (B11 continued 10, A-374 (c)): the Owner and the Manager draft and
-- activate templates, two people to each change (0335's maker-checker), and read the message log and retry a failed
-- message; the Accountant and Sales read the templates, so a reminder level picks one (the owner, 2026-11-23). The
-- Storekeeper, the Cashier, the Driver, the farm hand, investors and customers hold none of them.
-- Data category: none (grants).
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
INSERT INTO iam.role_permission (role_id, permission_code, created_by, updated_by)
SELECT r.id, p.code, '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001'
  FROM iam.role r JOIN (VALUES
    ('OWNER', 'ntf.template.read'), ('MANAGER', 'ntf.template.read'), ('ACCOUNTANT', 'ntf.template.read'), ('SALES', 'ntf.template.read'),
    ('OWNER', 'ntf.template.manage'), ('MANAGER', 'ntf.template.manage'),
    ('OWNER', 'ntf.message.read'), ('MANAGER', 'ntf.message.read'),
    ('OWNER', 'ntf.message.retry'), ('MANAGER', 'ntf.message.retry')
  ) AS p (role, code) ON p.role = r.code
 WHERE r.deleted_at IS NULL
ON CONFLICT DO NOTHING;

-- migrate:down
DELETE FROM iam.role_permission WHERE permission_code IN ('ntf.template.read', 'ntf.template.manage', 'ntf.message.read', 'ntf.message.retry');
