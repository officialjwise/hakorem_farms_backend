-- 0209_iam_grant_aud_business_profile_permission
-- Who reads the business profile in the console (FR-AUD-008, A-242), the most conservative reading: the two actors
-- FR-AUD-008 names, the Owner and the Manager. Only the Owner changes it (aud.setting.manage, 0103). The Accountant,
-- the counter and the field roles do not read it here; anyone reads the public shop profile.
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
INSERT INTO iam.role_permission (role_id, permission_code, created_by, updated_by)
SELECT r.id, p.code, '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001'
  FROM iam.role r JOIN (VALUES
    ('OWNER', 'aud.setting.read'), ('MANAGER', 'aud.setting.read')
  ) AS p (role, code) ON p.role = r.code
 WHERE r.deleted_at IS NULL
ON CONFLICT DO NOTHING;

-- migrate:down
DELETE FROM iam.role_permission WHERE permission_code = 'aud.setting.read';
