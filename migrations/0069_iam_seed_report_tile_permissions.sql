-- 0069_iam_seed_report_tile_permissions
-- The permissions of the operations B05x builds in RPT (contract x-permission): the owner dashboard in one request
-- (FR-RPT-001, NFR-023) and the dashboard tiles a screen embeds one at a time. Granted to no role here; 0070 grants
-- them (A-149).
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
INSERT INTO iam.permission (code, module, description, requires_step_up) VALUES
  ('rpt.dashboard.owner', 'rpt', 'Read the owner dashboard', false),
  ('rpt.tile.read', 'rpt', 'Read the dashboard tiles: stock value, animals, low stock, purchases, sales, cash and receivables', false);

-- migrate:down
DELETE FROM iam.permission WHERE code IN ('rpt.dashboard.owner', 'rpt.tile.read');
