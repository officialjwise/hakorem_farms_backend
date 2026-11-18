-- 0232_pay_refund_paid_from_shift
-- B09b continued (A-273 (i), ADR-0077): cash given back from a till leaves it only out of an open shift of the till that
-- took the payment, so every pesewa refunded in cash is counted at that shift's close. A refund paid of a cash payment
-- held by a till (not to store credit) names the till shift it was paid out of (ck_refund_till_shift); nothing else names
-- one, and once paid it never changes (pay.refund_guard freezes a paid refund). That the named document is a SHIFT, open, of that till and reachable by the payer
-- is POS's to check under the shift's lock (the TillShiftCheck port): PAY never reads POS's tables.
-- Data category: none (a column, an index and a trigger).
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
ALTER TABLE pay.refund ADD COLUMN paid_from_shift_id uuid NULL CONSTRAINT fk_refund_paid_from_shift REFERENCES platform.business_document (id) ON DELETE RESTRICT;
CREATE INDEX ix_refund_paid_from_shift ON pay.refund (paid_from_shift_id) WHERE paid_from_shift_id IS NOT NULL;

CREATE FUNCTION pay.refund_till_shift() RETURNS trigger
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
REVOKE ALL ON FUNCTION pay.refund_till_shift() FROM PUBLIC;
CREATE TRIGGER trg_refund_till_shift BEFORE INSERT OR UPDATE ON pay.refund
  FOR EACH ROW EXECUTE FUNCTION pay.refund_till_shift();

-- migrate:down
DROP TRIGGER trg_refund_till_shift ON pay.refund;
DROP FUNCTION pay.refund_till_shift();
DROP INDEX pay.ix_refund_paid_from_shift;
ALTER TABLE pay.refund DROP COLUMN paid_from_shift_id;
