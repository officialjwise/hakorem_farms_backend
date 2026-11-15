-- 0013_platform_add_tax_scheme_document
-- The TAX_SCHEME_VERSION document type, so a tax scheme version can be registered as a business document and
-- approved through iam.approval_request (ADR-0011, ADR-0017, ADR-0020).
-- Data category: none (one lookup row).
-- Rollback: tested (`pnpm db:rollback`); refused by the foreign key once a version is registered, which is why 0014
-- is rolled back first.

-- migrate:up
INSERT INTO platform.document_type (code, owner_module, name, is_numbered, series_prefix) VALUES
  ('TAX_SCHEME_VERSION', 'mdm', 'Tax scheme version', false, NULL);

-- migrate:down
DELETE FROM platform.document_type WHERE code = 'TAX_SCHEME_VERSION';
