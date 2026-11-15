-- 0044_inv_create_stock_ledger
-- The inventory schema's ledger core (docs/data-model/inv.md, ADR-0002, ADR-0018, ADR-0019, ADR-0027): movement types,
-- stock units and their lineage, the append-only stock movement ledger, the balance and cost pool projections the
-- movement trigger writes, reservations, holds and stock exceptions, and the three published views. The stock
-- documents (goods receipts, transfers, adjustments, stock takes), reorder rules, temperature readings and balance
-- snapshots arrive with their workflows.
--
-- The database refuses every stock invariant itself, whoever writes (FR-INV-019 to FR-INV-024). A refusal by a
-- trigger is SQLSTATE HK010 with the rule as its constraint name:
--   ck_stock_movement_type     the movement breaks a rule of its movement type or its locations
--   ck_stock_serial_location   a serial unit moved from a location it is not in (sold twice, or moved twice)
--   ck_stock_unit_inactive     a movement of a unit that is sold, consumed, written off or depleted
--   ck_stock_on_hold           a movement type blocked by hold, while an unreleased hold covers occurred_at
--   ck_stock_negative          a physical location would go below zero, and type and location do not both allow it
--   ck_stock_reserved          an outbound movement would take on-hand below what is reserved
--   ck_stock_reservation_use   a movement names a reservation that is not its own active one
--   ck_stock_reversal          a reversal that is not the exact opposite of an unreversed original
--   ck_stock_reversal_value    the cost pool no longer holds the value the reversed movement carried
--   ck_stock_reservation       a reservation above what is available, or of a unit that cannot be promised
--   ck_stock_unit_change       a stock unit column only the movement trigger writes was changed
--   ck_stock_hold_change       a hold changed other than by one release with a reason (never a WITHDRAWAL hold)
--   ck_stock_reservation_change, ck_stock_exception_change   the same for reservations and exceptions
-- The trigger functions are SECURITY DEFINER owned by hk_owner with a fixed search_path; hk_app cannot write the
-- projections. They take two lower-layer facts by primary key, as ADR-0002 decides, through the functions master data
-- publishes for it (0043, ADR-0047), never by reading its tables: what a location is, and how a product is tracked.
-- Data category: INTERNAL (DC-13): quantities, values and locations; no personal data.
-- Rollback: tested (`pnpm db:rollback`), safe before the first movement; afterwards forward fix only (the ledger is
-- never rewritten).

-- migrate:up
CREATE SCHEMA inv AUTHORIZATION hk_owner;
REVOKE ALL ON SCHEMA inv FROM PUBLIC;
GRANT USAGE ON SCHEMA inv TO hk_app, hk_worker, hk_report;

-- Behaviour of each kind of movement. Changed only by migration.
CREATE TABLE inv.movement_type (
  code                text PRIMARY KEY CONSTRAINT ck_movement_type_code CHECK (code ~ '^[A-Z][A-Z_]{2,39}$'),
  name                text NOT NULL,
  is_value_only       boolean NOT NULL,
  allows_negative     boolean NOT NULL,
  blocked_by_hold     boolean NOT NULL,
  requires_reason     boolean NOT NULL,
  requires_stock_unit boolean NOT NULL,
  posting_event       text NULL CONSTRAINT ck_movement_type_posting_event CHECK (posting_event ~ '^inv\.[A-Z][A-Za-z]+$')
);
COMMENT ON TABLE inv.movement_type IS 'class=LOOKUP';

INSERT INTO inv.movement_type (code, name, is_value_only, allows_negative, blocked_by_hold, requires_reason, requires_stock_unit, posting_event) VALUES
  ('RECEIPT_PURCHASE', 'Receipt from a supplier', false, false, false, false, false, 'inv.GoodsReceived'),
  ('RECEIPT_HARVEST', 'Receipt from harvest or lay', false, false, false, false, false, 'inv.ProductionReceived'),
  ('BIRTH', 'Birth, at nil cost', false, false, false, false, true, NULL),
  ('OPENING_BALANCE', 'Opening balance', false, false, false, false, false, 'inv.OpeningStockLoaded'),
  ('TRANSFER_INTERNAL', 'Move between locations of a branch', false, false, false, false, false, NULL),
  ('TRANSFER_DISPATCH', 'Transfer dispatched to in-transit', false, false, true, false, false, NULL),
  ('TRANSFER_RECEIPT', 'Transfer received from in-transit', false, false, false, false, false, NULL),
  ('SALE_ISSUE', 'Issue for a sale', false, false, true, false, false, 'inv.StockIssuedForSale'),
  ('SALE_ISSUE_OFFLINE', 'Issue for a sale made offline', false, true, true, false, false, 'inv.StockIssuedForSale'),
  ('SALE_RETURN', 'Return from a customer', false, false, false, true, false, 'inv.SaleReturnReceived'),
  ('PROCESS_CONSUME', 'Consumed by processing', false, false, true, false, true, 'inv.StockConsumedInProcessing'),
  ('PROCESS_OUTPUT', 'Output of processing', false, false, false, false, true, 'inv.ProcessingOutputReceived'),
  ('FEED_ISSUE', 'Feed issued to a pen', false, false, false, false, false, NULL),
  ('MEDICATION_ISSUE', 'Medication issued for treatment', false, false, false, false, false, NULL),
  ('COST_CAPITALISE', 'Cost added to a stock unit', true, false, false, false, true, 'inv.CostCapitalised'),
  ('MORTALITY', 'Death', false, false, false, true, true, 'inv.StockWrittenOff'),
  ('CULL', 'Cull', false, false, false, true, true, 'inv.StockWrittenOff'),
  ('ADJUST_GAIN', 'Adjustment gain', false, false, false, true, false, 'inv.StockGainRecorded'),
  ('ADJUST_LOSS', 'Adjustment loss', false, false, false, true, false, 'inv.StockWrittenOff'),
  ('STOCKTAKE_GAIN', 'Stock take gain', false, false, false, true, false, 'inv.StockGainRecorded'),
  ('STOCKTAKE_LOSS', 'Stock take loss', false, false, false, true, false, 'inv.StockWrittenOff'),
  ('SUPPLIER_RETURN', 'Return to a supplier', false, false, false, true, false, 'inv.SupplierReturnIssued');

-- One individually tracked thing: an animal (SERIAL) or a lot (LOT).
CREATE TABLE inv.stock_unit (
  id                  uuid PRIMARY KEY,
  product_id          uuid NOT NULL CONSTRAINT fk_stock_unit_product REFERENCES mdm.product (id) ON DELETE RESTRICT,
  tracking            text NOT NULL CONSTRAINT ck_stock_unit_tracking CHECK (tracking IN ('SERIAL', 'LOT')),
  branch_id           uuid NOT NULL CONSTRAINT fk_stock_unit_branch REFERENCES mdm.branch (id) ON DELETE RESTRICT,
  identifier          text NOT NULL CONSTRAINT ck_stock_unit_identifier CHECK (identifier ~ '^[A-Za-z0-9][A-Za-z0-9/_-]{0,39}$'),
  current_location_id uuid NULL CONSTRAINT fk_stock_unit_current_location REFERENCES mdm.location (id) ON DELETE RESTRICT,
  status              text NOT NULL CONSTRAINT ck_stock_unit_status CHECK (status IN ('ACTIVE', 'SOLD', 'CONSUMED', 'WRITTEN_OFF', 'DEPLETED')),
  produced_on         date NULL,
  expires_on          date NULL,
  storage_temp_class  text NULL CONSTRAINT ck_stock_unit_temp_class CHECK (storage_temp_class IN ('AMBIENT', 'CHILLED', 'FROZEN')),
  supplier_id         uuid NULL CONSTRAINT fk_stock_unit_supplier REFERENCES mdm.supplier (id) ON DELETE RESTRICT,
  source_document_id  uuid NOT NULL CONSTRAINT fk_stock_unit_source_document REFERENCES platform.business_document (id) ON DELETE RESTRICT,
  grade_id            uuid NULL CONSTRAINT fk_stock_unit_grade REFERENCES mdm.grade (id) ON DELETE RESTRICT,
  last_weight_kg      platform.kg NULL,
  last_weighed_at     timestamptz NULL,
  version             integer NOT NULL DEFAULT 1,
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid NOT NULL CONSTRAINT fk_stock_unit_created_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  updated_by          uuid NOT NULL CONSTRAINT fk_stock_unit_updated_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  deleted_at          timestamptz NULL,
  deleted_by          uuid NULL CONSTRAINT fk_stock_unit_deleted_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  delete_reason       text NULL,
  -- FR-INV-005: a lot cannot expire before it was produced.
  CONSTRAINT ck_stock_unit_dates CHECK (expires_on IS NULL OR produced_on IS NULL OR expires_on >= produced_on),
  CONSTRAINT ck_stock_unit_lot_location CHECK (tracking = 'SERIAL' OR current_location_id IS NULL),
  CONSTRAINT ck_stock_unit_weighed CHECK ((last_weight_kg IS NULL) = (last_weighed_at IS NULL)),
  CONSTRAINT ck_stock_unit_soft_delete CHECK ((deleted_at IS NULL) = (deleted_by IS NULL) AND (deleted_at IS NULL) = (delete_reason IS NULL))
);
COMMENT ON TABLE inv.stock_unit IS 'class=MASTER';
CREATE UNIQUE INDEX uq_stock_unit_identifier ON inv.stock_unit (product_id, identifier) WHERE status = 'ACTIVE' AND deleted_at IS NULL;
CREATE INDEX ix_stock_unit_location ON inv.stock_unit (current_location_id) WHERE current_location_id IS NOT NULL;
CREATE INDEX ix_stock_unit_supplier ON inv.stock_unit (supplier_id) WHERE supplier_id IS NOT NULL;
CREATE TRIGGER trg_stock_unit_version BEFORE UPDATE ON inv.stock_unit
  FOR EACH ROW EXECUTE FUNCTION platform.touch_version();

-- A new unit is ACTIVE, has no location until its first movement, and tracks as its product does. Only the movement
-- trigger (running as hk_owner) changes the location and status; anyone else may change only the four columns the
-- data model names, and may archive a unit only before its first movement.
CREATE FUNCTION inv.stock_unit_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  product_tracking text;
  editable text[] := ARRAY['grade_id', 'last_weight_kg', 'last_weighed_at', 'expires_on', 'version', 'updated_at', 'updated_by'];
BEGIN
  IF TG_OP = 'INSERT' THEN
    product_tracking := mdm.product_tracking(NEW.product_id);
    IF product_tracking IS DISTINCT FROM NEW.tracking OR NEW.status <> 'ACTIVE' OR NEW.current_location_id IS NOT NULL THEN
      RAISE EXCEPTION 'inv.stock_unit %: a new unit is ACTIVE, has no location yet, and tracks as product % does (%)', NEW.id, NEW.product_id, product_tracking
        USING ERRCODE = 'HK010', CONSTRAINT = 'ck_stock_unit_change';
    END IF;
    RETURN NEW;
  END IF;
  IF current_user = 'hk_owner' THEN
    RETURN NEW;
  END IF;
  IF NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL THEN
    IF EXISTS (SELECT 1 FROM inv.stock_movement m WHERE m.stock_unit_id = OLD.id) THEN
      RAISE EXCEPTION 'inv.stock_unit %: a unit with movements is never archived', OLD.id USING ERRCODE = 'HK010', CONSTRAINT = 'ck_stock_unit_change';
    END IF;
    editable := editable || ARRAY['deleted_at', 'deleted_by', 'delete_reason'];
  END IF;
  IF (to_jsonb(NEW) - editable) IS DISTINCT FROM (to_jsonb(OLD) - editable) THEN
    RAISE EXCEPTION 'inv.stock_unit %: only the grade, the last weight and the expiry date may be changed by hand', OLD.id
      USING ERRCODE = 'HK010', CONSTRAINT = 'ck_stock_unit_change';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION inv.stock_unit_guard() FROM PUBLIC;

-- Genealogy: which unit came from which (FR-INV-006).
CREATE TABLE inv.stock_unit_lineage (
  child_unit_id      uuid NOT NULL CONSTRAINT fk_stock_unit_lineage_child REFERENCES inv.stock_unit (id) ON DELETE RESTRICT,
  parent_unit_id     uuid NOT NULL CONSTRAINT fk_stock_unit_lineage_parent REFERENCES inv.stock_unit (id) ON DELETE RESTRICT,
  link_type          text NOT NULL CONSTRAINT ck_stock_unit_lineage_link CHECK (link_type IN ('PROCESSING', 'SPLIT', 'REPACK', 'BIRTH')),
  source_document_id uuid NOT NULL CONSTRAINT fk_stock_unit_lineage_source_document REFERENCES platform.business_document (id) ON DELETE RESTRICT,
  recorded_at        timestamptz NOT NULL DEFAULT now(),
  actor_id           uuid NOT NULL CONSTRAINT fk_stock_unit_lineage_actor REFERENCES iam.principal (id) ON DELETE RESTRICT,
  CONSTRAINT pk_stock_unit_lineage PRIMARY KEY (child_unit_id, parent_unit_id),
  CONSTRAINT ck_stock_unit_lineage_self CHECK (child_unit_id <> parent_unit_id)
);
COMMENT ON TABLE inv.stock_unit_lineage IS 'class=LEDGER';
CREATE INDEX ix_stock_unit_lineage_parent ON inv.stock_unit_lineage (parent_unit_id);
CREATE TRIGGER trg_stock_unit_lineage_immutable BEFORE UPDATE OR DELETE ON inv.stock_unit_lineage
  FOR EACH ROW EXECUTE FUNCTION platform.reject_change();
CREATE TRIGGER trg_stock_unit_lineage_no_truncate BEFORE TRUNCATE ON inv.stock_unit_lineage
  FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_change();

-- Stock promised to a document (ADR-0019).
CREATE TABLE inv.stock_reservation (
  id                 uuid PRIMARY KEY,
  product_id         uuid NOT NULL CONSTRAINT fk_stock_reservation_product REFERENCES mdm.product (id) ON DELETE RESTRICT,
  stock_unit_id      uuid NULL CONSTRAINT fk_stock_reservation_unit REFERENCES inv.stock_unit (id) ON DELETE RESTRICT,
  location_id        uuid NOT NULL CONSTRAINT fk_stock_reservation_location REFERENCES mdm.location (id) ON DELETE RESTRICT,
  qty                platform.qty NOT NULL CONSTRAINT ck_stock_reservation_qty CHECK (qty > 0),
  is_exclusive       boolean NOT NULL,
  holder_document_id uuid NOT NULL CONSTRAINT fk_stock_reservation_holder REFERENCES platform.business_document (id) ON DELETE RESTRICT,
  status             text NOT NULL CONSTRAINT ck_stock_reservation_status CHECK (status IN ('ACTIVE', 'CONSUMED', 'RELEASED', 'EXPIRED')),
  expires_at         timestamptz NULL,
  released_reason    text NULL CONSTRAINT ck_stock_reservation_released_reason CHECK (length(btrim(released_reason)) BETWEEN 1 AND 200),
  branch_id          uuid NOT NULL CONSTRAINT fk_stock_reservation_branch REFERENCES mdm.branch (id) ON DELETE RESTRICT,
  version            integer NOT NULL DEFAULT 1,
  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid NOT NULL CONSTRAINT fk_stock_reservation_created_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  updated_by         uuid NOT NULL CONSTRAINT fk_stock_reservation_updated_by REFERENCES iam.principal (id) ON DELETE RESTRICT
);
COMMENT ON TABLE inv.stock_reservation IS 'class=DOCUMENT';
-- One goat cannot be promised twice.
CREATE UNIQUE INDEX uq_stock_reservation_exclusive ON inv.stock_reservation (stock_unit_id) WHERE status = 'ACTIVE' AND is_exclusive;
CREATE INDEX ix_stock_reservation_expiry ON inv.stock_reservation (expires_at) WHERE status = 'ACTIVE';
CREATE INDEX ix_stock_reservation_holder ON inv.stock_reservation (holder_document_id);
CREATE TRIGGER trg_stock_reservation_version BEFORE UPDATE ON inv.stock_reservation
  FOR EACH ROW EXECUTE FUNCTION platform.touch_version();

-- A block on moving a stock unit out (ADR-0019).
CREATE TABLE inv.stock_hold (
  id                  uuid PRIMARY KEY,
  stock_unit_id       uuid NOT NULL CONSTRAINT fk_stock_hold_unit REFERENCES inv.stock_unit (id) ON DELETE RESTRICT,
  kind                text NOT NULL CONSTRAINT ck_stock_hold_kind CHECK (kind IN ('WITHDRAWAL', 'QUARANTINE', 'INVESTIGATION')),
  starts_at           timestamptz NOT NULL,
  ends_at             timestamptz NULL,
  source_document_id  uuid NOT NULL CONSTRAINT fk_stock_hold_source_document REFERENCES platform.business_document (id) ON DELETE RESTRICT,
  released_at         timestamptz NULL,
  released_by         uuid NULL CONSTRAINT fk_stock_hold_released_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  release_reason_code text NULL CONSTRAINT fk_stock_hold_release_reason REFERENCES mdm.reason_code (code) ON DELETE RESTRICT,
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid NOT NULL CONSTRAINT fk_stock_hold_created_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  CONSTRAINT ck_stock_hold_window CHECK (ends_at IS NULL OR ends_at > starts_at),
  CONSTRAINT ck_stock_hold_release CHECK ((released_at IS NULL) = (released_by IS NULL) AND (released_at IS NULL) = (release_reason_code IS NULL))
);
COMMENT ON TABLE inv.stock_hold IS 'class=DOCUMENT';
CREATE INDEX ix_stock_hold_unit ON inv.stock_hold (stock_unit_id) WHERE released_at IS NULL;

-- The stock ledger (FR-INV-001, FR-INV-002).
CREATE TABLE inv.stock_movement (
  id                   uuid PRIMARY KEY,
  movement_type        text NOT NULL CONSTRAINT fk_stock_movement_type REFERENCES inv.movement_type (code) ON DELETE RESTRICT,
  product_id           uuid NOT NULL CONSTRAINT fk_stock_movement_product REFERENCES mdm.product (id) ON DELETE RESTRICT,
  stock_unit_id        uuid NULL CONSTRAINT fk_stock_movement_unit REFERENCES inv.stock_unit (id) ON DELETE RESTRICT,
  branch_id            uuid NOT NULL CONSTRAINT fk_stock_movement_branch REFERENCES mdm.branch (id) ON DELETE RESTRICT,
  from_location_id     uuid NOT NULL CONSTRAINT fk_stock_movement_from REFERENCES mdm.location (id) ON DELETE RESTRICT,
  to_location_id       uuid NOT NULL CONSTRAINT fk_stock_movement_to REFERENCES mdm.location (id) ON DELETE RESTRICT,
  qty_base             platform.qty NOT NULL,
  weight_kg            platform.kg NULL,
  weight_source        text NULL CONSTRAINT ck_stock_movement_weight_source CHECK (weight_source IN ('SCALE', 'MANUAL', 'ESTIMATE')),
  pack_count           integer NULL CONSTRAINT ck_stock_movement_pack_count CHECK (pack_count >= 0),
  value_pesewas        platform.pesewas NOT NULL,
  cost_element         text NULL CONSTRAINT ck_stock_movement_cost_element CHECK (cost_element IN ('PURCHASE', 'FEED', 'VETERINARY', 'LABOUR', 'OVERHEAD', 'PROCESSING')),
  reason_code          text NULL CONSTRAINT fk_stock_movement_reason REFERENCES mdm.reason_code (code) ON DELETE RESTRICT,
  source_document_id   uuid NOT NULL CONSTRAINT fk_stock_movement_source_document REFERENCES platform.business_document (id) ON DELETE RESTRICT,
  source_line_ref      uuid NULL,
  reservation_id       uuid NULL CONSTRAINT fk_stock_movement_reservation REFERENCES inv.stock_reservation (id) ON DELETE RESTRICT,
  reverses_movement_id uuid NULL CONSTRAINT uq_stock_movement_reverses UNIQUE
                         CONSTRAINT fk_stock_movement_reverses REFERENCES inv.stock_movement (id) ON DELETE RESTRICT,
  occurred_at          timestamptz NOT NULL,
  recorded_at          timestamptz NOT NULL DEFAULT now(),
  actor_id             uuid NOT NULL CONSTRAINT fk_stock_movement_actor REFERENCES iam.principal (id) ON DELETE RESTRICT,
  CONSTRAINT ck_stock_movement_locations CHECK (from_location_id <> to_location_id),
  CONSTRAINT ck_stock_movement_weight CHECK ((weight_kg IS NULL) = (weight_source IS NULL)),
  CONSTRAINT ck_stock_movement_moves CHECK (qty_base > 0 OR value_pesewas > 0)
);
COMMENT ON TABLE inv.stock_movement IS 'class=LEDGER';
CREATE INDEX ix_stock_movement_product ON inv.stock_movement (product_id, occurred_at);
CREATE INDEX ix_stock_movement_unit ON inv.stock_movement (stock_unit_id, occurred_at) WHERE stock_unit_id IS NOT NULL;
CREATE INDEX ix_stock_movement_document ON inv.stock_movement (source_document_id);
CREATE INDEX ix_stock_movement_to ON inv.stock_movement (to_location_id, product_id);
CREATE INDEX ix_stock_movement_from ON inv.stock_movement (from_location_id, product_id);
CREATE TRIGGER trg_stock_movement_immutable BEFORE UPDATE OR DELETE ON inv.stock_movement
  FOR EACH ROW EXECUTE FUNCTION platform.reject_change();
CREATE TRIGGER trg_stock_movement_no_truncate BEFORE TRUNCATE ON inv.stock_movement
  FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_change();

-- On-hand per product, stock unit and location. Written only by triggers. Signed; virtual locations go negative.
CREATE TABLE inv.stock_balance (
  product_id        uuid NOT NULL CONSTRAINT fk_stock_balance_product REFERENCES mdm.product (id) ON DELETE RESTRICT,
  stock_unit_id     uuid NULL CONSTRAINT fk_stock_balance_unit REFERENCES inv.stock_unit (id) ON DELETE RESTRICT,
  location_id       uuid NOT NULL CONSTRAINT fk_stock_balance_location REFERENCES mdm.location (id) ON DELETE RESTRICT,
  branch_id         uuid NOT NULL CONSTRAINT fk_stock_balance_branch REFERENCES mdm.branch (id) ON DELETE RESTRICT,
  on_hand_qty       numeric(14,3) NOT NULL,
  on_hand_weight_kg numeric(12,3) NOT NULL DEFAULT 0,
  pack_count        integer NOT NULL DEFAULT 0,
  reserved_qty      platform.qty NOT NULL DEFAULT 0,
  updated_at        timestamptz NOT NULL,
  CONSTRAINT uq_stock_balance UNIQUE NULLS NOT DISTINCT (product_id, stock_unit_id, location_id)
);
COMMENT ON TABLE inv.stock_balance IS 'class=PROJECTION';
CREATE INDEX ix_stock_balance_unit ON inv.stock_balance (stock_unit_id) WHERE stock_unit_id IS NOT NULL;
CREATE INDEX ix_stock_balance_location ON inv.stock_balance (location_id, product_id);

-- Value of stock (ADR-0018): per stock unit, or per untracked product and branch. Written only by the trigger.
CREATE TABLE inv.cost_pool (
  product_id    uuid NOT NULL CONSTRAINT fk_cost_pool_product REFERENCES mdm.product (id) ON DELETE RESTRICT,
  stock_unit_id uuid NULL CONSTRAINT fk_cost_pool_unit REFERENCES inv.stock_unit (id) ON DELETE RESTRICT,
  branch_id     uuid NOT NULL CONSTRAINT fk_cost_pool_branch REFERENCES mdm.branch (id) ON DELETE RESTRICT,
  qty           numeric(14,3) NOT NULL,
  value_pesewas platform.pesewas NOT NULL,
  updated_at    timestamptz NOT NULL,
  CONSTRAINT uq_cost_pool UNIQUE NULLS NOT DISTINCT (product_id, stock_unit_id, branch_id),
  -- A pool with no quantity has no value.
  CONSTRAINT ck_cost_pool_empty CHECK (qty <> 0 OR value_pesewas = 0)
);
COMMENT ON TABLE inv.cost_pool IS 'class=PROJECTION';

-- A stock fact that needs a person (FR-INV-023, ADR-0027).
CREATE TABLE inv.stock_exception (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind                   text NOT NULL CONSTRAINT ck_stock_exception_kind CHECK (kind IN (
                           'NEGATIVE_STOCK', 'SERIAL_CONFLICT', 'HOLD_CONFLICT', 'RESERVATION_CONFLICT', 'TEMPERATURE_EXCURSION', 'BALANCE_DRIFT', 'TRANSFER_VARIANCE')),
  branch_id              uuid NOT NULL CONSTRAINT fk_stock_exception_branch REFERENCES mdm.branch (id) ON DELETE RESTRICT,
  product_id             uuid NOT NULL CONSTRAINT fk_stock_exception_product REFERENCES mdm.product (id) ON DELETE RESTRICT,
  stock_unit_id          uuid NULL CONSTRAINT fk_stock_exception_unit REFERENCES inv.stock_unit (id) ON DELETE RESTRICT,
  location_id            uuid NULL CONSTRAINT fk_stock_exception_location REFERENCES mdm.location (id) ON DELETE RESTRICT,
  movement_id            uuid NULL CONSTRAINT fk_stock_exception_movement REFERENCES inv.stock_movement (id) ON DELETE RESTRICT,
  source_document_id     uuid NULL CONSTRAINT fk_stock_exception_source_document REFERENCES platform.business_document (id) ON DELETE RESTRICT,
  qty                    numeric(14,3) NULL,
  details                jsonb NOT NULL,
  raised_at              timestamptz NOT NULL DEFAULT now(),
  status                 text NOT NULL DEFAULT 'OPEN' CONSTRAINT ck_stock_exception_status CHECK (status IN ('OPEN', 'RESOLVED')),
  resolved_at            timestamptz NULL,
  resolved_by            uuid NULL CONSTRAINT fk_stock_exception_resolved_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  resolution_document_id uuid NULL CONSTRAINT fk_stock_exception_resolution_document REFERENCES platform.business_document (id) ON DELETE RESTRICT,
  resolution_note        text NULL CONSTRAINT ck_stock_exception_note CHECK (length(btrim(resolution_note)) BETWEEN 1 AND 1000),
  CONSTRAINT ck_stock_exception_resolved CHECK ((status = 'RESOLVED') = (resolved_at IS NOT NULL)
                                                AND (resolved_at IS NULL) = (resolved_by IS NULL)
                                                AND (resolved_at IS NULL) = (resolution_note IS NULL))
);
COMMENT ON TABLE inv.stock_exception IS 'class=DOCUMENT';
CREATE INDEX ix_stock_exception_open ON inv.stock_exception (branch_id, raised_at) WHERE status = 'OPEN';
CREATE INDEX ix_stock_exception_movement ON inv.stock_exception (movement_id) WHERE movement_id IS NOT NULL;

-- Raise one rule refusal (HK010).
CREATE FUNCTION inv.refuse(rule text, message text) RETURNS void
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION '%', message USING ERRCODE = 'HK010', CONSTRAINT = rule;
END
$$;
REVOKE ALL ON FUNCTION inv.refuse(text, text) FROM PUBLIC;
-- The guards that run as the caller raise through it too.
GRANT EXECUTE ON FUNCTION inv.refuse(text, text) TO hk_app, hk_worker;

-- BEFORE INSERT on a movement: lock the unit, check the movement type, the locations, the serial unit's location, holds
-- and the reversal; then set the value of anything leaving a physical location from its cost pool (ADR-0018). A
-- reversal carries the value of the movement it reverses. Every lock is a point lock: the unit row, then the pool row.
CREATE FUNCTION inv.check_movement() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
DECLARE
  mt inv.movement_type;
  unit inv.stock_unit;
  original inv.stock_movement;
  from_virtual boolean;
  to_virtual boolean;
  from_branch uuid;
  to_branch uuid;
  product_tracking text;
  pool_qty numeric;
  pool_value bigint;
  q bigint;
  big_q bigint;
BEGIN
  SELECT * INTO mt FROM inv.movement_type t WHERE t.code = NEW.movement_type;
  SELECT f.is_virtual, f.branch_id INTO from_virtual, from_branch FROM mdm.location_stock_facts(NEW.from_location_id) f;
  SELECT f.is_virtual, f.branch_id INTO to_virtual, to_branch FROM mdm.location_stock_facts(NEW.to_location_id) f;
  product_tracking := mdm.product_tracking(NEW.product_id);

  IF from_virtual AND to_virtual THEN
    PERFORM inv.refuse('ck_stock_movement_type', format('a %s movement must start or end at a physical location', NEW.movement_type));
  END IF;
  IF NEW.branch_id <> (CASE WHEN from_virtual THEN to_branch ELSE from_branch END) THEN
    PERFORM inv.refuse('ck_stock_movement_type', format('the movement''s branch %s is not the branch of its physical source', NEW.branch_id));
  END IF;
  IF mt.is_value_only <> (NEW.qty_base = 0) THEN
    PERFORM inv.refuse('ck_stock_movement_type', format('%s moves %s quantity', NEW.movement_type, CASE WHEN mt.is_value_only THEN 'no' ELSE 'a positive' END));
  END IF;
  IF mt.requires_reason AND NEW.reason_code IS NULL THEN
    PERFORM inv.refuse('ck_stock_movement_type', format('%s needs a reason code', NEW.movement_type));
  END IF;
  IF (mt.requires_stock_unit OR product_tracking <> 'NONE') AND NEW.stock_unit_id IS NULL THEN
    PERFORM inv.refuse('ck_stock_movement_type', format('%s of product %s needs its stock unit', NEW.movement_type, NEW.product_id));
  END IF;
  IF product_tracking = 'NONE' AND NEW.stock_unit_id IS NOT NULL THEN
    PERFORM inv.refuse('ck_stock_movement_type', format('product %s is not tracked by unit', NEW.product_id));
  END IF;
  IF mt.is_value_only AND (NEW.cost_element IS NULL OR to_virtual) THEN
    PERFORM inv.refuse('ck_stock_movement_type', 'a value-only movement names its cost element and ends where the unit is');
  END IF;

  IF NEW.stock_unit_id IS NOT NULL THEN
    SELECT * INTO unit FROM inv.stock_unit u WHERE u.id = NEW.stock_unit_id FOR UPDATE;
    IF unit.product_id <> NEW.product_id THEN
      PERFORM inv.refuse('ck_stock_movement_type', format('stock unit %s is not of product %s', unit.identifier, NEW.product_id));
    END IF;
    IF unit.tracking = 'SERIAL' THEN
      IF NEW.qty_base NOT IN (0, 1) THEN
        PERFORM inv.refuse('ck_stock_movement_type', format('serial unit %s moves one at a time', unit.identifier));
      END IF;
      IF mt.is_value_only THEN
        IF NEW.to_location_id IS DISTINCT FROM unit.current_location_id THEN
          PERFORM inv.refuse('ck_stock_serial_location', format('%s is not at the location the cost is added to', unit.identifier));
        END IF;
      ELSIF unit.current_location_id IS NULL THEN
        IF NOT from_virtual THEN
          PERFORM inv.refuse('ck_stock_serial_location', format('%s has not been received yet', unit.identifier));
        END IF;
      ELSIF NEW.from_location_id <> unit.current_location_id THEN
        PERFORM inv.refuse('ck_stock_serial_location', format('%s is not at the location the movement starts from', unit.identifier));
      END IF;
    END IF;
    IF unit.status <> 'ACTIVE' AND NOT from_virtual THEN
      PERFORM inv.refuse('ck_stock_unit_inactive', format('%s is %s', unit.identifier, unit.status));
    END IF;
    IF mt.is_value_only AND unit.status <> 'ACTIVE' THEN
      PERFORM inv.refuse('ck_stock_unit_inactive', format('%s is %s', unit.identifier, unit.status));
    END IF;
    IF mt.blocked_by_hold AND NOT from_virtual AND EXISTS (
      SELECT 1 FROM inv.stock_hold h
       WHERE h.stock_unit_id = unit.id AND h.released_at IS NULL
         AND h.starts_at <= NEW.occurred_at AND (h.ends_at IS NULL OR h.ends_at > NEW.occurred_at)
    ) THEN
      PERFORM inv.refuse('ck_stock_on_hold', format('%s is under a hold and cannot be moved by %s', unit.identifier, NEW.movement_type));
    END IF;
  END IF;

  IF NEW.reverses_movement_id IS NOT NULL THEN
    SELECT * INTO original FROM inv.stock_movement m WHERE m.id = NEW.reverses_movement_id;
    IF original.reverses_movement_id IS NOT NULL
       OR original.movement_type <> NEW.movement_type OR original.product_id <> NEW.product_id
       OR original.stock_unit_id IS DISTINCT FROM NEW.stock_unit_id
       OR original.from_location_id <> NEW.to_location_id OR original.to_location_id <> NEW.from_location_id
       OR original.qty_base <> NEW.qty_base
       OR original.weight_kg IS DISTINCT FROM NEW.weight_kg OR original.weight_source IS DISTINCT FROM NEW.weight_source
       OR original.pack_count IS DISTINCT FROM NEW.pack_count
       OR original.cost_element IS DISTINCT FROM NEW.cost_element
       OR mt.is_value_only THEN
      PERFORM inv.refuse('ck_stock_reversal', format('movement %s is not the exact opposite of movement %s', NEW.id, NEW.reverses_movement_id));
    END IF;
    NEW.value_pesewas := original.value_pesewas;
    RETURN NEW;
  END IF;

  IF from_virtual THEN
    -- A receipt, or a value-only movement: the caller's value, tagged with its cost element when it has one.
    IF NEW.value_pesewas > 0 AND NEW.cost_element IS NULL THEN
      PERFORM inv.refuse('ck_stock_movement_type', 'a receipt that carries value names its cost element');
    END IF;
    RETURN NEW;
  END IF;

  -- Leaving a physical location: the value comes from the pool, never from the caller. Issue q of Q valued V carries
  -- V when q >= Q, otherwise half_up(V x q / Q), in exact integer thousandths; nothing from a pool at or below zero.
  SELECT c.qty, c.value_pesewas INTO pool_qty, pool_value
    FROM inv.cost_pool c
   WHERE c.product_id = NEW.product_id AND c.stock_unit_id IS NOT DISTINCT FROM NEW.stock_unit_id
     AND c.branch_id = COALESCE(unit.branch_id, from_branch)
   FOR UPDATE;
  IF pool_qty IS NULL OR pool_qty <= 0 THEN
    NEW.value_pesewas := 0;
  ELSIF NEW.qty_base >= pool_qty THEN
    NEW.value_pesewas := pool_value;
  ELSE
    q := (NEW.qty_base * 1000)::bigint;
    big_q := (pool_qty * 1000)::bigint;
    NEW.value_pesewas := div(2 * pool_value::numeric * q + big_q, 2 * big_q::numeric)::bigint;
  END IF;
  IF NEW.qty_base = 0 THEN
    PERFORM inv.refuse('ck_stock_movement_type', format('a %s movement out of a physical location moves a quantity', NEW.movement_type));
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION inv.check_movement() FROM PUBLIC;

-- Add a signed delta to one balance row and return the row.
CREATE FUNCTION inv.add_to_balance(p_product uuid, p_unit uuid, p_location uuid, p_branch uuid, p_qty numeric, p_weight numeric, p_packs integer)
  RETURNS inv.stock_balance
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  result inv.stock_balance;
BEGIN
  INSERT INTO inv.stock_balance AS b (product_id, stock_unit_id, location_id, branch_id, on_hand_qty, on_hand_weight_kg, pack_count, updated_at)
  VALUES (p_product, p_unit, p_location, p_branch, p_qty, p_weight, p_packs, now())
  ON CONFLICT ON CONSTRAINT uq_stock_balance DO UPDATE
     SET on_hand_qty = b.on_hand_qty + EXCLUDED.on_hand_qty,
         on_hand_weight_kg = b.on_hand_weight_kg + EXCLUDED.on_hand_weight_kg,
         pack_count = b.pack_count + EXCLUDED.pack_count,
         updated_at = now()
  RETURNING * INTO result;
  RETURN result;
END
$$;
REVOKE ALL ON FUNCTION inv.add_to_balance(uuid, uuid, uuid, uuid, numeric, numeric, integer) FROM PUBLIC;

-- Add a signed quantity and value to one cost pool.
CREATE FUNCTION inv.add_to_pool(p_product uuid, p_unit uuid, p_branch uuid, p_qty numeric, p_value bigint, p_movement uuid)
  RETURNS void
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  current_value bigint;
BEGIN
  SELECT c.value_pesewas INTO current_value FROM inv.cost_pool c
   WHERE c.product_id = p_product AND c.stock_unit_id IS NOT DISTINCT FROM p_unit AND c.branch_id = p_branch FOR UPDATE;
  IF COALESCE(current_value, 0) + p_value < 0 THEN
    PERFORM inv.refuse('ck_stock_reversal_value', format('movement %s: the cost pool no longer holds the value it must give up; correct it with an adjustment', p_movement));
  END IF;
  INSERT INTO inv.cost_pool (product_id, stock_unit_id, branch_id, qty, value_pesewas, updated_at)
  VALUES (p_product, p_unit, p_branch, 0, 0, now())
  ON CONFLICT ON CONSTRAINT uq_cost_pool DO NOTHING;
  UPDATE inv.cost_pool c SET qty = c.qty + p_qty, value_pesewas = c.value_pesewas + p_value, updated_at = now()
   WHERE c.product_id = p_product AND c.stock_unit_id IS NOT DISTINCT FROM p_unit AND c.branch_id = p_branch;
EXCEPTION
  WHEN check_violation THEN
    PERFORM inv.refuse('ck_stock_reversal_value', format('movement %s would leave a cost pool with value and no quantity; correct it with an adjustment', p_movement));
END
$$;
REVOKE ALL ON FUNCTION inv.add_to_pool(uuid, uuid, uuid, numeric, bigint, uuid) FROM PUBLIC;

-- AFTER INSERT on a movement: the seven steps of ADR-0002 that write projections. Consume the movement's own
-- reservation, move the balances, refuse or record negative stock, protect reserved stock, move the serial unit and
-- set unit status, and apply the value to the cost pools.
CREATE FUNCTION inv.apply_movement() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
DECLARE
  mt inv.movement_type;
  unit inv.stock_unit;
  reservation inv.stock_reservation;
  source_balance inv.stock_balance;
  from_location record;
  to_location record;
  weight numeric := COALESCE(NEW.weight_kg, 0);
  packs integer := COALESCE(NEW.pack_count, 0);
  physical_on_hand numeric;
  source_pool_branch uuid;
  target_pool_branch uuid;
  next_status text;
BEGIN
  SELECT * INTO mt FROM inv.movement_type t WHERE t.code = NEW.movement_type;
  SELECT * INTO from_location FROM mdm.location_stock_facts(NEW.from_location_id);
  SELECT * INTO to_location FROM mdm.location_stock_facts(NEW.to_location_id);
  IF NEW.stock_unit_id IS NOT NULL THEN
    SELECT * INTO unit FROM inv.stock_unit u WHERE u.id = NEW.stock_unit_id;
  END IF;

  IF NEW.reservation_id IS NOT NULL THEN
    SELECT * INTO reservation FROM inv.stock_reservation r WHERE r.id = NEW.reservation_id FOR UPDATE;
    IF reservation.status <> 'ACTIVE' OR reservation.product_id <> NEW.product_id
       OR reservation.stock_unit_id IS DISTINCT FROM NEW.stock_unit_id OR reservation.location_id <> NEW.from_location_id THEN
      PERFORM inv.refuse('ck_stock_reservation_use', format('movement %s names reservation %s, which is not an active reservation of this stock here', NEW.id, NEW.reservation_id));
    END IF;
    UPDATE inv.stock_reservation SET status = 'CONSUMED', version = version + 1, updated_by = NEW.actor_id WHERE id = NEW.reservation_id;
  END IF;

  IF NEW.qty_base > 0 THEN
    source_balance := inv.add_to_balance(NEW.product_id, NEW.stock_unit_id, NEW.from_location_id, from_location.branch_id, -NEW.qty_base, -weight, -packs);
    PERFORM inv.add_to_balance(NEW.product_id, NEW.stock_unit_id, NEW.to_location_id, to_location.branch_id, NEW.qty_base, weight, packs);

    IF NOT from_location.is_virtual THEN
      IF source_balance.on_hand_qty < 0 THEN
        IF mt.allows_negative AND from_location.allows_negative AND unit.tracking IS DISTINCT FROM 'SERIAL' THEN
          INSERT INTO inv.stock_exception (kind, branch_id, product_id, stock_unit_id, location_id, movement_id, source_document_id, qty, details)
          VALUES ('NEGATIVE_STOCK', from_location.branch_id, NEW.product_id, NEW.stock_unit_id, NEW.from_location_id, NEW.id, NEW.source_document_id,
                  -source_balance.on_hand_qty,
                  jsonb_build_object('movementType', NEW.movement_type, 'qtyMoved', NEW.qty_base, 'onHandAfter', source_balance.on_hand_qty,
                                     'note', 'the uncovered quantity carried no cost: cost of sales is understated until this is resolved'));
        ELSE
          PERFORM inv.refuse('ck_stock_negative', format('product %s at location %s would go to %s, short by %s', NEW.product_id, from_location.code,
                                                        source_balance.on_hand_qty, -source_balance.on_hand_qty));
        END IF;
      END IF;
      IF source_balance.on_hand_qty < source_balance.reserved_qty THEN
        IF mt.allows_negative AND from_location.allows_negative AND unit.tracking IS DISTINCT FROM 'SERIAL' THEN
          INSERT INTO inv.stock_exception (kind, branch_id, product_id, stock_unit_id, location_id, movement_id, source_document_id, qty, details)
          VALUES ('RESERVATION_CONFLICT', from_location.branch_id, NEW.product_id, NEW.stock_unit_id, NEW.from_location_id, NEW.id, NEW.source_document_id,
                  source_balance.reserved_qty - source_balance.on_hand_qty,
                  jsonb_build_object('movementType', NEW.movement_type, 'onHandAfter', source_balance.on_hand_qty, 'reserved', source_balance.reserved_qty));
        ELSE
          PERFORM inv.refuse('ck_stock_reserved', format('product %s at location %s: %s would remain against %s reserved', NEW.product_id, from_location.code,
                                                        source_balance.on_hand_qty, source_balance.reserved_qty));
        END IF;
      END IF;
    END IF;

    IF unit.tracking = 'SERIAL' THEN
      next_status := CASE WHEN NOT to_location.is_virtual THEN 'ACTIVE'
                          WHEN to_location.kind = 'CUSTOMER' THEN 'SOLD'
                          WHEN to_location.kind = 'PROCESSING' THEN 'CONSUMED'
                          WHEN to_location.kind = 'LOSS' THEN 'WRITTEN_OFF'
                          ELSE 'DEPLETED' END;
      UPDATE inv.stock_unit SET current_location_id = NEW.to_location_id, status = next_status, version = version + 1, updated_by = NEW.actor_id
       WHERE id = unit.id;
    ELSIF unit.tracking = 'LOT' THEN
      SELECT COALESCE(sum(b.on_hand_qty), 0) INTO physical_on_hand
        FROM inv.stock_balance b
       WHERE b.stock_unit_id = unit.id AND NOT (SELECT f.is_virtual FROM mdm.location_stock_facts(b.location_id) f);
      next_status := CASE WHEN physical_on_hand > 0 THEN 'ACTIVE' ELSE 'DEPLETED' END;
      IF next_status <> unit.status THEN
        UPDATE inv.stock_unit SET status = next_status, version = version + 1, updated_by = NEW.actor_id WHERE id = unit.id;
      END IF;
    END IF;
  END IF;

  -- Cost pools: a tracked unit has one pool at its branch; an untracked product one per branch.
  source_pool_branch := COALESCE(unit.branch_id, from_location.branch_id);
  target_pool_branch := COALESCE(unit.branch_id, to_location.branch_id);
  IF from_location.is_virtual THEN
    PERFORM inv.add_to_pool(NEW.product_id, NEW.stock_unit_id, target_pool_branch, NEW.qty_base, NEW.value_pesewas, NEW.id);
  ELSIF to_location.is_virtual THEN
    PERFORM inv.add_to_pool(NEW.product_id, NEW.stock_unit_id, source_pool_branch, -NEW.qty_base, -NEW.value_pesewas, NEW.id);
  ELSIF source_pool_branch <> target_pool_branch THEN
    PERFORM inv.add_to_pool(NEW.product_id, NEW.stock_unit_id, source_pool_branch, -NEW.qty_base, -NEW.value_pesewas, NEW.id);
    PERFORM inv.add_to_pool(NEW.product_id, NEW.stock_unit_id, target_pool_branch, NEW.qty_base, NEW.value_pesewas, NEW.id);
  END IF;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION inv.apply_movement() FROM PUBLIC;

CREATE TRIGGER trg_stock_movement_check BEFORE INSERT ON inv.stock_movement
  FOR EACH ROW EXECUTE FUNCTION inv.check_movement();
CREATE TRIGGER trg_stock_movement_apply AFTER INSERT ON inv.stock_movement
  FOR EACH ROW EXECUTE FUNCTION inv.apply_movement();
CREATE TRIGGER trg_stock_unit_guard BEFORE INSERT OR UPDATE ON inv.stock_unit
  FOR EACH ROW EXECUTE FUNCTION inv.stock_unit_guard();

-- Reservations: a new one is ACTIVE, promises no more than is available, and a serial unit is promised exclusively,
-- whole, where it is. Status moves once from ACTIVE; nothing else changes. reserved_qty follows (ADR-0019).
CREATE FUNCTION inv.apply_reservation() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
DECLARE
  unit inv.stock_unit;
  balance inv.stock_balance;
  mutable text[] := ARRAY['status', 'released_reason', 'version', 'updated_at', 'updated_by'];
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.status <> 'ACTIVE' OR NEW.status = 'ACTIVE' OR (to_jsonb(NEW) - mutable) IS DISTINCT FROM (to_jsonb(OLD) - mutable)
       OR (NEW.status IN ('RELEASED', 'EXPIRED')) <> (NEW.released_reason IS NOT NULL) THEN
      PERFORM inv.refuse('ck_stock_reservation_change', format('reservation %s moves once from ACTIVE to CONSUMED, or to RELEASED or EXPIRED with a reason', OLD.id));
    END IF;
    UPDATE inv.stock_balance SET reserved_qty = reserved_qty - OLD.qty, updated_at = now()
     WHERE product_id = OLD.product_id AND stock_unit_id IS NOT DISTINCT FROM OLD.stock_unit_id AND location_id = OLD.location_id;
    RETURN NEW;
  END IF;

  IF NEW.status <> 'ACTIVE' OR NEW.released_reason IS NOT NULL THEN
    PERFORM inv.refuse('ck_stock_reservation', format('reservation %s starts ACTIVE', NEW.id));
  END IF;
  IF NEW.stock_unit_id IS NOT NULL THEN
    SELECT * INTO unit FROM inv.stock_unit u WHERE u.id = NEW.stock_unit_id FOR UPDATE;
    IF unit.product_id <> NEW.product_id OR unit.status <> 'ACTIVE' THEN
      PERFORM inv.refuse('ck_stock_reservation', format('stock unit %s cannot be promised', unit.identifier));
    END IF;
    IF unit.tracking = 'SERIAL' AND (NOT NEW.is_exclusive OR NEW.qty <> 1 OR unit.current_location_id IS DISTINCT FROM NEW.location_id) THEN
      PERFORM inv.refuse('ck_stock_reservation', format('%s is promised whole and exclusively, where it is', unit.identifier));
    END IF;
  END IF;
  SELECT * INTO balance FROM inv.stock_balance b
   WHERE b.product_id = NEW.product_id AND b.stock_unit_id IS NOT DISTINCT FROM NEW.stock_unit_id AND b.location_id = NEW.location_id
   FOR UPDATE;
  IF balance.product_id IS NULL OR balance.on_hand_qty - balance.reserved_qty < NEW.qty THEN
    PERFORM inv.refuse('ck_stock_reservation', format('reservation %s of %s is above the %s available', NEW.id, NEW.qty,
                                                     COALESCE(balance.on_hand_qty - balance.reserved_qty, 0)));
  END IF;
  UPDATE inv.stock_balance SET reserved_qty = reserved_qty + NEW.qty, updated_at = now()
   WHERE product_id = NEW.product_id AND stock_unit_id IS NOT DISTINCT FROM NEW.stock_unit_id AND location_id = NEW.location_id;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION inv.apply_reservation() FROM PUBLIC;
CREATE TRIGGER trg_stock_reservation_apply AFTER INSERT OR UPDATE ON inv.stock_reservation
  FOR EACH ROW EXECUTE FUNCTION inv.apply_reservation();

-- Holds: placing one locks the unit row, as a sale does, so the rule holds at any isolation level. A hold is released
-- once, by a named user with a reason, and only that; a WITHDRAWAL hold is never released early: it ends by time.
CREATE FUNCTION inv.stock_hold_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  locked uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT u.id INTO locked FROM inv.stock_unit u WHERE u.id = NEW.stock_unit_id FOR UPDATE;
    IF NEW.released_at IS NOT NULL THEN
      PERFORM inv.refuse('ck_stock_hold_change', format('hold %s is placed unreleased', NEW.id));
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.released_at IS NOT NULL OR NEW.released_at IS NULL OR OLD.kind = 'WITHDRAWAL'
     OR (to_jsonb(NEW) - ARRAY['released_at', 'released_by', 'release_reason_code'])
        IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['released_at', 'released_by', 'release_reason_code']) THEN
    PERFORM inv.refuse('ck_stock_hold_change', format('hold %s (%s) is released once with a reason, and a withdrawal hold only ends by time', OLD.id, OLD.kind));
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION inv.stock_hold_guard() FROM PUBLIC;
CREATE TRIGGER trg_stock_hold_guard BEFORE INSERT OR UPDATE ON inv.stock_hold
  FOR EACH ROW EXECUTE FUNCTION inv.stock_hold_guard();

-- An exception is resolved once; only its resolution columns and status change.
CREATE FUNCTION inv.stock_exception_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  mutable text[] := ARRAY['status', 'resolved_at', 'resolved_by', 'resolution_document_id', 'resolution_note'];
BEGIN
  IF OLD.status <> 'OPEN' OR (to_jsonb(NEW) - mutable) IS DISTINCT FROM (to_jsonb(OLD) - mutable) THEN
    PERFORM inv.refuse('ck_stock_exception_change', format('stock exception %s is resolved once, and only its resolution is written', OLD.id));
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION inv.stock_exception_guard() FROM PUBLIC;
CREATE TRIGGER trg_stock_exception_guard BEFORE UPDATE ON inv.stock_exception
  FOR EACH ROW EXECUTE FUNCTION inv.stock_exception_guard();

-- Published views (MODULE_BOUNDARIES INV card). Available to promise is on hand less reserved, and nothing while a
-- hold covers the unit now.
CREATE VIEW inv.pub_stock_on_hand AS
SELECT b.product_id, b.stock_unit_id, b.location_id, b.branch_id, b.on_hand_qty, b.on_hand_weight_kg, b.reserved_qty,
       CASE WHEN b.stock_unit_id IS NOT NULL AND EXISTS (
              SELECT 1 FROM inv.stock_hold h
               WHERE h.stock_unit_id = b.stock_unit_id AND h.released_at IS NULL AND h.starts_at <= now() AND (h.ends_at IS NULL OR h.ends_at > now()))
            THEN 0::numeric(14,3)
            ELSE GREATEST(b.on_hand_qty - b.reserved_qty, 0)::numeric(14,3) END AS available_qty
  FROM inv.stock_balance b
 WHERE NOT (SELECT f.is_virtual FROM mdm.location_stock_facts(b.location_id) f);
CREATE VIEW inv.pub_stock_value AS
SELECT c.product_id, c.stock_unit_id, c.branch_id, c.qty, c.value_pesewas FROM inv.cost_pool c;
CREATE VIEW inv.pub_movement AS
SELECT m.id, m.movement_type, m.product_id, m.stock_unit_id, m.branch_id, m.from_location_id, m.to_location_id, m.qty_base,
       m.weight_kg, m.weight_source, m.value_pesewas, m.source_document_id, m.reverses_movement_id, m.occurred_at
  FROM inv.stock_movement m;

REVOKE ALL ON ALL TABLES IN SCHEMA inv FROM PUBLIC;
GRANT SELECT ON inv.movement_type, inv.stock_balance, inv.cost_pool TO hk_app, hk_worker;
GRANT SELECT, INSERT ON inv.stock_movement, inv.stock_unit_lineage TO hk_app, hk_worker;
GRANT SELECT, INSERT, UPDATE ON inv.stock_unit, inv.stock_reservation, inv.stock_hold, inv.stock_exception TO hk_app, hk_worker;
GRANT SELECT ON inv.pub_stock_on_hand, inv.pub_stock_value, inv.pub_movement TO hk_app, hk_worker, hk_report;

-- migrate:down
DROP VIEW inv.pub_movement;
DROP VIEW inv.pub_stock_value;
DROP VIEW inv.pub_stock_on_hand;
DROP TRIGGER trg_stock_exception_guard ON inv.stock_exception;
DROP TRIGGER trg_stock_hold_guard ON inv.stock_hold;
DROP TRIGGER trg_stock_reservation_apply ON inv.stock_reservation;
DROP TRIGGER trg_stock_unit_guard ON inv.stock_unit;
DROP TRIGGER trg_stock_movement_apply ON inv.stock_movement;
DROP TRIGGER trg_stock_movement_check ON inv.stock_movement;
DROP FUNCTION inv.stock_exception_guard();
DROP FUNCTION inv.stock_hold_guard();
DROP FUNCTION inv.apply_reservation();
DROP FUNCTION inv.apply_movement();
DROP FUNCTION inv.add_to_pool(uuid, uuid, uuid, numeric, bigint, uuid);
DROP FUNCTION inv.add_to_balance(uuid, uuid, uuid, uuid, numeric, numeric, integer);
DROP FUNCTION inv.check_movement();
DROP FUNCTION inv.stock_unit_guard();
DROP TABLE inv.stock_exception;
DROP TABLE inv.cost_pool;
DROP TABLE inv.stock_balance;
DROP TABLE inv.stock_movement;
DROP TABLE inv.stock_hold;
DROP TABLE inv.stock_reservation;
DROP TABLE inv.stock_unit_lineage;
DROP TABLE inv.stock_unit;
DROP TABLE inv.movement_type;
DROP FUNCTION inv.refuse(text, text);
DROP SCHEMA inv;
