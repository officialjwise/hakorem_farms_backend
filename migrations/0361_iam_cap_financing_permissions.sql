-- 0361_iam_cap_financing_permissions
-- B12 continued (FR-CAP-002, FR-CAP-015, ADR-0017, ADR-0101): the permissions of payout details and of loans and grants,
-- their approval policies and their grants.
--   cap.investor.payout.read     reveal an investor's payout details and identity number in full, step-up, each
--                                decryption audited (FR-CAP-002)
--   cap.investor.payout.approve  approve a change of an investor's payout details asked for by someone else, step-up
--   cap.financing.read           read loans and grants with their schedules
--   cap.financing.manage         record a loan or grant (a draft until approved) and record a repayment, step-up
--   cap.financing.approve        approve a loan or grant recorded by someone else (it is drawn and posted), step-up
-- Approval policies: every payout change (INVESTOR_PAYOUT_CHANGE) and every loan or grant (FINANCING), whatever the
-- amount, needs a different person holding the approver's permission, with a step-up within five minutes.
-- Grants (A-381, ADR-0101): the Accountant reads, records and repays; the Owner holds all of that and is the only
-- checker and the only one who reveals payout details in full. No other role holds any of it.
-- Data category: none (lookup rows and grants).
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
INSERT INTO iam.permission (code, module, description, requires_step_up) VALUES
  ('cap.investor.payout.read', 'cap', 'Reveal an investor''s payout details and identity number in full (each decryption audited)', true),
  ('cap.investor.payout.approve', 'cap', 'Approve a change of an investor''s payout details asked for by someone else', true),
  ('cap.financing.read', 'cap', 'Read loans and grants with their schedules and repayments', false),
  ('cap.financing.manage', 'cap', 'Record a loan or grant and record a repayment of a loan', true),
  ('cap.financing.approve', 'cap', 'Approve a loan or grant recorded by someone else', true);

INSERT INTO iam.approval_policy (id, kind, branch_id, threshold_pesewas, approver_permission, requires_evidence, requires_step_up, created_by, updated_by) VALUES
  ('01900000-0000-7000-8000-000000000663', 'INVESTOR_PAYOUT_CHANGE', NULL, 0, 'cap.investor.payout.approve', false, true,
   '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001'),
  ('01900000-0000-7000-8000-000000000664', 'FINANCING', NULL, 0, 'cap.financing.approve', false, true,
   '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001');

INSERT INTO iam.role_permission (role_id, permission_code, created_by, updated_by)
SELECT r.id, p.code, '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001'
  FROM iam.role r JOIN (VALUES
    ('OWNER', 'cap.investor.payout.read'), ('OWNER', 'cap.investor.payout.approve'),
    ('OWNER', 'cap.financing.read'), ('OWNER', 'cap.financing.manage'), ('OWNER', 'cap.financing.approve'),
    ('ACCOUNTANT', 'cap.financing.read'), ('ACCOUNTANT', 'cap.financing.manage')
  ) AS p (role, code) ON p.role = r.code
 WHERE r.deleted_at IS NULL
ON CONFLICT DO NOTHING;

-- migrate:down
DELETE FROM iam.role_permission WHERE permission_code IN ('cap.investor.payout.read', 'cap.investor.payout.approve', 'cap.financing.read', 'cap.financing.manage', 'cap.financing.approve');
DELETE FROM iam.approval_policy WHERE id IN ('01900000-0000-7000-8000-000000000663', '01900000-0000-7000-8000-000000000664');
DELETE FROM iam.permission WHERE code IN ('cap.investor.payout.read', 'cap.investor.payout.approve', 'cap.financing.read', 'cap.financing.manage', 'cap.financing.approve');
