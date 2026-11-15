-- 0016_platform_add_promotion_document
-- The PROMOTION document type, so a promotion can be registered as a business document and approved through
-- iam.approval_request (ADR-0011, ADR-0017, FR-MDM-018).
-- Data category: none (one lookup row).
-- Rollback: tested (`pnpm db:rollback`); refused by the foreign key once a promotion is registered, which is why 0017
-- is rolled back first.

-- migrate:up
INSERT INTO platform.document_type (code, owner_module, name, is_numbered, series_prefix) VALUES
  ('PROMOTION', 'mdm', 'Promotion', false, NULL);

-- migrate:down
DELETE FROM platform.document_type WHERE code = 'PROMOTION';
