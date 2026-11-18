-- 0249_mdm_uom_names_and_egg
-- B09u, the owner's decision 1 (2026-11-17, F10g): every unit answers a singular and a plural name, so a screen can say
-- "540 eggs" and "from 10 crates"; and a unit named "egg", the base unit the seeded eggs are counted in (A-303). Both are
-- lowercase words a sentence can carry; `name` stays the unit's title as before.
--   singular_name, plural_name   NOT NULL, CHECK trimmed and non-empty
--   EGG                          a COUNT unit shown with no decimals, like UNIT
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`). The two columns are dropped; the EGG row is removed only while nothing names it
-- (a product, a conversion, a price entry or any line), and is otherwise kept, since a stored figure counted in it must
-- keep its unit; applying the migration again finds it and sets its names.

-- migrate:up
ALTER TABLE mdm.uom ADD COLUMN singular_name text NULL, ADD COLUMN plural_name text NULL;
INSERT INTO mdm.uom (code, name, kind, display_decimals) VALUES ('EGG', 'Egg', 'COUNT', 0) ON CONFLICT (code) DO NOTHING;
UPDATE mdm.uom u SET singular_name = n.singular_name, plural_name = n.plural_name
  FROM (VALUES
    ('HEAD', 'head', 'head'), ('KG', 'kilogram', 'kilograms'), ('CRATE', 'crate', 'crates'), ('BUNCH', 'bunch', 'bunches'),
    ('TUBER', 'tuber', 'tubers'), ('PACK', 'pack', 'packs'), ('UNIT', 'unit', 'units'), ('BAG', 'bag', 'bags'),
    ('LITRE', 'litre', 'litres'), ('EGG', 'egg', 'eggs')
  ) AS n (code, singular_name, plural_name)
 WHERE u.code = n.code;
ALTER TABLE mdm.uom ALTER COLUMN singular_name SET NOT NULL, ALTER COLUMN plural_name SET NOT NULL;
ALTER TABLE mdm.uom ADD CONSTRAINT ck_uom_singular_name CHECK (singular_name = btrim(singular_name) AND singular_name <> ''),
  ADD CONSTRAINT ck_uom_plural_name CHECK (plural_name = btrim(plural_name) AND plural_name <> '');

-- migrate:down
ALTER TABLE mdm.uom DROP CONSTRAINT ck_uom_singular_name, DROP CONSTRAINT ck_uom_plural_name;
ALTER TABLE mdm.uom DROP COLUMN singular_name, DROP COLUMN plural_name;
DO $$
BEGIN
  DELETE FROM mdm.uom WHERE code = 'EGG';
EXCEPTION WHEN foreign_key_violation THEN
  -- Something counted in eggs exists: the unit stays with it (see the header).
  RAISE NOTICE 'mdm.uom EGG is kept: rows still name it';
END;
$$;
