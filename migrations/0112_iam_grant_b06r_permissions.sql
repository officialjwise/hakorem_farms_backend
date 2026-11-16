-- 0112_iam_grant_b06r_permissions
-- Who holds B06r's permissions (owner, 2026-11-15; A-158 as decided, A-175):
--   the Farm hand          platform.file.upload.evidence: it uploads the photograph of a death it reports, and no
--                          other file; it keeps liv.mortality.report but not liv.mortality.post, so every write-off
--                          it reports waits for someone above it
--   Owner, Manager         platform.file.upload.evidence as well, which adds nothing to the platform.file.upload they
--                          hold, so that they may grant the Farm hand role (a granter holds what it grants, A-121)
--   Owner, Manager,
--   Storekeeper            liv.mortality.post: they keep the direct write-off below the threshold they had
--   Owner, Manager         liv.mortality.confirm: a person above the Farm hand confirms its reports below the threshold
--                          (the Storekeeper, named in abuse case 2, does not, and reads no approval inbox); at or above
--                          it liv.mortality.approve (Owner, Manager) with step-up still decides
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
INSERT INTO iam.role_permission (role_id, permission_code, created_by, updated_by)
SELECT r.id, p.code, '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001'
  FROM iam.role r CROSS JOIN iam.permission p
 WHERE r.deleted_at IS NULL
   AND ((r.code IN ('FARM_HAND', 'OWNER', 'MANAGER') AND p.code = 'platform.file.upload.evidence')
     OR (r.code IN ('OWNER', 'MANAGER', 'STOREKEEPER') AND p.code = 'liv.mortality.post')
     OR (r.code IN ('OWNER', 'MANAGER') AND p.code = 'liv.mortality.confirm'))
ON CONFLICT DO NOTHING;

-- migrate:down
DELETE FROM iam.role_permission rp USING iam.role r
 WHERE rp.role_id = r.id
   AND ((r.code IN ('FARM_HAND', 'OWNER', 'MANAGER') AND rp.permission_code = 'platform.file.upload.evidence')
     OR (r.code IN ('OWNER', 'MANAGER', 'STOREKEEPER') AND rp.permission_code = 'liv.mortality.post')
     OR (r.code IN ('OWNER', 'MANAGER') AND rp.permission_code = 'liv.mortality.confirm'));
