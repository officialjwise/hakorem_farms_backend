-- 0058_iam_seed_inventory_hold_permissions
-- The hold permissions of the operations B05 continued 3 builds (contract x-permission): reading holds, placing a
-- quarantine or investigation hold by hand, and releasing one early (FR-INV-022). Granted to no role here; 0059
-- grants them (A-142). A withdrawal hold is placed only by recording a treatment (B6) and is never released.
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
INSERT INTO iam.permission (code, module, description, requires_step_up) VALUES
  ('inv.hold.read', 'inv', 'Read stock holds', false),
  ('inv.hold.create', 'inv', 'Place a quarantine or investigation hold', false),
  ('inv.hold.release', 'inv', 'Release a quarantine or investigation hold early', false);

-- migrate:down
DELETE FROM iam.permission WHERE code IN ('inv.hold.read', 'inv.hold.create', 'inv.hold.release');
