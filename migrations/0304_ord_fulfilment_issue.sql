-- 0304_ord_fulfilment_issue
-- B11 continued (FR-ORD-011, FR-DEL-005, FR-DEL-008, ADR-0091, A-337): a delivered pick's sale issue. At dispatch a pick
-- is given its movement once (`ord.fulfilment_line.stock_movement_id`, 0294): onto the vehicle for a delivery, to the
-- customer for a collection. A delivered pick's second movement, the sale issue from the vehicle to the customer when the
-- proof is recorded, is written here, once per pick:
--   ord.fulfilment_issue   LEDGER, insert-only: the pick (unique) and the sale issue (unique).
-- Data category: CONFIDENTIAL (DC-22).
-- Rollback: tested (`pnpm db:rollback`), safe before the first delivery; afterwards forward fix only.

-- migrate:up
CREATE TABLE ord.fulfilment_issue (
  fulfilment_line_id uuid PRIMARY KEY CONSTRAINT fk_fulfilment_issue_pick REFERENCES ord.fulfilment_line (id) ON DELETE RESTRICT,
  stock_movement_id  uuid NOT NULL CONSTRAINT fk_fulfilment_issue_movement REFERENCES inv.stock_movement (id) ON DELETE RESTRICT
                       CONSTRAINT uq_fulfilment_issue_movement UNIQUE,
  recorded_at        timestamptz NOT NULL DEFAULT now(),
  created_by         uuid NOT NULL CONSTRAINT fk_fulfilment_issue_created_by REFERENCES iam.principal (id) ON DELETE RESTRICT
);
COMMENT ON TABLE ord.fulfilment_issue IS 'class=LEDGER';
CREATE TRIGGER trg_fulfilment_issue_immutable BEFORE UPDATE OR DELETE ON ord.fulfilment_issue
  FOR EACH ROW EXECUTE FUNCTION platform.reject_change();
CREATE TRIGGER trg_fulfilment_issue_no_truncate BEFORE TRUNCATE ON ord.fulfilment_issue
  FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_change();
REVOKE ALL ON ord.fulfilment_issue FROM PUBLIC;
GRANT SELECT, INSERT ON ord.fulfilment_issue TO hk_app, hk_worker;

-- migrate:down
DROP TABLE ord.fulfilment_issue;
