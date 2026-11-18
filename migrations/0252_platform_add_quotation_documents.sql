-- 0252_platform_add_quotation_documents
-- B10 (FR-QUO-001, FR-QUO-002, FR-QUO-003, ADR-0011, ADR-0015): a request for quote and a quote are business documents
-- of their own, owned by QUO. Each is numbered from its own gap-free series per branch and year when it is written:
-- RFQ-2026-DDW-000154 and QUO-2026-DDW-000088; a quote keeps its number across every version (FR-QUO-006).
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`). Once a request or a quote has been registered the types stay: the registry and
-- the number series are insert-only and name them, so the down step keeps them and says so.

-- migrate:up
INSERT INTO platform.document_type (code, owner_module, name, is_numbered, series_prefix) VALUES
  ('RFQ', 'quo', 'Request for quote', true, 'RFQ'),
  ('QUOTE', 'quo', 'Quotation', true, 'QUO')
ON CONFLICT (code) DO NOTHING;

-- migrate:down
DO $$
BEGIN
  DELETE FROM platform.document_type WHERE code IN ('RFQ', 'QUOTE');
EXCEPTION WHEN foreign_key_violation THEN
  RAISE NOTICE 'platform.document_type RFQ and QUOTE are kept: requests or quotes were registered or numbered under them';
END
$$;
