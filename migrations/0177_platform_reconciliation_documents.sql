-- 0177_platform_reconciliation_documents
-- B09a continued 1c (FR-PAY-016, ADR-0065, A-214): a provider settlement report and a bank statement are business
-- documents PAY imports, each the source of the journal entries its matching posts (`pay.ProviderSettled`, and the
-- break resolutions that hold an unknown payer's money in suspense). A break's resolution is a document too: it is the
-- subject of its RECONCILIATION_BREAK approval. Unnumbered: the provider's settlement reference and the bank's
-- statement period name them.
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`), safe before the first import.

-- migrate:up
INSERT INTO platform.document_type (code, owner_module, name, is_numbered, series_prefix) VALUES
  ('SETTLEMENT_REPORT', 'pay', 'Provider settlement report', false, NULL),
  ('BANK_STATEMENT', 'pay', 'Bank statement', false, NULL),
  ('BREAK_RESOLUTION', 'pay', 'Reconciliation break resolution', false, NULL);

-- migrate:down
DELETE FROM platform.document_type WHERE code IN ('SETTLEMENT_REPORT', 'BANK_STATEMENT', 'BREAK_RESOLUTION');
