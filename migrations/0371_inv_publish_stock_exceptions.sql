-- 0371_inv_publish_stock_exceptions
-- B12 continued 3 (FR-RPT-007, ADR-0011, ADR-0023, ADR-0103): inventory's stock exception queue as RPT's daily
-- exception report reads it (abuse cases 11, 15, 20, 23 to 25, 36). Most exceptions are raised by the ledger's own
-- triggers, so the person is the actor of the movement that raised it, where there is one.
-- Data category: INTERNAL: stock facts; people as ids only.
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
CREATE VIEW inv.pub_stock_exception AS
SELECT e.id, e.kind, e.branch_id, e.product_id, e.stock_unit_id, e.location_id, e.movement_id, e.source_document_id,
       e.qty, e.raised_at, e.status, m.actor_id
  FROM inv.stock_exception e
  LEFT JOIN inv.stock_movement m ON m.id = e.movement_id;

REVOKE ALL ON inv.pub_stock_exception FROM PUBLIC;
GRANT SELECT ON inv.pub_stock_exception TO hk_app, hk_worker, hk_report;

-- migrate:down
DROP VIEW inv.pub_stock_exception;
