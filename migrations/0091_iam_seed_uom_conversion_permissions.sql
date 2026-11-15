-- 0091_iam_seed_uom_conversion_permissions
-- The permissions to manage a product's alternative units (FR-MDM-003, whose actor is the Manager; A-163): make an exact
-- conversion, and archive one. Reading conversions needs `mdm.product.read`, as reading the units does. Granted by 0092.
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
INSERT INTO iam.permission (code, module, description, requires_step_up) VALUES
  ('mdm.uom_conversion.create', 'mdm', 'Make an exact conversion from an alternative unit to a product''s base unit', false),
  ('mdm.uom_conversion.archive', 'mdm', 'Archive a product''s unit conversion', false);

-- migrate:down
DELETE FROM iam.permission WHERE code IN ('mdm.uom_conversion.create', 'mdm.uom_conversion.archive');
