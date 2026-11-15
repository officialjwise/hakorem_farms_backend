-- 0052_iam_seed_inventory_control_permissions
-- The inventory permissions of the operations B05 continued 2 builds (contract x-permission): reading movements and
-- reversing one (FR-INV-004), reading, drafting, dispatching and receiving transfers (FR-INV-010, FR-INV-011), and
-- reading, drafting and approving adjustments (FR-INV-012). Granted to no role here; 0053 grants them (A-139).
-- The two approval policies (ADR-0017): a stock write-off (an adjustment) and a movement reversal at or above
-- 50,000 pesewas (FR-INV-012's seed threshold) need a different person holding inv.adjustment.approve, with a fresh
-- step-up, as every other approval policy asks.
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
INSERT INTO iam.permission (code, module, description, requires_step_up) VALUES
  ('inv.movement.read', 'inv', 'Read stock movements', false),
  ('inv.movement.reverse', 'inv', 'Reverse a stock movement', false),
  ('inv.transfer.read', 'inv', 'Read stock transfers', false),
  ('inv.transfer.create', 'inv', 'Draft and cancel a stock transfer', false),
  ('inv.transfer.dispatch', 'inv', 'Dispatch a stock transfer to in-transit', false),
  ('inv.transfer.receive', 'inv', 'Receive a stock transfer at its destination', false),
  ('inv.adjustment.read', 'inv', 'Read stock adjustments', false),
  ('inv.adjustment.create', 'inv', 'Draft and submit a stock adjustment', false),
  ('inv.adjustment.approve', 'inv', 'Approve a stock write-off or a movement reversal', true);

INSERT INTO iam.approval_policy (id, kind, branch_id, threshold_pesewas, approver_permission, requires_evidence, requires_step_up, created_by, updated_by) VALUES
  ('01900000-0000-7000-8000-000000000404', 'STOCK_WRITE_OFF', NULL, 50000, 'inv.adjustment.approve', false, true,
   '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001'),
  ('01900000-0000-7000-8000-000000000405', 'STOCK_REVERSAL', NULL, 50000, 'inv.adjustment.approve', false, true,
   '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001');

-- migrate:down
DELETE FROM iam.approval_policy WHERE id IN ('01900000-0000-7000-8000-000000000404', '01900000-0000-7000-8000-000000000405');
DELETE FROM iam.permission WHERE code IN ('inv.movement.read', 'inv.movement.reverse', 'inv.transfer.read', 'inv.transfer.create', 'inv.transfer.dispatch',
  'inv.transfer.receive', 'inv.adjustment.read', 'inv.adjustment.create', 'inv.adjustment.approve');
