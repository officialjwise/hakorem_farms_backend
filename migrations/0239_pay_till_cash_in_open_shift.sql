-- 0239_pay_till_cash_in_open_shift
-- B09b continued (ADR-0077 Amendments; the parent session for the owner, 2026-11-17: the rule is held by the database
-- too): a payment that names a till shift (a cash tender into a till, a mobile money charge taken at it, the reversing
-- payment of a reversal or a void) is written only while that shift takes entries, of its branch and of the till the
-- payment names, and by the shift's holder or someone who may recover another cashier's till; a refund paid out of a
-- till shift (`paid_from_shift_id`) is paid under the same rule, out of the till that took the payment. The shift's
-- state is read from the platform's published document entry state (0236) and the recovery permission from IAM's
-- published iam.holds_permission_at (0237), never from pos or iam tables (ADR-0008). Refusals: HK010 with
-- ck_payment_till_shift and ck_refund_till_shift. The payment trigger is named to fire before the other insert triggers,
-- so the till rule is judged first.
-- Data category: none (triggers).
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
CREATE FUNCTION pay.till_shift_refusal(p_shift_id uuid, p_branch_id uuid, p_register uuid, p_actor uuid) RETURNS text
  LANGUAGE plpgsql
  STABLE
  SET search_path = pg_catalog
AS $$
DECLARE
  e record;
BEGIN
  SELECT * INTO e FROM platform.document_entry_state(p_shift_id);
  IF NOT FOUND OR e.doc_type <> 'SHIFT' THEN RETURN 'SHIFT_UNKNOWN'; END IF;
  IF NOT e.accepts_entries THEN RETURN 'SHIFT_NOT_OPEN'; END IF;
  IF e.branch_id <> p_branch_id THEN RETURN 'SHIFT_OTHER_BRANCH'; END IF;
  IF p_register IS NOT NULL AND e.container_id <> p_register THEN RETURN 'SHIFT_OTHER_REGISTER'; END IF;
  IF e.holder_id <> p_actor AND NOT iam.holds_permission_at(p_actor, 'pos.shift.force_close', e.branch_id) THEN RETURN 'SHIFT_NOT_OWN'; END IF;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION pay.till_shift_refusal(uuid, uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pay.till_shift_refusal(uuid, uuid, uuid, uuid) TO hk_app, hk_worker;

CREATE FUNCTION pay.payment_till_shift() RETURNS trigger
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
REVOKE ALL ON FUNCTION pay.payment_till_shift() FROM PUBLIC;
CREATE TRIGGER trg_payment_a_till_shift BEFORE INSERT ON pay.payment
  FOR EACH ROW EXECUTE FUNCTION pay.payment_till_shift();

CREATE OR REPLACE FUNCTION pay.refund_till_shift() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  p record;
  till_cash boolean;
  refusal text;
BEGIN
  SELECT x.method_kind, x.register_ref, x.branch_id INTO p FROM pay.payment x WHERE x.id = NEW.original_payment_id;
  till_cash := p.method_kind = 'CASH' AND p.register_ref IS NOT NULL AND NEW.destination <> 'STORE_CREDIT';
  IF NEW.paid_from_shift_id IS NOT NULL AND NOT till_cash THEN
    RAISE EXCEPTION 'pay.refund: refund % pays nothing out of a till and names no shift', NEW.id USING ERRCODE = 'HK010', CONSTRAINT = 'ck_refund_till_shift';
  END IF;
  IF NEW.status = 'PAID' AND till_cash AND NEW.paid_from_shift_id IS NULL THEN
    RAISE EXCEPTION 'pay.refund: refund % gives cash back from a till and must name the open shift it is paid out of', NEW.id USING ERRCODE = 'HK010', CONSTRAINT = 'ck_refund_till_shift';
  END IF;
  IF NEW.status = 'PAID' AND till_cash AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'PAID') THEN
    refusal := pay.till_shift_refusal(NEW.paid_from_shift_id, p.branch_id, p.register_ref, NEW.paid_by);
    IF refusal IS NOT NULL THEN
      RAISE EXCEPTION 'pay.refund %: shift % refuses the payout (%)', NEW.id, NEW.paid_from_shift_id, refusal USING ERRCODE = 'HK010', CONSTRAINT = 'ck_refund_till_shift', DETAIL = refusal;
    END IF;
  END IF;
  RETURN NEW;
END
$$;

-- migrate:down
CREATE OR REPLACE FUNCTION pay.refund_till_shift() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  p record;
  till_cash boolean;
BEGIN
  SELECT x.method_kind, x.register_ref INTO p FROM pay.payment x WHERE x.id = NEW.original_payment_id;
  till_cash := p.method_kind = 'CASH' AND p.register_ref IS NOT NULL AND NEW.destination <> 'STORE_CREDIT';
  IF NEW.paid_from_shift_id IS NOT NULL AND NOT till_cash THEN
    RAISE EXCEPTION 'pay.refund: refund % pays nothing out of a till and names no shift', NEW.id USING ERRCODE = 'HK010', CONSTRAINT = 'ck_refund_till_shift';
  END IF;
  IF NEW.status = 'PAID' AND till_cash AND NEW.paid_from_shift_id IS NULL THEN
    RAISE EXCEPTION 'pay.refund: refund % gives cash back from a till and must name the open shift it is paid out of', NEW.id USING ERRCODE = 'HK010', CONSTRAINT = 'ck_refund_till_shift';
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER trg_payment_a_till_shift ON pay.payment;
DROP FUNCTION pay.payment_till_shift();
DROP FUNCTION pay.till_shift_refusal(uuid, uuid, uuid, uuid);
