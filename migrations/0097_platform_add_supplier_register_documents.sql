-- 0097_platform_add_supplier_register_documents
-- The document types the rest of procurement registers in platform.business_document (ADR-0011, B07 continued): a
-- change of a supplier's payout details, the subject a SUPPLIER_PAYOUT_CHANGE approval names (FR-PUR-002), and a
-- purchase requisition (FR-PUR-004). A requisition is numbered once document numbering exists (B8); a payout change
-- is never numbered.
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`); refused by the foreign key once a document of one of these types exists,
-- which is why 0098 and 0099 are rolled back first.

-- migrate:up
INSERT INTO platform.document_type (code, owner_module, name, is_numbered, series_prefix) VALUES
  ('SUPPLIER_PAYOUT_CHANGE', 'pur', 'Supplier payout detail change', false, NULL),
  ('PURCHASE_REQUISITION', 'pur', 'Purchase requisition', true, 'PRQ');

-- migrate:down
DELETE FROM platform.document_type WHERE code IN ('SUPPLIER_PAYOUT_CHANGE', 'PURCHASE_REQUISITION');
