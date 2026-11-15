-- 0019_mdm_catalogue_admin
-- What the catalogue administration of B04d continued needs in mdm (docs/data-model/mdm.md, FR-MDM-002, FR-MDM-003):
-- each unit of measure declares the decimal places a quantity in it is shown with (CR-003: none for counted units,
-- three for weight and volume), and category names are unique among their siblings, live rows only.
-- Data category: PUBLIC (catalogue).
-- Rollback: tested (`pnpm db:rollback`); dropping the column and the index loses nothing that is not derived.

-- migrate:up
ALTER TABLE mdm.uom ADD COLUMN display_decimals smallint NULL;
UPDATE mdm.uom SET display_decimals = CASE kind WHEN 'COUNT' THEN 0 ELSE 3 END;
ALTER TABLE mdm.uom ALTER COLUMN display_decimals SET NOT NULL;
ALTER TABLE mdm.uom ADD CONSTRAINT ck_uom_display_decimals CHECK (display_decimals BETWEEN 0 AND 3);

-- A root category has no parent; the all-zero uuid stands in for "no parent" so roots are siblings of each other.
CREATE UNIQUE INDEX uq_category_sibling_name ON mdm.category (coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(btrim(name)))
  WHERE deleted_at IS NULL;

-- migrate:down
DROP INDEX mdm.uq_category_sibling_name;
ALTER TABLE mdm.uom DROP COLUMN display_decimals;
