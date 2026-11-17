-- 0222_platform_add_supplier_claim_document
-- B09e continued 3 (the owner's decision 5 of 2026-11-17, CR-036, ADR-0076): the document a claim raised from a posted
-- goods receipt's rejected lines is registered as. Not numbered: the claim is known by its receipt, and the supplier's
-- credit note that settles it carries the supplier's own number.
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`); refused by the foreign key once a claim exists, which is why 0223 is rolled
-- back first.

-- migrate:up
INSERT INTO platform.document_type (code, owner_module, name, is_numbered, series_prefix) VALUES
  ('SUPPLIER_CLAIM', 'pur', 'Supplier claim from a goods receipt', false, NULL);

-- migrate:down
DELETE FROM platform.document_type WHERE code = 'SUPPLIER_CLAIM';
