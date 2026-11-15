-- 0061_iam_seed_inventory_reservation_exception_permissions
-- The permissions of the operations B05 continued 3b builds (contract x-permission): reading reservations and
-- releasing one by hand (FR-INV-021), reading stock exceptions and resolving one (FR-INV-023, ADR-0048). Granted to
-- no role here; 0062 grants them (A-144). Availability and the stock unit list read under inv.stock.read (0048).
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
INSERT INTO iam.permission (code, module, description, requires_step_up) VALUES
  ('inv.reservation.read', 'inv', 'Read stock reservations', false),
  ('inv.reservation.release', 'inv', 'Release a stock reservation by hand, with a reason', false),
  ('inv.exception.read', 'inv', 'Read stock exceptions', false),
  ('inv.exception.resolve', 'inv', 'Resolve a stock exception, writing off or recording found a held transfer variance', false);

-- migrate:down
DELETE FROM iam.permission WHERE code IN ('inv.reservation.read', 'inv.reservation.release', 'inv.exception.read', 'inv.exception.resolve');
