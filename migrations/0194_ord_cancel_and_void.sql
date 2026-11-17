-- 0194_ord_cancel_and_void
-- B09a continued 2c (FR-ORD-002, FR-ORD-014, abuse case 1, A-226): an order's cancellation and a sale's void, held by
-- the database:
--   ck_sales_order_void_checker   a VOIDED order names who voided it and when, and that person is neither the one who
--                                 posted the sale nor its salesperson (the cashier): a supervisor who is not the cashier
--   ck_sales_order_transition     (replaced) as before; a COMPLETED order changes only to be VOIDED, now with its
--                                 voider and time beside its status and its approval
--   ord.order_void                one void asked for per sale at a time (uq_order_void_open), written PENDING_APPROVAL
--                                 with its SALE_VOID approval, then APPROVED with its credit note, or REJECTED, then
--                                 frozen (ck_order_void_transition); decided by someone other than its maker
--                                 (ck_order_void_decided)
-- Additions to docs/data-model/ord.md: `voided_by`, `voided_at` and `ord.order_void`.
-- Data category: CONFIDENTIAL (DC-22): commercial history.
-- Rollback: tested (`pnpm db:rollback`), safe before the first void; afterwards forward fix only (a void is never removed).

-- migrate:up
ALTER TABLE ord.sales_order
  ADD COLUMN voided_by uuid NULL CONSTRAINT fk_sales_order_voided_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  ADD COLUMN voided_at timestamptz NULL,
  ADD CONSTRAINT ck_sales_order_void_checker CHECK (status <> 'VOIDED'
    OR (voided_by IS NOT NULL AND voided_at IS NOT NULL AND voided_by <> created_by AND voided_by IS DISTINCT FROM salesperson_id));

CREATE OR REPLACE FUNCTION ord.sales_order_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  allowed text[];
  void_columns text[] := ARRAY['status', 'void_approval_request_id', 'voided_by', 'voided_at', 'version', 'updated_at', 'updated_by'];
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'PLACED' THEN
      RAISE EXCEPTION 'ord.sales_order %: an order is written PLACED', NEW.id USING ERRCODE = 'HK004', CONSTRAINT = 'ck_sales_order_transition';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status IN ('CANCELLED', 'VOIDED') AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
    RAISE EXCEPTION 'ord.sales_order % is % and frozen', OLD.id, OLD.status USING ERRCODE = 'HK004', CONSTRAINT = 'ck_sales_order_transition';
  END IF;
  IF OLD.status = 'COMPLETED' AND (to_jsonb(NEW) - void_columns) IS DISTINCT FROM (to_jsonb(OLD) - void_columns) THEN
    RAISE EXCEPTION 'ord.sales_order % is completed and frozen', OLD.id USING ERRCODE = 'HK004', CONSTRAINT = 'ck_sales_order_transition';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    allowed := CASE OLD.status
      WHEN 'PLACED' THEN ARRAY['CONFIRMED', 'COMPLETED', 'CANCELLED']
      WHEN 'CONFIRMED' THEN ARRAY['PICKING', 'CANCELLED']
      WHEN 'PICKING' THEN ARRAY['AWAITING_CUSTOMER', 'PACKED', 'CANCELLED']
      WHEN 'AWAITING_CUSTOMER' THEN ARRAY['PICKING', 'CANCELLED']
      WHEN 'PACKED' THEN ARRAY['READY_FOR_COLLECTION', 'DISPATCHED']
      WHEN 'READY_FOR_COLLECTION' THEN ARRAY['COMPLETED']
      WHEN 'DISPATCHED' THEN ARRAY['DELIVERED', 'DELIVERY_FAILED']
      WHEN 'DELIVERY_FAILED' THEN ARRAY['DISPATCHED', 'RETURNED']
      WHEN 'DELIVERED' THEN ARRAY['COMPLETED']
      WHEN 'RETURNED' THEN ARRAY['CANCELLED']
      WHEN 'COMPLETED' THEN ARRAY['VOIDED']
      ELSE ARRAY[]::text[] END;
    IF NOT (NEW.status = ANY (allowed)) THEN
      RAISE EXCEPTION 'ord.sales_order %: % cannot move to %', OLD.id, OLD.status, NEW.status USING ERRCODE = 'HK004', CONSTRAINT = 'ck_sales_order_transition';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TABLE ord.order_void (
  id                  uuid PRIMARY KEY,
  sales_order_id      uuid NOT NULL CONSTRAINT fk_order_void_order REFERENCES ord.sales_order (id) ON DELETE RESTRICT,
  reason_code         text NOT NULL CONSTRAINT fk_order_void_reason REFERENCES mdm.reason_code (code) ON DELETE RESTRICT,
  note                text NULL CONSTRAINT ck_order_void_note CHECK (length(btrim(note)) BETWEEN 1 AND 500),
  status              text NOT NULL CONSTRAINT ck_order_void_status CHECK (status IN ('PENDING_APPROVAL', 'APPROVED', 'REJECTED')),
  approval_request_id uuid NOT NULL CONSTRAINT fk_order_void_approval REFERENCES iam.approval_request (id) ON DELETE RESTRICT
                        CONSTRAINT uq_order_void_approval UNIQUE,
  credit_note_id      uuid NULL CONSTRAINT fk_order_void_credit_note REFERENCES bil.billing_document (id) ON DELETE RESTRICT
                        CONSTRAINT uq_order_void_credit_note UNIQUE,
  decided_by          uuid NULL CONSTRAINT fk_order_void_decided_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  decided_at          timestamptz NULL,
  branch_id           uuid NOT NULL CONSTRAINT fk_order_void_branch REFERENCES mdm.branch (id) ON DELETE RESTRICT,
  version             integer NOT NULL DEFAULT 1,
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid NOT NULL CONSTRAINT fk_order_void_created_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  updated_by          uuid NOT NULL CONSTRAINT fk_order_void_updated_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  CONSTRAINT ck_order_void_decided CHECK ((status = 'PENDING_APPROVAL') = (decided_by IS NULL)
                                          AND (decided_by IS NULL) = (decided_at IS NULL)
                                          AND decided_by IS DISTINCT FROM created_by
                                          AND (status = 'APPROVED') = (credit_note_id IS NOT NULL))
);
COMMENT ON TABLE ord.order_void IS 'class=DOCUMENT';
CREATE UNIQUE INDEX uq_order_void_open ON ord.order_void (sales_order_id) WHERE status <> 'REJECTED';
CREATE TRIGGER trg_order_void_version BEFORE UPDATE ON ord.order_void
  FOR EACH ROW EXECUTE FUNCTION platform.touch_version();

-- A void is written PENDING_APPROVAL; what was asked never changes; it is decided once, then frozen.
CREATE FUNCTION ord.order_void_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'PENDING_APPROVAL' THEN
      RAISE EXCEPTION 'ord.order_void %: a void is written PENDING_APPROVAL', NEW.id USING ERRCODE = 'HK004', CONSTRAINT = 'ck_order_void_transition';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status <> 'PENDING_APPROVAL'
     OR (to_jsonb(NEW) - ARRAY['status', 'credit_note_id', 'decided_by', 'decided_at', 'version', 'updated_at', 'updated_by'])
        IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'credit_note_id', 'decided_by', 'decided_at', 'version', 'updated_at', 'updated_by']) THEN
    RAISE EXCEPTION 'ord.order_void %: what was asked never changes, and a decided void is frozen', OLD.id USING ERRCODE = 'HK004', CONSTRAINT = 'ck_order_void_transition';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION ord.order_void_guard() FROM PUBLIC;
CREATE TRIGGER trg_order_void_guard BEFORE INSERT OR UPDATE ON ord.order_void
  FOR EACH ROW EXECUTE FUNCTION ord.order_void_guard();

REVOKE ALL ON ord.order_void FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON ord.order_void TO hk_app, hk_worker;

-- migrate:down
DROP TABLE ord.order_void;
DROP FUNCTION ord.order_void_guard();
CREATE OR REPLACE FUNCTION ord.sales_order_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  allowed text[];
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'PLACED' THEN
      RAISE EXCEPTION 'ord.sales_order %: an order is written PLACED', NEW.id USING ERRCODE = 'HK004', CONSTRAINT = 'ck_sales_order_transition';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status IN ('CANCELLED', 'VOIDED') AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
    RAISE EXCEPTION 'ord.sales_order % is % and frozen', OLD.id, OLD.status USING ERRCODE = 'HK004', CONSTRAINT = 'ck_sales_order_transition';
  END IF;
  IF OLD.status = 'COMPLETED'
     AND (to_jsonb(NEW) - ARRAY['status', 'void_approval_request_id', 'version', 'updated_at', 'updated_by'])
         IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'void_approval_request_id', 'version', 'updated_at', 'updated_by']) THEN
    RAISE EXCEPTION 'ord.sales_order % is completed and frozen', OLD.id USING ERRCODE = 'HK004', CONSTRAINT = 'ck_sales_order_transition';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    allowed := CASE OLD.status
      WHEN 'PLACED' THEN ARRAY['CONFIRMED', 'COMPLETED', 'CANCELLED']
      WHEN 'CONFIRMED' THEN ARRAY['PICKING', 'CANCELLED']
      WHEN 'PICKING' THEN ARRAY['AWAITING_CUSTOMER', 'PACKED', 'CANCELLED']
      WHEN 'AWAITING_CUSTOMER' THEN ARRAY['PICKING', 'CANCELLED']
      WHEN 'PACKED' THEN ARRAY['READY_FOR_COLLECTION', 'DISPATCHED']
      WHEN 'READY_FOR_COLLECTION' THEN ARRAY['COMPLETED']
      WHEN 'DISPATCHED' THEN ARRAY['DELIVERED', 'DELIVERY_FAILED']
      WHEN 'DELIVERY_FAILED' THEN ARRAY['DISPATCHED', 'RETURNED']
      WHEN 'DELIVERED' THEN ARRAY['COMPLETED']
      WHEN 'RETURNED' THEN ARRAY['CANCELLED']
      WHEN 'COMPLETED' THEN ARRAY['VOIDED']
      ELSE ARRAY[]::text[] END;
    IF NOT (NEW.status = ANY (allowed)) THEN
      RAISE EXCEPTION 'ord.sales_order %: % cannot move to %', OLD.id, OLD.status, NEW.status USING ERRCODE = 'HK004', CONSTRAINT = 'ck_sales_order_transition';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
ALTER TABLE ord.sales_order
  DROP CONSTRAINT ck_sales_order_void_checker,
  DROP COLUMN voided_at,
  DROP COLUMN voided_by;
