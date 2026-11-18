-- 0264_iam_seed_whl_ageing_dunning_permissions
-- B10 continued 2 (FR-WHL-010, FR-WHL-011, CR-048, ADR-0035): the permissions of the ageing report and the dunning
-- operations, as contract/openapi.yaml names them. Granted to no role here; 0265 grants them.
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
INSERT INTO iam.permission (code, module, description, requires_step_up) VALUES
  ('whl.ageing.read', 'whl', 'Read the receivables ageing report: what each customer owes by days past due, as at a date', false),
  ('whl.dunning.read', 'whl', 'Read the reminder levels and the reminders queued to customers', false),
  ('whl.dunning.manage', 'whl', 'Replace the reminder levels: when each fires, its channels and its template', false);

-- migrate:down
DELETE FROM iam.role_permission WHERE permission_code IN ('whl.ageing.read', 'whl.dunning.read', 'whl.dunning.manage');
DELETE FROM iam.permission WHERE code IN ('whl.ageing.read', 'whl.dunning.read', 'whl.dunning.manage');
