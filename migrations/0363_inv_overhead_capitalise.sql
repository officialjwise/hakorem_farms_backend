-- 0363_inv_overhead_capitalise
-- B12 continued 2 (FR-CST-001, FR-CST-002, ADR-0018, ADR-0102): what costing needs from the stock ledger, added only.
--   OVERHEAD_CAPITALISE        a value-only movement carrying a share of a period's labour or overhead onto a growing
--                              stock unit (cost element LABOUR or OVERHEAD), published as ◆ inv.OverheadAbsorbed so the
--                              ledger moves it out of the period's cost and into inventory (0364), never against 1300
--                              as inv.CostCapitalised's feed and medication do
--   inv.pub_movement           gains, at its end, the cost element, the reason, the line reference, the issue a return
--                              returns and the actor, so costing classifies every movement without reading the table
--   inv.pub_negative_stock_cost each cost of stock an offline sale took below zero, and each true-up of it, as the change
--                              it made to cost of sales (signed: a true-up below the last known cost is negative), with
--                              the sale movement it belongs to and the day it posted
-- New rows and views only; no movement type, rule or column changes.
-- Data category: INTERNAL (DC-13): stock and cost, no personal data.
-- Rollback: tested (`pnpm db:rollback`) before the first allocation is posted; afterwards forward fix only.

-- migrate:up
INSERT INTO inv.movement_type (code, name, is_value_only, allows_negative, blocked_by_hold, requires_reason, requires_stock_unit, posting_event) VALUES
  ('OVERHEAD_CAPITALISE', 'Labour or overhead added to a stock unit', true, false, false, false, true, 'inv.OverheadAbsorbed');

CREATE OR REPLACE VIEW inv.pub_movement AS
SELECT m.id, m.movement_type, m.product_id, m.stock_unit_id, m.branch_id, m.from_location_id, m.to_location_id, m.qty_base,
       m.weight_kg, m.weight_source, m.value_pesewas, m.source_document_id, m.reverses_movement_id, m.occurred_at,
       m.cost_element, m.reason_code, m.source_line_ref, m.returns_movement_id, m.actor_id
  FROM inv.stock_movement m;

CREATE VIEW inv.pub_negative_stock_cost AS
SELECT c.id AS cost_ref, c.movement_id AS sale_movement_id, NULL::uuid AS true_up_movement_id, c.product_id, c.branch_id,
       c.value_pesewas::bigint AS cost_pesewas, m.occurred_at
  FROM inv.negative_stock_cost c
  JOIN inv.stock_movement m ON m.id = c.movement_id
UNION ALL
SELECT s.id, c.movement_id, s.true_up_movement_id, c.product_id, c.branch_id,
       (s.true_up_value_pesewas - s.cleared_value_pesewas)::bigint, a.occurred_at
  FROM inv.negative_stock_settlement s
  JOIN inv.negative_stock_cost c ON c.id = s.cost_id
  JOIN inv.stock_movement a ON a.id = s.arrival_movement_id;

GRANT SELECT ON inv.pub_negative_stock_cost TO hk_app, hk_worker, hk_report;

-- migrate:down
DROP VIEW inv.pub_negative_stock_cost;
DROP VIEW inv.pub_movement;
CREATE VIEW inv.pub_movement AS
SELECT m.id, m.movement_type, m.product_id, m.stock_unit_id, m.branch_id, m.from_location_id, m.to_location_id, m.qty_base,
       m.weight_kg, m.weight_source, m.value_pesewas, m.source_document_id, m.reverses_movement_id, m.occurred_at
  FROM inv.stock_movement m;
GRANT SELECT ON inv.pub_movement TO hk_app, hk_worker, hk_report;
DELETE FROM inv.movement_type WHERE code = 'OVERHEAD_CAPITALISE';
