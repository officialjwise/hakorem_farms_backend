-- 0075_platform_add_livestock_documents
-- The documents LIV registers (ADR-0011; FR-LIV-007 to FR-LIV-009, FR-LIV-012, FR-LIV-015): a health event, the
-- source document of the withdrawal holds it places, the medication it issues and the veterinary cost it adds; a
-- mortality or cull record, the source document of its write-off and the subject of its approval; and a feed
-- consumption, the source document of the feed issue and of the cost it spreads across a pen. None is numbered: the
-- record itself is what people refer to.
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`); refused by the foreign key once a record exists, which is why 0076 is rolled
-- back first.

-- migrate:up
INSERT INTO platform.document_type (code, owner_module, name, is_numbered, series_prefix) VALUES
  ('HEALTH_EVENT', 'liv', 'Vaccination, treatment or health check', false, NULL),
  ('MORTALITY_RECORD', 'liv', 'Death or cull of an animal or birds of a flock', false, NULL),
  ('FEED_CONSUMPTION', 'liv', 'Feed issued to a pen', false, NULL);

-- migrate:down
DELETE FROM platform.document_type WHERE code IN ('HEALTH_EVENT', 'MORTALITY_RECORD', 'FEED_CONSUMPTION');
