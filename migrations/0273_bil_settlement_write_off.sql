-- 0273_bil_settlement_write_off
-- B10 continued 3 (FR-WHL-012, ADR-0090, A-321; the parent session's leave of 2026-11-18 to change BIL's settlement
-- functions): a bad-debt write-off closes the open item in BIL itself, so PAY's open items, WHL's credit exposure and
-- dunning all see it closed and no payment or credit note can be put onto the amount written off.
--   bil.document_settlement.written_off_pesewas  what has been written off the document as bad debt; nil until a
--                                                write-off is applied, and it only grows (insert-only write-offs in WHL)
--   ck_document_settlement_written_off           a document with anything written off never owes the customer money
--   bil.document_settlement_keep()               0182's trigger, the balance less what is written off; a credit note
--                                                that would reach into the amount written off is refused
--                                                (HK010 ck_billing_document_credit_cap, as BIL answers it already)
--   bil.apply_settlement (both forms)            0187's, the balance less what is written off: an allocation beyond
--                                                what is left is refused as before (ck_document_settlement_outstanding)
--   bil.credit_note_refund                       0187's, the balance less what is written off
--   bil.apply_write_off(document, amount, at)    new: under the summary's lock, at most what is outstanding, more than
--                                                nothing (HK010 ck_document_settlement_written_off); called only by
--                                                `Billing.writeOffIn` in WHL's approving transaction
-- On a document with nothing written off every function answers exactly as before (proved by
-- test/integration/bil/settlement-write-off.integration.spec.ts). The payment status of a document with something
-- written off is UNPAID when nothing was ever paid or credited, PART_PAID otherwise (A-321 (d)); no status is added.
-- Data category: CONFIDENTIAL (DC-09).
-- Rollback: tested (`pnpm db:rollback`): restores 0182's trigger function and 0187's three functions word for word
-- and drops the column; it refuses to run once anything has been written off (forward fix only from then on).

-- migrate:up
ALTER TABLE bil.document_settlement
  ADD COLUMN written_off_pesewas platform.pesewas NOT NULL DEFAULT 0,
  ADD CONSTRAINT ck_document_settlement_written_off CHECK (written_off_pesewas >= 0 AND (written_off_pesewas = 0 OR refundable_pesewas = 0));

CREATE OR REPLACE FUNCTION bil.document_settlement_keep() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
DECLARE
  allocated numeric := 0;
  refunded numeric := 0;
  written_off numeric := 0;
  balance numeric;
  outstanding numeric;
  refundable numeric;
  payment_status text;
BEGIN
  SELECT s.allocated_pesewas, s.refunded_pesewas, s.written_off_pesewas INTO allocated, refunded, written_off FROM bil.document_settlement s WHERE s.billing_document_id = NEW.id;
  allocated := COALESCE(allocated, 0);
  refunded := COALESCE(refunded, 0);
  written_off := COALESCE(written_off, 0);
  IF NEW.kind IN ('PROFORMA', 'CREDIT_NOTE') THEN
    outstanding := 0;
    refundable := 0;
    payment_status := 'NOT_APPLICABLE';
  ELSE
    balance := NEW.gross_pesewas - NEW.credited_pesewas - allocated + refunded - written_off;
    -- A credit note never reaches into what was written off as bad debt (ADR-0090).
    IF written_off > 0 AND balance < 0 THEN
      RAISE EXCEPTION 'bil.document_settlement: document % has % pesewas written off; a credit note may take off at most what is left outstanding', NEW.id, written_off
        USING ERRCODE = 'HK010', CONSTRAINT = 'ck_billing_document_credit_cap';
    END IF;
    outstanding := greatest(balance, 0);
    refundable := greatest(-balance, 0);
    payment_status := CASE
      WHEN written_off > 0 THEN CASE WHEN allocated = 0 AND NEW.credited_pesewas = 0 THEN 'UNPAID' ELSE 'PART_PAID' END
      WHEN outstanding > 0 AND allocated = 0 AND NEW.credited_pesewas = 0 THEN 'UNPAID'
      WHEN outstanding > 0 THEN 'PART_PAID'
      WHEN allocated = 0 THEN 'CREDITED'
      ELSE 'PAID' END;
  END IF;
  INSERT INTO bil.document_settlement (billing_document_id, allocated_pesewas, credited_pesewas, outstanding_pesewas, refundable_pesewas, payment_status, settled_at, as_of)
  VALUES (NEW.id, allocated, NEW.credited_pesewas, outstanding, refundable, payment_status,
          CASE WHEN outstanding = 0 AND payment_status <> 'NOT_APPLICABLE' THEN NEW.updated_at END, NEW.updated_at)
  ON CONFLICT (billing_document_id) DO UPDATE
     SET credited_pesewas = EXCLUDED.credited_pesewas, outstanding_pesewas = EXCLUDED.outstanding_pesewas, refundable_pesewas = EXCLUDED.refundable_pesewas,
         payment_status = EXCLUDED.payment_status, settled_at = COALESCE(bil.document_settlement.settled_at, EXCLUDED.settled_at), as_of = EXCLUDED.as_of;
  RETURN NULL;
END
$$;

CREATE OR REPLACE FUNCTION bil.apply_settlement(p_document_id uuid, p_amount bigint, p_direction text, p_at timestamptz) RETURNS bigint
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
  SELECT x.allocated_pesewas, x.refunded_pesewas, x.written_off_pesewas INTO s FROM bil.document_settlement x WHERE x.billing_document_id = p_document_id FOR UPDATE;
  allocated := s.allocated_pesewas + CASE p_direction WHEN 'APPLY' THEN p_amount ELSE -p_amount END;
  -- What was written off as bad debt is no longer outstanding: no payment is put onto it (ADR-0090).
  balance := d.gross_pesewas - d.credited_pesewas - allocated + s.refunded_pesewas - s.written_off_pesewas;
  -- Never more applied than the document has outstanding: a document that owes the customer money takes no allocation.
  IF allocated < 0 OR (p_direction = 'APPLY' AND balance < 0) THEN
    RAISE EXCEPTION 'bil.apply_settlement: % pesewas % leaves document % with % outstanding (% written off)', p_amount, lower(p_direction), p_document_id, balance, s.written_off_pesewas
      USING ERRCODE = 'HK010', CONSTRAINT = 'ck_document_settlement_outstanding';
  END IF;
  status := CASE
    WHEN s.written_off_pesewas > 0 THEN CASE WHEN allocated = 0 AND d.credited_pesewas = 0 THEN 'UNPAID' ELSE 'PART_PAID' END
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
  SELECT x.allocated_pesewas, x.refunded_pesewas, x.written_off_pesewas INTO os FROM bil.document_settlement x WHERE x.billing_document_id = cn.original_document_id FOR UPDATE;
  delta := CASE p_direction WHEN 'HOLD' THEN p_amount ELSE -p_amount END;
  balance := o.gross_pesewas - o.credited_pesewas - os.allocated_pesewas + os.refunded_pesewas + delta - os.written_off_pesewas;
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

-- A bad-debt write-off applied to an open item's summary (FR-WHL-012): more than nothing, at most what is outstanding,
-- under the summary's lock. Answers what is left outstanding.
CREATE FUNCTION bil.apply_write_off(p_document_id uuid, p_amount bigint, p_at timestamptz) RETURNS bigint
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
DECLARE
  d record;
  s record;
  balance numeric;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 OR p_at IS NULL THEN
    RAISE EXCEPTION 'bil.apply_write_off: an amount above zero, at an instant' USING ERRCODE = 'HK010', CONSTRAINT = 'ck_document_settlement_written_off';
  END IF;
  SELECT b.id, b.kind, b.status, b.gross_pesewas, b.credited_pesewas, b.customer_id INTO d FROM bil.billing_document b WHERE b.id = p_document_id;
  IF d.id IS NULL OR d.status <> 'ISSUED' OR d.kind NOT IN ('INVOICE', 'RECEIPT', 'DEBIT_NOTE') OR d.customer_id IS NULL THEN
    RAISE EXCEPTION 'bil.apply_write_off: % is not an issued invoice, receipt or debit note of a named customer', p_document_id
      USING ERRCODE = 'HK010', CONSTRAINT = 'ck_document_settlement_written_off';
  END IF;
  SELECT x.allocated_pesewas, x.refunded_pesewas, x.written_off_pesewas INTO s FROM bil.document_settlement x WHERE x.billing_document_id = p_document_id FOR UPDATE;
  balance := d.gross_pesewas - d.credited_pesewas - s.allocated_pesewas + s.refunded_pesewas - s.written_off_pesewas;
  IF p_amount > balance THEN
    RAISE EXCEPTION 'bil.apply_write_off: % pesewas is more than document % has outstanding (%)', p_amount, p_document_id, greatest(balance, 0)
      USING ERRCODE = 'HK010', CONSTRAINT = 'ck_document_settlement_written_off';
  END IF;
  UPDATE bil.document_settlement
     SET written_off_pesewas = written_off_pesewas + p_amount, outstanding_pesewas = balance - p_amount, refundable_pesewas = 0,
         payment_status = CASE WHEN s.allocated_pesewas = 0 AND d.credited_pesewas = 0 THEN 'UNPAID' ELSE 'PART_PAID' END,
         settled_at = CASE WHEN balance - p_amount = 0 THEN COALESCE(settled_at, p_at) ELSE NULL END, as_of = p_at
   WHERE billing_document_id = p_document_id;
  RETURN balance - p_amount;
END
$$;
REVOKE ALL ON FUNCTION bil.apply_write_off(uuid, bigint, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION bil.apply_write_off(uuid, bigint, timestamptz) TO hk_app, hk_worker;

-- migrate:down
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM bil.document_settlement WHERE written_off_pesewas > 0) THEN
    RAISE EXCEPTION '0273 cannot be rolled back: documents have amounts written off as bad debt (forward fix only, ADR-0090)';
  END IF;
END
$$;
DROP FUNCTION bil.apply_write_off(uuid, bigint, timestamptz);
-- 0182's trigger function and 0187's three functions, word for word.
CREATE OR REPLACE FUNCTION bil.document_settlement_keep() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
DECLARE
  allocated numeric := 0;
  refunded numeric := 0;
  balance numeric;
  outstanding numeric;
  refundable numeric;
  payment_status text;
BEGIN
  SELECT s.allocated_pesewas, s.refunded_pesewas INTO allocated, refunded FROM bil.document_settlement s WHERE s.billing_document_id = NEW.id;
  allocated := COALESCE(allocated, 0);
  refunded := COALESCE(refunded, 0);
  IF NEW.kind IN ('PROFORMA', 'CREDIT_NOTE') THEN
    outstanding := 0;
    refundable := 0;
    payment_status := 'NOT_APPLICABLE';
  ELSE
    balance := NEW.gross_pesewas - NEW.credited_pesewas - allocated + refunded;
    outstanding := greatest(balance, 0);
    refundable := greatest(-balance, 0);
    payment_status := CASE
      WHEN outstanding > 0 AND allocated = 0 AND NEW.credited_pesewas = 0 THEN 'UNPAID'
      WHEN outstanding > 0 THEN 'PART_PAID'
      WHEN allocated = 0 THEN 'CREDITED'
      ELSE 'PAID' END;
  END IF;
  INSERT INTO bil.document_settlement (billing_document_id, allocated_pesewas, credited_pesewas, outstanding_pesewas, refundable_pesewas, payment_status, settled_at, as_of)
  VALUES (NEW.id, allocated, NEW.credited_pesewas, outstanding, refundable, payment_status,
          CASE WHEN outstanding = 0 AND payment_status <> 'NOT_APPLICABLE' THEN NEW.updated_at END, NEW.updated_at)
  ON CONFLICT (billing_document_id) DO UPDATE
     SET credited_pesewas = EXCLUDED.credited_pesewas, outstanding_pesewas = EXCLUDED.outstanding_pesewas, refundable_pesewas = EXCLUDED.refundable_pesewas,
         payment_status = EXCLUDED.payment_status, settled_at = COALESCE(bil.document_settlement.settled_at, EXCLUDED.settled_at), as_of = EXCLUDED.as_of;
  RETURN NULL;
END
$$;

CREATE OR REPLACE FUNCTION bil.apply_settlement(p_document_id uuid, p_amount bigint, p_direction text, p_at timestamptz) RETURNS bigint
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

ALTER TABLE bil.document_settlement DROP CONSTRAINT ck_document_settlement_written_off, DROP COLUMN written_off_pesewas;
