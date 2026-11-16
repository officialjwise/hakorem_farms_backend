-- 0154_iam_grant_doc_permissions
-- Who reads and manages templates and the archive, and who reprints (FR-DOC-004, FR-BIL-009, A-202): the Owner and
-- the Manager manage templates (the SRS's actors), and with the Accountant read them and the archive; the Owner, the
-- Manager and the Cashier reprint (FR-BIL-009's actors). Sales and the Cashier read billing documents already
-- (0150) but not the archive, which also holds statements and investor schedules.
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
INSERT INTO iam.role_permission (role_id, permission_code, created_by, updated_by)
SELECT r.id, p.code, '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001'
  FROM iam.role r JOIN (VALUES
    ('OWNER', 'doc.template.read'), ('MANAGER', 'doc.template.read'), ('ACCOUNTANT', 'doc.template.read'),
    ('OWNER', 'doc.template.manage'), ('MANAGER', 'doc.template.manage'),
    ('OWNER', 'doc.document.read'), ('MANAGER', 'doc.document.read'), ('ACCOUNTANT', 'doc.document.read'),
    ('OWNER', 'bil.document.reprint'), ('MANAGER', 'bil.document.reprint'), ('CASHIER', 'bil.document.reprint')
  ) AS p (role, code) ON p.role = r.code
 WHERE r.deleted_at IS NULL
ON CONFLICT DO NOTHING;

-- migrate:down
DELETE FROM iam.role_permission WHERE permission_code IN ('doc.template.read', 'doc.template.manage', 'doc.document.read', 'bil.document.reprint');
