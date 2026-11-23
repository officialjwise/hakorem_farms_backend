-- 0299_platform_add_delivery_document
-- B11 continued (FR-DEL-003, ADR-0011, ADR-0015): a delivery is a business document, created at dispatch and numbered
-- from its own gap-free series per fiscal year and branch (`DLN-2026-DDW-000001`), the number the driver and the
-- customer read.
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`), safe before the first delivery; afterwards forward fix only.

-- migrate:up
INSERT INTO platform.document_type (code, owner_module, name, is_numbered, series_prefix) VALUES
  ('DELIVERY', 'del', 'Delivery of an order to its customer', true, 'DLN');

-- migrate:down
DELETE FROM platform.document_type WHERE code = 'DELIVERY';
