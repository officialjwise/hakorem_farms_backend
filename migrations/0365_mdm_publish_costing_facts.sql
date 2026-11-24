-- 0365_mdm_publish_costing_facts
-- B12 continued 2 (FR-CST-003, FR-CST-007, ADR-0011, ADR-0023): what costing reads of the catalogue and the reason
-- codes, as published views only.
--   mdm.pub_product      gains, at its end, the product line of the product's category (LIVE, MEAT, PRODUCE, ...)
--   mdm.pub_reason_code  each reason code's domain and the loss group a write-off under it posts to (5100, 5110, 5120)
-- Data category: INTERNAL (DC-13); no personal data.
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
CREATE OR REPLACE VIEW mdm.pub_product AS
SELECT p.id AS product_id, p.sku, p.name, p.tracking, p.stock_policy, p.species_id, s.code AS species_code, s.name AS species_name,
       c.product_line
  FROM mdm.product p
  LEFT JOIN mdm.species s ON s.id = p.species_id
  JOIN mdm.category c ON c.id = p.category_id;

CREATE VIEW mdm.pub_reason_code AS
SELECT r.code, r.domain, r.description, r.loss_account_group FROM mdm.reason_code r;

GRANT SELECT ON mdm.pub_reason_code TO hk_app, hk_worker, hk_report;

-- migrate:down
DROP VIEW mdm.pub_reason_code;
DROP VIEW mdm.pub_product;
CREATE VIEW mdm.pub_product AS
SELECT p.id AS product_id, p.sku, p.name, p.tracking, p.stock_policy, p.species_id, s.code AS species_code, s.name AS species_name
  FROM mdm.product p
  LEFT JOIN mdm.species s ON s.id = p.species_id;
GRANT SELECT ON mdm.pub_product TO hk_app, hk_worker, hk_report;
