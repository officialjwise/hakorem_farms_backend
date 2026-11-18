-- 0256_platform_add_account_change_document
-- B10 continued (FR-WHL-001, FR-WHL-008, CR-048, ADR-0011, ADR-0017): a change to a business account that needs a second
-- person (a new credit limit, or the release of a hold) is a business document of its own, owned by WHL, so the
-- approval request has a subject. It is not numbered: it is found from its account.
-- Data category: none (a lookup row).
-- Rollback: tested (`pnpm db:rollback`). Once a change has been registered the type stays: the registry is insert-only
-- and names it, so the down step keeps it and says so.

-- migrate:up
INSERT INTO platform.document_type (code, owner_module, name, is_numbered, series_prefix) VALUES
  ('ACCOUNT_CHANGE', 'whl', 'Business account change', false, NULL)
ON CONFLICT (code) DO NOTHING;

-- migrate:down
DO $$
BEGIN
  DELETE FROM platform.document_type WHERE code = 'ACCOUNT_CHANGE';
EXCEPTION WHEN foreign_key_violation THEN
  RAISE NOTICE 'platform.document_type ACCOUNT_CHANGE is kept: account changes were registered under it';
END
$$;
