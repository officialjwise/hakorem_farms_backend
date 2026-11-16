-- 0134_pur_supplier_payment_bank_account
-- B08 continued 1b2 (docs/data-model/pur.md, docs/DATA_MODEL.md Migrations, A-185, A-194): the farm's own account a
-- supplier payment leaves from, now that FIN builds fin.bank_account (published key, MODULE_BOUNDARIES section 5).
-- An expand migration: the column is optional, so a payment that names none (every payment so far, and any client that
-- does not send it) still posts as A-185 says, to the "Bank account not yet named" party. The application checks that the
-- account is active and of the payment's method (FIN's BankAccounts.payoutAccountIn); the database holds:
--   ck_supplier_payment_bank_account    a CASH payment names no bank account (it leaves the safe, 1010)
--   pur.supplier_payment_bank_account_guard   the account a payment names never changes once written (HK004)
-- remittance_document_id waits for doc.archived_document in B08 continued 2 (A-192).
-- Data category: CONFIDENTIAL (DC-11).
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
ALTER TABLE pur.supplier_payment
  ADD COLUMN bank_account_id uuid NULL CONSTRAINT fk_supplier_payment_bank_account REFERENCES fin.bank_account (id) ON DELETE RESTRICT;
ALTER TABLE pur.supplier_payment
  ADD CONSTRAINT ck_supplier_payment_bank_account CHECK (method <> 'CASH' OR bank_account_id IS NULL);
CREATE INDEX ix_supplier_payment_bank_account ON pur.supplier_payment (bank_account_id) WHERE bank_account_id IS NOT NULL;

CREATE FUNCTION pur.supplier_payment_bank_account_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.bank_account_id IS DISTINCT FROM OLD.bank_account_id THEN
    RAISE EXCEPTION 'pur.supplier_payment %: the account a payment leaves from never changes', OLD.id USING ERRCODE = 'HK004';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION pur.supplier_payment_bank_account_guard() FROM PUBLIC;
CREATE TRIGGER trg_supplier_payment_bank_account_guard BEFORE UPDATE ON pur.supplier_payment
  FOR EACH ROW EXECUTE FUNCTION pur.supplier_payment_bank_account_guard();

-- migrate:down
DROP TRIGGER trg_supplier_payment_bank_account_guard ON pur.supplier_payment;
DROP FUNCTION pur.supplier_payment_bank_account_guard();
ALTER TABLE pur.supplier_payment DROP COLUMN bank_account_id;
