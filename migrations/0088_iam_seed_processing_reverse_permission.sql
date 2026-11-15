-- 0088_iam_seed_processing_reverse_permission
-- The permission to reverse a completed processing order (FR-PRC-011, whose actor is the Manager; A-162): it moves the
-- animal back into its pen at its prior cost and empties the output lots. Granted by 0089.
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
INSERT INTO iam.permission (code, module, description, requires_step_up) VALUES
  ('prc.order.reverse', 'prc', 'Reverse a completed processing order whose outputs are all unsold', false);

-- migrate:down
DELETE FROM iam.permission WHERE code = 'prc.order.reverse';
