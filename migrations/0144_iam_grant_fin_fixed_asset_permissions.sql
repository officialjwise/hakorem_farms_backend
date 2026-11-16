-- 0144_iam_grant_fin_fixed_asset_permissions
-- Who keeps the fixed asset register (DC-15, A-199): the Owner and the Accountant, who keep the books; the Accountant
-- calculates a run (the maker) and the Owner posts it (the checker), or the other way round, never the same person.
-- No other role is granted anything of FIN.
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
INSERT INTO iam.role_permission (role_id, permission_code, created_by, updated_by)
SELECT r.id, p.code, '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001'
  FROM iam.role r CROSS JOIN (VALUES ('fin.fixed_asset.read'), ('fin.fixed_asset.manage')) AS p (code)
 WHERE r.code IN ('OWNER', 'ACCOUNTANT') AND r.deleted_at IS NULL
ON CONFLICT DO NOTHING;

-- migrate:down
DELETE FROM iam.role_permission rp USING iam.role r
 WHERE rp.role_id = r.id AND r.code IN ('OWNER', 'ACCOUNTANT') AND rp.permission_code IN ('fin.fixed_asset.read', 'fin.fixed_asset.manage');
