-- 0334_ord_return_part_of_unit
-- B11 continued 9 (FR-ORD-015, the owner 2026-11-18, ADR-0075, A-372): part of a unit of several returned as single
-- pieces (five cracked eggs of a crate), refunded pro rata at the price paid on the line per piece.
--   ord.order_return_line.uom              the unit a line returned in single pieces is counted in (the product's base
--                                          unit, the egg); null when it is counted in the unit the line was sold in.
--   ord.order_return_line.pieces_per_unit  how many of those pieces make one of the sold line's unit (30 eggs a crate),
--                                          as MDM's conversion gave it when the return was made; set with `uom` only.
--   ck_order_return_line_pieces            both or neither; more than one piece a unit; whole pieces only; never back
--                                          onto the shelf (RETURNS_HOLD or WRITE_OFF).
--   ord.order_return_line_guard()          the cap counted in pieces once any return of the line is (whole units times
--                                          the count, plus single pieces, never above what was fulfilled times the count),
--                                          one count per line, and a return in pieces never open beside another open
--                                          return of its line (ck_order_return_line_open), so its refund's running total
--                                          reads only decided returns. All under the sold line's row lock, as before.
-- Data category: INTERNAL (quantities; no personal data).
-- Rollback: tested (`pnpm db:rollback`), safe before the first return in pieces; afterwards forward fix only.

-- migrate:up
ALTER TABLE ord.order_return_line
  ADD COLUMN uom text NULL CONSTRAINT ck_order_return_line_uom CHECK (uom ~ '^[A-Z][A-Z0-9_]{0,19}$'),
  ADD COLUMN pieces_per_unit integer NULL,
  ADD CONSTRAINT ck_order_return_line_pieces CHECK (
    (uom IS NULL) = (pieces_per_unit IS NULL)
    AND (pieces_per_unit IS NULL OR (pieces_per_unit > 1 AND qty = trunc(qty) AND disposition <> 'RESTOCK'))
  );

CREATE OR REPLACE FUNCTION ord.order_return_line_guard() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
DECLARE
  sold record;
  ret record;
  held numeric;
  asked numeric;
  per integer;
BEGIN
  SELECT r.status, r.sales_order_id INTO ret FROM ord.order_return r WHERE r.id = NEW.order_return_id;
  IF TG_OP = 'UPDATE' THEN
    IF ret.status IN ('COMPLETED', 'REJECTED')
       OR (to_jsonb(NEW) - ARRAY['refund_pesewas', 'stock_movement_id']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['refund_pesewas', 'stock_movement_id']) THEN
      RAISE EXCEPTION 'ord.order_return_line %: only its refund and its movement are written, while its return is open', OLD.id
        USING ERRCODE = 'HK004', CONSTRAINT = 'ck_order_return_transition';
    END IF;
    RETURN NEW;
  END IF;
  IF ret.status <> 'REQUESTED' THEN
    RAISE EXCEPTION 'ord.order_return_line %: lines are written while the return is REQUESTED', NEW.id USING ERRCODE = 'HK004', CONSTRAINT = 'ck_order_return_transition';
  END IF;
  SELECT l.sales_order_id, l.qty_fulfilled INTO sold FROM ord.sales_order_line l WHERE l.id = NEW.sales_order_line_id FOR UPDATE;
  IF sold.sales_order_id IS DISTINCT FROM ret.sales_order_id THEN
    RAISE EXCEPTION 'ord.order_return_line %: the line is not of the return''s sale', NEW.id USING ERRCODE = 'HK010', CONSTRAINT = 'ck_order_return_line_cap';
  END IF;
  -- Single pieces of a unit of several (five eggs of a crate): every count of the line is in pieces, at one count per unit.
  SELECT rl.pieces_per_unit INTO per
    FROM ord.order_return_line rl JOIN ord.order_return r ON r.id = rl.order_return_id
   WHERE rl.sales_order_line_id = NEW.sales_order_line_id AND r.status <> 'REJECTED' AND rl.pieces_per_unit IS NOT NULL
   LIMIT 1;
  IF per IS NOT NULL AND NEW.pieces_per_unit IS NOT NULL AND per <> NEW.pieces_per_unit THEN
    RAISE EXCEPTION 'ord.order_return_line %: the line''s pieces are counted % to its unit, not %', NEW.id, per, NEW.pieces_per_unit
      USING ERRCODE = 'HK010', CONSTRAINT = 'ck_order_return_line_cap';
  END IF;
  per := COALESCE(per, NEW.pieces_per_unit);
  -- The pro-rata refund reads what came back before it: a return in pieces never waits beside another open return of the line.
  IF EXISTS (
    SELECT 1 FROM ord.order_return_line rl JOIN ord.order_return r ON r.id = rl.order_return_id
     WHERE rl.sales_order_line_id = NEW.sales_order_line_id AND r.id <> NEW.order_return_id AND r.status IN ('REQUESTED', 'PENDING_APPROVAL')
       AND (NEW.pieces_per_unit IS NOT NULL OR rl.pieces_per_unit IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'ord.order_return_line %: a return in single pieces waits for the open return of its line to be decided', NEW.id
      USING ERRCODE = 'HK010', CONSTRAINT = 'ck_order_return_line_open';
  END IF;
  IF per IS NULL THEN
    SELECT COALESCE(sum(rl.qty), 0) INTO held
      FROM ord.order_return_line rl JOIN ord.order_return r ON r.id = rl.order_return_id
     WHERE rl.sales_order_line_id = NEW.sales_order_line_id AND r.status <> 'REJECTED';
    IF held + NEW.qty > sold.qty_fulfilled THEN
      RAISE EXCEPTION 'ord.order_return_line %: % of the line was sold and % is returned already; % more is too much', NEW.id, sold.qty_fulfilled, held, NEW.qty
        USING ERRCODE = 'HK010', CONSTRAINT = 'ck_order_return_line_cap';
    END IF;
  ELSE
    SELECT COALESCE(sum(CASE WHEN rl.pieces_per_unit IS NULL THEN rl.qty * per ELSE rl.qty END), 0) INTO held
      FROM ord.order_return_line rl JOIN ord.order_return r ON r.id = rl.order_return_id
     WHERE rl.sales_order_line_id = NEW.sales_order_line_id AND r.status <> 'REJECTED';
    asked := CASE WHEN NEW.pieces_per_unit IS NULL THEN NEW.qty * per ELSE NEW.qty END;
    IF held + asked > sold.qty_fulfilled * per THEN
      RAISE EXCEPTION 'ord.order_return_line %: % pieces of the line were sold and % are returned already; % more is too much', NEW.id, sold.qty_fulfilled * per, held, asked
        USING ERRCODE = 'HK010', CONSTRAINT = 'ck_order_return_line_cap';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

-- migrate:down
CREATE OR REPLACE FUNCTION ord.order_return_line_guard() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
DECLARE
  sold record;
  ret record;
  held numeric;
BEGIN
  SELECT r.status, r.sales_order_id INTO ret FROM ord.order_return r WHERE r.id = NEW.order_return_id;
  IF TG_OP = 'UPDATE' THEN
    IF ret.status IN ('COMPLETED', 'REJECTED')
       OR (to_jsonb(NEW) - ARRAY['refund_pesewas', 'stock_movement_id']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['refund_pesewas', 'stock_movement_id']) THEN
      RAISE EXCEPTION 'ord.order_return_line %: only its refund and its movement are written, while its return is open', OLD.id
        USING ERRCODE = 'HK004', CONSTRAINT = 'ck_order_return_transition';
    END IF;
    RETURN NEW;
  END IF;
  IF ret.status <> 'REQUESTED' THEN
    RAISE EXCEPTION 'ord.order_return_line %: lines are written while the return is REQUESTED', NEW.id USING ERRCODE = 'HK004', CONSTRAINT = 'ck_order_return_transition';
  END IF;
  SELECT l.sales_order_id, l.qty_fulfilled INTO sold FROM ord.sales_order_line l WHERE l.id = NEW.sales_order_line_id FOR UPDATE;
  IF sold.sales_order_id IS DISTINCT FROM ret.sales_order_id THEN
    RAISE EXCEPTION 'ord.order_return_line %: the line is not of the return''s sale', NEW.id USING ERRCODE = 'HK010', CONSTRAINT = 'ck_order_return_line_cap';
  END IF;
  SELECT COALESCE(sum(rl.qty), 0) INTO held
    FROM ord.order_return_line rl JOIN ord.order_return r ON r.id = rl.order_return_id
   WHERE rl.sales_order_line_id = NEW.sales_order_line_id AND r.status <> 'REJECTED';
  IF held + NEW.qty > sold.qty_fulfilled THEN
    RAISE EXCEPTION 'ord.order_return_line %: % of the line was sold and % is returned already; % more is too much', NEW.id, sold.qty_fulfilled, held, NEW.qty
      USING ERRCODE = 'HK010', CONSTRAINT = 'ck_order_return_line_cap';
  END IF;
  RETURN NEW;
END
$$;
ALTER TABLE ord.order_return_line DROP CONSTRAINT ck_order_return_line_pieces, DROP COLUMN pieces_per_unit, DROP COLUMN uom;
