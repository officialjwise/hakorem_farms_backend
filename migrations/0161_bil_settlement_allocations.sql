-- 0161_bil_settlement_allocations
-- B9a (FR-PAY-009, FR-ORD-016, A-200): PAY's allocations reach a billing document's settlement summary through BIL.
-- `bil.apply_settlement(document, amount, direction)` is the only writer of `bil.document_settlement.allocated_pesewas`,
-- called by `Billing.settleIn` in the allocating transaction (PAY never touches BIL's tables). It holds:
--   ck_document_settlement_outstanding   an allocation never exceeds what the document has outstanding (its gross less
--                                        credits less what is already allocated), an unallocation never more than is
--                                        allocated, and only an ISSUED invoice, receipt or debit note takes one
-- Payment status follows: UNPAID, PART_PAID, PAID or CREDITED as the trigger of 0147 computes it.
-- Data category: CONFIDENTIAL (DC-09).
-- Rollback: tested (`pnpm db:rollback`), safe before the first allocation; afterwards forward fix only.

-- migrate:up
CREATE FUNCTION bil.apply_settlement(p_document_id uuid, p_amount bigint, p_direction text) RETURNS bigint
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
REVOKE ALL ON FUNCTION bil.apply_settlement(uuid, bigint, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION bil.apply_settlement(uuid, bigint, text) TO hk_app, hk_worker;

-- migrate:down
DROP FUNCTION bil.apply_settlement(uuid, bigint, text);
