-- 0188_iam_seed_ord_permissions
-- B09a continued 2b (FR-ORD-001, FR-ORD-002, FR-ORD-005, ADR-0017, ADR-0035, A-224): the permissions of the order
-- operations this phase builds, as contract/openapi.yaml names them: reading orders and their history, entering an
-- order for a customer, and confirming one (reserving its stock after the payment or credit check). Granted to no role
-- here; 0189 grants them. Cancelling, voiding (with the supervisor's approval), returns, the proforma and price
-- override approvals are seeded by the phase that builds them (B09a continued 2c, A-225).
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
INSERT INTO iam.permission (code, module, description, requires_step_up) VALUES
  ('ord.order.read', 'ord', 'Read orders on every channel, their lines with the pricing record, and their status history', false),
  ('ord.order.create', 'ord', 'Enter an order for a customer, priced line by line by the pricing engine', false),
  ('ord.order.confirm', 'ord', 'Confirm an order: check its payment or credit and reserve every line', false);

-- migrate:down
DELETE FROM iam.role_permission WHERE permission_code IN ('ord.order.read', 'ord.order.create', 'ord.order.confirm');
DELETE FROM iam.permission WHERE code IN ('ord.order.read', 'ord.order.create', 'ord.order.confirm');
