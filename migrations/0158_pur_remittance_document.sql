-- 0158_pur_remittance_document
-- B08 continued 2c (FR-PUR-013, docs/data-model/pur.md, ADR-0062, A-174): the expand migration that adds
-- `supplier_payment.remittance_document_id`, the archived rendering of the payment's remittance advice (DOC's published
-- key `doc.archived_document`). PUR's asynchronous subscriber `pur.remittance-link` sets it after DOC archives the
-- advice, once. The database holds (SQLSTATE HK004, the rule as the constraint name):
--   ck_supplier_payment_remittance_document   only a PAID payment names its advice, and once named it never changes
--   uq_supplier_payment_remittance_document   an advice belongs to one payment
-- A PAID payment stays frozen (`trg_supplier_payment_freeze`) but for this one link and its version columns.
-- Data category: CONFIDENTIAL (DC-11).
-- Rollback: tested (`pnpm db:rollback`). Rolling back drops only the link; the archive keeps every advice.

-- migrate:up
ALTER TABLE pur.supplier_payment ADD COLUMN remittance_document_id uuid NULL
  CONSTRAINT fk_supplier_payment_remittance_document REFERENCES doc.archived_document (id) ON DELETE RESTRICT;
CREATE UNIQUE INDEX uq_supplier_payment_remittance_document ON pur.supplier_payment (remittance_document_id) WHERE remittance_document_id IS NOT NULL;

CREATE FUNCTION pur.supplier_payment_remittance_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.remittance_document_id IS NOT NULL AND NEW.status <> 'PAID' THEN
    RAISE EXCEPTION 'pur.supplier_payment %: only a paid payment has a remittance advice', NEW.id USING ERRCODE = 'HK004', CONSTRAINT = 'ck_supplier_payment_remittance_document';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.remittance_document_id IS NOT NULL AND NEW.remittance_document_id IS DISTINCT FROM OLD.remittance_document_id THEN
    RAISE EXCEPTION 'pur.supplier_payment %: its remittance advice never changes', OLD.id USING ERRCODE = 'HK004', CONSTRAINT = 'ck_supplier_payment_remittance_document';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION pur.supplier_payment_remittance_guard() FROM PUBLIC;
DROP TRIGGER trg_supplier_payment_freeze ON pur.supplier_payment;
CREATE TRIGGER trg_supplier_payment_freeze BEFORE UPDATE ON pur.supplier_payment
  FOR EACH ROW EXECUTE FUNCTION platform.freeze_posted('PAID,REJECTED,CANCELLED', 'remittance_document_id', 'version', 'updated_at', 'updated_by');
CREATE TRIGGER trg_supplier_payment_remittance_guard BEFORE INSERT OR UPDATE ON pur.supplier_payment
  FOR EACH ROW EXECUTE FUNCTION pur.supplier_payment_remittance_guard();

-- migrate:down
DROP TRIGGER trg_supplier_payment_freeze ON pur.supplier_payment;
CREATE TRIGGER trg_supplier_payment_freeze BEFORE UPDATE ON pur.supplier_payment
  FOR EACH ROW EXECUTE FUNCTION platform.freeze_posted('PAID,REJECTED,CANCELLED');
DROP TRIGGER trg_supplier_payment_remittance_guard ON pur.supplier_payment;
DROP FUNCTION pur.supplier_payment_remittance_guard();
ALTER TABLE pur.supplier_payment DROP COLUMN remittance_document_id;
