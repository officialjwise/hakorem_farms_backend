-- 0293_platform_add_fulfilment_document
-- B11 (FR-ORD-008, ADR-0011, ADR-0015): a pick list (a fulfilment of all or part of an order) is a business document,
-- numbered from its own gap-free series per fiscal year and branch when it is made (`PCK-2026-DDW-000001`).
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`), safe before the first pick list; afterwards forward fix only.

-- migrate:up
INSERT INTO platform.document_type (code, owner_module, name, is_numbered, series_prefix) VALUES
  ('FULFILMENT', 'ord', 'Pick list and fulfilment of an order', true, 'PCK');

-- migrate:down
DELETE FROM platform.document_type WHERE code = 'FULFILMENT';
