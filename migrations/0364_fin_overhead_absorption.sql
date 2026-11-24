-- 0364_fin_overhead_absorption
-- B12 continued 2 (FR-CST-002, ADR-0003, ADR-0018, ADR-0102, A-387): a posted labour or overhead allocation moves the
-- capitalised share out of the period's cost and onto growing stock. The period's wages and overheads stay where they
-- were posted (6000, 6200, 6800 and the rest, gross); a new credit-normal cost account shows what was carried into stock,
-- as 5210 shows own production capitalised.
--   5220 Labour and overhead absorbed into stock (cost of sales, credit balance, no subledger)
--   inv.OverheadAbsorbed  value: Dr inventory by the product's GL group, Cr 5220
-- A breeding animal's share is not capitalised and posts nothing (ADR-0018): it stays in the period's cost.
-- New rows only; no existing rule, account or determination changes.
-- Data category: CONFIDENTIAL (DC-09): the farm's books.
-- Rollback: tested (`pnpm db:rollback`) before the first allocation is posted; afterwards forward fix only.

-- migrate:up
INSERT INTO fin.account (id, code, name, type, normal_side, is_postable, subledger_kind, cash_flow_category, status, created_by, updated_by) VALUES
  ('01900000-0000-7000-8100-000000005220', '5220', 'Labour and overhead absorbed into stock', 'COST_OF_SALES', 'C', true, NULL, 'OPERATING', 'ACTIVE',
   '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001');

INSERT INTO fin.posting_event_type (code, owner_module, description, amount_keys) VALUES
  ('inv.OverheadAbsorbed', 'inv', 'A share of a period''s labour or overhead capitalised onto growing stock', ARRAY['value']);

INSERT INTO fin.posting_rule (id, event_code, amount_key, side, account_id, determinant_type, determinant_role, subledger_from, valid_from, created_by, updated_by)
SELECT ('01900000-0000-7000-8300-' || lpad(r.n::text, 12, '0'))::uuid, r.event, r.amount, r.side,
       CASE WHEN r.code IS NULL THEN NULL ELSE ('01900000-0000-7000-8100-00000000' || r.code)::uuid END,
       r.det_type, r.det_role, NULL, DATE '2020-01-01', '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001'
  FROM (VALUES
    (330, 'inv.OverheadAbsorbed', 'value', 'D', NULL, 'GL_GROUP', 'INVENTORY'),
    (331, 'inv.OverheadAbsorbed', 'value', 'C', '5220', NULL, NULL)
  ) AS r (n, event, amount, side, code, det_type, det_role);

-- migrate:down
DELETE FROM fin.posting_rule WHERE event_code = 'inv.OverheadAbsorbed';
DELETE FROM fin.posting_event_type WHERE code = 'inv.OverheadAbsorbed';
DELETE FROM fin.account WHERE id = '01900000-0000-7000-8100-000000005220';
