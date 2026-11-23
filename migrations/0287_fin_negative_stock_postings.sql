-- 0287_fin_negative_stock_postings
-- B09b continued 3c (the owner's decision 2 of 2026-11-18, ADR-0081, ADR-0003 Amendments, A-283): stock an offline
-- sale took below zero is valued at the last known cost and trued up when stock arrives, and the inventory accounts
-- still reconcile to the cost pools. A new account holds the cost of what was sold before it was received:
--   1335 Stock sold ahead of receipt (asset, credit balance while open, no subledger)
--   inv.NegativeStockCosted   value: Dr cost of sales by the product's GL group, Cr 1335 (the uncovered quantity at the
--                             last known cost; the pool gave only what it held, which inv.StockIssuedForSale posted)
--   inv.NegativeStockTrueUp   cleared: Dr 1335, Cr cost of sales (the last known cost of what arrived to cover it);
--                             trueUp:  Dr cost of sales, Cr inventory by the GL group (its cost as it arrived, out of
--                             the pool). Cost of sales moves by exactly the difference; 1335 is back to zero once all is
--                             settled; each posts once per subject (uq_journal_entry_negative_stock).
-- New rows only; no existing rule, account or determination changes.
-- Data category: CONFIDENTIAL (DC-09): the farm's books.
-- Rollback: tested (`pnpm db:rollback`) before the first offline sale below zero; afterwards forward fix only.

-- migrate:up
INSERT INTO fin.account (id, code, name, type, normal_side, is_postable, subledger_kind, cash_flow_category, status, created_by, updated_by) VALUES
  ('01900000-0000-7000-8100-000000001335', '1335', 'Stock sold ahead of receipt', 'ASSET', 'C', true, NULL, 'OPERATING', 'ACTIVE',
   '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001');

INSERT INTO fin.posting_event_type (code, owner_module, description, amount_keys) VALUES
  ('inv.NegativeStockCosted', 'inv', 'Stock an offline sale took below zero, at the last known cost', ARRAY['value']),
  ('inv.NegativeStockTrueUp', 'inv', 'Stock sold ahead of receipt trued up to its cost on arrival', ARRAY['cleared', 'trueUp']);

INSERT INTO fin.posting_rule (id, event_code, amount_key, side, account_id, determinant_type, determinant_role, subledger_from, valid_from, created_by, updated_by)
SELECT ('01900000-0000-7000-8300-' || lpad(r.n::text, 12, '0'))::uuid, r.event, r.amount, r.side,
       CASE WHEN r.code IS NULL THEN NULL ELSE ('01900000-0000-7000-8100-00000000' || r.code)::uuid END,
       r.det_type, r.det_role, NULL, DATE '2020-01-01', '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001'
  FROM (VALUES
    (286, 'inv.NegativeStockCosted', 'value', 'D', NULL, 'GL_GROUP', 'COST_OF_SALES'),
    (287, 'inv.NegativeStockCosted', 'value', 'C', '1335', NULL, NULL),
    (288, 'inv.NegativeStockTrueUp', 'cleared', 'D', '1335', NULL, NULL),
    (289, 'inv.NegativeStockTrueUp', 'cleared', 'C', NULL, 'GL_GROUP', 'COST_OF_SALES'),
    (290, 'inv.NegativeStockTrueUp', 'trueUp', 'D', NULL, 'GL_GROUP', 'COST_OF_SALES'),
    (291, 'inv.NegativeStockTrueUp', 'trueUp', 'C', NULL, 'GL_GROUP', 'INVENTORY')
  ) AS r (n, event, amount, side, code, det_type, det_role);

CREATE UNIQUE INDEX uq_journal_entry_negative_stock ON fin.journal_entry (event_code, event_subject_id)
  WHERE event_code IN ('inv.NegativeStockCosted', 'inv.NegativeStockTrueUp');

-- migrate:down
DROP INDEX fin.uq_journal_entry_negative_stock;
DELETE FROM fin.posting_rule WHERE event_code IN ('inv.NegativeStockCosted', 'inv.NegativeStockTrueUp');
DELETE FROM fin.posting_event_type WHERE code IN ('inv.NegativeStockCosted', 'inv.NegativeStockTrueUp');
DELETE FROM fin.account WHERE id = '01900000-0000-7000-8100-000000001335';
