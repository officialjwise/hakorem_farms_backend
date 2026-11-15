-- 0072_prc_processing_orders
-- The processing schema (docs/data-model/prc.md, ADR-0018; FR-PRC-001 to FR-PRC-008, FR-PRC-011): yield standards,
-- and processing orders with their inputs, outputs and direct costs. An order is PLANNED, then IN_PROGRESS once
-- started, and COMPLETED or CANCELLED; both are final and frozen. Completion consumes every input through
-- PROCESS_CONSUME movements, receives every saleable output as a new lot through PROCESS_OUTPUT movements carrying its
-- allocated cost, and records lineage, all through INV's interface in one serializable transaction.
--
-- The database holds the document rules itself, whoever writes:
--   prc.processing_order_status_guard  an order starts PLANNED and moves only PLANNED -> IN_PROGRESS -> COMPLETED, or
--                                      to CANCELLED from PLANNED or IN_PROGRESS (HK004)
--   freeze_posted                      a completed or cancelled order is final: nothing on it changes (HK004)
--   prc.processing_part_guard          inputs change only while the order is PLANNED, apart from the cost and movement
--                                      written once by completion; outputs and direct costs change only while it is
--                                      PLANNED or IN_PROGRESS (HK004)
--   ck_processing_order_costs          deferred to commit, on a COMPLETED order: total = input + direct; direct = the
--                                      sum of its direct costs; the outputs' allocated costs sum exactly to the total;
--                                      input cost = the sum of the inputs' costs; every input consumed and every
--                                      saleable output received (HK010)
-- Pack tables (`prc.pack`) arrive with packing (B06 continued). `cancel_reason`, `posted_at/by`, `branch_id`,
-- `expires_on` on an output and the version and audit columns are the DOCUMENT class's standard columns or additions
-- recorded in the data model (A-154).
-- Data category: INTERNAL (DC-13 for orders, inputs and outputs; DC-11 for direct costs and yield standards).
-- Rollback: tested (`pnpm db:rollback`), safe before the first completed order; afterwards forward fix only, since a
-- completed order is the source document of its movements.

-- migrate:up
CREATE SCHEMA prc AUTHORIZATION hk_owner;
REVOKE ALL ON SCHEMA prc FROM PUBLIC;
GRANT USAGE ON SCHEMA prc TO hk_app, hk_worker, hk_report;

-- Expected yield of an output product from an input product, for the variance check (FR-PRC-004).
CREATE TABLE prc.yield_standard (
  id                uuid PRIMARY KEY,
  input_product_id  uuid NOT NULL CONSTRAINT fk_yield_standard_input REFERENCES mdm.product (id) ON DELETE RESTRICT,
  output_product_id uuid NOT NULL CONSTRAINT fk_yield_standard_output REFERENCES mdm.product (id) ON DELETE RESTRICT,
  expected_percent  platform.percent NOT NULL CONSTRAINT ck_yield_standard_expected CHECK (expected_percent > 0 AND expected_percent <= 100),
  tolerance_percent platform.percent NOT NULL DEFAULT 5 CONSTRAINT ck_yield_standard_tolerance CHECK (tolerance_percent >= 0 AND tolerance_percent <= 100),
  version           integer NOT NULL DEFAULT 1,
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid NOT NULL CONSTRAINT fk_yield_standard_created_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  updated_by        uuid NOT NULL CONSTRAINT fk_yield_standard_updated_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  deleted_at        timestamptz NULL,
  deleted_by        uuid NULL CONSTRAINT fk_yield_standard_deleted_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  delete_reason     text NULL,
  CONSTRAINT ck_yield_standard_products CHECK (input_product_id <> output_product_id),
  CONSTRAINT ck_yield_standard_soft_delete CHECK ((deleted_at IS NULL) = (deleted_by IS NULL) AND (deleted_at IS NULL) = (delete_reason IS NULL))
);
COMMENT ON TABLE prc.yield_standard IS 'class=MASTER';
CREATE UNIQUE INDEX uq_yield_standard_products ON prc.yield_standard (input_product_id, output_product_id) WHERE deleted_at IS NULL;
CREATE TRIGGER trg_yield_standard_version BEFORE UPDATE ON prc.yield_standard
  FOR EACH ROW EXECUTE FUNCTION platform.touch_version();

CREATE TABLE prc.processing_order (
  id                     uuid PRIMARY KEY CONSTRAINT fk_processing_order_document REFERENCES platform.business_document (id) ON DELETE RESTRICT,
  order_no               text NULL CONSTRAINT uq_processing_order_no UNIQUE,
  location_id            uuid NOT NULL CONSTRAINT fk_processing_order_location REFERENCES mdm.location (id) ON DELETE RESTRICT,
  output_location_id     uuid NOT NULL CONSTRAINT fk_processing_order_output_location REFERENCES mdm.location (id) ON DELETE RESTRICT,
  started_at             timestamptz NULL,
  completed_at           timestamptz NULL,
  input_weight_kg        platform.kg NULL CONSTRAINT ck_processing_order_input_weight CHECK (input_weight_kg > 0),
  output_weight_kg       platform.kg NULL CONSTRAINT ck_processing_order_output_weight_sign CHECK (output_weight_kg >= 0),
  waste_weight_kg        platform.kg NULL CONSTRAINT ck_processing_order_waste_weight CHECK (waste_weight_kg >= 0),
  expected_yield_percent platform.percent NULL CONSTRAINT ck_processing_order_expected_yield CHECK (expected_yield_percent BETWEEN 0 AND 100),
  actual_yield_percent   platform.percent NULL CONSTRAINT ck_processing_order_actual_yield CHECK (actual_yield_percent BETWEEN 0 AND 100),
  yield_variance_flag    boolean NOT NULL DEFAULT false,
  input_cost_pesewas     platform.pesewas NULL,
  direct_cost_pesewas    platform.pesewas NOT NULL DEFAULT 0,
  total_cost_pesewas     platform.pesewas NULL,
  reverses_order_id      uuid NULL CONSTRAINT uq_processing_order_reverses UNIQUE
                           CONSTRAINT fk_processing_order_reverses REFERENCES prc.processing_order (id) ON DELETE RESTRICT,
  cancel_reason          text NULL CONSTRAINT ck_processing_order_cancel_reason CHECK (length(btrim(cancel_reason)) BETWEEN 1 AND 500),
  status                 text NOT NULL CONSTRAINT ck_processing_order_status CHECK (status IN ('PLANNED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED')),
  branch_id              uuid NOT NULL CONSTRAINT fk_processing_order_branch REFERENCES mdm.branch (id) ON DELETE RESTRICT,
  version                integer NOT NULL DEFAULT 1,
  created_at             timestamptz NOT NULL DEFAULT now(),
  created_by             uuid NOT NULL CONSTRAINT fk_processing_order_created_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  updated_at             timestamptz NOT NULL DEFAULT now(),
  updated_by             uuid NOT NULL CONSTRAINT fk_processing_order_updated_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  posted_at              timestamptz NULL,
  posted_by              uuid NULL CONSTRAINT fk_processing_order_posted_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  CONSTRAINT ck_processing_order_locations CHECK (location_id <> output_location_id),
  CONSTRAINT ck_processing_order_output_weight CHECK (output_weight_kg IS NULL OR input_weight_kg IS NULL OR output_weight_kg + COALESCE(waste_weight_kg, 0) <= input_weight_kg),
  CONSTRAINT ck_processing_order_started CHECK ((status = 'PLANNED') = (started_at IS NULL) OR status = 'CANCELLED'),
  CONSTRAINT ck_processing_order_posted CHECK ((status = 'COMPLETED') = (posted_at IS NOT NULL) AND (posted_at IS NULL) = (posted_by IS NULL)
                                               AND (status = 'COMPLETED') = (completed_at IS NOT NULL)),
  CONSTRAINT ck_processing_order_cancelled CHECK ((status = 'CANCELLED') = (cancel_reason IS NOT NULL)),
  CONSTRAINT ck_processing_order_totals CHECK (status <> 'COMPLETED' OR (input_cost_pesewas IS NOT NULL AND total_cost_pesewas IS NOT NULL
                                               AND input_weight_kg IS NOT NULL AND output_weight_kg IS NOT NULL AND waste_weight_kg IS NOT NULL))
);
COMMENT ON TABLE prc.processing_order IS 'class=DOCUMENT';
CREATE INDEX ix_processing_order_branch ON prc.processing_order (branch_id, created_at);
CREATE INDEX ix_processing_order_flag ON prc.processing_order (branch_id) WHERE yield_variance_flag;
CREATE TRIGGER trg_processing_order_version BEFORE UPDATE ON prc.processing_order
  FOR EACH ROW EXECUTE FUNCTION platform.touch_version();
CREATE TRIGGER trg_processing_order_freeze BEFORE UPDATE ON prc.processing_order
  FOR EACH ROW EXECUTE FUNCTION platform.freeze_posted('COMPLETED,CANCELLED');

CREATE FUNCTION prc.processing_order_status_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'PLANNED' THEN
      RAISE EXCEPTION 'prc.processing_order %: an order starts PLANNED', NEW.id USING ERRCODE = 'HK004';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'PLANNED' AND NEW.status IN ('IN_PROGRESS', 'CANCELLED'))
    OR (OLD.status = 'IN_PROGRESS' AND NEW.status IN ('COMPLETED', 'CANCELLED'))) THEN
    RAISE EXCEPTION 'prc.processing_order %: % cannot become %', OLD.id, OLD.status, NEW.status USING ERRCODE = 'HK004';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION prc.processing_order_status_guard() FROM PUBLIC;
CREATE TRIGGER trg_processing_order_status BEFORE INSERT OR UPDATE ON prc.processing_order
  FOR EACH ROW EXECUTE FUNCTION prc.processing_order_status_guard();

CREATE TABLE prc.processing_input (
  id                  uuid PRIMARY KEY,
  processing_order_id uuid NOT NULL CONSTRAINT fk_processing_input_order REFERENCES prc.processing_order (id) ON DELETE RESTRICT,
  line_no             integer NOT NULL CONSTRAINT ck_processing_input_line_no CHECK (line_no > 0),
  stock_unit_id       uuid NOT NULL CONSTRAINT fk_processing_input_unit REFERENCES inv.stock_unit (id) ON DELETE RESTRICT,
  product_id          uuid NOT NULL CONSTRAINT fk_processing_input_product REFERENCES mdm.product (id) ON DELETE RESTRICT,
  qty                 platform.qty NOT NULL CONSTRAINT ck_processing_input_qty CHECK (qty > 0),
  weight_kg           platform.kg NOT NULL CONSTRAINT ck_processing_input_weight CHECK (weight_kg > 0),
  weight_source       text NOT NULL CONSTRAINT ck_processing_input_weight_source CHECK (weight_source IN ('SCALE', 'MANUAL', 'ESTIMATE')),
  cost_pesewas        platform.pesewas NULL,
  movement_id         uuid NULL CONSTRAINT fk_processing_input_movement REFERENCES inv.stock_movement (id) ON DELETE RESTRICT,
  CONSTRAINT uq_processing_input_unit UNIQUE (processing_order_id, stock_unit_id),
  CONSTRAINT uq_processing_input_line UNIQUE (processing_order_id, line_no),
  CONSTRAINT ck_processing_input_consumed CHECK ((cost_pesewas IS NULL) = (movement_id IS NULL))
);
COMMENT ON TABLE prc.processing_input IS 'class=DOCUMENT';
CREATE INDEX ix_processing_input_unit ON prc.processing_input (stock_unit_id);

CREATE TABLE prc.processing_output (
  id                             uuid PRIMARY KEY,
  processing_order_id            uuid NOT NULL CONSTRAINT fk_processing_output_order REFERENCES prc.processing_order (id) ON DELETE RESTRICT,
  line_no                        integer NOT NULL CONSTRAINT ck_processing_output_line_no CHECK (line_no > 0),
  product_id                     uuid NOT NULL CONSTRAINT fk_processing_output_product REFERENCES mdm.product (id) ON DELETE RESTRICT,
  output_kind                    text NOT NULL CONSTRAINT ck_processing_output_kind CHECK (output_kind IN ('MEAT', 'OFFAL', 'BY_PRODUCT', 'WASTE')),
  stock_unit_id                  uuid NULL CONSTRAINT fk_processing_output_unit REFERENCES inv.stock_unit (id) ON DELETE RESTRICT,
  weight_kg                      platform.kg NOT NULL CONSTRAINT ck_processing_output_weight CHECK (weight_kg > 0),
  weight_source                  text NOT NULL CONSTRAINT ck_processing_output_weight_source CHECK (weight_source IN ('SCALE', 'MANUAL', 'ESTIMATE')),
  pack_count                     integer NULL CONSTRAINT ck_processing_output_pack_count CHECK (pack_count > 0),
  expires_on                     date NULL,
  reference_price_pesewas_per_kg platform.pesewas NOT NULL DEFAULT 0,
  allocation_weight              bigint NOT NULL DEFAULT 0 CONSTRAINT ck_processing_output_allocation_weight CHECK (allocation_weight >= 0),
  allocated_cost_pesewas         platform.pesewas NOT NULL DEFAULT 0,
  movement_id                    uuid NULL CONSTRAINT fk_processing_output_movement REFERENCES inv.stock_movement (id) ON DELETE RESTRICT,
  CONSTRAINT uq_processing_output_line UNIQUE (processing_order_id, line_no),
  -- FR-PRC-008: waste carries no price, no weight in the allocation, no cost and no stock.
  CONSTRAINT ck_processing_output_waste CHECK (output_kind <> 'WASTE' OR (reference_price_pesewas_per_kg = 0 AND allocation_weight = 0
                                               AND allocated_cost_pesewas = 0 AND stock_unit_id IS NULL AND movement_id IS NULL)),
  CONSTRAINT ck_processing_output_received CHECK ((stock_unit_id IS NULL) = (movement_id IS NULL))
);
COMMENT ON TABLE prc.processing_output IS 'class=DOCUMENT';
CREATE INDEX ix_processing_output_unit ON prc.processing_output (stock_unit_id) WHERE stock_unit_id IS NOT NULL;

CREATE TABLE prc.processing_cost (
  id                  uuid PRIMARY KEY,
  processing_order_id uuid NOT NULL CONSTRAINT fk_processing_cost_order REFERENCES prc.processing_order (id) ON DELETE RESTRICT,
  cost_kind           text NOT NULL CONSTRAINT ck_processing_cost_kind CHECK (cost_kind IN ('LABOUR', 'CONSUMABLE', 'SERVICE', 'UTILITY')),
  amount_pesewas      platform.pesewas NOT NULL CONSTRAINT ck_processing_cost_amount CHECK (amount_pesewas > 0),
  description         text NOT NULL CONSTRAINT ck_processing_cost_description CHECK (length(btrim(description)) BETWEEN 1 AND 200),
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid NOT NULL CONSTRAINT fk_processing_cost_created_by REFERENCES iam.principal (id) ON DELETE RESTRICT
);
COMMENT ON TABLE prc.processing_cost IS 'class=DOCUMENT';
CREATE INDEX ix_processing_cost_order ON prc.processing_cost (processing_order_id);

-- Inputs change only while their order is PLANNED, except the cost and movement completion writes once while it is
-- IN_PROGRESS; outputs and direct costs change only while it is PLANNED or IN_PROGRESS. HK004.
CREATE FUNCTION prc.processing_part_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  order_status text;
  order_id uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.processing_order_id ELSE NEW.processing_order_id END;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.processing_order_id <> OLD.processing_order_id THEN
    order_id := NULL;
  END IF;
  SELECT o.status INTO order_status FROM prc.processing_order o WHERE o.id = order_id;
  IF TG_TABLE_NAME = 'processing_input' THEN
    IF order_status = 'PLANNED' THEN
      RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
    END IF;
    IF order_status = 'IN_PROGRESS' AND TG_OP = 'UPDATE' AND OLD.movement_id IS NULL
       AND (to_jsonb(NEW) - ARRAY['cost_pesewas', 'movement_id']) = (to_jsonb(OLD) - ARRAY['cost_pesewas', 'movement_id']) THEN
      RETURN NEW;
    END IF;
  ELSIF order_status IN ('PLANNED', 'IN_PROGRESS') THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  RAISE EXCEPTION '%.% is frozen with its processing order (status %)', TG_TABLE_SCHEMA, TG_TABLE_NAME, order_status USING ERRCODE = 'HK004';
END
$$;
REVOKE ALL ON FUNCTION prc.processing_part_guard() FROM PUBLIC;
CREATE TRIGGER trg_processing_input_guard BEFORE INSERT OR UPDATE OR DELETE ON prc.processing_input
  FOR EACH ROW EXECUTE FUNCTION prc.processing_part_guard();
CREATE TRIGGER trg_processing_output_guard BEFORE INSERT OR UPDATE OR DELETE ON prc.processing_output
  FOR EACH ROW EXECUTE FUNCTION prc.processing_part_guard();
CREATE TRIGGER trg_processing_cost_guard BEFORE INSERT OR UPDATE OR DELETE ON prc.processing_cost
  FOR EACH ROW EXECUTE FUNCTION prc.processing_part_guard();

-- The B6 gate in the database (ADR-0018): at commit, a completed order's sums hold exactly, whoever wrote it.
CREATE FUNCTION prc.processing_order_costs() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  order_row prc.processing_order;
  inputs_cost numeric;
  unconsumed integer;
  costs numeric;
  allocated numeric;
  unreceived integer;
BEGIN
  SELECT * INTO order_row FROM prc.processing_order o WHERE o.id = NEW.id;
  IF order_row.status <> 'COMPLETED' THEN
    RETURN NULL;
  END IF;
  SELECT COALESCE(sum(i.cost_pesewas), 0), count(*) FILTER (WHERE i.movement_id IS NULL) INTO inputs_cost, unconsumed
    FROM prc.processing_input i WHERE i.processing_order_id = NEW.id;
  SELECT COALESCE(sum(c.amount_pesewas), 0) INTO costs FROM prc.processing_cost c WHERE c.processing_order_id = NEW.id;
  SELECT COALESCE(sum(p.allocated_cost_pesewas), 0), count(*) FILTER (WHERE p.output_kind <> 'WASTE' AND p.movement_id IS NULL) INTO allocated, unreceived
    FROM prc.processing_output p WHERE p.processing_order_id = NEW.id;
  IF order_row.total_cost_pesewas <> order_row.input_cost_pesewas + order_row.direct_cost_pesewas
     OR order_row.direct_cost_pesewas <> costs
     OR order_row.input_cost_pesewas <> inputs_cost
     OR allocated <> order_row.total_cost_pesewas
     OR unconsumed > 0 OR unreceived > 0 THEN
    RAISE EXCEPTION 'prc.processing_order %: total % must be input % plus direct % (costs %), and the outputs carry % with % inputs unconsumed and % outputs unreceived',
      NEW.id, order_row.total_cost_pesewas, order_row.input_cost_pesewas, order_row.direct_cost_pesewas, costs, allocated, unconsumed, unreceived
      USING ERRCODE = 'HK010', CONSTRAINT = 'ck_processing_order_costs';
  END IF;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION prc.processing_order_costs() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER trg_processing_order_costs AFTER UPDATE OF status ON prc.processing_order
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.status = 'COMPLETED')
  EXECUTE FUNCTION prc.processing_order_costs();

-- updateProcessingOrder and recordProcessingOutputs replace the lists outright. hk_app holds no DELETE on a DOCUMENT
-- table (ADR-0024), so each removal is one function, which the part guard limits to an order that may still change.
CREATE FUNCTION prc.clear_processing_inputs(p_order_id uuid) RETURNS integer
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
DECLARE
  removed integer;
BEGIN
  DELETE FROM prc.processing_input WHERE processing_order_id = p_order_id;
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END
$$;
REVOKE ALL ON FUNCTION prc.clear_processing_inputs(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION prc.clear_processing_inputs(uuid) TO hk_app, hk_worker;

CREATE FUNCTION prc.clear_processing_outputs(p_order_id uuid) RETURNS integer
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
DECLARE
  removed integer;
BEGIN
  DELETE FROM prc.processing_output WHERE processing_order_id = p_order_id;
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END
$$;
REVOKE ALL ON FUNCTION prc.clear_processing_outputs(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION prc.clear_processing_outputs(uuid) TO hk_app, hk_worker;

REVOKE ALL ON prc.yield_standard, prc.processing_order, prc.processing_input, prc.processing_output, prc.processing_cost FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON prc.yield_standard, prc.processing_order, prc.processing_input, prc.processing_output, prc.processing_cost TO hk_app, hk_worker;

-- migrate:down
DROP FUNCTION prc.clear_processing_outputs(uuid);
DROP FUNCTION prc.clear_processing_inputs(uuid);
DROP TABLE prc.processing_cost;
DROP TABLE prc.processing_output;
DROP TABLE prc.processing_input;
DROP TABLE prc.processing_order;
DROP FUNCTION prc.processing_order_costs();
DROP FUNCTION prc.processing_part_guard();
DROP FUNCTION prc.processing_order_status_guard();
DROP TABLE prc.yield_standard;
DROP SCHEMA prc;
