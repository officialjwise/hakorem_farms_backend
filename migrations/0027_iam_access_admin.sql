-- 0027_iam_access_admin
-- User and grant administration (FR-IAM-001, FR-IAM-015, FR-IAM-022). Nobody revokes their own grant, as nobody grants
-- themselves one (ck_role_grant_not_self, migration 0004): the rule is the database's, not only the handler's.
-- Data category: none (a constraint).
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
ALTER TABLE iam.role_grant
  ADD CONSTRAINT ck_role_grant_not_self_revoked CHECK (deleted_by IS NULL OR deleted_by <> principal_id);

-- migrate:down
ALTER TABLE iam.role_grant DROP CONSTRAINT ck_role_grant_not_self_revoked;
