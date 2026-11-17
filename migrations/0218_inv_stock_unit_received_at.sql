-- 0218_inv_stock_unit_received_at
-- B09e continued (the owner's decision 4 of 2026-11-17): every bought lot has a received date, and stock sells oldest
-- first by expiry, then by received date, wherever the server picks a lot. The received date is the goods receipt's
-- received_at, kept on the stock unit when the receipt registers it (application clock, ADR-0067; never now()).
--   inv.stock_unit.received_at      when the unit arrived from its delivery: set once, by the goods receipt that
--                           registers it (any kind: a purchase, a harvest, opening stock), never changed afterwards
--                           (inv.stock_unit_guard lets only its four named columns change); null for a unit no receipt
--                           brought in (a processing output, an animal born on the farm)
--   backfill                every unit a goods receipt registered takes that receipt's received_at
--   inv.require_received_date()   (BEFORE INSERT on inv.stock_movement) a RECEIPT_PURCHASE of a stock unit, other than a
--                           reversal, needs the unit's received date: a bought lot always has one (HK010
--                           ck_stock_unit_received)
--   ix_stock_unit_received        the order a pick reads (expiry, then received date) over live lots, per product
-- Additions to docs/data-model/inv.md: `received_at`.
-- Data category: INTERNAL (stock).
-- Rollback: tested (`pnpm db:rollback`), and it keeps the data: it removes the trigger and the index, and leaves the
-- column, which the release before never writes and never reads. Applying 0218 again is safe: the backfill touches only
-- units without a date.

-- migrate:up
ALTER TABLE inv.stock_unit ADD COLUMN IF NOT EXISTS received_at timestamptz NULL;

UPDATE inv.stock_unit u
   SET received_at = r.received_at
  FROM inv.goods_receipt r
 WHERE r.id = u.source_document_id AND u.received_at IS NULL;

CREATE INDEX IF NOT EXISTS ix_stock_unit_received ON inv.stock_unit (product_id, expires_on, received_at, id)
  WHERE deleted_at IS NULL AND status = 'ACTIVE';

CREATE OR REPLACE FUNCTION inv.require_received_date() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.movement_type = 'RECEIPT_PURCHASE' AND NEW.stock_unit_id IS NOT NULL AND NEW.reverses_movement_id IS NULL
     AND NOT EXISTS (SELECT 1 FROM inv.stock_unit u WHERE u.id = NEW.stock_unit_id AND u.received_at IS NOT NULL) THEN
    RAISE EXCEPTION 'inv.stock_movement %: stock unit % is bought without a received date', NEW.id, NEW.stock_unit_id
      USING ERRCODE = 'HK010', CONSTRAINT = 'ck_stock_unit_received';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION inv.require_received_date() FROM PUBLIC;
DROP TRIGGER IF EXISTS trg_stock_movement_received_date ON inv.stock_movement;
CREATE TRIGGER trg_stock_movement_received_date BEFORE INSERT ON inv.stock_movement
  FOR EACH ROW EXECUTE FUNCTION inv.require_received_date();

-- migrate:down
DROP TRIGGER trg_stock_movement_received_date ON inv.stock_movement;
DROP FUNCTION inv.require_received_date();
DROP INDEX inv.ix_stock_unit_received;
