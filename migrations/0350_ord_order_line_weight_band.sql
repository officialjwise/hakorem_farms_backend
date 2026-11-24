-- 0350_ord_order_line_weight_band
-- B11u continued (the owner, 2026-11-24: "BL-123 and BL-124: fix them in one small phase before B12, so UAT scenario 2
-- runs exactly as written"; BL-124, A-351 (g) amended, A-359): an order line converted from a quote line of a weight band
-- carries that band, so the order's confirmation reserves, and its picker names, only animals whose weighing is in it.
--   weight_band_id                  (new, nullable) the band the quote line named; null on every other line
--   ck_sales_order_line_weight_band (new, HK004) the band is written with the line and never changes, so nobody switches
--                                   a line to a cheaper band between the quote and the picking (abuse case 67)
-- Data category: CONFIDENTIAL (DC-22): commercial history.
-- Rollback: tested (`pnpm db:rollback`): the trigger, then the column, dropped; the bands written are lost (they are
-- also on the quote lines the order lines name, so a forward fix re-reads them from there).

-- migrate:up
ALTER TABLE ord.sales_order_line ADD COLUMN weight_band_id uuid NULL CONSTRAINT fk_sales_order_line_weight_band REFERENCES mdm.weight_band (id) ON DELETE RESTRICT;

CREATE FUNCTION ord.sales_order_line_band_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.weight_band_id IS DISTINCT FROM OLD.weight_band_id THEN
    RAISE EXCEPTION 'ord.sales_order_line %: its weight band is written with the line and never changes', OLD.id
      USING ERRCODE = 'HK004', CONSTRAINT = 'ck_sales_order_line_weight_band';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION ord.sales_order_line_band_guard() FROM PUBLIC;
CREATE TRIGGER trg_sales_order_line_band_guard BEFORE UPDATE OF weight_band_id ON ord.sales_order_line
  FOR EACH ROW EXECUTE FUNCTION ord.sales_order_line_band_guard();

-- migrate:down
DROP TRIGGER trg_sales_order_line_band_guard ON ord.sales_order_line;
DROP FUNCTION ord.sales_order_line_band_guard();
ALTER TABLE ord.sales_order_line DROP COLUMN weight_band_id;
