-- 0272_platform_add_whl_standing_order_bad_debt_documents
-- B10 continued 3 (FR-WHL-004, FR-WHL-012, ADR-0011, ADR-0090): a standing order and a bad-debt write-off are business
-- documents owned by WHL, so the orders a standing order makes and the write-off's approval and journal have a subject.
-- Neither is numbered: each is found from its customer.
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`). Once a document has been registered under a type the registry names it and
-- the down step keeps the type and says so.

-- migrate:up
INSERT INTO platform.document_type (code, owner_module, name, is_numbered, series_prefix) VALUES
  ('STANDING_ORDER', 'whl', 'Standing order', false, NULL),
  ('BAD_DEBT_WRITE_OFF', 'whl', 'Bad-debt write-off', false, NULL)
ON CONFLICT (code) DO NOTHING;

-- migrate:down
DO $$
BEGIN
  DELETE FROM platform.document_type WHERE code IN ('STANDING_ORDER', 'BAD_DEBT_WRITE_OFF');
EXCEPTION WHEN foreign_key_violation THEN
  RAISE NOTICE 'platform.document_type STANDING_ORDER and BAD_DEBT_WRITE_OFF are kept: documents were registered under them';
END
$$;
