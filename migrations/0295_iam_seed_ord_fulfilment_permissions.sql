-- 0295_iam_seed_ord_fulfilment_permissions
-- B11 (FR-ORD-008 to FR-ORD-013, ADR-0017, CR-056): the permissions of the pick lists, picks and the customer's answers,
-- as contract/openapi.yaml names them. Granted to no role here; 0296 grants them.
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
INSERT INTO iam.permission (code, module, description, requires_step_up) VALUES
  ('ord.fulfilment.read', 'ord', 'Read pick lists and fulfilments: what each asks, what was picked and weighed', false),
  ('ord.fulfilment.pick', 'ord', 'Make a pick list, record picks and weights, pack, cancel a pick list, and propose a substitute or a smaller quantity', false),
  ('ord.order.update', 'ord', 'Record the customer’s answer to what an order asks them: a higher total, a substitute or a smaller quantity', false);

-- migrate:down
DELETE FROM iam.role_permission WHERE permission_code IN ('ord.fulfilment.read', 'ord.fulfilment.pick', 'ord.order.update');
DELETE FROM iam.permission WHERE code IN ('ord.fulfilment.read', 'ord.fulfilment.pick', 'ord.order.update');
