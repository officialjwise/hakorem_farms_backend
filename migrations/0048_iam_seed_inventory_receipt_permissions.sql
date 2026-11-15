-- 0048_iam_seed_inventory_receipt_permissions
-- The inventory permissions of the operations B05 continued builds (contract x-permission): reading stock on hand and
-- stock units, and reading, drafting and posting goods receipts (FR-INV-003, FR-INV-009). Granted to no role here;
-- 0049 grants them. The permissions of transfers, adjustments, stock takes, holds, reservations, exceptions, cold
-- chain and reorder rules arrive with their operations.
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
INSERT INTO iam.permission (code, module, description, requires_step_up) VALUES
  ('inv.stock.read', 'inv', 'Read stock on hand, its value at cost and stock units', false),
  ('inv.goods_receipt.read', 'inv', 'Read goods receipts', false),
  ('inv.goods_receipt.create', 'inv', 'Draft, change and cancel a goods receipt', false),
  ('inv.goods_receipt.post', 'inv', 'Post a goods receipt to stock', false);

-- migrate:down
DELETE FROM iam.permission WHERE code IN ('inv.stock.read', 'inv.goods_receipt.read', 'inv.goods_receipt.create', 'inv.goods_receipt.post');
