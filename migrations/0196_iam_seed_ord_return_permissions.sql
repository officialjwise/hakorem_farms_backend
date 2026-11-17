-- 0196_iam_seed_ord_return_permissions
-- B09a continued 2d (FR-ORD-015, ADR-0017, ADR-0035, ADR-0066, abuse case 12, A-228): the permissions of a return
-- against the original sale, as contract/openapi.yaml names them, and the RETURN approval: every return waits for a
-- holder of ord.return.approve who did not make it, whatever its amount, with a fresh step-up, because the credit note
-- it issues and the refund it asks for are money (A-200 (c): no credit note is issued without a second person).
-- Granted to no role here; 0197 grants them. The threshold is data.
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
INSERT INTO iam.permission (code, module, description, requires_step_up) VALUES
  ('ord.return.read', 'ord', 'See returns against sales', false),
  ('ord.return.create', 'ord', 'Make a return against the original sale and submit it for approval', false),
  ('ord.return.approve', 'ord', 'Approve a return someone else made: its credit note, its stock and its refund request', true);

INSERT INTO iam.approval_policy (id, kind, branch_id, threshold_pesewas, approver_permission, requires_evidence, requires_step_up, created_by, updated_by) VALUES
  ('01900000-0000-7000-8000-000000000425', 'RETURN', NULL, 0, 'ord.return.approve', false, true,
   '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001');

-- migrate:down
DELETE FROM iam.approval_policy WHERE id = '01900000-0000-7000-8000-000000000425';
DELETE FROM iam.role_permission WHERE permission_code IN ('ord.return.read', 'ord.return.create', 'ord.return.approve');
DELETE FROM iam.permission WHERE code IN ('ord.return.read', 'ord.return.create', 'ord.return.approve');
