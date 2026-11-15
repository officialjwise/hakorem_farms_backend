-- 0105_pur_first_payment_approver
-- The owner's answer of 2026-11-15 (A-171): the person who made a payout change may not approve the first payment to
-- that supplier after it. They may still prepare it, and the change's approver is not barred.
--   pur.supplier_payment_first_use        now also records which approved change the first payment follows
--                                          (`payout_first_use_change_id`), fixed on insert and never changed (HK004)
--   pur.supplier_payment_first_approver   a first payment becomes APPROVED only by someone other than that change's
--                                          maker: the approver is the row's `updated_by` on the approving update (HK010)
-- Data category: CONFIDENTIAL (DC-11).
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
ALTER TABLE pur.supplier_payment
  ADD COLUMN payout_first_use_change_id uuid NULL CONSTRAINT fk_supplier_payment_first_use_change REFERENCES pur.supplier_payout_change (id) ON DELETE RESTRICT;
ALTER TABLE pur.supplier_payment ADD CONSTRAINT ck_supplier_payment_first_use_change CHECK (payout_first_use = (payout_first_use_change_id IS NOT NULL));

CREATE OR REPLACE FUNCTION pur.supplier_payment_first_use() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  in_force uuid;
  changed_at timestamptz;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.payout_first_use IS DISTINCT FROM OLD.payout_first_use OR NEW.payout_first_use_change_id IS DISTINCT FROM OLD.payout_first_use_change_id THEN
      RAISE EXCEPTION 'pur.supplier_payment %: whether it is the first payment after a payout change never changes', OLD.id USING ERRCODE = 'HK004';
    END IF;
    RETURN NEW;
  END IF;
  SELECT c.id, c.posted_at INTO in_force, changed_at
    FROM pur.supplier_profile p JOIN pur.supplier_payout_change c ON c.id = p.payout_change_id
   WHERE p.supplier_id = NEW.supplier_id;
  NEW.payout_first_use := changed_at IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pur.supplier_payment o
     WHERE o.supplier_id = NEW.supplier_id AND o.id <> NEW.id AND o.created_at >= changed_at AND o.status NOT IN ('REJECTED', 'CANCELLED'));
  NEW.payout_first_use_change_id := CASE WHEN NEW.payout_first_use THEN in_force END;
  RETURN NEW;
END
$$;

CREATE FUNCTION pur.supplier_payment_first_approver() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  change_maker uuid;
BEGIN
  IF NEW.status = 'APPROVED' AND OLD.status IS DISTINCT FROM 'APPROVED' AND NEW.payout_first_use_change_id IS NOT NULL THEN
    SELECT c.created_by INTO change_maker FROM pur.supplier_payout_change c WHERE c.id = NEW.payout_first_use_change_id;
    IF NEW.updated_by = change_maker THEN
      RAISE EXCEPTION 'pur.supplier_payment %: the maker of payout change % may not approve the first payment after it', NEW.id, NEW.payout_first_use_change_id
        USING ERRCODE = 'HK010', CONSTRAINT = 'ck_supplier_payment_first_use_approver';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION pur.supplier_payment_first_approver() FROM PUBLIC;
CREATE TRIGGER trg_supplier_payment_first_approver BEFORE UPDATE ON pur.supplier_payment
  FOR EACH ROW EXECUTE FUNCTION pur.supplier_payment_first_approver();

-- migrate:down
DROP TRIGGER trg_supplier_payment_first_approver ON pur.supplier_payment;
DROP FUNCTION pur.supplier_payment_first_approver();
CREATE OR REPLACE FUNCTION pur.supplier_payment_first_use() RETURNS trigger
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
ALTER TABLE pur.supplier_payment DROP CONSTRAINT ck_supplier_payment_first_use_change;
ALTER TABLE pur.supplier_payment DROP COLUMN payout_first_use_change_id;
