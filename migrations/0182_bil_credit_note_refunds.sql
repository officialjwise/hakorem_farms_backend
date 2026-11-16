-- 0182_bil_credit_note_refunds
-- B09a continued 1d (FR-BIL-007, FR-PAY-012, ADR-0066, A-216): a credit note on a paid document, and what a refund
-- against it may draw on. A credit beyond what the original has outstanding is no longer refused: it leaves the credited
-- money owed back to the customer on the original, refundable. The settlement summary carries it:
--   refunded_pesewas     on an invoice or receipt: refunds asked for against its credit notes and not rejected (held
--                        while they wait); on a credit note: the same, against that note
--   refundable_pesewas   on an invoice or receipt: what it owes back to the customer, its gross less credited less
--                        allocated plus refunded when that is below zero; otherwise 0
-- Outstanding is that balance when it is above zero, otherwise 0. `bil.apply_settlement` refuses an allocation to a
-- document that would owe the customer money (`ck_document_settlement_outstanding`).
-- Published for PAY's refund triggers (ADR-0047, `tooling/architecture.json`):
--   bil.credit_note_refund(id, amount, HOLD | RELEASE)   under the credit note's row lock: holds a refund against an
--                        issued credit note, never beyond its gross less what is already held against it, and never
--                        beyond what its original owes back (`ck_credit_note_refund_cap`); a release gives it back.
--                        Executable only by its owner (PAY's SECURITY DEFINER trigger), never by hk_app directly
--   bil.credit_note_facts(id)   the credit note's original, customer, branch and maker, read only
-- Data category: CONFIDENTIAL (DC-09).
-- Rollback: tested (`pnpm db:rollback`), safe before the first credit beyond outstanding or refund against a credit
-- note; afterwards forward fix only.

-- migrate:up
ALTER TABLE bil.document_settlement
  ADD COLUMN refunded_pesewas platform.pesewas NOT NULL DEFAULT 0,
  ADD COLUMN refundable_pesewas platform.pesewas NOT NULL DEFAULT 0;

-- The settlement summary of an issued document, kept with it: written at issue and whenever its credited amount moves.
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

CREATE FUNCTION bil.credit_note_facts(p_credit_note_id uuid)
  RETURNS TABLE (original_document_id uuid, customer_id uuid, branch_id uuid, maker_id uuid)
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
  SELECT d.original_document_id, d.customer_id, d.branch_id, d.created_by
    FROM bil.billing_document d
   WHERE d.id = p_credit_note_id AND d.kind = 'CREDIT_NOTE' AND d.status = 'ISSUED';
$$;
REVOKE ALL ON FUNCTION bil.credit_note_facts(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION bil.credit_note_facts(uuid) TO hk_app, hk_worker;

CREATE FUNCTION bil.credit_note_refund(p_credit_note_id uuid, p_amount bigint, p_direction text)
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
REVOKE ALL ON FUNCTION bil.credit_note_refund(uuid, bigint, text) FROM PUBLIC;

-- migrate:down
DROP FUNCTION bil.credit_note_refund(uuid, bigint, text);
DROP FUNCTION bil.credit_note_facts(uuid);
CREATE OR REPLACE FUNCTION bil.document_settlement_keep() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
DECLARE
  allocated numeric := 0;
  outstanding numeric;
  payment_status text;
BEGIN
  SELECT s.allocated_pesewas INTO allocated FROM bil.document_settlement s WHERE s.billing_document_id = NEW.id;
  allocated := COALESCE(allocated, 0);
  IF NEW.kind IN ('PROFORMA', 'CREDIT_NOTE') THEN
    outstanding := 0;
    payment_status := 'NOT_APPLICABLE';
  ELSE
    outstanding := NEW.gross_pesewas - NEW.credited_pesewas - allocated;
    payment_status := CASE
      WHEN outstanding > 0 AND allocated = 0 AND NEW.credited_pesewas = 0 THEN 'UNPAID'
      WHEN outstanding > 0 THEN 'PART_PAID'
      WHEN allocated = 0 THEN 'CREDITED'
      ELSE 'PAID' END;
  END IF;
  INSERT INTO bil.document_settlement (billing_document_id, allocated_pesewas, credited_pesewas, outstanding_pesewas, payment_status, settled_at, as_of)
  VALUES (NEW.id, allocated, NEW.credited_pesewas, outstanding, payment_status,
          CASE WHEN outstanding = 0 AND payment_status <> 'NOT_APPLICABLE' THEN NEW.updated_at END, NEW.updated_at)
  ON CONFLICT (billing_document_id) DO UPDATE
     SET credited_pesewas = EXCLUDED.credited_pesewas, outstanding_pesewas = EXCLUDED.outstanding_pesewas, payment_status = EXCLUDED.payment_status,
         settled_at = COALESCE(bil.document_settlement.settled_at, EXCLUDED.settled_at), as_of = EXCLUDED.as_of;
  RETURN NULL;
END
$$;

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

ALTER TABLE bil.document_settlement DROP COLUMN refundable_pesewas, DROP COLUMN refunded_pesewas;
