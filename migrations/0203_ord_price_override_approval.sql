-- 0203_ord_price_override_approval
-- B09a continued 2e (FR-ORD-003, ADR-0017, abuse case 3, A-230, A-201): a price override approved by a different user,
-- and the proforma of an order, held by the database:
--   ck_sales_order_line_approved    a line names its approver and when exactly together, and only on a line whose price
--                                   needs the approval and names its request
--   ck_sales_order_line_flagged     a line names an override approval request only when its price needs one
--   ck_sales_order_line_priced      once a line names its approval request, its pricing record (product, animal,
--                                   quantity, unit, price source and basis, the rule, list, floor, ceiling, agreed price,
--                                   variance, reason, the flag and the request) never changes, and its approver, once
--                                   written, never changes either
--   ck_sales_order_settled_lines    (replaced) past PLACED, every line whose price needs approval names its request and
--                                   its approver, who is neither the person who wrote the order nor its salesperson; a
--                                   CANCELLED order is exempt, since cancelling an order whose override waits is how it
--                                   ends; the rest as 0163
--   ck_sales_order_proforma         an order names its proforma once and never another (`proforma_document_id`, unique)
-- Additions to docs/data-model/ord.md: `variance_approved_by`, `variance_approved_at`, `proforma_document_id`.
-- Data category: CONFIDENTIAL (DC-22): commercial history.
-- Rollback: tested (`pnpm db:rollback`), safe before the first approved override or proforma; afterwards forward fix
-- only (an approver or a proforma is never removed from an order).

-- migrate:up
ALTER TABLE ord.sales_order_line
  ADD COLUMN variance_approved_by uuid NULL CONSTRAINT fk_sales_order_line_variance_approved_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  ADD COLUMN variance_approved_at timestamptz NULL,
  ADD CONSTRAINT ck_sales_order_line_approved CHECK ((variance_approved_by IS NULL) = (variance_approved_at IS NULL)
                                                     AND (variance_approved_by IS NULL OR (variance_requires_approval AND variance_approval_request_id IS NOT NULL))),
  ADD CONSTRAINT ck_sales_order_line_flagged CHECK (variance_approval_request_id IS NULL OR variance_requires_approval);
CREATE INDEX ix_sales_order_line_variance_approval ON ord.sales_order_line (variance_approval_request_id) WHERE variance_approval_request_id IS NOT NULL;

ALTER TABLE ord.sales_order
  ADD COLUMN proforma_document_id uuid NULL CONSTRAINT fk_sales_order_proforma REFERENCES bil.billing_document (id) ON DELETE RESTRICT
                                           CONSTRAINT uq_sales_order_proforma UNIQUE;

CREATE OR REPLACE FUNCTION ord.sales_order_line_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  order_status text;
  order_id uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.sales_order_id ELSE NEW.sales_order_id END;
  priced text[] := ARRAY['product_id', 'stock_unit_id', 'qty_ordered', 'uom', 'price_source', 'price_basis', 'price_list_entry_id', 'quote_line_ref',
                         'resolved_unit_price_pesewas', 'floor_unit_price_pesewas', 'ceiling_unit_price_pesewas', 'agreed_unit_price_pesewas',
                         'variance_pesewas', 'variance_direction', 'variance_reason_code', 'variance_requires_approval', 'variance_approval_request_id',
                         'discount_pesewas', 'estimated_line_total_pesewas', 'sales_order_id', 'line_no'];
  pricing_changed boolean;
BEGIN
  SELECT o.status INTO order_status FROM ord.sales_order o WHERE o.id = order_id;
  IF order_status IN ('COMPLETED', 'CANCELLED', 'VOIDED') THEN
    RAISE EXCEPTION 'ord.sales_order_line: order % is % and its lines are frozen', order_id, order_status USING ERRCODE = 'HK004', CONSTRAINT = 'ck_sales_order_line_frozen';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ord.sales_order_line %: a line is cancelled, never removed', OLD.id USING ERRCODE = 'HK004', CONSTRAINT = 'ck_sales_order_line_frozen';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.variance_approval_request_id IS NOT NULL THEN
    SELECT bool_or((to_jsonb(NEW) -> c) IS DISTINCT FROM (to_jsonb(OLD) -> c)) INTO pricing_changed FROM unnest(priced) AS c;
    IF pricing_changed OR (OLD.variance_approved_by IS NOT NULL
                           AND (NEW.variance_approved_by IS DISTINCT FROM OLD.variance_approved_by OR NEW.variance_approved_at IS DISTINCT FROM OLD.variance_approved_at)) THEN
      RAISE EXCEPTION 'ord.sales_order_line %: its price waits for or holds an approval, and its pricing record is fixed', OLD.id
        USING ERRCODE = 'HK004', CONSTRAINT = 'ck_sales_order_line_priced';
    END IF;
  END IF;
  IF mdm.product_tracking(NEW.product_id) = 'SERIAL' AND (NEW.stock_unit_id IS NULL OR NEW.qty_ordered <> 1) THEN
    RAISE EXCEPTION 'ord.sales_order_line %: a serialised product is sold one named animal to a line', NEW.id USING ERRCODE = 'HK010', CONSTRAINT = 'ck_sales_order_line_serial';
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION ord.sales_order_check() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  o record;
BEGIN
  SELECT s.id, s.order_no, s.status, s.created_by, s.salesperson_id INTO o FROM ord.sales_order s WHERE s.id = NEW.id;
  IF o.order_no IS NOT NULL AND NOT platform.number_allocated(o.id, o.order_no, 'SALES_ORDER') THEN
    RAISE EXCEPTION 'ord.sales_order %: % is not the number allocated to it', o.id, o.order_no USING ERRCODE = 'HK010', CONSTRAINT = 'ck_sales_order_number';
  END IF;
  IF o.status NOT IN ('PLACED', 'CANCELLED') AND EXISTS (
       SELECT 1 FROM ord.sales_order_line l
        WHERE l.sales_order_id = o.id AND l.variance_requires_approval
          AND (l.variance_approval_request_id IS NULL OR l.variance_approved_by IS NULL
               OR l.variance_approved_by = o.created_by OR l.variance_approved_by IS NOT DISTINCT FROM o.salesperson_id)) THEN
    RAISE EXCEPTION 'ord.sales_order %: a price outside the band or beyond the limit has no approval by someone who neither wrote nor sold it', o.id
      USING ERRCODE = 'HK010', CONSTRAINT = 'ck_sales_order_settled_lines';
  END IF;
  IF o.status = 'COMPLETED' THEN
    IF NOT EXISTS (SELECT 1 FROM ord.sales_order_line l WHERE l.sales_order_id = o.id) THEN
      RAISE EXCEPTION 'ord.sales_order %: a completed order has at least one line', o.id USING ERRCODE = 'HK010', CONSTRAINT = 'ck_sales_order_settled_lines';
    END IF;
    IF EXISTS (SELECT 1 FROM ord.sales_order_line l
                WHERE l.sales_order_id = o.id AND l.line_status NOT IN ('CANCELLED', 'SUBSTITUTED')
                  AND l.stock_movement_id IS NULL AND l.stock_exception_id IS NULL) THEN
      RAISE EXCEPTION 'ord.sales_order %: a completed line has neither a stock movement nor a stock exception', o.id USING ERRCODE = 'HK010', CONSTRAINT = 'ck_sales_order_settled_lines';
    END IF;
  END IF;
  RETURN NULL;
END
$$;

-- An order names its proforma once: it is never replaced or removed.
CREATE FUNCTION ord.sales_order_proforma_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF OLD.proforma_document_id IS NOT NULL AND NEW.proforma_document_id IS DISTINCT FROM OLD.proforma_document_id THEN
    RAISE EXCEPTION 'ord.sales_order %: its proforma is issued and stays', OLD.id USING ERRCODE = 'HK004', CONSTRAINT = 'ck_sales_order_proforma';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION ord.sales_order_proforma_guard() FROM PUBLIC;
CREATE TRIGGER trg_sales_order_proforma_guard BEFORE UPDATE OF proforma_document_id ON ord.sales_order
  FOR EACH ROW EXECUTE FUNCTION ord.sales_order_proforma_guard();

-- migrate:down
DROP TRIGGER trg_sales_order_proforma_guard ON ord.sales_order;
DROP FUNCTION ord.sales_order_proforma_guard();
CREATE OR REPLACE FUNCTION ord.sales_order_check() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  o record;
BEGIN
  SELECT s.id, s.order_no, s.status INTO o FROM ord.sales_order s WHERE s.id = NEW.id;
  IF o.order_no IS NOT NULL AND NOT platform.number_allocated(o.id, o.order_no, 'SALES_ORDER') THEN
    RAISE EXCEPTION 'ord.sales_order %: % is not the number allocated to it', o.id, o.order_no USING ERRCODE = 'HK010', CONSTRAINT = 'ck_sales_order_number';
  END IF;
  IF o.status <> 'PLACED' AND EXISTS (SELECT 1 FROM ord.sales_order_line l WHERE l.sales_order_id = o.id AND l.variance_requires_approval AND l.variance_approval_request_id IS NULL) THEN
    RAISE EXCEPTION 'ord.sales_order %: a price outside the band or beyond the limit has no approval', o.id USING ERRCODE = 'HK010', CONSTRAINT = 'ck_sales_order_settled_lines';
  END IF;
  IF o.status = 'COMPLETED' THEN
    IF NOT EXISTS (SELECT 1 FROM ord.sales_order_line l WHERE l.sales_order_id = o.id) THEN
      RAISE EXCEPTION 'ord.sales_order %: a completed order has at least one line', o.id USING ERRCODE = 'HK010', CONSTRAINT = 'ck_sales_order_settled_lines';
    END IF;
    IF EXISTS (SELECT 1 FROM ord.sales_order_line l
                WHERE l.sales_order_id = o.id AND l.line_status NOT IN ('CANCELLED', 'SUBSTITUTED')
                  AND l.stock_movement_id IS NULL AND l.stock_exception_id IS NULL) THEN
      RAISE EXCEPTION 'ord.sales_order %: a completed line has neither a stock movement nor a stock exception', o.id USING ERRCODE = 'HK010', CONSTRAINT = 'ck_sales_order_settled_lines';
    END IF;
  END IF;
  RETURN NULL;
END
$$;
CREATE OR REPLACE FUNCTION ord.sales_order_line_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  order_status text;
  order_id uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.sales_order_id ELSE NEW.sales_order_id END;
BEGIN
  SELECT o.status INTO order_status FROM ord.sales_order o WHERE o.id = order_id;
  IF order_status IN ('COMPLETED', 'CANCELLED', 'VOIDED') THEN
    RAISE EXCEPTION 'ord.sales_order_line: order % is % and its lines are frozen', order_id, order_status USING ERRCODE = 'HK004', CONSTRAINT = 'ck_sales_order_line_frozen';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ord.sales_order_line %: a line is cancelled, never removed', OLD.id USING ERRCODE = 'HK004', CONSTRAINT = 'ck_sales_order_line_frozen';
  END IF;
  IF mdm.product_tracking(NEW.product_id) = 'SERIAL' AND (NEW.stock_unit_id IS NULL OR NEW.qty_ordered <> 1) THEN
    RAISE EXCEPTION 'ord.sales_order_line %: a serialised product is sold one named animal to a line', NEW.id USING ERRCODE = 'HK010', CONSTRAINT = 'ck_sales_order_line_serial';
  END IF;
  RETURN NEW;
END
$$;
ALTER TABLE ord.sales_order DROP COLUMN proforma_document_id;
DROP INDEX ord.ix_sales_order_line_variance_approval;
ALTER TABLE ord.sales_order_line
  DROP CONSTRAINT ck_sales_order_line_flagged,
  DROP CONSTRAINT ck_sales_order_line_approved,
  DROP COLUMN variance_approved_at,
  DROP COLUMN variance_approved_by;
