-- 0224_platform_add_shift_document
-- B9b (FR-POS-015, ADR-0011, ADR-0015): a till shift is a business document, so a payment and an order can name the
-- shift they were taken in (`pay.payment.shift_document_id`, `ord.sales_order.shift_document_id`) and its journals have
-- a source document. Numbered per branch and fiscal year: SHF-2026-DDW-000312.
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`); refused by the foreign key once a shift exists, which is why 0226 is rolled
-- back first.

-- migrate:up
INSERT INTO platform.document_type (code, owner_module, name, is_numbered, series_prefix) VALUES
  ('SHIFT', 'pos', 'Till shift', true, 'SHF');

-- migrate:down
DELETE FROM platform.document_type WHERE code = 'SHIFT';
