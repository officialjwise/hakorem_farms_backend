-- 0358_platform_add_financing_documents
-- B12 continued (FR-CAP-002, FR-CAP-015, ADR-0011, ADR-0101): CAP's further business documents.
--   INVESTOR_PAYOUT_CHANGE  a change of an investor's payout details waiting for a different person's approval, not numbered
--   FINANCING               a loan or grant, numbered when it is recorded (FNC-2027-DDW-000001)
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`). A type that documents were registered under is kept, and says so.

-- migrate:up
INSERT INTO platform.document_type (code, owner_module, name, is_numbered, series_prefix) VALUES
  ('INVESTOR_PAYOUT_CHANGE', 'cap', 'Investor payout details change awaiting approval', false, NULL),
  ('FINANCING', 'cap', 'Loan or grant', true, 'FNC')
ON CONFLICT (code) DO NOTHING;

-- migrate:down
DO $$
BEGIN
  DELETE FROM platform.document_type WHERE code IN ('INVESTOR_PAYOUT_CHANGE', 'FINANCING');
EXCEPTION WHEN foreign_key_violation THEN
  RAISE NOTICE 'platform.document_type INVESTOR_PAYOUT_CHANGE and FINANCING are kept: documents were registered under them';
END
$$;
