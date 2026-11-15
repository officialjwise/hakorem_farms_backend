-- 0055_iam_seed_inventory_count_permissions
-- The stock take permissions of the operations B05 continued 3 builds (contract x-permission): reading stock takes
-- and their lines, planning, starting and cancelling one, recording counts, and posting the variances (FR-INV-013,
-- FR-INV-014). Granted to no role here; 0056 grants them (A-141). A variance value at or above the threshold waits
-- for the existing STOCK_WRITE_OFF policy (migration 0052): a different person holding inv.adjustment.approve.
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
INSERT INTO iam.permission (code, module, description, requires_step_up) VALUES
  ('inv.stock_take.read', 'inv', 'Read stock takes and their lines', false),
  ('inv.stock_take.create', 'inv', 'Plan, start and cancel a stock take', false),
  ('inv.stock_take.count', 'inv', 'Record the counts of a stock take and close counting', false),
  ('inv.stock_take.post', 'inv', 'Submit a stock take and post its variances', false);

-- migrate:down
DELETE FROM iam.permission WHERE code IN ('inv.stock_take.read', 'inv.stock_take.create', 'inv.stock_take.count', 'inv.stock_take.post');
