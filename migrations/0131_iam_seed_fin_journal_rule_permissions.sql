-- 0131_iam_seed_fin_journal_rule_permissions
-- B08 continued 1b (FR-FIN-004, FR-FIN-005, FR-FIN-008, ADR-0017, A-190, A-191): the permissions of FIN's journals,
-- manual journals and posting rule and determination changes, as contract/openapi.yaml names them, and their two
-- approval kinds. A manual journal and a rule or determination change take effect only when a different person who
-- holds the approving permission approves it, whatever the amount, with a fresh step-up. Asking for a rule change needs
-- step-up too (the contract's x-requires-step-up on createPostingRule and createAccountDetermination).
-- Granted to no role here; 0132 grants them.
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
INSERT INTO iam.permission (code, module, description, requires_step_up) VALUES
  ('fin.journal.read', 'fin', 'Read posted journal entries, account activity and manual journals', false),
  ('fin.journal.create', 'fin', 'Draft, change and submit a manual journal, including the opening balance journal', false),
  ('fin.journal.approve', 'fin', 'Approve a manual journal drafted by someone else, which then posts', true),
  ('fin.posting_rule.read', 'fin', 'Read the posting event types, posting rules and account determinations', false),
  ('fin.posting_rule.manage', 'fin', 'Ask to change a posting rule or an account determination from a date', true),
  ('fin.posting_rule.approve', 'fin', 'Approve a posting rule or account determination change asked for by someone else', true);

INSERT INTO iam.approval_policy (id, kind, branch_id, threshold_pesewas, approver_permission, requires_evidence, requires_step_up, created_by, updated_by) VALUES
  ('01900000-0000-7000-8000-000000000415', 'MANUAL_JOURNAL', NULL, NULL, 'fin.journal.approve', false, true,
   '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001'),
  ('01900000-0000-7000-8000-000000000416', 'POSTING_RULE_CHANGE', NULL, NULL, 'fin.posting_rule.approve', false, true,
   '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001');

-- migrate:down
DELETE FROM iam.approval_policy WHERE id IN ('01900000-0000-7000-8000-000000000415', '01900000-0000-7000-8000-000000000416');
DELETE FROM iam.role_permission WHERE permission_code IN ('fin.journal.read', 'fin.journal.create', 'fin.journal.approve', 'fin.posting_rule.read', 'fin.posting_rule.manage', 'fin.posting_rule.approve');
DELETE FROM iam.permission WHERE code IN ('fin.journal.read', 'fin.journal.create', 'fin.journal.approve', 'fin.posting_rule.read', 'fin.posting_rule.manage', 'fin.posting_rule.approve');
