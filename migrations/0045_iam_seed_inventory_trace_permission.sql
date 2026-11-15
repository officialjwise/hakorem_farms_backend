-- 0045_iam_seed_inventory_trace_permission
-- The first inventory permission (contract x-permission on traceStockUnit, FR-INV-006): reading a stock unit's lineage
-- both ways. Granted to no role here; 0046 grants it. The other inventory permissions arrive with their operations.
-- Data category: none (lookup row).
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
INSERT INTO iam.permission (code, module, description, requires_step_up) VALUES
  ('inv.trace.read', 'inv', 'Trace a stock unit back to its animals, suppliers and costs, and forward to its sales', false);

-- migrate:down
DELETE FROM iam.permission WHERE code = 'inv.trace.read';
