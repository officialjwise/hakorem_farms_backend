-- 0195_platform_add_order_return_document
-- B09a continued 2d (FR-ORD-015, ADR-0011, ADR-0015, A-228): a return against the original sale is a business document,
-- numbered from its own gap-free series per fiscal year and branch when it is made (`RET-2026-DDW-000001`).
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`), safe before the first return; afterwards forward fix only.

-- migrate:up
INSERT INTO platform.document_type (code, owner_module, name, is_numbered, series_prefix) VALUES
  ('ORDER_RETURN', 'ord', 'Return against a sale', true, 'RET');

-- migrate:down
DELETE FROM platform.document_type WHERE code = 'ORDER_RETURN';
