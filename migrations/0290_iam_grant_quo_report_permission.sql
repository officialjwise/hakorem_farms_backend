-- 0290_iam_grant_quo_report_permission
-- Who reads the quote pipeline (FR-QUO-013's actors, A-329): Sales and the Manager, and the Owner, who holds every
-- permission of the roles they grant (FR-IAM-022). Every other role holds none: the most conservative reading.
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
INSERT INTO iam.role_permission (role_id, permission_code, created_by, updated_by)
SELECT r.id, 'quo.report.read', '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001'
  FROM iam.role r
 WHERE r.code IN ('OWNER', 'MANAGER', 'SALES') AND r.deleted_at IS NULL
ON CONFLICT DO NOTHING;

-- migrate:down
DELETE FROM iam.role_permission WHERE permission_code = 'quo.report.read';
