-- 0108_pur_remittance_and_score_facts
-- The remittance advice data (FR-PUR-013) and the receipt facts supplier scores are computed from (FR-PUR-014),
-- B07 continued 1b (A-173, A-174).
--   pur.supplier_remittance · LEDGER     one row per paid supplier payment, written in the transaction that marks it
--                                        paid and never changed: the invoices it pays as they stood then (a snapshot),
--                                        the amount and the reference. `uq_supplier_remittance_payment` makes it once
--                                        per payment; `pur.supplier_remittance_guard` holds the payment PAID and the
--                                        amount and reference its own (HK010). Rendering, archiving and the message to
--                                        the supplier wait for B8 and B11, which read it.
--   pur.supplier_receipt_line · LEDGER   each goods receipt line from a supplier, as `inv.GoodsReceiptPosted` told PUR in
--                                        the receipt's transaction: accepted and rejected base quantities, the day it
--                                        arrived and the day it was promised (the order's expected date, or its date
--                                        plus the supplier's lead time). Appended once per receipt line, never changed.
-- Data category: CONFIDENTIAL (DC-11).
-- Rollback: tested (`pnpm db:rollback`), safe before the first paid payment; afterwards forward fix only.

-- migrate:up
CREATE TABLE pur.supplier_remittance (
  id                  uuid PRIMARY KEY,
  supplier_payment_id uuid NOT NULL CONSTRAINT fk_supplier_remittance_payment REFERENCES pur.supplier_payment (id) ON DELETE RESTRICT,
  supplier_id         uuid NOT NULL CONSTRAINT fk_supplier_remittance_supplier REFERENCES mdm.supplier (id) ON DELETE RESTRICT,
  method              text NOT NULL CONSTRAINT ck_supplier_remittance_method CHECK (method IN ('BANK', 'MOBILE_MONEY', 'CASH', 'CHEQUE')),
  payee_masked        text NULL CONSTRAINT ck_supplier_remittance_payee CHECK (length(payee_masked) BETWEEN 1 AND 80),
  amount_pesewas      platform.pesewas NOT NULL CONSTRAINT ck_supplier_remittance_amount CHECK (amount_pesewas > 0),
  currency            char(3) NOT NULL DEFAULT 'GHS' CONSTRAINT ck_supplier_remittance_currency CHECK (currency = 'GHS'),
  paid_at             timestamptz NOT NULL,
  external_reference  text NOT NULL,
  -- The invoices paid as they stood when the payment was marked paid; a snapshot, never filtered or summed.
  lines               jsonb NOT NULL CONSTRAINT ck_supplier_remittance_lines CHECK (jsonb_typeof(lines) = 'array' AND jsonb_array_length(lines) > 0),
  branch_id           uuid NOT NULL CONSTRAINT fk_supplier_remittance_branch REFERENCES mdm.branch (id) ON DELETE RESTRICT,
  recorded_at         timestamptz NOT NULL DEFAULT now(),
  actor_id            uuid NOT NULL CONSTRAINT fk_supplier_remittance_actor REFERENCES iam.principal (id) ON DELETE RESTRICT,
  CONSTRAINT uq_supplier_remittance_payment UNIQUE (supplier_payment_id)
);
COMMENT ON TABLE pur.supplier_remittance IS 'class=LEDGER';
CREATE TRIGGER trg_supplier_remittance_immutable BEFORE UPDATE OR DELETE ON pur.supplier_remittance
  FOR EACH ROW EXECUTE FUNCTION platform.reject_change();
CREATE TRIGGER trg_supplier_remittance_no_truncate BEFORE TRUNCATE ON pur.supplier_remittance
  FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_change();
REVOKE ALL ON pur.supplier_remittance FROM PUBLIC;
GRANT SELECT, INSERT ON pur.supplier_remittance TO hk_app, hk_worker;

CREATE FUNCTION pur.supplier_remittance_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  payment pur.supplier_payment;
BEGIN
  SELECT * INTO payment FROM pur.supplier_payment p WHERE p.id = NEW.supplier_payment_id;
  IF payment.status <> 'PAID' OR payment.supplier_id <> NEW.supplier_id OR payment.method <> NEW.method OR payment.amount_pesewas <> NEW.amount_pesewas
     OR payment.external_reference <> NEW.external_reference OR payment.paid_at <> NEW.paid_at OR payment.branch_id <> NEW.branch_id THEN
    RAISE EXCEPTION 'pur.supplier_remittance %: the advice of a PAID payment carries its own supplier, method, amount, time and reference', NEW.id
      USING ERRCODE = 'HK010', CONSTRAINT = 'ck_supplier_remittance_payment';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION pur.supplier_remittance_guard() FROM PUBLIC;
CREATE TRIGGER trg_supplier_remittance_guard BEFORE INSERT ON pur.supplier_remittance
  FOR EACH ROW EXECUTE FUNCTION pur.supplier_remittance_guard();

CREATE TABLE pur.supplier_receipt_line (
  goods_receipt_line_id uuid PRIMARY KEY CONSTRAINT fk_supplier_receipt_line_line REFERENCES inv.goods_receipt_line (id) ON DELETE RESTRICT,
  goods_receipt_id      uuid NOT NULL CONSTRAINT fk_supplier_receipt_line_receipt REFERENCES inv.goods_receipt (id) ON DELETE RESTRICT,
  supplier_id           uuid NOT NULL CONSTRAINT fk_supplier_receipt_line_supplier REFERENCES mdm.supplier (id) ON DELETE RESTRICT,
  purchase_order_id     uuid NULL CONSTRAINT fk_supplier_receipt_line_order REFERENCES pur.purchase_order (id) ON DELETE RESTRICT,
  product_id            uuid NOT NULL CONSTRAINT fk_supplier_receipt_line_product REFERENCES mdm.product (id) ON DELETE RESTRICT,
  received_on           date NOT NULL,
  promised_on           date NULL,
  qty_accepted          platform.qty NOT NULL CONSTRAINT ck_supplier_receipt_line_accepted CHECK (qty_accepted >= 0),
  qty_rejected          platform.qty NOT NULL CONSTRAINT ck_supplier_receipt_line_rejected CHECK (qty_rejected >= 0),
  branch_id             uuid NOT NULL CONSTRAINT fk_supplier_receipt_line_branch REFERENCES mdm.branch (id) ON DELETE RESTRICT,
  recorded_at           timestamptz NOT NULL DEFAULT now(),
  actor_id              uuid NOT NULL CONSTRAINT fk_supplier_receipt_line_actor REFERENCES iam.principal (id) ON DELETE RESTRICT,
  CONSTRAINT ck_supplier_receipt_line_qty CHECK (qty_accepted + qty_rejected > 0)
);
COMMENT ON TABLE pur.supplier_receipt_line IS 'class=LEDGER';
CREATE INDEX ix_supplier_receipt_line_period ON pur.supplier_receipt_line (received_on, supplier_id);
CREATE TRIGGER trg_supplier_receipt_line_immutable BEFORE UPDATE OR DELETE ON pur.supplier_receipt_line
  FOR EACH ROW EXECUTE FUNCTION platform.reject_change();
CREATE TRIGGER trg_supplier_receipt_line_no_truncate BEFORE TRUNCATE ON pur.supplier_receipt_line
  FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_change();
REVOKE ALL ON pur.supplier_receipt_line FROM PUBLIC;
GRANT SELECT, INSERT ON pur.supplier_receipt_line TO hk_app, hk_worker;

-- migrate:down
DROP TABLE pur.supplier_receipt_line;
DROP TRIGGER trg_supplier_remittance_guard ON pur.supplier_remittance;
DROP FUNCTION pur.supplier_remittance_guard();
DROP TABLE pur.supplier_remittance;
