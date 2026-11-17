-- 0229_iam_seed_pos_permissions
-- B9b (FR-POS-001, FR-POS-015 to FR-POS-019, ADR-0017, ADR-0035, A-273 (f)): the permissions of the till operations this
-- phase builds, as contract/openapi.yaml names them. Signing off a count posts over or short to the ledger, so it asks
-- for a fresh step-up, as a void's approval does. Granted to no role here; 0230 grants them. Device enrolment, the
-- force close and the offline operations are seeded by the phases that build them.
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
INSERT INTO iam.permission (code, module, description, requires_step_up) VALUES
  ('pos.register.read', 'pos', 'Read the tills of a branch and which shift each has open', false),
  ('pos.register.manage', 'pos', 'Create a till, move it to another location of its branch, or retire it', false),
  ('pos.shift.read', 'pos', 'Read till shifts and their cash movements; a cashier reads only their own', false),
  ('pos.shift.open', 'pos', 'Open a shift on a till with its float from the safe', false),
  ('pos.cash.move', 'pos', 'Record a cash drop to the safe, a pay-out or a pay-in on one''s own open shift', false),
  ('pos.shift.report', 'pos', 'Read a shift''s X and Z reports; a cashier reads only their own, with expected cash hidden until declared', false),
  ('pos.shift.close', 'pos', 'Declare the count of one''s own shift, blind', false),
  ('pos.shift.close.approve', 'pos', 'Sign off a cashier''s declared count and post the over or short', true),
  ('pos.sale.create', 'pos', 'Sell at the counter on one''s own open shift', false);

-- migrate:down
DELETE FROM iam.role_permission WHERE permission_code LIKE 'pos.%';
DELETE FROM iam.permission WHERE code IN ('pos.register.read', 'pos.register.manage', 'pos.shift.read', 'pos.shift.open', 'pos.cash.move',
  'pos.shift.report', 'pos.shift.close', 'pos.shift.close.approve', 'pos.sale.create');
