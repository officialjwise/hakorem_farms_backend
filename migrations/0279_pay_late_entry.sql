-- 0279_pay_late_entry
-- B09b continued 3b (ADR-0077 Amendments, the owner on 2026-11-18, replacing A-278 (e)): cash a till took offline in a
-- shift that has since stopped taking entries (closing, closed or force-closed) is recorded on that shift as a late
-- entry, never on another shift and never nowhere. pay.payment.late_entry marks it. Such a payment is a cash tender into
-- a till, never a reversal, and its shift must be a till shift that no longer takes entries, of the payment's branch
-- and till, written by the shift's own holder (no recovery by another person: the queue is the cashier's own record).
-- Every other payment keeps 0239's rule unchanged: a shift that does not take entries refuses it. A shift's expected
-- cash leaves late entries out (PgPaymentStore.shiftTotals); each posts its own post-close adjustment from POS.
-- Data category: CONFIDENTIAL (DC-09): the farm's books.
-- Rollback: tested (`pnpm db:rollback`) before the first late entry; afterwards forward fix only.

-- migrate:up
ALTER TABLE pay.payment ADD COLUMN late_entry boolean NOT NULL DEFAULT false;
ALTER TABLE pay.payment ADD CONSTRAINT ck_payment_late_entry
  CHECK (NOT late_entry OR (method_kind = 'CASH' AND shift_document_id IS NOT NULL AND register_ref IS NOT NULL AND reverses_payment_id IS NULL AND status = 'CLEARED'));

CREATE FUNCTION pay.till_shift_late_refusal(p_shift_id uuid, p_branch_id uuid, p_register uuid, p_actor uuid) RETURNS text
  LANGUAGE plpgsql
  STABLE
  SET search_path = pg_catalog
AS $$
DECLARE
  e record;
BEGIN
  SELECT * INTO e FROM platform.document_entry_state(p_shift_id);
  IF NOT FOUND OR e.doc_type <> 'SHIFT' THEN RETURN 'SHIFT_UNKNOWN'; END IF;
  IF e.accepts_entries THEN RETURN 'SHIFT_STILL_OPEN'; END IF;
  IF e.branch_id <> p_branch_id THEN RETURN 'SHIFT_OTHER_BRANCH'; END IF;
  IF p_register IS NULL OR e.container_id <> p_register THEN RETURN 'SHIFT_OTHER_REGISTER'; END IF;
  IF e.holder_id <> p_actor THEN RETURN 'SHIFT_NOT_OWN'; END IF;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION pay.till_shift_late_refusal(uuid, uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pay.till_shift_late_refusal(uuid, uuid, uuid, uuid) TO hk_app, hk_worker;

CREATE OR REPLACE FUNCTION pay.payment_till_shift() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  refusal text;
BEGIN
  IF NEW.shift_document_id IS NULL THEN RETURN NEW; END IF;
  IF NEW.late_entry THEN
    refusal := pay.till_shift_late_refusal(NEW.shift_document_id, NEW.branch_id, NEW.register_ref, NEW.created_by);
  ELSE
    refusal := pay.till_shift_refusal(NEW.shift_document_id, NEW.branch_id, NEW.register_ref, NEW.created_by);
  END IF;
  IF refusal IS NOT NULL THEN
    RAISE EXCEPTION 'pay.payment %: shift % refuses it (%)', NEW.id, NEW.shift_document_id, refusal USING ERRCODE = 'HK010', CONSTRAINT = 'ck_payment_till_shift', DETAIL = refusal;
  END IF;
  RETURN NEW;
END
$$;

-- migrate:down
CREATE OR REPLACE FUNCTION pay.payment_till_shift() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  refusal text;
BEGIN
  IF NEW.shift_document_id IS NULL THEN RETURN NEW; END IF;
  refusal := pay.till_shift_refusal(NEW.shift_document_id, NEW.branch_id, NEW.register_ref, NEW.created_by);
  IF refusal IS NOT NULL THEN
    RAISE EXCEPTION 'pay.payment %: shift % refuses it (%)', NEW.id, NEW.shift_document_id, refusal USING ERRCODE = 'HK010', CONSTRAINT = 'ck_payment_till_shift', DETAIL = refusal;
  END IF;
  RETURN NEW;
END
$$;
DROP FUNCTION pay.till_shift_late_refusal(uuid, uuid, uuid, uuid);
ALTER TABLE pay.payment DROP CONSTRAINT ck_payment_late_entry;
ALTER TABLE pay.payment DROP COLUMN late_entry;
