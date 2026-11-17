-- 0217_inv_lines_in_selling_unit
-- B09e continued (the owner's decision 3 of 2026-11-17): a goods receipt line and a stock transfer line may be entered in
-- crates or in eggs. The line keeps the unit it was entered in, and stock moves in the product's base unit, converted by
-- the server through MasterDataRefs.toBaseIn and checked again here through MDM's published mdm.uom_to_base (0216,
-- ADR-0047), never with a factor of the line's own.
--   inv.goods_receipt_line.uom              the unit the line was entered in: null for the product's base unit (every line
--                           before B09e continued), otherwise a unit the product converts from
--   inv.goods_receipt_line.qty_received_uom, qty_rejected_uom   the quantities as entered, in `uom`; null with a null
--                           `uom`. qty_received and qty_rejected stay in the base unit: the movements, the cost pool,
--                           inv.GoodsReceiptPosted and the purchase order's three-way match read them unchanged
--   inv.stock_transfer_line.uom, qty_dispatched_uom   the same for a transfer: qty_dispatched stays in the base unit,
--                           as do qty_received and variance_qty, which the receiver may count in either unit
--   ck_goods_receipt_line_uom, ck_stock_transfer_line_uom   a unit comes with its quantities as entered, and only then
--   inv.line_uom_guard()     (BEFORE INSERT OR UPDATE of the unit's columns) the base quantity is exactly the entered
--                           quantity converted by the product's live conversion (HK010 ck_line_uom_conversion)
-- Additions to docs/data-model/inv.md: the five columns.
-- Data category: INTERNAL (stock quantities).
-- Rollback: tested (`pnpm db:rollback`), and it keeps the data: it removes only the guard, and leaves the columns and
-- their checks, which the release before never writes (every line it writes is in the base unit, `uom` null). Dropping
-- the columns would lose the unit a posted line was entered in, so they go only by a later forward fix. Applying 0217
-- again is safe: each step is written to run over what a rollback left.

-- migrate:up
ALTER TABLE inv.goods_receipt_line
  ADD COLUMN IF NOT EXISTS uom text NULL CONSTRAINT fk_goods_receipt_line_uom REFERENCES mdm.uom (code) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS qty_received_uom platform.qty NULL,
  ADD COLUMN IF NOT EXISTS qty_rejected_uom platform.qty NULL;
ALTER TABLE inv.goods_receipt_line DROP CONSTRAINT IF EXISTS ck_goods_receipt_line_uom;
ALTER TABLE inv.goods_receipt_line
  ADD CONSTRAINT ck_goods_receipt_line_uom CHECK (
    (uom IS NULL) = (qty_received_uom IS NULL) AND (uom IS NULL) = (qty_rejected_uom IS NULL)
    AND (qty_received_uom IS NULL OR qty_received_uom > 0) AND (qty_rejected_uom IS NULL OR qty_rejected_uom >= 0));

ALTER TABLE inv.stock_transfer_line
  ADD COLUMN IF NOT EXISTS uom text NULL CONSTRAINT fk_stock_transfer_line_uom REFERENCES mdm.uom (code) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS qty_dispatched_uom platform.qty NULL;
ALTER TABLE inv.stock_transfer_line DROP CONSTRAINT IF EXISTS ck_stock_transfer_line_uom;
ALTER TABLE inv.stock_transfer_line
  ADD CONSTRAINT ck_stock_transfer_line_uom CHECK ((uom IS NULL) = (qty_dispatched_uom IS NULL) AND (qty_dispatched_uom IS NULL OR qty_dispatched_uom > 0));

CREATE OR REPLACE FUNCTION inv.line_uom_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  entered jsonb := to_jsonb(NEW);
  pairs text[][] := CASE TG_TABLE_NAME
    WHEN 'goods_receipt_line' THEN ARRAY[ARRAY['qty_received', 'qty_received_uom'], ARRAY['qty_rejected', 'qty_rejected_uom']]
    ELSE ARRAY[ARRAY['qty_dispatched', 'qty_dispatched_uom']] END;
  pair text[];
  converted numeric;
BEGIN
  IF NEW.uom IS NULL THEN
    RETURN NEW;
  END IF;
  FOREACH pair SLICE 1 IN ARRAY pairs LOOP
    converted := mdm.uom_to_base(NEW.product_id, NEW.uom, (entered ->> pair[2])::numeric);
    IF converted IS NULL OR converted <> (entered ->> pair[1])::numeric THEN
      RAISE EXCEPTION '%.% %: % % of product % is not % in its base unit by a live conversion', TG_TABLE_SCHEMA, TG_TABLE_NAME, NEW.id,
        entered ->> pair[2], NEW.uom, NEW.product_id, entered ->> pair[1]
        USING ERRCODE = 'HK010', CONSTRAINT = 'ck_line_uom_conversion';
    END IF;
  END LOOP;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION inv.line_uom_guard() FROM PUBLIC;
DROP TRIGGER IF EXISTS trg_goods_receipt_line_uom_guard ON inv.goods_receipt_line;
CREATE TRIGGER trg_goods_receipt_line_uom_guard
  BEFORE INSERT OR UPDATE OF uom, product_id, qty_received, qty_rejected, qty_received_uom, qty_rejected_uom ON inv.goods_receipt_line
  FOR EACH ROW EXECUTE FUNCTION inv.line_uom_guard();
DROP TRIGGER IF EXISTS trg_stock_transfer_line_uom_guard ON inv.stock_transfer_line;
CREATE TRIGGER trg_stock_transfer_line_uom_guard
  BEFORE INSERT OR UPDATE OF uom, product_id, qty_dispatched, qty_dispatched_uom ON inv.stock_transfer_line
  FOR EACH ROW EXECUTE FUNCTION inv.line_uom_guard();

-- migrate:down
DROP TRIGGER trg_stock_transfer_line_uom_guard ON inv.stock_transfer_line;
DROP TRIGGER trg_goods_receipt_line_uom_guard ON inv.goods_receipt_line;
DROP FUNCTION inv.line_uom_guard();
