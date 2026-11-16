-- 0104_pur_first_payment_after_payout_change
-- The owner's rule of 2026-11-15 (A-170): the first payment to a supplier after its payout details change needs a
-- second approver, whatever the amount. The database decides which payment is the first, not the writer:
--   pur.supplier_payment_first_use     on insert, sets payout_first_use when the supplier has approved payout details
--                                      in force and no live payment (not REJECTED or CANCELLED) was prepared for it since
--                                      they were approved; the flag never changes afterwards (HK004)
--   ck_supplier_payment_first_use      such a payment is never approved or paid without an approval request
-- Every payment needs an approval today (FR-PUR-012, ck_supplier_payment_approval); this rule stands on its own, so a
-- payment threshold added later cannot remove it.
-- Data category: CONFIDENTIAL (DC-11).
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
ALTER TABLE pur.supplier_payment ADD COLUMN payout_first_use boolean NOT NULL DEFAULT false;
ALTER TABLE pur.supplier_payment ADD CONSTRAINT ck_supplier_payment_first_use
  CHECK (NOT payout_first_use OR status IN ('DRAFT', 'CANCELLED') OR approval_request_id IS NOT NULL);

CREATE FUNCTION pur.supplier_payment_first_use() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  changed_at timestamptz;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.payout_first_use IS DISTINCT FROM OLD.payout_first_use THEN
      RAISE EXCEPTION 'pur.supplier_payment %: whether it is the first payment after a payout change never changes', OLD.id USING ERRCODE = 'HK004';
    END IF;
    RETURN NEW;
  END IF;
  SELECT c.posted_at INTO changed_at
    FROM pur.supplier_profile p JOIN pur.supplier_payout_change c ON c.id = p.payout_change_id
   WHERE p.supplier_id = NEW.supplier_id;
  NEW.payout_first_use := changed_at IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pur.supplier_payment o
     WHERE o.supplier_id = NEW.supplier_id AND o.id <> NEW.id AND o.created_at >= changed_at AND o.status NOT IN ('REJECTED', 'CANCELLED'));
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION pur.supplier_payment_first_use() FROM PUBLIC;
CREATE TRIGGER trg_supplier_payment_first_use BEFORE INSERT OR UPDATE ON pur.supplier_payment
  FOR EACH ROW EXECUTE FUNCTION pur.supplier_payment_first_use();

-- migrate:down
DROP TRIGGER trg_supplier_payment_first_use ON pur.supplier_payment;
DROP FUNCTION pur.supplier_payment_first_use();
ALTER TABLE pur.supplier_payment DROP CONSTRAINT ck_supplier_payment_first_use;
ALTER TABLE pur.supplier_payment DROP COLUMN payout_first_use;
