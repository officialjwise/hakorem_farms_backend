-- 0183_pay_credit_note_refunds
-- B09a continued 1d (FR-PAY-012, FR-BIL-007, abuse case 12, ADR-0066, A-216): a refund against a credit note, and the
-- second person who approves it. The owner, 2026-11-16: refunds are where till fraud lives. What the database holds:
--   trg_refund_cap                 a refund without a credit note draws on its payment's unallocated money, as before.
--                                  A refund against a credit note draws on the credit note instead, through BIL's
--                                  `bil.credit_note_refund` under the credit note's row lock: never beyond the credit
--                                  note's amount less what is already held against it, nor beyond what its document
--                                  owes back (`ck_credit_note_refund_cap`); its payment is cleared, of the credit note's
--                                  customer and branch, and paid at least the amount on the credited document, less the
--                                  credit note refunds it already carries (`ck_refund_credit_note_payment`). A rejection
--                                  gives the amount back. SECURITY DEFINER, so hk_app never holds BIL's function itself
--   pay.refund.approved_by         who moved it from PENDING_APPROVAL to APPROVED, set by the guard and never changed;
--                                  never its maker (`ck_refund_approved_by`) and, against a credit note, never the
--                                  credit note's maker (`ck_refund_credit_note_checker`)
-- Data category: CONFIDENTIAL (DC-09).
-- Rollback: tested (`pnpm db:rollback`), safe before the first refund against a credit note; afterwards forward fix only.

-- migrate:up
ALTER TABLE pay.refund
  ADD COLUMN approved_by uuid NULL CONSTRAINT fk_refund_approved_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  ADD CONSTRAINT ck_refund_approved_by CHECK (approved_by IS NULL OR approved_by <> created_by);
CREATE INDEX ix_refund_credit_note ON pay.refund (credit_note_id) WHERE credit_note_id IS NOT NULL;

CREATE OR REPLACE FUNCTION pay.refund_cap() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
DECLARE
  p record;
  cn record;
  applied numeric;
  carried numeric;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT x.status, x.amount_pesewas, x.allocated_pesewas, x.refunded_pesewas, x.customer_id, x.branch_id INTO p FROM pay.payment x WHERE x.id = NEW.original_payment_id FOR UPDATE;
    IF p.status IS DISTINCT FROM 'CLEARED' THEN
      RAISE EXCEPTION 'pay.refund: payment % is %, only a cleared payment is refunded', NEW.original_payment_id, p.status USING ERRCODE = 'HK010', CONSTRAINT = 'ck_refund_cap';
    END IF;
    IF NEW.credit_note_id IS NULL THEN
      IF p.allocated_pesewas + p.refunded_pesewas + NEW.amount_pesewas > p.amount_pesewas THEN
        RAISE EXCEPTION 'pay.refund: % pesewas exceeds the % payment % has unallocated and unrefunded', NEW.amount_pesewas,
          p.amount_pesewas - p.allocated_pesewas - p.refunded_pesewas, NEW.original_payment_id USING ERRCODE = 'HK010', CONSTRAINT = 'ck_refund_cap';
      END IF;
      UPDATE pay.payment SET refunded_pesewas = refunded_pesewas + NEW.amount_pesewas, version = version + 1 WHERE id = NEW.original_payment_id;
    ELSE
      SELECT * INTO cn FROM bil.credit_note_refund(NEW.credit_note_id, NEW.amount_pesewas, 'HOLD');
      SELECT COALESCE(sum(CASE a.direction WHEN 'APPLY' THEN a.amount_pesewas ELSE -a.amount_pesewas END), 0) INTO applied
        FROM pay.payment_allocation a WHERE a.payment_id = NEW.original_payment_id AND a.billing_document_id = cn.original_document_id;
      SELECT COALESCE(sum(r.amount_pesewas), 0) INTO carried
        FROM pay.refund r WHERE r.original_payment_id = NEW.original_payment_id AND r.credit_note_id IS NOT NULL AND r.status <> 'REJECTED';
      IF p.customer_id IS DISTINCT FROM cn.customer_id OR p.branch_id <> cn.branch_id OR NEW.branch_id <> cn.branch_id OR carried > applied THEN
        RAISE EXCEPTION 'pay.refund: payment % paid % on the document credit note % credits and carries % of credit note refunds', NEW.original_payment_id,
          applied, NEW.credit_note_id, carried USING ERRCODE = 'HK010', CONSTRAINT = 'ck_refund_credit_note_payment';
      END IF;
    END IF;
  ELSIF NEW.status = 'REJECTED' AND OLD.status IS DISTINCT FROM 'REJECTED' THEN
    IF NEW.credit_note_id IS NULL THEN
      UPDATE pay.payment SET refunded_pesewas = refunded_pesewas - NEW.amount_pesewas, version = version + 1 WHERE id = NEW.original_payment_id;
    ELSE
      PERFORM bil.credit_note_refund(NEW.credit_note_id, NEW.amount_pesewas, 'RELEASE');
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION pay.refund_guard() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
DECLARE
  maker uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT (NEW.status = 'PENDING_APPROVAL' OR (NEW.status = 'APPROVED' AND NEW.is_automatic)) OR NEW.attempts <> 0 OR NEW.paid_at IS NOT NULL OR NEW.approved_by IS NOT NULL THEN
      RAISE EXCEPTION 'pay.refund %: a refund is written PENDING_APPROVAL, or APPROVED only when automatic', NEW.id USING ERRCODE = 'HK004', CONSTRAINT = 'ck_refund_transition';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT ((OLD.status = 'PENDING_APPROVAL' AND NEW.status IN ('APPROVED', 'REJECTED'))
              OR (OLD.status = 'APPROVED' AND NEW.status IN ('PROCESSING', 'PAID'))
              OR (OLD.status = 'PROCESSING' AND NEW.status IN ('PAID', 'FAILED'))
              OR (OLD.status = 'FAILED' AND NEW.status IN ('APPROVED', 'PAID'))) THEN
    RAISE EXCEPTION 'pay.refund %: % cannot move to %', OLD.id, OLD.status, NEW.status USING ERRCODE = 'HK004', CONSTRAINT = 'ck_refund_transition';
  END IF;
  IF OLD.status IN ('PAID', 'REJECTED')
     OR (NEW.original_payment_id, NEW.amount_pesewas, NEW.destination, NEW.reason_code, NEW.note, NEW.credit_note_id, NEW.is_automatic, NEW.branch_id, NEW.created_by)
        IS DISTINCT FROM (OLD.original_payment_id, OLD.amount_pesewas, OLD.destination, OLD.reason_code, OLD.note, OLD.credit_note_id, OLD.is_automatic, OLD.branch_id, OLD.created_by)
     OR (OLD.approval_request_id IS NOT NULL AND NEW.approval_request_id IS DISTINCT FROM OLD.approval_request_id)
     OR (OLD.provider_reference IS NOT NULL AND NEW.provider_reference IS DISTINCT FROM OLD.provider_reference)
     OR (NEW.approved_by IS DISTINCT FROM OLD.approved_by AND NOT (OLD.status = 'PENDING_APPROVAL' AND NEW.status = 'APPROVED')) THEN
    RAISE EXCEPTION 'pay.refund %: what was asked for, and a paid or rejected refund, never change', OLD.id USING ERRCODE = 'HK004', CONSTRAINT = 'ck_refund_transition';
  END IF;
  -- The approver is whoever moves it to APPROVED: never its maker (ck_refund_approved_by), and never the credit note's.
  IF OLD.status = 'PENDING_APPROVAL' AND NEW.status = 'APPROVED' THEN
    NEW.approved_by := NEW.updated_by;
    IF NEW.credit_note_id IS NOT NULL THEN
      SELECT f.maker_id INTO maker FROM bil.credit_note_facts(NEW.credit_note_id) f;
      IF maker IS NULL OR maker = NEW.approved_by THEN
        RAISE EXCEPTION 'pay.refund %: approved by the maker of credit note %', OLD.id, NEW.credit_note_id USING ERRCODE = 'HK010', CONSTRAINT = 'ck_refund_credit_note_checker';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END
$$;

-- migrate:down
CREATE OR REPLACE FUNCTION pay.refund_cap() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY INVOKER
  SET search_path = pg_catalog
AS $$
DECLARE
  p record;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT x.status, x.amount_pesewas, x.allocated_pesewas, x.refunded_pesewas INTO p FROM pay.payment x WHERE x.id = NEW.original_payment_id FOR UPDATE;
    IF p.status IS DISTINCT FROM 'CLEARED' THEN
      RAISE EXCEPTION 'pay.refund: payment % is %, only a cleared payment is refunded', NEW.original_payment_id, p.status USING ERRCODE = 'HK010', CONSTRAINT = 'ck_refund_cap';
    END IF;
    IF p.allocated_pesewas + p.refunded_pesewas + NEW.amount_pesewas > p.amount_pesewas THEN
      RAISE EXCEPTION 'pay.refund: % pesewas exceeds the % payment % has unallocated and unrefunded', NEW.amount_pesewas,
        p.amount_pesewas - p.allocated_pesewas - p.refunded_pesewas, NEW.original_payment_id USING ERRCODE = 'HK010', CONSTRAINT = 'ck_refund_cap';
    END IF;
    UPDATE pay.payment SET refunded_pesewas = refunded_pesewas + NEW.amount_pesewas, version = version + 1 WHERE id = NEW.original_payment_id;
  ELSIF NEW.status = 'REJECTED' AND OLD.status IS DISTINCT FROM 'REJECTED' THEN
    UPDATE pay.payment SET refunded_pesewas = refunded_pesewas - NEW.amount_pesewas, version = version + 1 WHERE id = NEW.original_payment_id;
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION pay.refund_guard() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY INVOKER
  SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT (NEW.status = 'PENDING_APPROVAL' OR (NEW.status = 'APPROVED' AND NEW.is_automatic)) OR NEW.attempts <> 0 OR NEW.paid_at IS NOT NULL THEN
      RAISE EXCEPTION 'pay.refund %: a refund is written PENDING_APPROVAL, or APPROVED only when automatic', NEW.id USING ERRCODE = 'HK004', CONSTRAINT = 'ck_refund_transition';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT ((OLD.status = 'PENDING_APPROVAL' AND NEW.status IN ('APPROVED', 'REJECTED'))
              OR (OLD.status = 'APPROVED' AND NEW.status IN ('PROCESSING', 'PAID'))
              OR (OLD.status = 'PROCESSING' AND NEW.status IN ('PAID', 'FAILED'))
              OR (OLD.status = 'FAILED' AND NEW.status IN ('APPROVED', 'PAID'))) THEN
    RAISE EXCEPTION 'pay.refund %: % cannot move to %', OLD.id, OLD.status, NEW.status USING ERRCODE = 'HK004', CONSTRAINT = 'ck_refund_transition';
  END IF;
  IF OLD.status IN ('PAID', 'REJECTED')
     OR (NEW.original_payment_id, NEW.amount_pesewas, NEW.destination, NEW.reason_code, NEW.note, NEW.credit_note_id, NEW.is_automatic, NEW.branch_id, NEW.created_by)
        IS DISTINCT FROM (OLD.original_payment_id, OLD.amount_pesewas, OLD.destination, OLD.reason_code, OLD.note, OLD.credit_note_id, OLD.is_automatic, OLD.branch_id, OLD.created_by)
     OR (OLD.approval_request_id IS NOT NULL AND NEW.approval_request_id IS DISTINCT FROM OLD.approval_request_id)
     OR (OLD.provider_reference IS NOT NULL AND NEW.provider_reference IS DISTINCT FROM OLD.provider_reference) THEN
    RAISE EXCEPTION 'pay.refund %: what was asked for, and a paid or rejected refund, never change', OLD.id USING ERRCODE = 'HK004', CONSTRAINT = 'ck_refund_transition';
  END IF;
  RETURN NEW;
END
$$;

DROP INDEX pay.ix_refund_credit_note;
ALTER TABLE pay.refund DROP CONSTRAINT ck_refund_approved_by, DROP COLUMN approved_by;
