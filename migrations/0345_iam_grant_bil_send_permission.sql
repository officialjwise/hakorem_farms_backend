-- 0345_iam_grant_bil_send_permission
-- Who sends a billing document (B11 continued 13, A-288 (a)): the roles that reprint one (0154: the Owner, the Manager
-- and the Cashier), since a send is a copy of the archived document like a reprint, logged in bil.reprint_log with its
-- channel. No role gains a document it could not already reprint.
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
INSERT INTO iam.role_permission (role_id, permission_code, created_by, updated_by)
SELECT r.id, p.code, '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001'
  FROM iam.role r JOIN (VALUES
    ('OWNER', 'bil.document.send'), ('MANAGER', 'bil.document.send'), ('CASHIER', 'bil.document.send')
  ) AS p (role, code) ON p.role = r.code
 WHERE r.deleted_at IS NULL
ON CONFLICT DO NOTHING;

-- migrate:down
DELETE FROM iam.role_permission WHERE permission_code = 'bil.document.send';
