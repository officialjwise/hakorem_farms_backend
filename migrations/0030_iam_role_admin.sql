-- 0030_iam_role_admin
-- Role writes and the approval endpoints (FR-IAM-008, FR-IAM-012, FR-IAM-022; A-122). A permission leaves a role by the
-- soft deletion of its link, with an actor and a reason, as every MASTER row does (ADR-0024: the application role holds
-- no DELETE on a MASTER table); adding it back restores the link. Seeds the three permission codes the contract names
-- for these operations. Changing a role needs step-up. Granted to no role here: migration 0031 grants them.
-- Data category: none (lookup rows and columns of a configuration table).
-- Rollback: tested (`pnpm db:rollback`). It drops removed links, whose before state the audit trail keeps.

-- migrate:up
ALTER TABLE iam.role_permission
  ADD COLUMN updated_at    timestamptz NULL,
  ADD COLUMN updated_by    uuid NULL CONSTRAINT fk_role_permission_updated_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  ADD COLUMN deleted_at    timestamptz NULL,
  ADD COLUMN deleted_by    uuid NULL CONSTRAINT fk_role_permission_deleted_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  ADD COLUMN delete_reason text NULL;
-- updated_by stays null until a link is removed or restored; until then the creator is the last writer.
UPDATE iam.role_permission SET updated_at = created_at;
ALTER TABLE iam.role_permission
  ALTER COLUMN updated_at SET NOT NULL,
  ALTER COLUMN updated_at SET DEFAULT now(),
  ADD CONSTRAINT ck_role_permission_soft_delete CHECK ((deleted_at IS NULL) = (deleted_by IS NULL) AND (deleted_at IS NULL) = (delete_reason IS NULL));

INSERT INTO iam.permission (code, module, description, requires_step_up) VALUES
  ('iam.role.manage', 'iam', 'Create a role, or change a role''s name, permissions or limits', true),
  ('iam.approval.read', 'iam', 'Read the approval requests at a branch (the approval inbox)', false),
  ('iam.approval.cancel.own', 'iam', 'Withdraw an approval request you made while it is pending', false);

-- migrate:down
DELETE FROM iam.permission WHERE code IN ('iam.role.manage', 'iam.approval.read', 'iam.approval.cancel.own');
DELETE FROM iam.role_permission WHERE deleted_at IS NOT NULL;
ALTER TABLE iam.role_permission
  DROP CONSTRAINT ck_role_permission_soft_delete,
  DROP COLUMN delete_reason,
  DROP COLUMN deleted_by,
  DROP COLUMN deleted_at,
  DROP COLUMN updated_by,
  DROP COLUMN updated_at;
