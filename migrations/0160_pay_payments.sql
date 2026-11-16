-- 0160_pay_payments
-- B9a (FR-PAY-001, FR-PAY-002, FR-PAY-005, FR-PAY-009, ADR-0014, ADR-0010, A-200, A-208): schema `pay` with the payment
-- (one tender received) and its allocations to billing documents. The database holds:
--   ck_payment_status_value        PENDING, CLEARED, FAILED or REVERSED
--   ck_payment_transition          PENDING to CLEARED or FAILED, CLEARED to REVERSED, nothing else; a payment is written
--                                  PENDING or CLEARED; once CLEARED, FAILED or REVERSED only its allocated and refunded
--                                  amounts (and CLEARED to REVERSED) change (FR-PAY-002)
--   ck_payment_verified            a mobile money or card payment is never CLEARED without a provider callback or lookup,
--                                  and an UNVERIFIED tender is never CLEARED (FR-PAY-005, abuse case 4)
--   ck_payment_cleared             a CLEARED or REVERSED payment has its clearing time, and only they do
--   ck_payment_cash_holder         cash lands in a till (its register) or with a driver
--   uq_payment_provider_reference  a provider's reference is recorded once: a replay collides
--   ck_payment_allocation_cap      a payment's allocations never exceed its amount less what was refunded, kept on
--                                  `pay.payment.allocated_pesewas` by the allocation trigger; an unallocation reverses
--                                  one allocation of the same payment and document, once, for its amount
-- An allocation never exceeds the document's outstanding amount: BIL's `bil.apply_settlement` refuses it (migration
-- 0161), called through `Billing.settleIn` in the allocating transaction (A-200), so PAY never writes BIL's table.
-- `pay.payment_allocation` is LEDGER: insert-only for every role. Provider transactions, webhook events, refunds, store
-- credit and the reconciliation tables are added by the sessions that build them (A-209).
-- Data category: CONFIDENTIAL (DC-22): a payment against a named customer; RESTRICTED payment identifiers never reach a
-- log (SECURE_CODING_STANDARDS).
-- Rollback: tested (`pnpm db:rollback`), safe before the first payment; afterwards forward fix only.

-- migrate:up
CREATE SCHEMA pay AUTHORIZATION hk_owner;
REVOKE ALL ON SCHEMA pay FROM PUBLIC;
GRANT USAGE ON SCHEMA pay TO hk_app, hk_worker, hk_report;

CREATE TABLE pay.payment (
  id                  uuid PRIMARY KEY CONSTRAINT fk_payment_document REFERENCES platform.business_document (id) ON DELETE RESTRICT,
  payment_no          text NULL CONSTRAINT uq_payment_no UNIQUE,
  payment_method_id   uuid NOT NULL CONSTRAINT fk_payment_method REFERENCES mdm.payment_method (id) ON DELETE RESTRICT,
  method_kind         text NOT NULL CONSTRAINT ck_payment_method_kind CHECK (method_kind IN ('CASH', 'MOBILE_MONEY', 'CARD', 'BANK_TRANSFER', 'CHEQUE', 'STORE_CREDIT')),
  amount_pesewas      platform.pesewas NOT NULL CONSTRAINT ck_payment_amount CHECK (amount_pesewas > 0),
  currency            char(3) NOT NULL DEFAULT 'GHS' CONSTRAINT ck_payment_currency CHECK (currency = 'GHS'),
  customer_id         uuid NULL CONSTRAINT fk_payment_customer REFERENCES mdm.customer (id) ON DELETE RESTRICT,
  order_document_id   uuid NULL CONSTRAINT fk_payment_order REFERENCES platform.business_document (id) ON DELETE RESTRICT,
  shift_document_id   uuid NULL CONSTRAINT fk_payment_shift REFERENCES platform.business_document (id) ON DELETE RESTRICT,
  register_ref        uuid NULL,
  register_code       text NULL CONSTRAINT ck_payment_register_code CHECK (register_code ~ '^[A-Z0-9]{1,10}$'),
  driver_id           uuid NULL CONSTRAINT fk_payment_driver REFERENCES iam.principal (id) ON DELETE RESTRICT,
  bank_account_id     uuid NULL CONSTRAINT fk_payment_bank_account REFERENCES fin.bank_account (id) ON DELETE RESTRICT,
  provider            text NULL CONSTRAINT ck_payment_provider CHECK (provider ~ '^[A-Z][A-Z_]{1,29}$'),
  provider_reference  text NULL CONSTRAINT uq_payment_provider_reference UNIQUE
                        CONSTRAINT ck_payment_provider_reference CHECK (provider_reference = btrim(provider_reference) AND length(provider_reference) BETWEEN 1 AND 100),
  external_reference  text NULL CONSTRAINT ck_payment_external_reference CHECK (external_reference = btrim(external_reference) AND length(external_reference) BETWEEN 1 AND 100),
  verification        text NOT NULL CONSTRAINT ck_payment_verification CHECK (verification IN ('NOT_REQUIRED', 'PROVIDER_CALLBACK', 'PROVIDER_LOOKUP', 'UNVERIFIED')),
  cheque_due_on       date NULL,
  allocated_pesewas   platform.pesewas NOT NULL DEFAULT 0,
  refunded_pesewas    platform.pesewas NOT NULL DEFAULT 0,
  received_at         timestamptz NOT NULL,
  cleared_at          timestamptz NULL,
  reverses_payment_id uuid NULL CONSTRAINT fk_payment_reverses REFERENCES pay.payment (id) ON DELETE RESTRICT CONSTRAINT uq_payment_reverses UNIQUE,
  failure_reason      text NULL CONSTRAINT ck_payment_failure_reason CHECK (length(btrim(failure_reason)) BETWEEN 1 AND 500),
  status              text NOT NULL CONSTRAINT ck_payment_status_value CHECK (status IN ('PENDING', 'CLEARED', 'FAILED', 'REVERSED')),
  branch_id           uuid NOT NULL CONSTRAINT fk_payment_branch REFERENCES mdm.branch (id) ON DELETE RESTRICT,
  version             integer NOT NULL DEFAULT 1,
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid NOT NULL CONSTRAINT fk_payment_created_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  updated_by          uuid NOT NULL CONSTRAINT fk_payment_updated_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  posted_at           timestamptz NULL,
  posted_by           uuid NULL CONSTRAINT fk_payment_posted_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  CONSTRAINT ck_payment_amounts CHECK (allocated_pesewas + refunded_pesewas <= amount_pesewas),
  CONSTRAINT ck_payment_verified CHECK (status <> 'CLEARED' OR (verification <> 'UNVERIFIED' AND (method_kind NOT IN ('MOBILE_MONEY', 'CARD') OR verification IN ('PROVIDER_CALLBACK', 'PROVIDER_LOOKUP')))),
  CONSTRAINT ck_payment_cleared CHECK ((cleared_at IS NULL) = (status NOT IN ('CLEARED', 'REVERSED')) AND (posted_at IS NULL) = (cleared_at IS NULL) AND (posted_at IS NULL) = (posted_by IS NULL)),
  CONSTRAINT ck_payment_failed CHECK ((status = 'FAILED') = (failure_reason IS NOT NULL)),
  CONSTRAINT ck_payment_cash_holder CHECK (method_kind <> 'CASH' OR ((register_ref IS NOT NULL) = (register_code IS NOT NULL) AND (register_ref IS NOT NULL OR driver_id IS NOT NULL))),
  CONSTRAINT ck_payment_provider_pair CHECK ((provider IS NULL) = (provider_reference IS NULL))
);
COMMENT ON TABLE pay.payment IS 'class=DOCUMENT';
CREATE INDEX ix_payment_order ON pay.payment (order_document_id) WHERE order_document_id IS NOT NULL;
CREATE INDEX ix_payment_customer ON pay.payment (customer_id, received_at) WHERE customer_id IS NOT NULL;
CREATE INDEX ix_payment_branch ON pay.payment (branch_id, received_at);
CREATE TRIGGER trg_payment_version BEFORE UPDATE ON pay.payment
  FOR EACH ROW EXECUTE FUNCTION platform.touch_version();

CREATE FUNCTION pay.payment_guard() RETURNS trigger
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
REVOKE ALL ON FUNCTION pay.payment_guard() FROM PUBLIC;
CREATE TRIGGER trg_payment_guard BEFORE INSERT OR UPDATE ON pay.payment
  FOR EACH ROW EXECUTE FUNCTION pay.payment_guard();

CREATE TABLE pay.payment_allocation (
  id                     uuid PRIMARY KEY,
  payment_id             uuid NOT NULL CONSTRAINT fk_payment_allocation_payment REFERENCES pay.payment (id) ON DELETE RESTRICT,
  billing_document_id    uuid NOT NULL CONSTRAINT fk_payment_allocation_document REFERENCES bil.billing_document (id) ON DELETE RESTRICT,
  amount_pesewas         platform.pesewas NOT NULL CONSTRAINT ck_payment_allocation_amount CHECK (amount_pesewas > 0),
  direction              text NOT NULL DEFAULT 'APPLY' CONSTRAINT ck_payment_allocation_direction CHECK (direction IN ('APPLY', 'UNAPPLY')),
  reverses_allocation_id uuid NULL CONSTRAINT fk_payment_allocation_reverses REFERENCES pay.payment_allocation (id) ON DELETE RESTRICT
                           CONSTRAINT uq_payment_allocation_reverses UNIQUE,
  reason                 text NULL CONSTRAINT ck_payment_allocation_reason CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
  recorded_at            timestamptz NOT NULL DEFAULT now(),
  actor_id               uuid NOT NULL CONSTRAINT fk_payment_allocation_actor REFERENCES iam.principal (id) ON DELETE RESTRICT,
  CONSTRAINT ck_payment_allocation_unapply CHECK ((direction = 'UNAPPLY') = (reverses_allocation_id IS NOT NULL) AND (direction = 'APPLY' OR reason IS NOT NULL))
);
COMMENT ON TABLE pay.payment_allocation IS 'class=LEDGER';
CREATE INDEX ix_payment_allocation_payment ON pay.payment_allocation (payment_id);
CREATE INDEX ix_payment_allocation_document ON pay.payment_allocation (billing_document_id);
CREATE TRIGGER trg_payment_allocation_immutable BEFORE UPDATE OR DELETE ON pay.payment_allocation
  FOR EACH ROW EXECUTE FUNCTION platform.reject_change();
CREATE TRIGGER trg_payment_allocation_no_truncate BEFORE TRUNCATE ON pay.payment_allocation
  FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_change();

-- An allocation applies part of a live payment, never more than it has left; an unallocation reverses one allocation
-- exactly. Either keeps the payment's allocated amount, under the payment's row lock.
CREATE FUNCTION pay.payment_allocation_apply() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  p record;
  original record;
BEGIN
  SELECT x.status, x.amount_pesewas, x.allocated_pesewas, x.refunded_pesewas INTO p FROM pay.payment x WHERE x.id = NEW.payment_id FOR UPDATE;
  IF NEW.direction = 'APPLY' THEN
    IF p.status NOT IN ('PENDING', 'CLEARED') THEN
      RAISE EXCEPTION 'pay.payment_allocation: payment % is %', NEW.payment_id, p.status USING ERRCODE = 'HK010', CONSTRAINT = 'ck_payment_allocation_cap';
    END IF;
    IF p.allocated_pesewas + NEW.amount_pesewas > p.amount_pesewas - p.refunded_pesewas THEN
      RAISE EXCEPTION 'pay.payment_allocation: % pesewas exceeds the % payment % has left', NEW.amount_pesewas,
        p.amount_pesewas - p.refunded_pesewas - p.allocated_pesewas, NEW.payment_id USING ERRCODE = 'HK010', CONSTRAINT = 'ck_payment_allocation_cap';
    END IF;
    UPDATE pay.payment SET allocated_pesewas = allocated_pesewas + NEW.amount_pesewas, version = version + 1 WHERE id = NEW.payment_id;
  ELSE
    SELECT a.payment_id, a.billing_document_id, a.amount_pesewas, a.direction INTO original FROM pay.payment_allocation a WHERE a.id = NEW.reverses_allocation_id;
    IF original.direction IS DISTINCT FROM 'APPLY' OR original.payment_id <> NEW.payment_id OR original.billing_document_id <> NEW.billing_document_id
       OR original.amount_pesewas <> NEW.amount_pesewas THEN
      RAISE EXCEPTION 'pay.payment_allocation: an unallocation reverses one allocation of the same payment and document for its amount'
        USING ERRCODE = 'HK010', CONSTRAINT = 'ck_payment_allocation_cap';
    END IF;
    UPDATE pay.payment SET allocated_pesewas = allocated_pesewas - NEW.amount_pesewas, version = version + 1 WHERE id = NEW.payment_id;
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION pay.payment_allocation_apply() FROM PUBLIC;
CREATE TRIGGER trg_payment_allocation_apply BEFORE INSERT ON pay.payment_allocation
  FOR EACH ROW EXECUTE FUNCTION pay.payment_allocation_apply();

REVOKE ALL ON ALL TABLES IN SCHEMA pay FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON pay.payment TO hk_app, hk_worker;
GRANT SELECT, INSERT ON pay.payment_allocation TO hk_app, hk_worker;

-- migrate:down
DROP TABLE pay.payment_allocation;
DROP FUNCTION pay.payment_allocation_apply();
DROP TABLE pay.payment;
DROP FUNCTION pay.payment_guard();
DROP SCHEMA pay;
