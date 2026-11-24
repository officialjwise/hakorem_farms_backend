-- 0329_ord_backorders
-- B11 continued 7 (FR-ORD-012, ADR-0094, A-331 (b) approved by the owner 2026-11-23, A-366): partial fulfilment with a
-- backorder, and the extra delivery fee the customer asks for.
--   ord.sales_order_line    ck_sales_order_line_backorder: never more back-ordered than ordered; a BACKORDERED line sent
--                           nothing and back-ordered all of it.
--   ord.sales_order         ck_sales_order_parent: a backorder is never its own parent.
--                           ck_sales_order_backorder (HK010, on insert): a backorder names an order that is not itself a
--                           backorder, of the same branch, customer, terms and fulfilment mode, and carries no delivery
--                           fee of its own: the fee is charged once, on the first dispatch (A-331 (b)).
--                           ck_sales_order_settled_lines (replaced): a completed order's line wholly back-ordered
--                           (BACKORDERED) needs no stock movement of its own; its backorder carries it.
--   ord.order_extra_fee     (LEDGER) an extra delivery the customer asked for, added by staff holding
--                           ord.delivery_fee.add (0330, 0331): one a backorder (uq_order_extra_fee_order), its zone's fee,
--                           positive; only on a delivery backorder not yet dispatched (ck_order_extra_fee_order, HK010).
-- Data category: CONFIDENTIAL as ord.sales_order (no new personal data).
-- Rollback: tested (`pnpm db:rollback`), safe before the first backorder; afterwards forward fix only.

-- migrate:up
ALTER TABLE ord.sales_order_line
  ADD CONSTRAINT ck_sales_order_line_backorder CHECK (qty_backordered <= qty_ordered
                                                      AND (line_status <> 'BACKORDERED' OR (qty_fulfilled = 0 AND qty_backordered = qty_ordered)));
ALTER TABLE ord.sales_order
  ADD CONSTRAINT ck_sales_order_parent CHECK (parent_order_id IS NULL OR parent_order_id <> id);
CREATE INDEX ix_sales_order_parent ON ord.sales_order (parent_order_id) WHERE parent_order_id IS NOT NULL;

CREATE FUNCTION ord.sales_order_backorder_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  p record;
BEGIN
  IF NEW.parent_order_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT s.parent_order_id, s.branch_id, s.customer_id, s.payment_terms, s.fulfilment_mode INTO p FROM ord.sales_order s WHERE s.id = NEW.parent_order_id;
  IF p.parent_order_id IS NOT NULL OR p.branch_id IS DISTINCT FROM NEW.branch_id OR p.customer_id IS DISTINCT FROM NEW.customer_id
     OR p.payment_terms IS DISTINCT FROM NEW.payment_terms OR p.fulfilment_mode IS DISTINCT FROM NEW.fulfilment_mode OR NEW.delivery_fee_pesewas <> 0 THEN
    RAISE EXCEPTION 'ord.sales_order %: a backorder is of an order that is no backorder, of its branch, customer, terms and mode, and carries no delivery fee', NEW.id
      USING ERRCODE = 'HK010', CONSTRAINT = 'ck_sales_order_backorder';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION ord.sales_order_backorder_guard() FROM PUBLIC;
CREATE TRIGGER trg_sales_order_backorder BEFORE INSERT ON ord.sales_order
  FOR EACH ROW EXECUTE FUNCTION ord.sales_order_backorder_guard();

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
                WHERE l.sales_order_id = o.id AND l.line_status NOT IN ('CANCELLED', 'SUBSTITUTED', 'BACKORDERED')
                  AND l.stock_movement_id IS NULL AND l.stock_exception_id IS NULL) THEN
      RAISE EXCEPTION 'ord.sales_order %: a completed line has neither a stock movement nor a stock exception', o.id USING ERRCODE = 'HK010', CONSTRAINT = 'ck_sales_order_settled_lines';
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE TABLE ord.order_extra_fee (
  id                uuid PRIMARY KEY,
  sales_order_id    uuid NOT NULL CONSTRAINT fk_order_extra_fee_order REFERENCES ord.sales_order (id) ON DELETE RESTRICT
                      CONSTRAINT uq_order_extra_fee_order UNIQUE,
  delivery_zone_id  uuid NOT NULL CONSTRAINT fk_order_extra_fee_zone REFERENCES mdm.delivery_zone (id) ON DELETE RESTRICT,
  amount_pesewas    platform.pesewas NOT NULL CONSTRAINT ck_order_extra_fee_amount CHECK (amount_pesewas > 0),
  note              text NOT NULL CONSTRAINT ck_order_extra_fee_note CHECK (length(btrim(note)) BETWEEN 1 AND 500),
  branch_id         uuid NOT NULL CONSTRAINT fk_order_extra_fee_branch REFERENCES mdm.branch (id) ON DELETE RESTRICT,
  recorded_at       timestamptz NOT NULL DEFAULT now(),
  actor_id          uuid NOT NULL CONSTRAINT fk_order_extra_fee_actor REFERENCES iam.principal (id) ON DELETE RESTRICT
);
COMMENT ON TABLE ord.order_extra_fee IS 'class=LEDGER';
CREATE TRIGGER trg_order_extra_fee_immutable BEFORE UPDATE OR DELETE ON ord.order_extra_fee
  FOR EACH ROW EXECUTE FUNCTION platform.reject_change();
CREATE TRIGGER trg_order_extra_fee_no_truncate BEFORE TRUNCATE ON ord.order_extra_fee
  FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_change();
REVOKE ALL ON ord.order_extra_fee FROM PUBLIC;
GRANT SELECT, INSERT ON ord.order_extra_fee TO hk_app, hk_worker;
GRANT SELECT ON ord.order_extra_fee TO hk_report;

-- An extra fee only on a delivery backorder not yet dispatched, of its own branch and zone.
CREATE FUNCTION ord.order_extra_fee_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM ord.sales_order s
                  WHERE s.id = NEW.sales_order_id AND s.parent_order_id IS NOT NULL AND s.fulfilment_mode = 'DELIVERY'
                    AND s.status IN ('CONFIRMED', 'PICKING', 'AWAITING_CUSTOMER', 'PACKED')
                    AND s.branch_id = NEW.branch_id AND s.delivery_zone_id = NEW.delivery_zone_id) THEN
    RAISE EXCEPTION 'ord.order_extra_fee %: only on a delivery backorder of its branch and zone not yet dispatched', NEW.id
      USING ERRCODE = 'HK010', CONSTRAINT = 'ck_order_extra_fee_order';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION ord.order_extra_fee_guard() FROM PUBLIC;
CREATE TRIGGER trg_order_extra_fee_guard BEFORE INSERT ON ord.order_extra_fee
  FOR EACH ROW EXECUTE FUNCTION ord.order_extra_fee_guard();

-- migrate:down
DROP TABLE ord.order_extra_fee;
DROP FUNCTION ord.order_extra_fee_guard();
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
DROP TRIGGER trg_sales_order_backorder ON ord.sales_order;
DROP FUNCTION ord.sales_order_backorder_guard();
DROP INDEX ord.ix_sales_order_parent;
ALTER TABLE ord.sales_order DROP CONSTRAINT ck_sales_order_parent;
ALTER TABLE ord.sales_order_line DROP CONSTRAINT ck_sales_order_line_backorder;
