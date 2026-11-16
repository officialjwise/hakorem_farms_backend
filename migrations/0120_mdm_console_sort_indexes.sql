-- 0120_mdm_console_sort_indexes
-- The indexes behind listProducts' server-side sort (CR-019, ADR-0054, B07 continued 3): one per allowed field, each
-- ending in the product id, the tie-breaker the shared keyset pages by, over live products only as the list reads
-- them. Sorting by category is by the category's name, so the category's name has its own index and the product's
-- category its index ending in the id; both are MDM's own tables. The default order (newest first) is the primary key.
-- No rule and no data change: indexes only.
-- Rollback: tested (`pnpm db:rollback`), safe at any time (the list then sorts without an index).

-- migrate:up
CREATE INDEX ix_product_sort_name ON mdm.product (lower(name), id) WHERE deleted_at IS NULL;
CREATE INDEX ix_product_sort_sku ON mdm.product (sku, id) WHERE deleted_at IS NULL;
CREATE INDEX ix_product_sort_category ON mdm.product (category_id, id) WHERE deleted_at IS NULL;
CREATE INDEX ix_product_sort_status ON mdm.product (status, id) WHERE deleted_at IS NULL;
CREATE INDEX ix_product_sort_updated ON mdm.product (updated_at, id) WHERE deleted_at IS NULL;
CREATE INDEX ix_category_sort_name ON mdm.category (lower(name), id);

-- migrate:down
DROP INDEX mdm.ix_category_sort_name;
DROP INDEX mdm.ix_product_sort_updated;
DROP INDEX mdm.ix_product_sort_status;
DROP INDEX mdm.ix_product_sort_category;
DROP INDEX mdm.ix_product_sort_sku;
DROP INDEX mdm.ix_product_sort_name;
