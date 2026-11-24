-- 0349_ord_quote_animals_named_at_picking
-- B11u (the owner, 2026-11-23, UAT scenario 2: "convert without tags; tags are named at picking"; A-351, ADR-0098,
-- ADR-0091): a converted quote's line of animals that named none on the quote is entered one head to a line with no
-- animal; the quote's hold on that many animals passes to the order; the picker names each animal, and dispatch or
-- collection writes it onto its line before the line is fulfilled.
--   ck_sales_order_line_serial        (replaced) a line of a serialised product is one head; it names its animal, unless
--                                     it is a QUOTE line still OPEN, BACKORDERED, CANCELLED or SUBSTITUTED
--   ck_sales_order_line_animal_named  (new) a line's animal, once named, never changes (HK004)
-- Data category: CONFIDENTIAL (DC-22): commercial history.
-- Rollback: tested (`pnpm db:rollback`), safe while no QUOTE line waits for its animal; afterwards forward fix only (name
-- the animal at picking, never by hand).

-- migrate:up
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
  -- B11u: a converted quote's line of animals may wait for its animal until it is picked (the owner, 2026-11-23:
  -- "convert without tags; tags are named at picking"); it is named, once, before it is fulfilled. Every other line of
  -- a serialised product names its animal from the start, one to a line, as before.
  IF mdm.product_tracking(NEW.product_id) = 'SERIAL' AND (NEW.qty_ordered <> 1 OR (NEW.stock_unit_id IS NULL
       AND NOT (NEW.price_source = 'QUOTE' AND NEW.line_status IN ('OPEN', 'BACKORDERED', 'CANCELLED', 'SUBSTITUTED')))) THEN
    RAISE EXCEPTION 'ord.sales_order_line %: a serialised product is sold one named animal to a line', NEW.id USING ERRCODE = 'HK010', CONSTRAINT = 'ck_sales_order_line_serial';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.stock_unit_id IS NOT NULL AND NEW.stock_unit_id IS DISTINCT FROM OLD.stock_unit_id THEN
    RAISE EXCEPTION 'ord.sales_order_line %: the animal a line names is named once and never changed', OLD.id USING ERRCODE = 'HK004', CONSTRAINT = 'ck_sales_order_line_animal_named';
  END IF;
  RETURN NEW;
END
$$;

-- migrate:down
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
