-- 0174_iam_grant_manager_credit_notes
-- The owner, 2026-11-16 (from the frontend's F8; A-200 (c) amended): a credit note is raised by the Owner, the
-- Accountant and the Manager. A Cashier may not: counter refunds are till returns, built in B9b. An Owner or a Manager
-- approves (bil.credit_note.approve, unchanged), never the person who raised it (ck on iam.approval_request, ADR-0017),
-- so a Manager's own credit note is approved by another Manager or the Owner. 0150 is not edited: this adds one row.
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
INSERT INTO iam.role_permission (role_id, permission_code, created_by, updated_by)
SELECT r.id, 'bil.credit_note.create', '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001'
  FROM iam.role r
 WHERE r.code = 'MANAGER' AND r.deleted_at IS NULL
ON CONFLICT DO NOTHING;

-- migrate:down
DELETE FROM iam.role_permission
 WHERE permission_code = 'bil.credit_note.create' AND role_id IN (SELECT id FROM iam.role WHERE code = 'MANAGER');
