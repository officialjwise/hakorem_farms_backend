-- 0115_iam_seed_b07c_permissions
-- B07 continued 2 (FR-DEL-001 without its capacity rule, FR-SHP-001 to FR-SHP-008; ADR-0026's delivery split, A-177):
--   del.slot.read    list delivery slots with their capacity and bookings (listDeliverySlots)
--   del.slot.manage  generate a zone's slots over a date range and change a slot's capacity, never below its bookings
-- And the principal the public storefront acts as (A-177): a guest has no account, yet a cart, a checkout, its stock
-- reservations, idempotency keys and audit rows each name an actor. It is a SYSTEM principal with no credentials and
-- no grants; the storefront's handlers check the guest's cart token, never a permission.
-- The new permissions are granted to no role here; 0116 grants them.
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`), safe before the first guest cart; afterwards forward fix only.

-- migrate:up
INSERT INTO iam.principal (id, kind, display_name, status, created_by, updated_by) VALUES
  ('01900000-0000-7000-8000-000000000006', 'SYSTEM', 'Storefront', 'ACTIVE', '01900000-0000-7000-8000-000000000006', '01900000-0000-7000-8000-000000000006');

INSERT INTO iam.permission (code, module, description, requires_step_up) VALUES
  ('del.slot.read', 'del', 'List delivery slots with their capacity and bookings', false),
  ('del.slot.manage', 'del', 'Generate delivery slots for a zone and change a slot''s capacity', false);

-- migrate:down
DELETE FROM iam.role_permission WHERE permission_code IN ('del.slot.read', 'del.slot.manage');
DELETE FROM iam.permission WHERE code IN ('del.slot.read', 'del.slot.manage');
DELETE FROM iam.principal WHERE id = '01900000-0000-7000-8000-000000000006';
