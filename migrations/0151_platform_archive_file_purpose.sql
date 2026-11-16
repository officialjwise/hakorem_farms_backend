-- 0151_platform_archive_file_purpose
-- B08 continued 2b (FR-DOC-001, FR-BIL-008, ADR-0061): the bytes of a rendered, archived document are a stored file of
-- their own use, `ARCHIVE`, written by the worker under the `archive/` prefix and never uploaded by anyone. Like every
-- stored file it is registered PENDING and served only once the worker's scan has said CLEAN (ADR-0044, unchanged).
-- Data category: none (a constraint).
-- Rollback: tested (`pnpm db:rollback`), safe before the first archived document; afterwards forward fix only.

-- migrate:up
ALTER TABLE platform.stored_file DROP CONSTRAINT ck_stored_file_purpose;
ALTER TABLE platform.stored_file ADD CONSTRAINT ck_stored_file_purpose CHECK (purpose IN (
  'PRODUCT_IMAGE', 'PROOF_OF_DELIVERY', 'SIGNATURE', 'SUPPLIER_DOCUMENT', 'SUPPLIER_INVOICE',
  'INVESTOR_DOCUMENT', 'IMPORT', 'EXPORT', 'EVIDENCE', 'STATEMENT', 'AGREEMENT', 'ARCHIVE'));

-- migrate:down
ALTER TABLE platform.stored_file DROP CONSTRAINT ck_stored_file_purpose;
ALTER TABLE platform.stored_file ADD CONSTRAINT ck_stored_file_purpose CHECK (purpose IN (
  'PRODUCT_IMAGE', 'PROOF_OF_DELIVERY', 'SIGNATURE', 'SUPPLIER_DOCUMENT', 'SUPPLIER_INVOICE',
  'INVESTOR_DOCUMENT', 'IMPORT', 'EXPORT', 'EVIDENCE', 'STATEMENT', 'AGREEMENT'));
