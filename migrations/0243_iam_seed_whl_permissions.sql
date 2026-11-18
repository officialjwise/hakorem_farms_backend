-- 0243_iam_seed_whl_permissions
-- B08 continued 2d (FR-WHL-009, ADR-0017, ADR-0035, A-300 (f)): the permissions of the customer statement operations,
-- as contract/openapi.yaml names them. Granted to no role here; 0244 grants them. B10 seeds the rest of WHL's.
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
INSERT INTO iam.permission (code, module, description, requires_step_up) VALUES
  ('whl.statement.read', 'whl', 'Read the customer statements of a branch, with their lines', false),
  ('whl.statement.create', 'whl', 'Produce a customer''s statement for a period at a branch, as a draft or issued and archived', false);

-- migrate:down
DELETE FROM iam.role_permission WHERE permission_code IN ('whl.statement.read', 'whl.statement.create');
DELETE FROM iam.permission WHERE code IN ('whl.statement.read', 'whl.statement.create');
