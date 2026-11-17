-- 0207_pur_number_supplier_payment
-- B09x (A-205, ADR-0015, FR-PUR-013): a supplier payment is numbered from its SUPPLIER_PAYMENT series (prefix SPY, 0093)
-- when it is marked paid, through platform.allocate_number in the same transaction, and the remittance advice prints that
-- number. The database holds it (ck_supplier_payment_number, HK010): a payment becomes PAID only carrying the number
-- allocated to it (platform.number_allocated, 0145), and a payment not PAID carries none. The number is set once, with the
-- move to PAID; platform.freeze_posted (0094) freezes it afterwards.
-- A payment marked paid before this migration keeps its null number: the guard judges only the move to PAID and a
-- change of the number, never a row it does not touch, so an existing database applies it unchanged.
-- Data category: none (a trigger).
-- Rollback: tested (`pnpm db:rollback`); drops the trigger and its function. Numbers already allocated stay allocated, as
-- they must (platform.number_allocation is a LEDGER).

-- migrate:up
CREATE FUNCTION pur.supplier_payment_number_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.status <> 'PAID' THEN
    IF NEW.payment_no IS NOT NULL THEN
      RAISE EXCEPTION 'pur.supplier_payment %: only a paid payment carries a number', NEW.id
        USING ERRCODE = 'HK010', CONSTRAINT = 'ck_supplier_payment_number';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'PAID' AND NEW.payment_no IS NOT DISTINCT FROM OLD.payment_no THEN
    RETURN NEW;
  END IF;
  IF NEW.payment_no IS NULL OR NOT platform.number_allocated(NEW.id, NEW.payment_no, 'SUPPLIER_PAYMENT') THEN
    RAISE EXCEPTION 'pur.supplier_payment %: a payment is paid carrying the number its SPY series allocated to it, not %', NEW.id, NEW.payment_no
      USING ERRCODE = 'HK010', CONSTRAINT = 'ck_supplier_payment_number';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION pur.supplier_payment_number_guard() FROM PUBLIC;
CREATE TRIGGER trg_supplier_payment_number BEFORE INSERT OR UPDATE ON pur.supplier_payment
  FOR EACH ROW EXECUTE FUNCTION pur.supplier_payment_number_guard();

-- migrate:down
DROP TRIGGER trg_supplier_payment_number ON pur.supplier_payment;
DROP FUNCTION pur.supplier_payment_number_guard();
