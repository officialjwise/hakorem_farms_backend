-- 0176_pay_store_credit_named_customer
-- The owner, 2026-11-16 (FR-PAY-015, A-212 (b)): store credit is issued only to a named customer with a phone number,
-- never the walk-in. `pay.store_credit_entry.customer_id` is already NOT NULL (a walk-in payment has no customer to
-- credit); this refuses an ISSUE entry for a customer MDM holds no phone for (`ck_store_credit_entry_customer_phone`),
-- whoever writes it. A redemption or expiry of credit already held is not refused.
-- Data category: none (a trigger).
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
CREATE FUNCTION pay.store_credit_named_customer() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF NOT mdm.customer_has_phone(NEW.customer_id) THEN
    RAISE EXCEPTION 'pay.store_credit_entry %: store credit is issued only to a named customer with a phone number', NEW.id
      USING ERRCODE = 'HK004', CONSTRAINT = 'ck_store_credit_entry_customer_phone';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION pay.store_credit_named_customer() FROM PUBLIC;
CREATE TRIGGER trg_store_credit_entry_named_customer BEFORE INSERT ON pay.store_credit_entry
  FOR EACH ROW WHEN (NEW.direction = 'ISSUE') EXECUTE FUNCTION pay.store_credit_named_customer();

-- migrate:down
DROP TRIGGER trg_store_credit_entry_named_customer ON pay.store_credit_entry;
DROP FUNCTION pay.store_credit_named_customer();
