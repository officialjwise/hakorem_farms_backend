-- 0038_platform_export_purpose
-- A file the server writes for a master data export (FR-MDM-020, A-128) is a stored file of its own use, `EXPORT`,
-- so it is never mistaken for an uploaded import. It is registered PENDING like any other file and is linked only
-- once the worker's scan has said CLEAN (ADR-0044, unchanged): the store never serves a file it has not scanned.
-- Data category: none (a constraint).
-- Rollback: tested (`pnpm db:rollback`), safe before the first export; afterwards forward fix only.

-- migrate:up
ALTER TABLE platform.stored_file DROP CONSTRAINT ck_stored_file_purpose;
ALTER TABLE platform.stored_file ADD CONSTRAINT ck_stored_file_purpose CHECK (purpose IN (
  'PRODUCT_IMAGE', 'PROOF_OF_DELIVERY', 'SIGNATURE', 'SUPPLIER_DOCUMENT', 'SUPPLIER_INVOICE',
  'INVESTOR_DOCUMENT', 'IMPORT', 'EXPORT', 'EVIDENCE', 'STATEMENT', 'AGREEMENT'));

-- migrate:down
ALTER TABLE platform.stored_file DROP CONSTRAINT ck_stored_file_purpose;
ALTER TABLE platform.stored_file ADD CONSTRAINT ck_stored_file_purpose CHECK (purpose IN (
  'PRODUCT_IMAGE', 'PROOF_OF_DELIVERY', 'SIGNATURE', 'SUPPLIER_DOCUMENT', 'SUPPLIER_INVOICE',
  'INVESTOR_DOCUMENT', 'IMPORT', 'EVIDENCE', 'STATEMENT', 'AGREEMENT'));
