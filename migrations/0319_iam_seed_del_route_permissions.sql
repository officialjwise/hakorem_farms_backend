-- 0319_iam_seed_del_route_permissions
-- B11 continued 3 (FR-DEL-005, CR-056 item 3, A-337 (d)): the route permissions, as contract/openapi.yaml names them:
--   del.route.read    read a branch's driver runs, their stops and what each run still carries and holds
--   del.route.manage  plan, order, start and close a driver's run, and list the drivers it may be given
-- Granted to no role here; 0320 grants them.
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
INSERT INTO iam.permission (code, module, description, requires_step_up) VALUES
  ('del.route.read', 'del', 'Read the drivers'' runs of a branch: their stops, what is still on the van and the cash still held', false),
  ('del.route.manage', 'del', 'Plan, order, start and close a driver''s run, and list the drivers of a branch', false);

-- migrate:down
DELETE FROM iam.role_permission WHERE permission_code IN ('del.route.read', 'del.route.manage');
DELETE FROM iam.permission WHERE code IN ('del.route.read', 'del.route.manage');
