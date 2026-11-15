-- 0086_platform_add_processing_reversal_document
-- The document type of a processing order's reversal (FR-PRC-011; A-162), the source document of the movements that
-- reverse a completed order. Not numbered: it is read through the order it reverses.
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
INSERT INTO platform.document_type (code, owner_module, name, is_numbered, series_prefix) VALUES
  ('PROCESSING_REVERSAL', 'prc', 'Reversal of a completed processing order', false, NULL);

-- migrate:down
DELETE FROM platform.document_type WHERE code = 'PROCESSING_REVERSAL';
