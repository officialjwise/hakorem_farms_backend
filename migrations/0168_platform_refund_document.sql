-- 0168_platform_refund_document
-- B09a continued (FR-PAY-012, A-210): a refund is a business document, unnumbered like the payment it returns (the
-- credit note or receipt is the customer's document); and a document's number is read by the document's id (`DocumentRegistry.numberedRefs`, the order
-- and the documents a payment names), so the read is a point read under serializable isolation (ADR-0005), never a scan.
-- Data category: none (a lookup row and an index).
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
INSERT INTO platform.document_type (code, owner_module, name, is_numbered, series_prefix) VALUES
  ('REFUND', 'pay', 'Refund', false, NULL);
CREATE INDEX ix_number_allocation_document ON platform.number_allocation (document_id);

-- migrate:down
DROP INDEX platform.ix_number_allocation_document;
DELETE FROM platform.document_type WHERE code = 'REFUND';
