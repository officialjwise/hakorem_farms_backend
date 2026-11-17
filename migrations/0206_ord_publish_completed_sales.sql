-- 0206_ord_publish_completed_sales
-- B09a continued 2g (FR-RPT-001, CR-013, A-149, A-234): ORD publishes its completed sales for RPT's owner dashboard
-- (ADR-0011, ADR-0023), so RPT never reads ORD's tables:
--   ord.pub_completed_sale        one row per COMPLETED order: its branch, channel, completion time, the Africa/Accra
--                                 business date it completed on, and its gross total (the billing document's). A
--                                 VOIDED, CANCELLED or still open order is not a sale and is not listed.
--   ord.pub_completed_sale_line   one row per line of a COMPLETED order: its product, the quantity sold (the weighed
--                                 kilograms of a line priced per kilogram, else the quantity in the line's unit) and
--                                 the line's gross total.
--   ix_sales_order_completed      the branch and completion time of completed orders, the range the dashboard reads.
-- Neither view reads the clock: a business date is the completion time in Africa/Accra (ADR-0067); the reader
-- chooses the dates from the application clock. No column is added. docs/data-model/ord.md names both views.
-- Data category: CONFIDENTIAL (DC-22): commercial history, no customer, contact or price-band detail.
-- Rollback: tested (`pnpm db:rollback`), always safe: dropping the views and the index writes nothing.

-- migrate:up
CREATE INDEX ix_sales_order_completed ON ord.sales_order (branch_id, completed_at) WHERE status = 'COMPLETED';

CREATE VIEW ord.pub_completed_sale AS
SELECT o.id AS order_id, o.branch_id, o.channel, o.completed_at, (o.completed_at AT TIME ZONE 'Africa/Accra')::date AS business_date,
       o.final_total_pesewas AS gross_pesewas
  FROM ord.sales_order o
 WHERE o.status = 'COMPLETED';

CREATE VIEW ord.pub_completed_sale_line AS
SELECT l.sales_order_id AS order_id, l.id AS line_id, o.branch_id, o.channel, o.completed_at,
       (o.completed_at AT TIME ZONE 'Africa/Accra')::date AS business_date, l.product_id,
       CASE l.price_basis WHEN 'PER_KG' THEN l.fulfilled_weight_kg ELSE l.qty_fulfilled END AS sold_qty,
       CASE l.price_basis WHEN 'PER_KG' THEN 'KG' ELSE l.uom END AS sold_uom,
       l.final_line_total_pesewas AS gross_pesewas
  FROM ord.sales_order_line l
  JOIN ord.sales_order o ON o.id = l.sales_order_id
 WHERE o.status = 'COMPLETED';

GRANT SELECT ON ord.pub_completed_sale, ord.pub_completed_sale_line TO hk_app, hk_worker, hk_report;

-- migrate:down
DROP VIEW ord.pub_completed_sale_line;
DROP VIEW ord.pub_completed_sale;
DROP INDEX ord.ix_sales_order_completed;
