-- 0336_iam_seed_ntf_permissions
-- B11 continued 10 (FR-NTF-001, FR-NTF-007, A-374): who reads and changes the message templates, and who reads the
-- message log and retries a failed message; and the principal a messaging provider's webhook acts as, which holds no
-- grant (as the payment provider's, 0164):
--   ntf.template.read     list, read and preview the message templates
--   ntf.template.manage   draft a template version, and activate another person's draft (never one's own, 0335)
--   ntf.message.read      read the message log: what was sent to whom (masked) and when, with every attempt
--   ntf.message.retry     queue a failed message again; a suppressed message is never sent
-- Granted to no role here; 0337 grants them.
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
INSERT INTO iam.principal (id, kind, display_name, status, created_by, updated_by) VALUES
  ('01900000-0000-7000-8000-000000000008', 'SYSTEM', 'Messaging provider webhook', 'ACTIVE', '01900000-0000-7000-8000-000000000008', '01900000-0000-7000-8000-000000000008');

INSERT INTO iam.permission (code, module, description, requires_step_up) VALUES
  ('ntf.template.read', 'ntf', 'List, read and preview the message templates', false),
  ('ntf.template.manage', 'ntf', 'Draft a message template version, and activate a version another person drafted', false),
  ('ntf.message.read', 'ntf', 'Read the message log: what was sent to whom, masked, and when, with every attempt', false),
  ('ntf.message.retry', 'ntf', 'Queue a failed message to be sent again; a suppressed message is never sent', false);

-- migrate:down
DELETE FROM iam.role_permission WHERE permission_code IN ('ntf.template.read', 'ntf.template.manage', 'ntf.message.read', 'ntf.message.retry');
DELETE FROM iam.permission WHERE code IN ('ntf.template.read', 'ntf.template.manage', 'ntf.message.read', 'ntf.message.retry');
DELETE FROM iam.principal WHERE id = '01900000-0000-7000-8000-000000000008';
