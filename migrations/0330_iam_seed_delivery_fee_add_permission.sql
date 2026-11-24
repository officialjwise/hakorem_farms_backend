-- 0330_iam_seed_delivery_fee_add_permission
-- B11 continued 7 (the owner, 2026-11-23, A-331 (b)): an extra delivery the customer asks for is a separate, explicit
-- fee line, added by staff who hold its permission, never inferred from a second dispatch:
--   ord.delivery_fee.add    add the zone's delivery fee to a backorder as an extra delivery the customer asked for
-- Granted to no role here; 0331 grants it.
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
INSERT INTO iam.permission (code, module, description, requires_step_up) VALUES
  ('ord.delivery_fee.add', 'ord', 'Add the zone''s delivery fee to a backorder as an extra delivery the customer asked for', false);

-- migrate:down
DELETE FROM iam.role_permission WHERE permission_code = 'ord.delivery_fee.add';
DELETE FROM iam.permission WHERE code = 'ord.delivery_fee.add';
