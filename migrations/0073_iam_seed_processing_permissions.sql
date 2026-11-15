-- 0073_iam_seed_processing_permissions
-- The permissions of the operations B6 builds in PRC (contract x-permission): reading processing orders, planning and
-- changing them, processing them (start, outputs, direct costs, completion), and reading and managing yield
-- standards. Granted to no role here; 0074 grants them (A-153).
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
INSERT INTO iam.permission (code, module, description, requires_step_up) VALUES
  ('prc.order.read', 'prc', 'Read processing orders, with their inputs, outputs and costs', false),
  ('prc.order.create', 'prc', 'Plan, change and cancel processing orders', false),
  ('prc.order.process', 'prc', 'Start processing orders, record their outputs and direct costs, and complete them', false),
  ('prc.yield_standard.read', 'prc', 'Read yield standards', false),
  ('prc.yield_standard.manage', 'prc', 'Create and change yield standards', false);

-- migrate:down
DELETE FROM iam.permission WHERE code IN ('prc.order.read', 'prc.order.create', 'prc.order.process', 'prc.yield_standard.read', 'prc.yield_standard.manage');
