-- 0070_iam_grant_report_tile_permissions
-- Grants the B05x reporting permissions (A-149). FR-RPT-001 names the Owner for the owner dashboard: only the Owner
-- holds it. The tiles carry stock value at cost, purchases and, once their sources exist, sales, cash and
-- receivables, so the Owner, the Manager and the Accountant read them; every other role holds neither until the owner
-- says otherwise.
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
INSERT INTO iam.role_permission (role_id, permission_code, created_by, updated_by)
SELECT r.id, p.code, '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001'
  FROM iam.role r CROSS JOIN iam.permission p
 WHERE r.deleted_at IS NULL
   AND ((r.code = 'OWNER' AND p.code IN ('rpt.dashboard.owner', 'rpt.tile.read'))
     OR (r.code IN ('MANAGER', 'ACCOUNTANT') AND p.code = 'rpt.tile.read'));

-- migrate:down
DELETE FROM iam.role_permission WHERE permission_code IN ('rpt.dashboard.owner', 'rpt.tile.read');
