-- 0028_iam_seed_access_admin_permissions
-- The permission codes of user, role-reading and grant administration (contract x-permission; FR-IAM-001, FR-IAM-008,
-- FR-IAM-015, FR-IAM-017, FR-IAM-022). Creating a user, resetting a password and changing a grant need step-up, as
-- the contract says. Granted to no role here: migration 0029 grants them (A-120).
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
INSERT INTO iam.permission (code, module, description, requires_step_up) VALUES
  ('iam.user.read', 'iam', 'Read user accounts and their grants', false),
  ('iam.user.create', 'iam', 'Create a staff account with a temporary password', true),
  ('iam.user.update', 'iam', 'Change a user''s name, email or phone', false),
  ('iam.user.disable', 'iam', 'Disable or enable a user account', false),
  ('iam.user.unlock', 'iam', 'Unlock an account locked by failed logins', false),
  ('iam.user.reset_password', 'iam', 'Give a user a new temporary password', true),
  ('iam.role.read', 'iam', 'Read roles and the permission list', false),
  ('iam.grant.read', 'iam', 'Read role grants', false),
  ('iam.grant.manage', 'iam', 'Grant or revoke a role at a branch', true);

-- migrate:down
DELETE FROM iam.permission WHERE code IN (
  'iam.user.read', 'iam.user.create', 'iam.user.update', 'iam.user.disable', 'iam.user.unlock', 'iam.user.reset_password',
  'iam.role.read', 'iam.grant.read', 'iam.grant.manage');
