-- 0313_pay_driver_hand_in_payment
-- B11 continued 2 (FR-DEL-010, CR-057, ADR-0077, ADR-0092, abuse case 47): a driver's cash handed in at a till is
-- written as a cash payment onto the receiving cashier's own open shift (so the till's records, its X and Z reports and
-- its close count it, through the one door every till cash takes, `Payments.writeIn` and `trg_payment_a_till_shift`),
-- naming the driver it was received from. It settles nothing: the collections it receives were already allocated to
-- their documents when the driver took them (del.CodCollected). So:
--   received_from_driver_id         the driver whose cash on delivery this till payment receives (NULL for any other)
--   ck_payment_driver_hand_in       a hand-in is cash into a till (a register, a shift), held by no driver, of no
--                                   customer or order, cleared, and never a late entry
--   pay.driver_hand_in_guard()      (HK010, ck_payment_driver_hand_in_final) a hand-in is never allocated to a
--                                   document, linked to an order, refunded or reversed, and its status, amount, shift and
--                                   driver never change: the same cash can never settle a document twice
-- New column and triggers only; no existing column, constraint or trigger changes.
-- Data category: CONFIDENTIAL (DC-09): the farm's money.
-- Rollback: tested (`pnpm db:rollback`), safe before the first hand-in; afterwards forward fix only.

-- migrate:up
ALTER TABLE pay.payment ADD COLUMN received_from_driver_id uuid NULL
  CONSTRAINT fk_payment_received_from_driver REFERENCES iam.principal (id) ON DELETE RESTRICT;
ALTER TABLE pay.payment ADD CONSTRAINT ck_payment_driver_hand_in CHECK (
  received_from_driver_id IS NULL
  OR (method_kind = 'CASH' AND register_ref IS NOT NULL AND shift_document_id IS NOT NULL AND driver_id IS NULL
      AND customer_id IS NULL AND order_document_id IS NULL AND status = 'CLEARED' AND NOT late_entry
      AND received_from_driver_id <> created_by));
CREATE INDEX ix_payment_received_from_driver ON pay.payment (received_from_driver_id) WHERE received_from_driver_id IS NOT NULL;
COMMENT ON COLUMN pay.payment.received_from_driver_id IS 'A driver''s cash on delivery handed in at this till shift; it settles nothing (B11 continued 2)';

CREATE FUNCTION pay.driver_hand_in_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  target uuid;
BEGIN
  IF TG_TABLE_NAME = 'payment' THEN
    IF OLD.received_from_driver_id IS NOT NULL
       AND (NEW.status, NEW.amount_pesewas, NEW.shift_document_id, NEW.received_from_driver_id, NEW.allocated_pesewas, NEW.refunded_pesewas)
           IS DISTINCT FROM (OLD.status, OLD.amount_pesewas, OLD.shift_document_id, OLD.received_from_driver_id, OLD.allocated_pesewas, OLD.refunded_pesewas) THEN
      RAISE EXCEPTION 'pay.payment %: a driver''s hand-in never changes', OLD.id USING ERRCODE = 'HK010', CONSTRAINT = 'ck_payment_driver_hand_in_final';
    END IF;
    IF OLD.received_from_driver_id IS NULL AND NEW.received_from_driver_id IS NOT NULL THEN
      RAISE EXCEPTION 'pay.payment %: a payment cannot become a driver''s hand-in', OLD.id USING ERRCODE = 'HK010', CONSTRAINT = 'ck_payment_driver_hand_in_final';
    END IF;
    RETURN NEW;
  END IF;
  target := (CASE WHEN TG_TABLE_NAME = 'refund' THEN to_jsonb(NEW) ->> 'original_payment_id' ELSE to_jsonb(NEW) ->> 'payment_id' END)::uuid;
  IF EXISTS (SELECT 1 FROM pay.payment p WHERE p.id = target AND p.received_from_driver_id IS NOT NULL) THEN
    RAISE EXCEPTION 'pay.%: payment % is a driver''s hand-in and settles nothing', TG_TABLE_NAME, target USING ERRCODE = 'HK010', CONSTRAINT = 'ck_payment_driver_hand_in_final';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION pay.driver_hand_in_guard() FROM PUBLIC;
CREATE TRIGGER trg_payment_driver_hand_in BEFORE UPDATE ON pay.payment
  FOR EACH ROW EXECUTE FUNCTION pay.driver_hand_in_guard();
CREATE TRIGGER trg_payment_allocation_driver_hand_in BEFORE INSERT ON pay.payment_allocation
  FOR EACH ROW EXECUTE FUNCTION pay.driver_hand_in_guard();
CREATE TRIGGER trg_payment_order_link_driver_hand_in BEFORE INSERT ON pay.payment_order_link
  FOR EACH ROW EXECUTE FUNCTION pay.driver_hand_in_guard();
CREATE TRIGGER trg_refund_driver_hand_in BEFORE INSERT ON pay.refund
  FOR EACH ROW EXECUTE FUNCTION pay.driver_hand_in_guard();
CREATE TRIGGER trg_payment_reversal_driver_hand_in BEFORE INSERT ON pay.payment_reversal
  FOR EACH ROW EXECUTE FUNCTION pay.driver_hand_in_guard();

-- migrate:down
DROP TRIGGER trg_payment_reversal_driver_hand_in ON pay.payment_reversal;
DROP TRIGGER trg_refund_driver_hand_in ON pay.refund;
DROP TRIGGER trg_payment_order_link_driver_hand_in ON pay.payment_order_link;
DROP TRIGGER trg_payment_allocation_driver_hand_in ON pay.payment_allocation;
DROP TRIGGER trg_payment_driver_hand_in ON pay.payment;
DROP FUNCTION pay.driver_hand_in_guard();
DROP INDEX pay.ix_payment_received_from_driver;
ALTER TABLE pay.payment DROP CONSTRAINT ck_payment_driver_hand_in;
ALTER TABLE pay.payment DROP COLUMN received_from_driver_id;
