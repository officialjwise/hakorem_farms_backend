-- 0093_platform_add_purchasing_documents
-- The document types the procurement module registers in platform.business_document (ADR-0011): a purchase order
-- (the document a goods receipt names in `order_document_id`, which inventory already checks by this code), a
-- supplier invoice or credit note, and a supplier payment. The order and the payment are numbered once document
-- numbering exists (B8); a supplier invoice carries the supplier's own number and is never numbered by the farm.
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`); refused by the foreign key once a document of one of these types exists,
-- which is why 0094 is rolled back first.

-- migrate:up
INSERT INTO platform.document_type (code, owner_module, name, is_numbered, series_prefix) VALUES
  ('PURCHASE_ORDER', 'pur', 'Purchase order', true, 'PO'),
  ('SUPPLIER_INVOICE', 'pur', 'Supplier invoice', false, NULL),
  ('SUPPLIER_PAYMENT', 'pur', 'Supplier payment', true, 'SPY');

-- migrate:down
DELETE FROM platform.document_type WHERE code IN ('PURCHASE_ORDER', 'SUPPLIER_INVOICE', 'SUPPLIER_PAYMENT');
