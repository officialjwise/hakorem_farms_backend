-- 0367_ord_publish_sale_dimensions
-- B12 continued 2 (FR-CST-003, ADR-0011, ADR-0023): the dimensions a margin is cut by, for every order whatever its
-- status, and the order each order line belongs to (a sale issue's line reference is its order line).
--   ord.pub_sale_order  order, branch, channel, customer, salesperson
--   ord.pub_sale_line   order line, its order, product, and the order's branch, channel, customer and salesperson
-- Data category: CONFIDENTIAL (DC-09): ids only, no contact details.
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
CREATE VIEW ord.pub_sale_order AS
SELECT o.id AS order_id, o.branch_id, o.channel, o.customer_id, o.salesperson_id FROM ord.sales_order o;

CREATE VIEW ord.pub_sale_line AS
SELECT l.id AS line_id, o.id AS order_id, l.product_id, o.branch_id, o.channel, o.customer_id, o.salesperson_id
  FROM ord.sales_order_line l
  JOIN ord.sales_order o ON o.id = l.sales_order_id;

GRANT SELECT ON ord.pub_sale_order, ord.pub_sale_line TO hk_app, hk_worker, hk_report;

-- migrate:down
DROP VIEW ord.pub_sale_line;
DROP VIEW ord.pub_sale_order;
