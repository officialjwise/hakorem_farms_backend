-- 0309_iam_seed_ord_order_read_fulfilment
-- The owner, 2026-11-23 (decision 6, A-335 decided, A-344, CR-056 item 2): the Storekeeper reads the orders of their own
-- branch: lines, quantities and delivery details, never payment, credit, prices or totals. Its own permission for its
-- own narrower read (`getOrderFulfilmentView`), never `ord.order.read`. Granted to no role here; 0310 grants it.
-- Data category: none (a lookup row).
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
INSERT INTO iam.permission (code, module, description, requires_step_up) VALUES
  ('ord.order.read.fulfilment', 'ord', 'Read an order as the store does: its lines, quantities and delivery details, never a payment, credit, price or total', false);

-- migrate:down
DELETE FROM iam.role_permission WHERE permission_code = 'ord.order.read.fulfilment';
DELETE FROM iam.permission WHERE code = 'ord.order.read.fulfilment';
