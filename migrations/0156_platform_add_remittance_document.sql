-- 0156_platform_add_remittance_document
-- B08 continued 2c (FR-PUR-013, FR-DOC-002, ADR-0011, ADR-0062): the supplier remittance advice is a business document
-- of its own, owned by PUR and rendered and archived by DOC. It carries no number of its own: it prints the payment's.
-- Its id is the id of its `pur.supplier_remittance` row, registered in the transaction that marks the payment paid.
-- Data category: none (a lookup row).
-- Rollback: tested (`pnpm db:rollback`), safe before the first remittance advice; afterwards forward fix only.

-- migrate:up
INSERT INTO platform.document_type (code, owner_module, name, is_numbered, series_prefix) VALUES
  ('REMITTANCE_ADVICE', 'pur', 'Supplier remittance advice', false, NULL);

-- migrate:down
DELETE FROM platform.document_type WHERE code = 'REMITTANCE_ADVICE';
