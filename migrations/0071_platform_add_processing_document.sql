-- 0071_platform_add_processing_document
-- The document a processing order is registered as (FR-PRC-001, ADR-0011): the source document of the movements that
-- consume its inputs and receive its output lots, and of the lineage between them. Numbered, like a goods receipt;
-- the number is allocated once document numbering exists (B8), so until then `order_no` is null.
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`); refused by the foreign key once an order exists, which is why 0072 is rolled
-- back first.

-- migrate:up
INSERT INTO platform.document_type (code, owner_module, name, is_numbered, series_prefix) VALUES
  ('PROCESSING_ORDER', 'prc', 'Processing order', true, 'PRO');

-- migrate:down
DELETE FROM platform.document_type WHERE code = 'PROCESSING_ORDER';
