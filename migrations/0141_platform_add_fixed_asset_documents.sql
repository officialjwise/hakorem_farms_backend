-- 0141_platform_add_fixed_asset_documents
-- B08 continued 1c2 (FR-FIN-014, FR-FIN-015, ADR-0059): a depreciation run and a fixed asset disposal are business
-- documents (ADR-0011), so the journal entries the ledger posts from `fin.DepreciationRun` and `fin.FixedAssetDisposed`
-- name them as their source documents. Not numbered: each entry carries the gap-free JNL number, a run is identified by
-- its period and a disposal by its asset.
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`), safe before the first run or disposal.

-- migrate:up
INSERT INTO platform.document_type (code, owner_module, name, is_numbered, series_prefix) VALUES
  ('DEPRECIATION_RUN', 'fin', 'Depreciation run', false, NULL),
  ('FIXED_ASSET_DISPOSAL', 'fin', 'Fixed asset disposal', false, NULL);

-- migrate:down
DELETE FROM platform.document_type WHERE code IN ('DEPRECIATION_RUN', 'FIXED_ASSET_DISPOSAL');
