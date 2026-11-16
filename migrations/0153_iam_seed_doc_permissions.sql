-- 0153_iam_seed_doc_permissions
-- B08 continued 2b (FR-DOC-001, FR-DOC-004, FR-DOC-007, FR-BIL-009, A-202): reading and managing document templates,
-- reading the document archive (its signed download links are logged), and reprinting a billing document, as
-- contract/openapi.yaml names them. Granted to no role here; 0154 grants them.
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
INSERT INTO iam.permission (code, module, description, requires_step_up) VALUES
  ('doc.template.read', 'doc', 'Read document templates and their versions, and preview a version', false),
  ('doc.template.manage', 'doc', 'Draft and activate document template versions', false),
  ('doc.document.read', 'doc', 'Read the document archive and download an archived document by a signed link', false),
  ('bil.document.reprint', 'bil', 'Reprint an issued billing document, marked as a reprint with its copy number', false);

-- migrate:down
DELETE FROM iam.role_permission WHERE permission_code IN ('doc.template.read', 'doc.template.manage', 'doc.document.read', 'bil.document.reprint');
DELETE FROM iam.permission WHERE code IN ('doc.template.read', 'doc.template.manage', 'doc.document.read', 'bil.document.reprint');
