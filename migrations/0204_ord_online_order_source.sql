-- 0204_ord_online_order_source
-- B09a continued 2f (FR-SHP-005, FR-ORD-001, A-232): an online order is placed once from its checkout, held by the
-- database:
--   uq_sales_order_online_source   at most one ONLINE order names a given source document (the checkout it was placed
--                                  from); it is also the point read that the order's hold-ended and payment handlers
--                                  take under serializable isolation, so they never scan the table (ADR-0005)
-- No column is added. docs/data-model/ord.md names the index.
-- Data category: CONFIDENTIAL (DC-22): commercial history.
-- Rollback: tested (`pnpm db:rollback`), always safe: dropping the index removes a rule and writes nothing.

-- migrate:up
CREATE UNIQUE INDEX uq_sales_order_online_source ON ord.sales_order (source_document_id) WHERE channel = 'ONLINE' AND source_document_id IS NOT NULL;

-- migrate:down
DROP INDEX ord.uq_sales_order_online_source;
