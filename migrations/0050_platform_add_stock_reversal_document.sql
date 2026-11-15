-- 0050_platform_add_stock_reversal_document
-- The document a reversal of a stock movement is recorded as (FR-INV-004, A-139): the request to reverse, its reason,
-- its approval when the value reaches the threshold, and the reversing movement, which names it as its source
-- document. Not numbered: the reversed movement and the reversing one are the record.
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`); refused by the foreign key once a reversal exists, which is why 0051 is
-- rolled back first.

-- migrate:up
INSERT INTO platform.document_type (code, owner_module, name, is_numbered, series_prefix) VALUES
  ('STOCK_REVERSAL', 'inv', 'Stock movement reversal', false, NULL);

-- migrate:down
DELETE FROM platform.document_type WHERE code = 'STOCK_REVERSAL';
