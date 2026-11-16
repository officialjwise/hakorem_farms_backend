-- 0143_iam_seed_fin_fixed_asset_permissions
-- B08 continued 1c2 (FR-FIN-014, FR-FIN-015, ADR-0017, A-199): reading and keeping the fixed asset register and its
-- depreciation runs, as contract/openapi.yaml names them. Granted to no role here; 0144 grants them.
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
INSERT INTO iam.permission (code, module, description, requires_step_up) VALUES
  ('fin.fixed_asset.read', 'fin', 'Read the fixed asset register and its depreciation runs', false),
  ('fin.fixed_asset.manage', 'fin', 'Register, change and dispose of fixed assets; calculate and post depreciation runs (a run is posted by someone other than its maker)', false);

-- migrate:down
DELETE FROM iam.role_permission WHERE permission_code IN ('fin.fixed_asset.read', 'fin.fixed_asset.manage');
DELETE FROM iam.permission WHERE code IN ('fin.fixed_asset.read', 'fin.fixed_asset.manage');
