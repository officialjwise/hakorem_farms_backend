-- 0333_ord_pick_breakage
-- B11 continued 8 (CR-054 point 1, FR-ORD-009, A-370): eggs found broken while picking, written off from the pick
-- location in the pick's own transaction through INV's stock adjustment and its STOCK_WRITE_OFF approval.
--   ord.pick_breakage   (LEDGER) what one pick found broken: the quantity in the unit the picker counted it in and in
--                       the product's base unit, the STOCK_ADJUSTMENT reason, and the adjustment that writes it off (keyed to its business document: ADR-0011; posted
--                       at once, or waiting for its approval). One per pick (uq_pick_breakage_pick); insert-only.
-- Data category: INTERNAL (stock quantities; no personal data).
-- Rollback: tested (`pnpm db:rollback`), safe before the first breakage; afterwards forward fix only (the adjustments stay).

-- migrate:up
CREATE TABLE ord.pick_breakage (
  id                   uuid PRIMARY KEY,
  fulfilment_line_id   uuid NOT NULL CONSTRAINT fk_pick_breakage_pick REFERENCES ord.fulfilment_line (id) ON DELETE RESTRICT
                         CONSTRAINT uq_pick_breakage_pick UNIQUE,
  fulfilment_id        uuid NOT NULL CONSTRAINT fk_pick_breakage_fulfilment REFERENCES ord.fulfilment (id) ON DELETE RESTRICT,
  sales_order_line_id  uuid NOT NULL CONSTRAINT fk_pick_breakage_order_line REFERENCES ord.sales_order_line (id) ON DELETE RESTRICT,
  stock_unit_id        uuid NULL CONSTRAINT fk_pick_breakage_stock_unit REFERENCES inv.stock_unit (id) ON DELETE RESTRICT,
  qty                  platform.qty NOT NULL CONSTRAINT ck_pick_breakage_qty CHECK (qty > 0),
  uom                  text NOT NULL CONSTRAINT ck_pick_breakage_uom CHECK (length(btrim(uom)) BETWEEN 1 AND 20),
  qty_base             platform.qty NOT NULL CONSTRAINT ck_pick_breakage_qty_base CHECK (qty_base > 0),
  reason_code          text NOT NULL CONSTRAINT ck_pick_breakage_reason CHECK (length(btrim(reason_code)) BETWEEN 1 AND 40),
  stock_adjustment_id  uuid NOT NULL CONSTRAINT fk_pick_breakage_adjustment REFERENCES platform.business_document (id) ON DELETE RESTRICT
                         CONSTRAINT uq_pick_breakage_adjustment UNIQUE,
  branch_id            uuid NOT NULL CONSTRAINT fk_pick_breakage_branch REFERENCES mdm.branch (id) ON DELETE RESTRICT,
  recorded_at          timestamptz NOT NULL DEFAULT now(),
  actor_id             uuid NOT NULL CONSTRAINT fk_pick_breakage_actor REFERENCES iam.principal (id) ON DELETE RESTRICT
);
COMMENT ON TABLE ord.pick_breakage IS 'class=LEDGER';
CREATE INDEX ix_pick_breakage_fulfilment ON ord.pick_breakage (fulfilment_id);
CREATE TRIGGER trg_pick_breakage_immutable BEFORE UPDATE OR DELETE ON ord.pick_breakage
  FOR EACH ROW EXECUTE FUNCTION platform.reject_change();
CREATE TRIGGER trg_pick_breakage_no_truncate BEFORE TRUNCATE ON ord.pick_breakage
  FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_change();
REVOKE ALL ON ord.pick_breakage FROM PUBLIC;
GRANT SELECT, INSERT ON ord.pick_breakage TO hk_app, hk_worker;
GRANT SELECT ON ord.pick_breakage TO hk_report;

-- migrate:down
DROP TABLE ord.pick_breakage;
