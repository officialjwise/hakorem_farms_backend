-- 0149_iam_seed_bil_permissions
-- B08 continued 2 (FR-BIL-006, FR-BIL-007, ADR-0017, A-200): reading billing documents, issuing credit and debit notes,
-- and approving a credit note, as contract/openapi.yaml names them; and the CREDIT_NOTE approval: every credit note
-- issued on its own (not by a return) waits for a holder of bil.credit_note.approve other than its maker, whatever its
-- amount, with a fresh step-up (the contract: "a standalone credit note needs approval"). Granted to no role here;
-- 0150 grants them. The threshold is data: a lower-risk policy is a row change with no code change.
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
INSERT INTO iam.permission (code, module, description, requires_step_up) VALUES
  ('bil.document.read', 'bil', 'Read invoices, receipts, proformas, credit notes and debit notes', false),
  ('bil.credit_note.create', 'bil', 'Raise a credit note against an issued invoice or receipt (it waits for a different approver)', false),
  ('bil.credit_note.approve', 'bil', 'Approve a credit note raised by someone else, so it is issued and posted', true),
  ('bil.debit_note.create', 'bil', 'Issue a debit note adding a charge to an issued invoice or receipt', false);

INSERT INTO iam.approval_policy (id, kind, branch_id, threshold_pesewas, approver_permission, requires_evidence, requires_step_up, created_by, updated_by) VALUES
  ('01900000-0000-7000-8000-000000000420', 'CREDIT_NOTE', NULL, NULL, 'bil.credit_note.approve', false, true,
   '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001');

-- migrate:down
DELETE FROM iam.approval_policy WHERE id = '01900000-0000-7000-8000-000000000420';
DELETE FROM iam.role_permission WHERE permission_code IN ('bil.document.read', 'bil.credit_note.create', 'bil.credit_note.approve', 'bil.debit_note.create');
DELETE FROM iam.permission WHERE code IN ('bil.document.read', 'bil.credit_note.create', 'bil.credit_note.approve', 'bil.debit_note.create');
