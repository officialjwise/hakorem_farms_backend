-- 0079_platform_add_livestock_breeding_documents
-- The documents LIV registers in B06 continued 2 (ADR-0011; FR-LIV-003, FR-LIV-006, FR-LIV-010, FR-LIV-011): a move
-- of an animal between pens, the source document of its TRANSFER_INTERNAL movement; a hatched batch, the source
-- document of the flock's lot and its BIRTH movement; and a breeding record, the source document of the offspring's
-- stock units and their BIRTH movements. None is numbered: the record itself is what people refer to (A-159).
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`); refused by the foreign key once a record exists, which is why 0080 is rolled
-- back first.

-- migrate:up
INSERT INTO platform.document_type (code, owner_module, name, is_numbered, series_prefix) VALUES
  ('ANIMAL_MOVE', 'liv', 'Move of an animal between pens', false, NULL),
  ('LIVESTOCK_BATCH', 'liv', 'A flock hatched or started on the farm', false, NULL),
  ('BREEDING_RECORD', 'liv', 'Mating and birth of a dam', false, NULL);

-- migrate:down
DELETE FROM platform.document_type WHERE code IN ('ANIMAL_MOVE', 'LIVESTOCK_BATCH', 'BREEDING_RECORD');
