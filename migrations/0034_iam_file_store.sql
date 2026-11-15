-- 0034_iam_file_store
-- IAM's side of the file store (ADR-0044; FR-DOC-006, FR-DOC-007, FR-IAM-012). Adds `evidence_file_id` to an approval
-- request, with its foreign key to `platform.stored_file` (a published key, downward from IAM to platform), as the
-- expand migration that 0006 named. Adds the SYSTEM principal the worker's malware scanner acts as, so a scan verdict
-- in the audit trail names who gave it. Seeds the three permission codes of the file operations, granted to no role
-- here: migration 0035 grants them (A-124).
-- Data category: INTERNAL (a reference to a file; lookup rows).
-- Rollback: tested (`pnpm db:rollback`). It fails once a scan has been audited under the scanner principal; then
-- forward fix only.

-- migrate:up
ALTER TABLE iam.approval_request
  ADD COLUMN evidence_file_id uuid NULL CONSTRAINT fk_approval_request_evidence_file REFERENCES platform.stored_file (id) ON DELETE RESTRICT;

INSERT INTO iam.principal (id, kind, display_name, status, created_by, updated_by) VALUES
  ('01900000-0000-7000-8000-000000000005', 'SYSTEM', 'Malware scanner', 'ACTIVE', '01900000-0000-7000-8000-000000000005', '01900000-0000-7000-8000-000000000005');

INSERT INTO iam.permission (code, module, description, requires_step_up) VALUES
  ('platform.file.upload', 'platform', 'Upload a file for a stated use (a product photograph, evidence, a supplier document)', false),
  ('platform.file.read', 'platform', 'Read the metadata of a file you uploaded, and issue a signed link to it once it is clean', false),
  ('platform.file.read.any', 'platform', 'Read and issue signed links to files other people uploaded', false);

-- migrate:down
DELETE FROM iam.permission WHERE code IN ('platform.file.upload', 'platform.file.read', 'platform.file.read.any');
DELETE FROM iam.principal WHERE id = '01900000-0000-7000-8000-000000000005';
ALTER TABLE iam.approval_request DROP COLUMN evidence_file_id;
