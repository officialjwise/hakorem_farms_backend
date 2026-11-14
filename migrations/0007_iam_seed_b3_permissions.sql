-- 0007_iam_seed_b3_permissions
-- The permission codes the B3 operations check (contract x-permission). Granted to no role here (secure defaults,
-- security architecture section 13); 0008 grants them.
-- Data category: none (lookup rows).

-- migrate:up
INSERT INTO iam.permission (code, module, description, requires_step_up) VALUES
  ('iam.session.read', 'iam', 'List my own sessions and devices', false),
  ('iam.session.read.any', 'iam', 'List anyone''s sessions and devices', false),
  ('iam.session.revoke', 'iam', 'Revoke one of my own sessions', false),
  ('iam.session.revoke.any', 'iam', 'Revoke anyone''s session (forced logout)', false),
  ('mdm.product.read', 'mdm', 'Read the product catalogue', false),
  ('mdm.product.create', 'mdm', 'Create a product', false);

-- migrate:down
DELETE FROM iam.permission WHERE code IN (
  'iam.session.read', 'iam.session.read.any', 'iam.session.revoke', 'iam.session.revoke.any',
  'mdm.product.read', 'mdm.product.create');
