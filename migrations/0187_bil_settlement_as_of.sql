-- 0187_bil_settlement_as_of
-- B09t (owner, 2026-11-16; ADR-0067, A-217): a settlement summary's `settled_at` and `as_of` are the application's
-- instant, never the database's `now()`.
--   bil.apply_settlement(document, amount, direction, at)  0182's function with the instant as an argument;
--                                                           `Billing.settleIn` passes its clock's instant
--   bil.apply_settlement(document, amount, direction)      0182's form, kept for one release (expand then contract):
--                                                           delegates with `platform.app_now()` (0185)
--   bil.credit_note_refund                                 0182's function, its `as_of` at `platform.app_now()`
-- Data category: CONFIDENTIAL (DC-09).
-- Rollback: tested (`pnpm db:rollback`), restores 0182's two functions and drops the four-argument form; safe at any
-- time (the summary rows are unchanged).

-- migrate:up
CREATE FUNCTION bil.apply_settlement(p_document_id uuid, p_amount bigint, p_direction text, p_at timestamptz) RETURNS bigint
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
DECLARE
  d record;
  s record;
  allocated numeric;
  balance numeric;
  status text;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 OR p_direction NOT IN ('APPLY', 'UNAPPLY') OR p_at IS NULL THEN
    RAISE EXCEPTION 'bil.apply_settlement: an amount above zero, applied or unapplied, at an instant' USING ERRCODE = 'HK010', CONSTRAINT = 'ck_document_settlement_outstanding';
  END IF;
  SELECT b.id, b.kind, b.status, b.gross_pesewas, b.credited_pesewas, b.updated_at INTO d FROM bil.billing_document b WHERE b.id = p_document_id;
  IF d.id IS NULL OR d.status <> 'ISSUED' OR d.kind NOT IN ('INVOICE', 'RECEIPT', 'DEBIT_NOTE') THEN
    RAISE EXCEPTION 'bil.apply_settlement: % is not an issued invoice, receipt or debit note', p_document_id USING ERRCODE = 'HK010', CONSTRAINT = 'ck_document_settlement_outstanding';
  END IF;
  SELECT x.allocated_pesewas, x.refunded_pesewas INTO s FROM bil.document_settlement x WHERE x.billing_document_id = p_document_id FOR UPDATE;
  allocated := s.allocated_pesewas + CASE p_direction WHEN 'APPLY' THEN p_amount ELSE -p_amount END;
  balance := d.gross_pesewas - d.credited_pesewas - allocated + s.refunded_pesewas;
  -- Never more applied than the document has outstanding: a document that owes the customer money takes no allocation.
  IF allocated < 0 OR (p_direction = 'APPLY' AND balance < 0) THEN
    RAISE EXCEPTION 'bil.apply_settlement: % pesewas % leaves document % with % outstanding', p_amount, lower(p_direction), p_document_id, balance
      USING ERRCODE = 'HK010', CONSTRAINT = 'ck_document_settlement_outstanding';
  END IF;
  status := CASE
    WHEN balance > 0 AND allocated = 0 AND d.credited_pesewas = 0 THEN 'UNPAID'
    WHEN balance > 0 THEN 'PART_PAID'
    WHEN allocated = 0 THEN 'CREDITED'
    ELSE 'PAID' END;
  UPDATE bil.document_settlement
     SET allocated_pesewas = allocated, outstanding_pesewas = greatest(balance, 0), refundable_pesewas = greatest(-balance, 0), payment_status = status,
         settled_at = CASE WHEN balance <= 0 THEN COALESCE(settled_at, p_at) ELSE NULL END, as_of = p_at
   WHERE billing_document_id = p_document_id;
  RETURN greatest(balance, 0);
END
$$;
REVOKE ALL ON FUNCTION bil.apply_settlement(uuid, bigint, text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION bil.apply_settlement(uuid, bigint, text, timestamptz) TO hk_app, hk_worker;

CREATE OR REPLACE FUNCTION bil.apply_settlement(p_document_id uuid, p_amount bigint, p_direction text) RETURNS bigint
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
  SELECT bil.apply_settlement(p_document_id, p_amount, p_direction, platform.app_now())
$$;

CREATE OR REPLACE FUNCTION bil.credit_note_refund(p_credit_note_id uuid, p_amount bigint, p_direction text)
  RETURNS TABLE (original_document_id uuid, customer_id uuid, branch_id uuid, maker_id uuid)
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
DECLARE
  cn record;
  o record;
  cs record;
  os record;
  delta numeric;
  balance numeric;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 OR p_direction NOT IN ('HOLD', 'RELEASE') THEN
    RAISE EXCEPTION 'bil.credit_note_refund: an amount above zero, held or released' USING ERRCODE = 'HK010', CONSTRAINT = 'ck_credit_note_refund_cap';
  END IF;
  -- The credit note's lock: two refunds against one credit note queue here.
  SELECT d.id, d.kind, d.status, d.gross_pesewas, d.original_document_id, d.customer_id, d.branch_id, d.created_by INTO cn
    FROM bil.billing_document d WHERE d.id = p_credit_note_id FOR UPDATE;
  IF cn.id IS NULL OR cn.kind <> 'CREDIT_NOTE' OR cn.status <> 'ISSUED' THEN
    RAISE EXCEPTION 'bil.credit_note_refund: % is not an issued credit note', p_credit_note_id USING ERRCODE = 'HK010', CONSTRAINT = 'ck_credit_note_refund_cap';
  END IF;
  SELECT d.gross_pesewas, d.credited_pesewas INTO o FROM bil.billing_document d WHERE d.id = cn.original_document_id;
  SELECT x.refunded_pesewas INTO cs FROM bil.document_settlement x WHERE x.billing_document_id = cn.id FOR UPDATE;
  SELECT x.allocated_pesewas, x.refunded_pesewas INTO os FROM bil.document_settlement x WHERE x.billing_document_id = cn.original_document_id FOR UPDATE;
  delta := CASE p_direction WHEN 'HOLD' THEN p_amount ELSE -p_amount END;
  balance := o.gross_pesewas - o.credited_pesewas - os.allocated_pesewas + os.refunded_pesewas + delta;
  IF cs.refunded_pesewas + delta > cn.gross_pesewas OR cs.refunded_pesewas + delta < 0 OR os.refunded_pesewas + delta < 0 OR (p_direction = 'HOLD' AND balance > 0) THEN
    RAISE EXCEPTION 'bil.credit_note_refund: % pesewas is more than credit note % has left to refund (% of % held; its document owes back %)', p_amount, p_credit_note_id,
      cs.refunded_pesewas, cn.gross_pesewas, greatest(-(balance - delta), 0) USING ERRCODE = 'HK010', CONSTRAINT = 'ck_credit_note_refund_cap';
  END IF;
  UPDATE bil.document_settlement SET refunded_pesewas = refunded_pesewas + delta, as_of = platform.app_now() WHERE billing_document_id = cn.id;
  UPDATE bil.document_settlement
     SET refunded_pesewas = refunded_pesewas + delta, outstanding_pesewas = greatest(balance, 0), refundable_pesewas = greatest(-balance, 0), as_of = platform.app_now()
   WHERE billing_document_id = cn.original_document_id;
  RETURN QUERY SELECT cn.original_document_id, cn.customer_id, cn.branch_id, cn.created_by;
END
$$;

-- migrate:down
CREATE OR REPLACE FUNCTION bil.apply_settlement(p_document_id uuid, p_amount bigint, p_direction text) RETURNS bigint
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
DECLARE
  d record;
  s record;
  allocated numeric;
  balance numeric;
  status text;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 OR p_direction NOT IN ('APPLY', 'UNAPPLY') THEN
    RAISE EXCEPTION 'bil.apply_settlement: an amount above zero, applied or unapplied' USING ERRCODE = 'HK010', CONSTRAINT = 'ck_document_settlement_outstanding';
  END IF;
  SELECT b.id, b.kind, b.status, b.gross_pesewas, b.credited_pesewas, b.updated_at INTO d FROM bil.billing_document b WHERE b.id = p_document_id;
  IF d.id IS NULL OR d.status <> 'ISSUED' OR d.kind NOT IN ('INVOICE', 'RECEIPT', 'DEBIT_NOTE') THEN
    RAISE EXCEPTION 'bil.apply_settlement: % is not an issued invoice, receipt or debit note', p_document_id USING ERRCODE = 'HK010', CONSTRAINT = 'ck_document_settlement_outstanding';
  END IF;
  SELECT x.allocated_pesewas, x.refunded_pesewas INTO s FROM bil.document_settlement x WHERE x.billing_document_id = p_document_id FOR UPDATE;
  allocated := s.allocated_pesewas + CASE p_direction WHEN 'APPLY' THEN p_amount ELSE -p_amount END;
  balance := d.gross_pesewas - d.credited_pesewas - allocated + s.refunded_pesewas;
  -- Never more applied than the document has outstanding: a document that owes the customer money takes no allocation.
  IF allocated < 0 OR (p_direction = 'APPLY' AND balance < 0) THEN
    RAISE EXCEPTION 'bil.apply_settlement: % pesewas % leaves document % with % outstanding', p_amount, lower(p_direction), p_document_id, balance
      USING ERRCODE = 'HK010', CONSTRAINT = 'ck_document_settlement_outstanding';
  END IF;
  status := CASE
    WHEN balance > 0 AND allocated = 0 AND d.credited_pesewas = 0 THEN 'UNPAID'
    WHEN balance > 0 THEN 'PART_PAID'
    WHEN allocated = 0 THEN 'CREDITED'
    ELSE 'PAID' END;
  UPDATE bil.document_settlement
     SET allocated_pesewas = allocated, outstanding_pesewas = greatest(balance, 0), refundable_pesewas = greatest(-balance, 0), payment_status = status,
         settled_at = CASE WHEN balance <= 0 THEN COALESCE(settled_at, now()) ELSE NULL END, as_of = now()
   WHERE billing_document_id = p_document_id;
  RETURN greatest(balance, 0);
END
$$;

CREATE OR REPLACE FUNCTION bil.credit_note_refund(p_credit_note_id uuid, p_amount bigint, p_direction text)
  RETURNS TABLE (original_document_id uuid, customer_id uuid, branch_id uuid, maker_id uuid)
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
DECLARE
  cn record;
  o record;
  cs record;
  os record;
  delta numeric;
  balance numeric;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 OR p_direction NOT IN ('HOLD', 'RELEASE') THEN
    RAISE EXCEPTION 'bil.credit_note_refund: an amount above zero, held or released' USING ERRCODE = 'HK010', CONSTRAINT = 'ck_credit_note_refund_cap';
  END IF;
  -- The credit note's lock: two refunds against one credit note queue here.
  SELECT d.id, d.kind, d.status, d.gross_pesewas, d.original_document_id, d.customer_id, d.branch_id, d.created_by INTO cn
    FROM bil.billing_document d WHERE d.id = p_credit_note_id FOR UPDATE;
  IF cn.id IS NULL OR cn.kind <> 'CREDIT_NOTE' OR cn.status <> 'ISSUED' THEN
    RAISE EXCEPTION 'bil.credit_note_refund: % is not an issued credit note', p_credit_note_id USING ERRCODE = 'HK010', CONSTRAINT = 'ck_credit_note_refund_cap';
  END IF;
  SELECT d.gross_pesewas, d.credited_pesewas INTO o FROM bil.billing_document d WHERE d.id = cn.original_document_id;
  SELECT x.refunded_pesewas INTO cs FROM bil.document_settlement x WHERE x.billing_document_id = cn.id FOR UPDATE;
  SELECT x.allocated_pesewas, x.refunded_pesewas INTO os FROM bil.document_settlement x WHERE x.billing_document_id = cn.original_document_id FOR UPDATE;
  delta := CASE p_direction WHEN 'HOLD' THEN p_amount ELSE -p_amount END;
  balance := o.gross_pesewas - o.credited_pesewas - os.allocated_pesewas + os.refunded_pesewas + delta;
  IF cs.refunded_pesewas + delta > cn.gross_pesewas OR cs.refunded_pesewas + delta < 0 OR os.refunded_pesewas + delta < 0 OR (p_direction = 'HOLD' AND balance > 0) THEN
    RAISE EXCEPTION 'bil.credit_note_refund: % pesewas is more than credit note % has left to refund (% of % held; its document owes back %)', p_amount, p_credit_note_id,
      cs.refunded_pesewas, cn.gross_pesewas, greatest(-(balance - delta), 0) USING ERRCODE = 'HK010', CONSTRAINT = 'ck_credit_note_refund_cap';
  END IF;
  UPDATE bil.document_settlement SET refunded_pesewas = refunded_pesewas + delta, as_of = now() WHERE billing_document_id = cn.id;
  UPDATE bil.document_settlement
     SET refunded_pesewas = refunded_pesewas + delta, outstanding_pesewas = greatest(balance, 0), refundable_pesewas = greatest(-balance, 0), as_of = now()
   WHERE billing_document_id = cn.original_document_id;
  RETURN QUERY SELECT cn.original_document_id, cn.customer_id, cn.branch_id, cn.created_by;
END
$$;

DROP FUNCTION bil.apply_settlement(uuid, bigint, text, timestamptz);
