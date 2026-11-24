-- 0373_iam_rpt_exception_permissions
-- B12 continued 3 (FR-RPT-007, CR-059 point 5, ADR-0103): the daily exception report's permissions and grants.
--   rpt.exceptions.read    the daily exception report and the list of exception items
--   rpt.exceptions.review  mark an exception item reviewed with a note
-- Grants (the owner, 2026-11-23): the Owner and the Manager read and review; the Accountant reads. The report goes to
-- the owner, not to the approvers (FR-RPT-007): no other role holds either. An item about the investor books is shown
-- only to a reader who also holds cap.capital.read (the application).
-- Data category: none (lookup rows and grants).
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
INSERT INTO iam.permission (code, module, description, requires_step_up) VALUES
  ('rpt.exceptions.read', 'rpt', 'Read the daily exception report and the exception items', false),
  ('rpt.exceptions.review', 'rpt', 'Mark an exception item reviewed with a note', false);

INSERT INTO iam.role_permission (role_id, permission_code, created_by, updated_by)
SELECT r.id, p.code, '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001'
  FROM iam.role r JOIN (VALUES
    ('OWNER', 'rpt.exceptions.read'), ('OWNER', 'rpt.exceptions.review'),
    ('MANAGER', 'rpt.exceptions.read'), ('MANAGER', 'rpt.exceptions.review'),
    ('ACCOUNTANT', 'rpt.exceptions.read')
  ) AS p (role, code) ON p.role = r.code
 WHERE r.deleted_at IS NULL
ON CONFLICT DO NOTHING;

-- migrate:down
DELETE FROM iam.role_permission WHERE permission_code IN ('rpt.exceptions.read', 'rpt.exceptions.review');
DELETE FROM iam.permission WHERE code IN ('rpt.exceptions.read', 'rpt.exceptions.review');
