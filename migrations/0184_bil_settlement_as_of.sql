-- 0184_bil_settlement_as_of
-- B09t (owner, 2026-11-16; ADR-0066, A-216): a settlement summary's `settled_at` and `as_of` are the application's
-- instant, passed in. `bil.apply_settlement(document, amount, direction, at)` is 0161's function with the instant as an
-- argument instead of the database's `now()`; `Billing.settleIn` passes its clock's instant. The three-argument form
-- stays for one release (expand then contract) and delegates with `platform.app_now()` (0182), so a running previous
-- version still settles; a later release drops it.
-- Data category: CONFIDENTIAL (DC-09).
-- Rollback: tested (`pnpm db:rollback`), restores 0161's three-argument function and drops the four-argument one; safe
-- at any time (the summary rows are unchanged).

-- migrate:up
CREATE FUNCTION bil.apply_settlement(p_document_id uuid, p_amount bigint, p_direction text, p_at timestamptz) RETURNS bigint
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
DECLARE
  d record;
  allocated numeric;
  outstanding numeric;
  status text;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 OR p_direction NOT IN ('APPLY', 'UNAPPLY') OR p_at IS NULL THEN
    RAISE EXCEPTION 'bil.apply_settlement: an amount above zero, applied or unapplied, at an instant' USING ERRCODE = 'HK010', CONSTRAINT = 'ck_document_settlement_outstanding';
  END IF;
  SELECT b.id, b.kind, b.status, b.gross_pesewas, b.credited_pesewas, b.updated_at INTO d FROM bil.billing_document b WHERE b.id = p_document_id;
  IF d.id IS NULL OR d.status <> 'ISSUED' OR d.kind NOT IN ('INVOICE', 'RECEIPT', 'DEBIT_NOTE') THEN
    RAISE EXCEPTION 'bil.apply_settlement: % is not an issued invoice, receipt or debit note', p_document_id USING ERRCODE = 'HK010', CONSTRAINT = 'ck_document_settlement_outstanding';
  END IF;
  SELECT s.allocated_pesewas INTO allocated FROM bil.document_settlement s WHERE s.billing_document_id = p_document_id FOR UPDATE;
  allocated := allocated + CASE p_direction WHEN 'APPLY' THEN p_amount ELSE -p_amount END;
  outstanding := d.gross_pesewas - d.credited_pesewas - allocated;
  IF allocated < 0 OR outstanding < 0 THEN
    RAISE EXCEPTION 'bil.apply_settlement: % pesewas % leaves document % with % outstanding', p_amount, lower(p_direction), p_document_id, outstanding
      USING ERRCODE = 'HK010', CONSTRAINT = 'ck_document_settlement_outstanding';
  END IF;
  status := CASE
    WHEN outstanding > 0 AND allocated = 0 AND d.credited_pesewas = 0 THEN 'UNPAID'
    WHEN outstanding > 0 THEN 'PART_PAID'
    WHEN allocated = 0 THEN 'CREDITED'
    ELSE 'PAID' END;
  UPDATE bil.document_settlement
     SET allocated_pesewas = allocated, outstanding_pesewas = outstanding, payment_status = status,
         settled_at = CASE WHEN outstanding = 0 THEN COALESCE(settled_at, p_at) ELSE NULL END, as_of = p_at
   WHERE billing_document_id = p_document_id;
  RETURN outstanding;
END
$$;
REVOKE ALL ON FUNCTION bil.apply_settlement(uuid, bigint, text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION bil.apply_settlement(uuid, bigint, text, timestamptz) TO hk_app, hk_worker;

-- 0161's form, for a running previous version: the same rule at the unit of work's instant.
CREATE OR REPLACE FUNCTION bil.apply_settlement(p_document_id uuid, p_amount bigint, p_direction text) RETURNS bigint
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
  SELECT bil.apply_settlement(p_document_id, p_amount, p_direction, platform.app_now())
$$;

-- migrate:down
CREATE OR REPLACE FUNCTION bil.apply_settlement(p_document_id uuid, p_amount bigint, p_direction text) RETURNS bigint
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
DECLARE
  d record;
  allocated numeric;
  outstanding numeric;
  status text;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 OR p_direction NOT IN ('APPLY', 'UNAPPLY') THEN
    RAISE EXCEPTION 'bil.apply_settlement: an amount above zero, applied or unapplied' USING ERRCODE = 'HK010', CONSTRAINT = 'ck_document_settlement_outstanding';
  END IF;
  SELECT b.id, b.kind, b.status, b.gross_pesewas, b.credited_pesewas, b.updated_at INTO d FROM bil.billing_document b WHERE b.id = p_document_id;
  IF d.id IS NULL OR d.status <> 'ISSUED' OR d.kind NOT IN ('INVOICE', 'RECEIPT', 'DEBIT_NOTE') THEN
    RAISE EXCEPTION 'bil.apply_settlement: % is not an issued invoice, receipt or debit note', p_document_id USING ERRCODE = 'HK010', CONSTRAINT = 'ck_document_settlement_outstanding';
  END IF;
  SELECT s.allocated_pesewas INTO allocated FROM bil.document_settlement s WHERE s.billing_document_id = p_document_id FOR UPDATE;
  allocated := allocated + CASE p_direction WHEN 'APPLY' THEN p_amount ELSE -p_amount END;
  outstanding := d.gross_pesewas - d.credited_pesewas - allocated;
  IF allocated < 0 OR outstanding < 0 THEN
    RAISE EXCEPTION 'bil.apply_settlement: % pesewas % leaves document % with % outstanding', p_amount, lower(p_direction), p_document_id, outstanding
      USING ERRCODE = 'HK010', CONSTRAINT = 'ck_document_settlement_outstanding';
  END IF;
  status := CASE
    WHEN outstanding > 0 AND allocated = 0 AND d.credited_pesewas = 0 THEN 'UNPAID'
    WHEN outstanding > 0 THEN 'PART_PAID'
    WHEN allocated = 0 THEN 'CREDITED'
    ELSE 'PAID' END;
  UPDATE bil.document_settlement
     SET allocated_pesewas = allocated, outstanding_pesewas = outstanding, payment_status = status,
         settled_at = CASE WHEN outstanding = 0 THEN COALESCE(settled_at, now()) ELSE NULL END, as_of = now()
   WHERE billing_document_id = p_document_id;
  RETURN outstanding;
END
$$;
DROP FUNCTION bil.apply_settlement(uuid, bigint, text, timestamptz);
