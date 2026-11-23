-- 0316_iam_seed_del_cash_reconciliation_read
-- B11 continued 2 (FR-DEL-010, CR-057, abuse cases 6 and 43): the driver variance report's read, as contract/openapi.yaml
-- names it. The hand-in itself is taken at the till under the counter's own `pos.sale.create` (the cashier, on their own
-- open shift, as an invoice paid at the till is, A-285 (h)); a driver reads their own cash under
-- `del.delivery.read.assigned`. `del.cash_reconciliation.create`, the contract's planned count outside a till, is not
-- seeded: a driver's cash is never counted outside a till shift (CR-057, A-345 (a)).
-- Granted to no role here; 0317 grants it.
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
INSERT INTO iam.permission (code, module, description, requires_step_up) VALUES
  ('del.cash_reconciliation.read', 'del', 'Read the drivers'' cash handed in at the tills, and each driver''s variance', false);

-- migrate:down
DELETE FROM iam.role_permission WHERE permission_code = 'del.cash_reconciliation.read';
DELETE FROM iam.permission WHERE code = 'del.cash_reconciliation.read';
