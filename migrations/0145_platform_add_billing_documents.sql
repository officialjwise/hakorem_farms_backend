-- 0145_platform_add_billing_documents
-- B08 continued 2 (FR-BIL-001, FR-BIL-002, FR-BIL-006, FR-BIL-007, ADR-0011, ADR-0015): the five billing documents are
-- business documents, each numbered from its own gap-free series per fiscal year and branch through
-- platform.allocate_number in the issuing transaction: proforma PRO, invoice INV, receipt RCP, credit note CRN, debit
-- note DBN (`INV-2026-DDW-000123`; a receipt adds its register when it has one, B9b).
-- `platform.number_allocated(document, number, doc type)` answers whether the platform allocated that number of that
-- type to that document, so a module's own trigger can hold its issued number to its allocation without reading the
-- platform's tables (shared object, tooling/architecture.json).
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`), safe before the first billing document.

-- migrate:up
INSERT INTO platform.document_type (code, owner_module, name, is_numbered, series_prefix) VALUES
  ('PROFORMA', 'bil', 'Proforma invoice', true, 'PRO'),
  ('INVOICE', 'bil', 'Invoice', true, 'INV'),
  ('RECEIPT', 'bil', 'Receipt', true, 'RCP'),
  ('CREDIT_NOTE', 'bil', 'Credit note', true, 'CRN'),
  ('DEBIT_NOTE', 'bil', 'Debit note', true, 'DBN');

CREATE FUNCTION platform.number_allocated(p_document_id uuid, p_formatted text, p_doc_type text) RETURNS boolean
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
  SELECT EXISTS (SELECT 1 FROM platform.number_allocation a JOIN platform.number_series s ON s.id = a.series_id
                  WHERE a.document_id = p_document_id AND a.formatted = p_formatted AND s.doc_type = p_doc_type)
$$;
REVOKE ALL ON FUNCTION platform.number_allocated(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.number_allocated(uuid, text, text) TO hk_app, hk_worker;

-- migrate:down
DROP FUNCTION platform.number_allocated(uuid, text, text);
DELETE FROM platform.document_type WHERE code IN ('PROFORMA', 'INVOICE', 'RECEIPT', 'CREDIT_NOTE', 'DEBIT_NOTE');
