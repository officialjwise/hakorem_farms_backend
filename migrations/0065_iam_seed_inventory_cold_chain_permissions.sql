-- 0065_iam_seed_inventory_cold_chain_permissions
-- The permissions of the operations B05 continued 4 builds (contract x-permission): reading and managing reorder
-- rules (FR-INV-015), reading and recording cold chain temperature readings (FR-INV-007, FR-INV-008), and loading
-- opening stock from the OPENING_STOCK import sheet (A-128, ADR-0050), which applying such an import needs as well as
-- mdm.import.apply. Stock alerts read under inv.stock.read (0048). Granted to no role here; 0066 grants them (A-147).
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
INSERT INTO iam.permission (code, module, description, requires_step_up) VALUES
  ('inv.reorder_rule.read', 'inv', 'Read reorder rules', false),
  ('inv.reorder_rule.manage', 'inv', 'Create and change reorder rules', false),
  ('inv.cold_chain.read', 'inv', 'Read cold chain temperature readings', false),
  ('inv.cold_chain.record', 'inv', 'Record a cold chain temperature reading, quarantining the lots on an excursion', false),
  ('inv.opening_stock.load', 'inv', 'Load opening stock from an OPENING_STOCK import', false);

-- migrate:down
DELETE FROM iam.permission WHERE code IN ('inv.reorder_rule.read', 'inv.reorder_rule.manage', 'inv.cold_chain.read', 'inv.cold_chain.record', 'inv.opening_stock.load');
