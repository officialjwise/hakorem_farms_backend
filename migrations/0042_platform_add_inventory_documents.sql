-- 0042_platform_add_inventory_documents
-- The document types the inventory module registers in platform.business_document (ADR-0011): the four numbered
-- stock documents of docs/data-model/inv.md, and a stock hold placed by hand (an INVESTIGATION hold has no other
-- document to name as its source). The tables of the four documents arrive with their workflows; the types exist
-- first so a stock movement can name its source document from the start (FR-INV-002).
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`); refused by the foreign key once a document of one of these types exists,
-- which is why 0044 is rolled back first.

-- migrate:up
INSERT INTO platform.document_type (code, owner_module, name, is_numbered, series_prefix) VALUES
  ('GOODS_RECEIPT', 'inv', 'Goods receipt', true, 'GRN'),
  ('STOCK_TRANSFER', 'inv', 'Stock transfer', true, 'TRF'),
  ('STOCK_ADJUSTMENT', 'inv', 'Stock adjustment', true, 'ADJ'),
  ('STOCK_TAKE', 'inv', 'Stock take', true, 'STK'),
  ('STOCK_HOLD', 'inv', 'Stock hold placed by hand', false, NULL);

-- migrate:down
DELETE FROM platform.document_type WHERE code IN ('GOODS_RECEIPT', 'STOCK_TRANSFER', 'STOCK_ADJUSTMENT', 'STOCK_TAKE', 'STOCK_HOLD');
