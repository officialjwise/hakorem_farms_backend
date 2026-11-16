-- 0117_platform_add_checkout_document
-- The storefront checkout is a business document (docs/data-model/shp.md, ADR-0011): it holds the stock reservations
-- that INV keys by `holder_document_id`. Not numbered: an order placed from it takes the order's number (B9a).
-- Data category: none (lookup row).
-- Rollback: tested (`pnpm db:rollback`), safe before the first checkout.

-- migrate:up
INSERT INTO platform.document_type (code, owner_module, name, is_numbered, series_prefix) VALUES
  ('CHECKOUT_SESSION', 'shp', 'Storefront checkout', false, NULL);

-- migrate:down
DELETE FROM platform.document_type WHERE code = 'CHECKOUT_SESSION';
