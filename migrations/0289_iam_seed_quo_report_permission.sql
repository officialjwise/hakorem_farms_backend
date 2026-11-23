-- 0289_iam_seed_quo_report_permission
-- B10 continued 5 (FR-QUO-013, ADR-0017, A-329): the permission of getQuotePipeline, as contract/openapi.yaml names
-- it: the quote pipeline of the caller's branches (counts, values and win rates by salesperson or product line). Granted
-- to no role here; 0290 grants it.
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
INSERT INTO iam.permission (code, module, description, requires_step_up) VALUES
  ('quo.report.read', 'quo', 'Read the quote pipeline of a branch: issued, accepted, declined and expired, their value and the win rate', false);

-- migrate:down
DELETE FROM iam.role_permission WHERE permission_code = 'quo.report.read';
DELETE FROM iam.permission WHERE code = 'quo.report.read';
