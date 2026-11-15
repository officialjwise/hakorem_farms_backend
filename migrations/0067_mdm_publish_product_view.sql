-- 0067_mdm_publish_product_view
-- A published view of the catalogue for the reporting module (ADR-0011, ADR-0023, MODULE_BOUNDARIES RPT card): what
-- a product is (its SKU, name, how it is tracked and its stock-keeping policy) and its species, so the animals on hand
-- tile counts serialised live stock by species without reading mdm.product or mdm.species (B05x, A-149). Archived
-- products stay in the view: stock may still stand on a product archived since.
-- Data category: INTERNAL (DC-13); no personal data.
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
CREATE VIEW mdm.pub_product AS
SELECT p.id AS product_id, p.sku, p.name, p.tracking, p.stock_policy, p.species_id, s.code AS species_code, s.name AS species_name
  FROM mdm.product p
  LEFT JOIN mdm.species s ON s.id = p.species_id;

GRANT USAGE ON SCHEMA mdm TO hk_report;
GRANT SELECT ON mdm.pub_product TO hk_app, hk_worker, hk_report;

-- migrate:down
DROP VIEW mdm.pub_product;
REVOKE USAGE ON SCHEMA mdm FROM hk_report;
