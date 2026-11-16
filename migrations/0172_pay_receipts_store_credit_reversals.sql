-- 0172_pay_receipts_store_credit_reversals
-- B09a continued 1b (FR-PAY-001, FR-PAY-002, FR-PAY-011, FR-PAY-014, FR-PAY-015, ADR-0003, ADR-0064, A-212): manual
-- receipts, cheques, reversals and store credit. The database holds:
--   ck_payment_bank_account         a cheque or a bank transfer names the bank account it is paid into
--   ck_payment_store_credit_customer a store credit tender names its customer
--   ck_payment_cheque_clearance     a cheque that cleared names the subject of its clearing entry, and only it does
--   ck_payment_reversal_row         a reversing payment is written REVERSED, once per original (uq_payment_reverses),
--                                   for the original's method, amount, customer and branch, after the original is
--                                   REVERSED or FAILED
--   ck_payment_transition           (replaced) as before, plus: a payment is written REVERSED only as a reversing
--                                   payment, and becomes REVERSED or FAILED only with nothing allocated and nothing
--                                   refunded, so a reversal or a bounce always reopens what it settled
--   pay.payment_reversal            one reversal asked for per payment at a time, PENDING_APPROVAL to APPROVED (with
--                                   its reversing payment) or REJECTED, then frozen
--   pay.store_credit_entry          LEDGER, insert-only for every role; one entry per source document and direction
--   pay.store_credit_balance        PROJECTION written only by the entry trigger (SECURITY DEFINER, owned by hk_owner):
--                                   a redemption beyond the balance is refused (ck_store_credit_balance) under the
--                                   balance row's lock, so two redemptions of the last credit cannot both succeed
--   pay.pub_reconciliation_break    the published view of every break, of every kind, for the daily exception report
--                                   (RPT, B12): its facts without its details
-- Data category: CONFIDENTIAL (DC-22): payments and credit against named customers.
-- Rollback: tested (`pnpm db:rollback`), safe before the first cheque, reversal or store credit entry; afterwards
-- forward fix only.

-- migrate:up
ALTER TABLE pay.payment ADD COLUMN clearance_ref uuid NULL;
ALTER TABLE pay.payment
  ADD CONSTRAINT ck_payment_bank_account CHECK (method_kind NOT IN ('CHEQUE', 'BANK_TRANSFER') OR bank_account_id IS NOT NULL),
  ADD CONSTRAINT ck_payment_store_credit_customer CHECK (method_kind <> 'STORE_CREDIT' OR customer_id IS NOT NULL),
  ADD CONSTRAINT ck_payment_cheque_clearance CHECK (
    (clearance_ref IS NULL OR (method_kind = 'CHEQUE' AND status IN ('CLEARED', 'REVERSED') AND reverses_payment_id IS NULL))
    AND (method_kind <> 'CHEQUE' OR status <> 'CLEARED' OR clearance_ref IS NOT NULL)),
  ADD CONSTRAINT ck_payment_reversal_row CHECK (reverses_payment_id IS NULL OR (status = 'REVERSED' AND allocated_pesewas = 0 AND refunded_pesewas = 0));

CREATE OR REPLACE FUNCTION pay.payment_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  original record;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.allocated_pesewas <> 0 OR NEW.refunded_pesewas <> 0
       OR NOT (NEW.status IN ('PENDING', 'CLEARED') OR (NEW.status = 'REVERSED' AND NEW.reverses_payment_id IS NOT NULL))
       OR (NEW.reverses_payment_id IS NOT NULL AND NEW.status <> 'REVERSED') THEN
      RAISE EXCEPTION 'pay.payment %: a payment is written PENDING or CLEARED with nothing allocated or refunded, or REVERSED as a reversing payment', NEW.id
        USING ERRCODE = 'HK004', CONSTRAINT = 'ck_payment_transition';
    END IF;
    IF NEW.reverses_payment_id IS NOT NULL THEN
      SELECT x.status, x.method_kind, x.amount_pesewas, x.customer_id, x.branch_id INTO original FROM pay.payment x WHERE x.id = NEW.reverses_payment_id FOR UPDATE;
      IF original.status NOT IN ('REVERSED', 'FAILED') OR original.method_kind <> NEW.method_kind OR original.amount_pesewas <> NEW.amount_pesewas
         OR original.customer_id IS DISTINCT FROM NEW.customer_id OR original.branch_id <> NEW.branch_id THEN
        RAISE EXCEPTION 'pay.payment %: a reversing payment mirrors a reversed or bounced original exactly', NEW.id
          USING ERRCODE = 'HK004', CONSTRAINT = 'ck_payment_reversal_row';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT ((OLD.status = 'PENDING' AND NEW.status IN ('CLEARED', 'FAILED')) OR (OLD.status = 'CLEARED' AND NEW.status = 'REVERSED')) THEN
    RAISE EXCEPTION 'pay.payment %: % cannot move to %', OLD.id, OLD.status, NEW.status USING ERRCODE = 'HK004', CONSTRAINT = 'ck_payment_transition';
  END IF;
  IF NEW.status IN ('REVERSED', 'FAILED') AND NEW.status IS DISTINCT FROM OLD.status AND (NEW.allocated_pesewas <> 0 OR NEW.refunded_pesewas <> 0) THEN
    RAISE EXCEPTION 'pay.payment %: a payment is reversed or failed only with nothing allocated or refunded', OLD.id
      USING ERRCODE = 'HK004', CONSTRAINT = 'ck_payment_transition';
  END IF;
  IF OLD.status IN ('CLEARED', 'FAILED', 'REVERSED')
     AND (to_jsonb(NEW) - ARRAY['allocated_pesewas', 'refunded_pesewas', 'status', 'version', 'updated_at', 'updated_by'])
         IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['allocated_pesewas', 'refunded_pesewas', 'status', 'version', 'updated_at', 'updated_by']) THEN
    RAISE EXCEPTION 'pay.payment % is % and frozen', OLD.id, OLD.status USING ERRCODE = 'HK004', CONSTRAINT = 'ck_payment_transition';
  END IF;
  RETURN NEW;
END
$$;

CREATE TABLE pay.payment_reversal (
  id                   uuid PRIMARY KEY,
  payment_id           uuid NOT NULL CONSTRAINT fk_payment_reversal_payment REFERENCES pay.payment (id) ON DELETE RESTRICT,
  reason_code          text NOT NULL CONSTRAINT fk_payment_reversal_reason REFERENCES mdm.reason_code (code) ON DELETE RESTRICT,
  note                 text NOT NULL CONSTRAINT ck_payment_reversal_note CHECK (length(btrim(note)) BETWEEN 1 AND 500),
  approval_request_id  uuid NULL CONSTRAINT fk_payment_reversal_approval REFERENCES iam.approval_request (id) ON DELETE RESTRICT
                         CONSTRAINT uq_payment_reversal_approval UNIQUE,
  reversing_payment_id uuid NULL CONSTRAINT fk_payment_reversal_reversing REFERENCES pay.payment (id) ON DELETE RESTRICT
                         CONSTRAINT uq_payment_reversal_reversing UNIQUE,
  status               text NOT NULL CONSTRAINT ck_payment_reversal_status CHECK (status IN ('PENDING_APPROVAL', 'APPROVED', 'REJECTED')),
  branch_id            uuid NOT NULL CONSTRAINT fk_payment_reversal_branch REFERENCES mdm.branch (id) ON DELETE RESTRICT,
  version              integer NOT NULL DEFAULT 1,
  created_at           timestamptz NOT NULL DEFAULT now(),
  created_by           uuid NOT NULL CONSTRAINT fk_payment_reversal_created_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  updated_by           uuid NOT NULL CONSTRAINT fk_payment_reversal_updated_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  CONSTRAINT ck_payment_reversal_approved CHECK ((status = 'APPROVED') = (reversing_payment_id IS NOT NULL) AND (status = 'PENDING_APPROVAL' OR approval_request_id IS NOT NULL))
);
COMMENT ON TABLE pay.payment_reversal IS 'class=DOCUMENT';
CREATE UNIQUE INDEX uq_payment_reversal_open ON pay.payment_reversal (payment_id) WHERE status <> 'REJECTED';
CREATE TRIGGER trg_payment_reversal_version BEFORE UPDATE ON pay.payment_reversal
  FOR EACH ROW EXECUTE FUNCTION platform.touch_version();

CREATE FUNCTION pay.payment_reversal_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'PENDING_APPROVAL' OR NEW.reversing_payment_id IS NOT NULL THEN
      RAISE EXCEPTION 'pay.payment_reversal %: a reversal is written PENDING_APPROVAL', NEW.id USING ERRCODE = 'HK004', CONSTRAINT = 'ck_payment_reversal_transition';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status <> 'PENDING_APPROVAL'
     OR (NEW.status IS DISTINCT FROM OLD.status AND NEW.status NOT IN ('APPROVED', 'REJECTED'))
     OR (NEW.payment_id, NEW.reason_code, NEW.note, NEW.branch_id, NEW.created_by, NEW.created_at)
        IS DISTINCT FROM (OLD.payment_id, OLD.reason_code, OLD.note, OLD.branch_id, OLD.created_by, OLD.created_at)
     OR (OLD.approval_request_id IS NOT NULL AND NEW.approval_request_id IS DISTINCT FROM OLD.approval_request_id) THEN
    RAISE EXCEPTION 'pay.payment_reversal %: what was asked for never changes, and a decided reversal is frozen', OLD.id
      USING ERRCODE = 'HK004', CONSTRAINT = 'ck_payment_reversal_transition';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION pay.payment_reversal_guard() FROM PUBLIC;
CREATE TRIGGER trg_payment_reversal_guard BEFORE INSERT OR UPDATE ON pay.payment_reversal
  FOR EACH ROW EXECUTE FUNCTION pay.payment_reversal_guard();

CREATE TABLE pay.store_credit_entry (
  id                 uuid PRIMARY KEY,
  customer_id        uuid NOT NULL CONSTRAINT fk_store_credit_entry_customer REFERENCES mdm.customer (id) ON DELETE RESTRICT,
  direction          text NOT NULL CONSTRAINT ck_store_credit_entry_direction CHECK (direction IN ('ISSUE', 'REDEEM', 'EXPIRE')),
  amount_pesewas     platform.pesewas NOT NULL CONSTRAINT ck_store_credit_entry_amount CHECK (amount_pesewas > 0),
  source_document_id uuid NOT NULL CONSTRAINT fk_store_credit_entry_source REFERENCES platform.business_document (id) ON DELETE RESTRICT,
  branch_id          uuid NOT NULL CONSTRAINT fk_store_credit_entry_branch REFERENCES mdm.branch (id) ON DELETE RESTRICT,
  recorded_at        timestamptz NOT NULL DEFAULT now(),
  actor_id           uuid NOT NULL CONSTRAINT fk_store_credit_entry_actor REFERENCES iam.principal (id) ON DELETE RESTRICT,
  CONSTRAINT uq_store_credit_entry_source UNIQUE (source_document_id, direction)
);
COMMENT ON TABLE pay.store_credit_entry IS 'class=LEDGER';
CREATE INDEX ix_store_credit_entry_customer ON pay.store_credit_entry (customer_id, id);
CREATE TRIGGER trg_store_credit_entry_immutable BEFORE UPDATE OR DELETE ON pay.store_credit_entry
  FOR EACH ROW EXECUTE FUNCTION platform.reject_change();
CREATE TRIGGER trg_store_credit_entry_no_truncate BEFORE TRUNCATE ON pay.store_credit_entry
  FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_change();

CREATE TABLE pay.store_credit_balance (
  customer_id     uuid PRIMARY KEY CONSTRAINT fk_store_credit_balance_customer REFERENCES mdm.customer (id) ON DELETE RESTRICT,
  balance_pesewas platform.pesewas NOT NULL CONSTRAINT ck_store_credit_balance CHECK (balance_pesewas >= 0),
  updated_at      timestamptz NOT NULL
);
COMMENT ON TABLE pay.store_credit_balance IS 'class=PROJECTION';

-- The balance moves with each entry, under its row's lock: an issue adds, a redemption or an expiry takes off and is
-- refused beyond what is there. The only writer of the projection.
CREATE FUNCTION pay.store_credit_apply() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
DECLARE
  current_balance bigint;
BEGIN
  IF NEW.direction = 'ISSUE' THEN
    INSERT INTO pay.store_credit_balance (customer_id, balance_pesewas, updated_at) VALUES (NEW.customer_id, NEW.amount_pesewas, NEW.recorded_at)
    ON CONFLICT (customer_id) DO UPDATE SET balance_pesewas = pay.store_credit_balance.balance_pesewas + EXCLUDED.balance_pesewas, updated_at = EXCLUDED.updated_at;
    RETURN NEW;
  END IF;
  SELECT b.balance_pesewas INTO current_balance FROM pay.store_credit_balance b WHERE b.customer_id = NEW.customer_id FOR UPDATE;
  IF COALESCE(current_balance, 0) < NEW.amount_pesewas THEN
    RAISE EXCEPTION 'pay.store_credit_entry: % pesewas exceeds the % of store credit customer % holds', NEW.amount_pesewas, COALESCE(current_balance, 0), NEW.customer_id
      USING ERRCODE = 'HK010', CONSTRAINT = 'ck_store_credit_balance';
  END IF;
  UPDATE pay.store_credit_balance SET balance_pesewas = balance_pesewas - NEW.amount_pesewas, updated_at = NEW.recorded_at WHERE customer_id = NEW.customer_id;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION pay.store_credit_apply() FROM PUBLIC;
CREATE TRIGGER trg_store_credit_apply BEFORE INSERT ON pay.store_credit_entry
  FOR EACH ROW EXECUTE FUNCTION pay.store_credit_apply();

-- Published for the daily exception report (RPT, B12): every break of every kind, with what it is about and its state.
-- The details stay in PAY.
CREATE VIEW pay.pub_reconciliation_break AS
SELECT b.id, b.kind, b.branch_id, b.payment_id, b.refund_id, b.provider, b.reference, b.source_document_id, b.amount_pesewas,
       b.raised_at, b.status, b.resolved_at, b.resolved_by, b.created_by
  FROM pay.reconciliation_break b;

REVOKE ALL ON pay.payment_reversal, pay.store_credit_entry, pay.store_credit_balance, pay.pub_reconciliation_break FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON pay.payment_reversal TO hk_app, hk_worker;
GRANT SELECT, INSERT ON pay.store_credit_entry TO hk_app, hk_worker;
GRANT SELECT ON pay.store_credit_balance TO hk_app, hk_worker;
GRANT SELECT ON pay.pub_reconciliation_break TO hk_app, hk_worker, hk_report;

-- migrate:down
DROP VIEW pay.pub_reconciliation_break;
DROP TABLE pay.store_credit_entry;
DROP FUNCTION pay.store_credit_apply();
DROP TABLE pay.store_credit_balance;
DROP TABLE pay.payment_reversal;
DROP FUNCTION pay.payment_reversal_guard();
CREATE OR REPLACE FUNCTION pay.payment_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status NOT IN ('PENDING', 'CLEARED') OR NEW.allocated_pesewas <> 0 OR NEW.refunded_pesewas <> 0 THEN
      RAISE EXCEPTION 'pay.payment %: a payment is written PENDING or CLEARED with nothing allocated or refunded', NEW.id USING ERRCODE = 'HK004', CONSTRAINT = 'ck_payment_transition';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT ((OLD.status = 'PENDING' AND NEW.status IN ('CLEARED', 'FAILED')) OR (OLD.status = 'CLEARED' AND NEW.status = 'REVERSED')) THEN
    RAISE EXCEPTION 'pay.payment %: % cannot move to %', OLD.id, OLD.status, NEW.status USING ERRCODE = 'HK004', CONSTRAINT = 'ck_payment_transition';
  END IF;
  IF OLD.status IN ('CLEARED', 'FAILED', 'REVERSED')
     AND (to_jsonb(NEW) - ARRAY['allocated_pesewas', 'refunded_pesewas', 'status', 'version', 'updated_at', 'updated_by'])
         IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['allocated_pesewas', 'refunded_pesewas', 'status', 'version', 'updated_at', 'updated_by']) THEN
    RAISE EXCEPTION 'pay.payment % is % and frozen', OLD.id, OLD.status USING ERRCODE = 'HK004', CONSTRAINT = 'ck_payment_transition';
  END IF;
  RETURN NEW;
END
$$;
ALTER TABLE pay.payment
  DROP CONSTRAINT ck_payment_reversal_row,
  DROP CONSTRAINT ck_payment_cheque_clearance,
  DROP CONSTRAINT ck_payment_store_credit_customer,
  DROP CONSTRAINT ck_payment_bank_account;
ALTER TABLE pay.payment DROP COLUMN clearance_ref;
