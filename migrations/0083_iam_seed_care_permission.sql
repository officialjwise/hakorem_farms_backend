-- 0083_iam_seed_care_permission
-- The permission of the Farm hand's cost-free care reads (owner, 2026-11-15; A-160, ADR-0052): the animal register,
-- the rations, the batches and the health events with their withdrawal holds, each in a shape that carries no cost and
-- no price. Granted by 0084.
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
INSERT INTO iam.permission (code, module, description, requires_step_up) VALUES
  ('liv.care.read', 'liv', 'Read the animal register, rations, batches and health events with their withdrawal holds, without cost', false);

-- migrate:down
DELETE FROM iam.permission WHERE code = 'liv.care.read';
