-- 0063_platform_add_temperature_excursion_document
-- The document a temperature excursion is recorded as (FR-INV-008, ADR-0019): the cause of the QUARANTINE holds it
-- places on every lot in the location and of the TEMPERATURE_EXCURSION exceptions it raises, both of which name it
-- as their source document. Not numbered: the reading itself is the record.
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`); refused by the foreign key once an excursion exists, which is why 0064 is
-- rolled back first.

-- migrate:up
INSERT INTO platform.document_type (code, owner_module, name, is_numbered, series_prefix) VALUES
  ('TEMPERATURE_EXCURSION', 'inv', 'Cold chain temperature excursion', false, NULL);

-- migrate:down
DELETE FROM platform.document_type WHERE code = 'TEMPERATURE_EXCURSION';
