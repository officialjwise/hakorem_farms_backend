-- 0076_liv_livestock_register
-- The livestock schema, first part (docs/data-model/liv.md, ADR-0018, ADR-0019; FR-LIV-001, FR-LIV-004, FR-LIV-007 to
-- FR-LIV-009, FR-LIV-012, FR-LIV-014, FR-LIV-015, FR-LIV-017): the animal register, weight records, health events
-- with their veterinary cost spread, mortality and cull records, rations, and feed consumption with its spread.
-- Batches and breeding records are B06 continued 2's (A-158); the animal's `batch_id` and `breeding_record_id` are
-- added there by an expand migration, with their tables. Stock, location and cost stay inventory's: an animal shares
-- its stock unit's id, and every change of stock or cost goes through INV's interface.
--
-- The database holds these rules itself, whoever writes:
--   uq_animal_live_tag              one live animal per tag (FR-LIV-001)
--   liv.animal_guard                species, product, branch, acquisition date, source, supplier and acquisition cost
--                                   never change; status moves only ALIVE -> SOLD, SLAUGHTERED, DEAD or CULLED, or back
--                                   to ALIVE on a customer return or the reversal of the closing movement (FR-LIV-017)
--                                   (HK004)
--   liv.mortality_record_guard      REPORTED -> PENDING_APPROVAL or POSTED; PENDING_APPROVAL -> POSTED or REJECTED;
--                                   POSTED and REJECTED frozen (HK004); a photograph is an EVIDENCE file
--                                   (platform.require_clean_file, HK008)
--   ck_mortality_record_approved    a POSTED record valued at or above its threshold has a photograph and an approval
--                                   (FR-LIV-012, threat model abuse case 2)
--   ck_feed_consumption_spread      deferred to commit: a posted consumption's allocations sum exactly to its value
--                                   (FR-LIV-015) (HK010)
--   ck_health_event_spread          deferred to commit: a health event's cost allocations sum exactly to its cost
--                                   (FR-LIV-009) (HK010)
-- Additions to docs/data-model/liv.md (A-158): `branch_id`, `product_id` and `exit_value_pesewas` on an animal, `branch_id` on a weight
-- record, `branch_id`, `holds_placed`, `medication_value_pesewas` and `issue_movement_id` on a health event, the table
-- `liv.health_cost_allocation`, `location_id`, `threshold_pesewas` and the DOCUMENT columns on a mortality record,
-- and `from_location_id` and the DOCUMENT columns on a feed consumption.
-- Data category: INTERNAL (DC-10; DC-11 for acquisition cost and cost allocations; DC-34 for the photograph's id).
-- Rollback: tested (`pnpm db:rollback`), safe before the first animal is registered; afterwards forward fix only,
-- since the register and its records are what stock movements and holds cite.

-- migrate:up
CREATE SCHEMA liv AUTHORIZATION hk_owner;
REVOKE ALL ON SCHEMA liv FROM PUBLIC;
GRANT USAGE ON SCHEMA liv TO hk_app, hk_worker, hk_report;

-- One individual animal, sharing its stock unit's id (ADR-0018). Its pen and cost are inventory's.
CREATE TABLE liv.animal (
  stock_unit_id            uuid PRIMARY KEY CONSTRAINT fk_animal_stock_unit REFERENCES inv.stock_unit (id) ON DELETE RESTRICT,
  tag_no                   text NOT NULL CONSTRAINT ck_animal_tag CHECK (tag_no ~ '^[A-Za-z0-9][A-Za-z0-9/_-]{0,39}$'),
  species_id               uuid NOT NULL CONSTRAINT fk_animal_species REFERENCES mdm.species (id) ON DELETE RESTRICT,
  product_id               uuid NOT NULL CONSTRAINT fk_animal_product REFERENCES mdm.product (id) ON DELETE RESTRICT,
  branch_id                uuid NOT NULL CONSTRAINT fk_animal_branch REFERENCES mdm.branch (id) ON DELETE RESTRICT,
  breed                    text NULL CONSTRAINT ck_animal_breed CHECK (length(btrim(breed)) BETWEEN 1 AND 80),
  sex                      text NOT NULL CONSTRAINT ck_animal_sex CHECK (sex IN ('MALE', 'FEMALE', 'UNKNOWN')),
  date_of_birth            date NULL,
  acquired_on              date NOT NULL,
  source                   text NOT NULL CONSTRAINT ck_animal_source CHECK (source IN ('PURCHASE', 'BIRTH', 'OPENING')),
  supplier_id              uuid NULL CONSTRAINT fk_animal_supplier REFERENCES mdm.supplier (id) ON DELETE RESTRICT,
  acquisition_cost_pesewas platform.pesewas NOT NULL DEFAULT 0,
  dam_id                   uuid NULL CONSTRAINT fk_animal_dam REFERENCES liv.animal (stock_unit_id) ON DELETE RESTRICT,
  sire_id                  uuid NULL CONSTRAINT fk_animal_sire REFERENCES liv.animal (stock_unit_id) ON DELETE RESTRICT,
  purpose                  text NOT NULL CONSTRAINT ck_animal_purpose CHECK (purpose IN ('GROWING', 'BREEDING')),
  status                   text NOT NULL CONSTRAINT ck_animal_status CHECK (status IN ('ALIVE', 'SOLD', 'SLAUGHTERED', 'DEAD', 'CULLED')),
  status_changed_at        timestamptz NULL,
  -- The cost the closing movement carried out of its pool (A-158): what the register shows once the pool is empty.
  exit_value_pesewas       platform.pesewas NULL,
  version                  integer NOT NULL DEFAULT 1,
  created_at               timestamptz NOT NULL DEFAULT now(),
  created_by               uuid NOT NULL CONSTRAINT fk_animal_created_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  updated_at               timestamptz NOT NULL DEFAULT now(),
  updated_by               uuid NOT NULL CONSTRAINT fk_animal_updated_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  CONSTRAINT ck_animal_supplier CHECK ((source = 'PURCHASE') = (supplier_id IS NOT NULL)),
  CONSTRAINT ck_animal_birth CHECK (date_of_birth IS NULL OR date_of_birth <= acquired_on),
  CONSTRAINT ck_animal_closed CHECK ((status = 'ALIVE') = (exit_value_pesewas IS NULL)),
  CONSTRAINT ck_animal_parents CHECK (dam_id IS DISTINCT FROM stock_unit_id AND sire_id IS DISTINCT FROM stock_unit_id)
);
COMMENT ON TABLE liv.animal IS 'class=MASTER';
CREATE UNIQUE INDEX uq_animal_live_tag ON liv.animal (tag_no) WHERE status = 'ALIVE';
CREATE INDEX ix_animal_branch ON liv.animal (branch_id, stock_unit_id);
CREATE INDEX ix_animal_dam ON liv.animal (dam_id) WHERE dam_id IS NOT NULL;
CREATE TRIGGER trg_animal_version BEFORE UPDATE ON liv.animal
  FOR EACH ROW EXECUTE FUNCTION platform.touch_version();

CREATE FUNCTION liv.animal_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'ALIVE' THEN
      RAISE EXCEPTION 'liv.animal %: an animal is registered ALIVE', NEW.stock_unit_id USING ERRCODE = 'HK004';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.stock_unit_id <> OLD.stock_unit_id OR NEW.species_id <> OLD.species_id OR NEW.product_id <> OLD.product_id
     OR NEW.branch_id <> OLD.branch_id OR NEW.acquired_on <> OLD.acquired_on OR NEW.source <> OLD.source
     OR NEW.supplier_id IS DISTINCT FROM OLD.supplier_id OR NEW.acquisition_cost_pesewas <> OLD.acquisition_cost_pesewas
     OR NEW.created_at <> OLD.created_at OR NEW.created_by <> OLD.created_by THEN
    RAISE EXCEPTION 'liv.animal %: species, product, branch, acquisition and source never change', OLD.stock_unit_id USING ERRCODE = 'HK004';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'ALIVE' AND NEW.status IN ('SOLD', 'SLAUGHTERED', 'DEAD', 'CULLED'))
    OR (OLD.status <> 'ALIVE' AND NEW.status = 'ALIVE')) THEN
    RAISE EXCEPTION 'liv.animal %: % cannot become %', OLD.stock_unit_id, OLD.status, NEW.status USING ERRCODE = 'HK004';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION liv.animal_guard() FROM PUBLIC;
CREATE TRIGGER trg_animal_guard BEFORE INSERT OR UPDATE ON liv.animal
  FOR EACH ROW EXECUTE FUNCTION liv.animal_guard();

-- Weights over time (FR-LIV-004): append-only; a correction is a later record.
CREATE TABLE liv.weight_record (
  id            uuid PRIMARY KEY,
  stock_unit_id uuid NOT NULL CONSTRAINT fk_weight_record_unit REFERENCES inv.stock_unit (id) ON DELETE RESTRICT,
  branch_id     uuid NOT NULL CONSTRAINT fk_weight_record_branch REFERENCES mdm.branch (id) ON DELETE RESTRICT,
  weight_kg     platform.kg NOT NULL CONSTRAINT ck_weight_record_weight CHECK (weight_kg > 0),
  weight_source text NOT NULL CONSTRAINT ck_weight_record_source CHECK (weight_source IN ('SCALE', 'MANUAL', 'ESTIMATE')),
  head_weighed  integer NOT NULL DEFAULT 1 CONSTRAINT ck_weight_record_head CHECK (head_weighed > 0),
  measured_at   timestamptz NOT NULL,
  recorded_at   timestamptz NOT NULL DEFAULT now(),
  actor_id      uuid NOT NULL CONSTRAINT fk_weight_record_actor REFERENCES iam.principal (id) ON DELETE RESTRICT
);
COMMENT ON TABLE liv.weight_record IS 'class=LEDGER';
CREATE INDEX ix_weight_record_unit ON liv.weight_record (stock_unit_id, measured_at);
CREATE INDEX ix_weight_record_branch ON liv.weight_record (branch_id, id);
CREATE TRIGGER trg_weight_record_immutable BEFORE UPDATE OR DELETE ON liv.weight_record
  FOR EACH ROW EXECUTE FUNCTION platform.reject_change();
CREATE TRIGGER trg_weight_record_no_truncate BEFORE TRUNCATE ON liv.weight_record
  FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_change();

-- Vaccinations, treatments, checks and deworming (FR-LIV-007 to FR-LIV-009), registered as a business document so
-- that the withdrawal holds, the medication issue and the cost movements cite it.
CREATE TABLE liv.health_event (
  id                       uuid PRIMARY KEY CONSTRAINT fk_health_event_document REFERENCES platform.business_document (id) ON DELETE RESTRICT,
  kind                     text NOT NULL CONSTRAINT ck_health_event_kind CHECK (kind IN ('VACCINATION', 'TREATMENT', 'CHECK', 'DEWORMING')),
  branch_id                uuid NOT NULL CONSTRAINT fk_health_event_branch REFERENCES mdm.branch (id) ON DELETE RESTRICT,
  stock_unit_id            uuid NULL CONSTRAINT fk_health_event_unit REFERENCES inv.stock_unit (id) ON DELETE RESTRICT,
  location_id              uuid NULL CONSTRAINT fk_health_event_location REFERENCES mdm.location (id) ON DELETE RESTRICT,
  product_id               uuid NULL CONSTRAINT fk_health_event_product REFERENCES mdm.product (id) ON DELETE RESTRICT,
  dose                     text NULL CONSTRAINT ck_health_event_dose CHECK (length(btrim(dose)) BETWEEN 1 AND 80),
  qty_used                 platform.qty NULL CONSTRAINT ck_health_event_qty CHECK (qty_used > 0),
  withdrawal_days          integer NOT NULL DEFAULT 0 CONSTRAINT ck_health_event_withdrawal_days CHECK (withdrawal_days BETWEEN 0 AND 365),
  withdrawal_ends_at       timestamptz NULL,
  stock_hold_id            uuid NULL CONSTRAINT fk_health_event_hold REFERENCES inv.stock_hold (id) ON DELETE RESTRICT,
  holds_placed             integer NOT NULL DEFAULT 0 CONSTRAINT ck_health_event_holds_placed CHECK (holds_placed >= 0),
  cost_pesewas             platform.pesewas NOT NULL DEFAULT 0,
  medication_value_pesewas platform.pesewas NOT NULL DEFAULT 0,
  issue_movement_id        uuid NULL CONSTRAINT fk_health_event_issue REFERENCES inv.stock_movement (id) ON DELETE RESTRICT,
  administered_by          text NULL CONSTRAINT ck_health_event_administered_by CHECK (length(btrim(administered_by)) BETWEEN 1 AND 120),
  notes                    text NULL CONSTRAINT ck_health_event_notes CHECK (length(btrim(notes)) BETWEEN 1 AND 1000),
  occurred_at              timestamptz NOT NULL,
  recorded_at              timestamptz NOT NULL DEFAULT now(),
  actor_id                 uuid NOT NULL CONSTRAINT fk_health_event_actor REFERENCES iam.principal (id) ON DELETE RESTRICT,
  CONSTRAINT ck_health_event_subject CHECK (num_nonnulls(stock_unit_id, location_id) = 1),
  CONSTRAINT ck_health_event_withdrawal CHECK ((withdrawal_days > 0) = (withdrawal_ends_at IS NOT NULL) AND (withdrawal_days > 0) = (holds_placed > 0)),
  -- A single animal or flock treated with withdrawal days names its hold; a pen-wide treatment places one per unit,
  -- each citing this event, and names none here.
  CONSTRAINT ck_health_event_hold CHECK ((stock_unit_id IS NOT NULL AND withdrawal_days > 0) = (stock_hold_id IS NOT NULL)),
  CONSTRAINT ck_health_event_medication CHECK ((product_id IS NULL) = (qty_used IS NULL) AND (qty_used IS NULL) = (issue_movement_id IS NULL)
                                               AND medication_value_pesewas <= cost_pesewas
                                               AND (issue_movement_id IS NOT NULL OR medication_value_pesewas = 0))
);
COMMENT ON TABLE liv.health_event IS 'class=LEDGER';
CREATE INDEX ix_health_event_branch ON liv.health_event (branch_id, id);
CREATE INDEX ix_health_event_unit ON liv.health_event (stock_unit_id) WHERE stock_unit_id IS NOT NULL;
CREATE INDEX ix_health_event_location ON liv.health_event (location_id) WHERE location_id IS NOT NULL;
CREATE TRIGGER trg_health_event_immutable BEFORE UPDATE OR DELETE ON liv.health_event
  FOR EACH ROW EXECUTE FUNCTION platform.reject_change();
CREATE TRIGGER trg_health_event_no_truncate BEFORE TRUNCATE ON liv.health_event
  FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_change();

-- How a health event's cost was spread across the animals and flocks treated, by head-days (FR-LIV-009).
CREATE TABLE liv.health_cost_allocation (
  health_event_id uuid NOT NULL CONSTRAINT fk_health_cost_allocation_event REFERENCES liv.health_event (id) ON DELETE RESTRICT,
  stock_unit_id   uuid NOT NULL CONSTRAINT fk_health_cost_allocation_unit REFERENCES inv.stock_unit (id) ON DELETE RESTRICT,
  head_days       integer NOT NULL CONSTRAINT ck_health_cost_allocation_head_days CHECK (head_days > 0),
  amount_pesewas  platform.pesewas NOT NULL,
  treatment       text NOT NULL CONSTRAINT ck_health_cost_allocation_treatment CHECK (treatment IN ('CAPITALISED', 'EXPENSED')),
  movement_id     uuid NULL CONSTRAINT fk_health_cost_allocation_movement REFERENCES inv.stock_movement (id) ON DELETE RESTRICT,
  recorded_at     timestamptz NOT NULL DEFAULT now(),
  actor_id        uuid NOT NULL CONSTRAINT fk_health_cost_allocation_actor REFERENCES iam.principal (id) ON DELETE RESTRICT,
  CONSTRAINT pk_health_cost_allocation PRIMARY KEY (health_event_id, stock_unit_id),
  CONSTRAINT ck_health_cost_allocation_movement CHECK (treatment = 'EXPENSED' OR amount_pesewas = 0 OR movement_id IS NOT NULL)
);
COMMENT ON TABLE liv.health_cost_allocation IS 'class=LEDGER';
CREATE INDEX ix_health_cost_allocation_unit ON liv.health_cost_allocation (stock_unit_id);
CREATE TRIGGER trg_health_cost_allocation_immutable BEFORE UPDATE OR DELETE ON liv.health_cost_allocation
  FOR EACH ROW EXECUTE FUNCTION platform.reject_change();
CREATE TRIGGER trg_health_cost_allocation_no_truncate BEFORE TRUNCATE ON liv.health_cost_allocation
  FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_change();

CREATE FUNCTION liv.health_event_spread() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  event_id uuid;
  cost bigint;
  spread numeric;
  shares integer;
BEGIN
  IF TG_TABLE_NAME = 'health_event' THEN
    event_id := NEW.id;
  ELSE
    event_id := NEW.health_event_id;
  END IF;
  SELECT e.cost_pesewas INTO cost FROM liv.health_event e WHERE e.id = event_id;
  SELECT COALESCE(sum(a.amount_pesewas), 0), count(*) INTO spread, shares FROM liv.health_cost_allocation a WHERE a.health_event_id = event_id;
  IF (cost > 0 OR shares > 0) AND spread <> cost THEN
    RAISE EXCEPTION 'liv.health_event %: cost % but its allocations sum to %', event_id, cost, spread
      USING ERRCODE = 'HK010', CONSTRAINT = 'ck_health_event_spread';
  END IF;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION liv.health_event_spread() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER trg_health_event_spread AFTER INSERT ON liv.health_event
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION liv.health_event_spread();
CREATE CONSTRAINT TRIGGER trg_health_cost_allocation_spread AFTER INSERT ON liv.health_cost_allocation
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION liv.health_event_spread();

-- A death or cull (FR-LIV-012, FR-LIV-013). At or above its threshold it posts only once a different person approves
-- it, with a photograph (threat model abuse case 2).
CREATE TABLE liv.mortality_record (
  id                  uuid PRIMARY KEY CONSTRAINT fk_mortality_record_document REFERENCES platform.business_document (id) ON DELETE RESTRICT,
  kind                text NOT NULL CONSTRAINT ck_mortality_record_kind CHECK (kind IN ('DEATH', 'CULL')),
  stock_unit_id       uuid NOT NULL CONSTRAINT fk_mortality_record_unit REFERENCES inv.stock_unit (id) ON DELETE RESTRICT,
  location_id         uuid NOT NULL CONSTRAINT fk_mortality_record_location REFERENCES mdm.location (id) ON DELETE RESTRICT,
  head                integer NOT NULL DEFAULT 1 CONSTRAINT ck_mortality_record_head CHECK (head > 0),
  reason_code         text NOT NULL CONSTRAINT fk_mortality_record_reason REFERENCES mdm.reason_code (code) ON DELETE RESTRICT,
  found_at            timestamptz NOT NULL,
  reported_by         uuid NOT NULL CONSTRAINT fk_mortality_record_reported_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  photo_file_id       uuid NULL CONSTRAINT fk_mortality_record_photo REFERENCES platform.stored_file (id) ON DELETE RESTRICT,
  value_pesewas       platform.pesewas NOT NULL,
  threshold_pesewas   platform.pesewas NULL,
  approval_request_id uuid NULL CONSTRAINT fk_mortality_record_approval REFERENCES iam.approval_request (id) ON DELETE RESTRICT,
  movement_id         uuid NULL CONSTRAINT fk_mortality_record_movement REFERENCES inv.stock_movement (id) ON DELETE RESTRICT,
  disposal_note       text NULL CONSTRAINT ck_mortality_record_disposal CHECK (length(btrim(disposal_note)) BETWEEN 1 AND 500),
  status              text NOT NULL CONSTRAINT ck_mortality_record_status CHECK (status IN ('REPORTED', 'PENDING_APPROVAL', 'POSTED', 'REJECTED')),
  branch_id           uuid NOT NULL CONSTRAINT fk_mortality_record_branch REFERENCES mdm.branch (id) ON DELETE RESTRICT,
  version             integer NOT NULL DEFAULT 1,
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid NOT NULL CONSTRAINT fk_mortality_record_created_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  updated_by          uuid NOT NULL CONSTRAINT fk_mortality_record_updated_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  posted_at           timestamptz NULL,
  posted_by           uuid NULL CONSTRAINT fk_mortality_record_posted_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  CONSTRAINT ck_mortality_record_posted CHECK ((status = 'POSTED') = (movement_id IS NOT NULL) AND (status = 'POSTED') = (posted_at IS NOT NULL)
                                               AND (posted_at IS NULL) = (posted_by IS NULL)),
  CONSTRAINT ck_mortality_record_judged CHECK (status = 'REPORTED' OR threshold_pesewas IS NOT NULL),
  CONSTRAINT ck_mortality_record_pending CHECK (status <> 'PENDING_APPROVAL' OR approval_request_id IS NOT NULL),
  CONSTRAINT ck_mortality_record_approved CHECK (status <> 'POSTED' OR value_pesewas < threshold_pesewas
                                                 OR (photo_file_id IS NOT NULL AND approval_request_id IS NOT NULL))
);
COMMENT ON TABLE liv.mortality_record IS 'class=DOCUMENT';
CREATE INDEX ix_mortality_record_branch ON liv.mortality_record (branch_id, id);
CREATE INDEX ix_mortality_record_unit ON liv.mortality_record (stock_unit_id);
CREATE INDEX ix_mortality_record_reporter ON liv.mortality_record (reported_by, found_at);
CREATE TRIGGER trg_mortality_record_version BEFORE UPDATE ON liv.mortality_record
  FOR EACH ROW EXECUTE FUNCTION platform.touch_version();
CREATE TRIGGER trg_mortality_record_freeze BEFORE UPDATE ON liv.mortality_record
  FOR EACH ROW EXECUTE FUNCTION platform.freeze_posted('POSTED,REJECTED');

CREATE FUNCTION liv.mortality_record_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.status <> 'REPORTED' THEN
    RAISE EXCEPTION 'liv.mortality_record %: a record starts REPORTED', NEW.id USING ERRCODE = 'HK004';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'REPORTED' AND NEW.status IN ('PENDING_APPROVAL', 'POSTED'))
    OR (OLD.status = 'PENDING_APPROVAL' AND NEW.status IN ('POSTED', 'REJECTED'))) THEN
    RAISE EXCEPTION 'liv.mortality_record %: % cannot become %', OLD.id, OLD.status, NEW.status USING ERRCODE = 'HK004';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.reported_by <> OLD.reported_by OR NEW.stock_unit_id <> OLD.stock_unit_id OR NEW.kind <> OLD.kind) THEN
    RAISE EXCEPTION 'liv.mortality_record %: the animal, the kind and the reporter never change', OLD.id USING ERRCODE = 'HK004';
  END IF;
  IF NEW.photo_file_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.photo_file_id IS DISTINCT FROM OLD.photo_file_id) THEN
    PERFORM platform.require_clean_file(NEW.photo_file_id, 'EVIDENCE');
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION liv.mortality_record_guard() FROM PUBLIC;
CREATE TRIGGER trg_mortality_record_guard BEFORE INSERT OR UPDATE ON liv.mortality_record
  FOR EACH ROW EXECUTE FUNCTION liv.mortality_record_guard();

-- A feeding standard (FR-LIV-014): data for planning and variance, never a stock transaction.
CREATE TABLE liv.ration (
  id                   uuid PRIMARY KEY,
  name                 text NOT NULL CONSTRAINT ck_ration_name CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  species_id           uuid NOT NULL CONSTRAINT fk_ration_species REFERENCES mdm.species (id) ON DELETE RESTRICT,
  feed_product_id      uuid NOT NULL CONSTRAINT fk_ration_feed REFERENCES mdm.product (id) ON DELETE RESTRICT,
  qty_per_head_per_day platform.qty NOT NULL CONSTRAINT ck_ration_qty CHECK (qty_per_head_per_day > 0),
  stage                text NULL CONSTRAINT ck_ration_stage CHECK (length(btrim(stage)) BETWEEN 1 AND 40),
  version              integer NOT NULL DEFAULT 1,
  created_at           timestamptz NOT NULL DEFAULT now(),
  created_by           uuid NOT NULL CONSTRAINT fk_ration_created_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  updated_by           uuid NOT NULL CONSTRAINT fk_ration_updated_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  deleted_at           timestamptz NULL,
  deleted_by           uuid NULL CONSTRAINT fk_ration_deleted_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  delete_reason        text NULL,
  CONSTRAINT ck_ration_soft_delete CHECK ((deleted_at IS NULL) = (deleted_by IS NULL) AND (deleted_at IS NULL) = (delete_reason IS NULL))
);
COMMENT ON TABLE liv.ration IS 'class=MASTER';
CREATE UNIQUE INDEX uq_ration_name ON liv.ration (species_id, lower(name)) WHERE deleted_at IS NULL;
CREATE TRIGGER trg_ration_version BEFORE UPDATE ON liv.ration
  FOR EACH ROW EXECUTE FUNCTION platform.touch_version();

-- Feed issued to a pen on a date (FR-LIV-015), posted when recorded: the issue and the spread happen in its
-- transaction, so it is never a DRAFT on this build.
CREATE TABLE liv.feed_consumption (
  id                uuid PRIMARY KEY CONSTRAINT fk_feed_consumption_document REFERENCES platform.business_document (id) ON DELETE RESTRICT,
  location_id       uuid NOT NULL CONSTRAINT fk_feed_consumption_location REFERENCES mdm.location (id) ON DELETE RESTRICT,
  from_location_id  uuid NOT NULL CONSTRAINT fk_feed_consumption_from REFERENCES mdm.location (id) ON DELETE RESTRICT,
  feed_product_id   uuid NOT NULL CONSTRAINT fk_feed_consumption_feed REFERENCES mdm.product (id) ON DELETE RESTRICT,
  qty               platform.qty NOT NULL CONSTRAINT ck_feed_consumption_qty CHECK (qty > 0),
  consumed_on       date NOT NULL,
  ration_id         uuid NULL CONSTRAINT fk_feed_consumption_ration REFERENCES liv.ration (id) ON DELETE RESTRICT,
  value_pesewas     platform.pesewas NULL,
  issue_movement_id uuid NULL CONSTRAINT fk_feed_consumption_issue REFERENCES inv.stock_movement (id) ON DELETE RESTRICT,
  status            text NOT NULL CONSTRAINT ck_feed_consumption_status CHECK (status IN ('DRAFT', 'POSTED')),
  branch_id         uuid NOT NULL CONSTRAINT fk_feed_consumption_branch REFERENCES mdm.branch (id) ON DELETE RESTRICT,
  version           integer NOT NULL DEFAULT 1,
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid NOT NULL CONSTRAINT fk_feed_consumption_created_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  updated_by        uuid NOT NULL CONSTRAINT fk_feed_consumption_updated_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  posted_at         timestamptz NULL,
  posted_by         uuid NULL CONSTRAINT fk_feed_consumption_posted_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  CONSTRAINT ck_feed_consumption_places CHECK (location_id <> from_location_id),
  CONSTRAINT ck_feed_consumption_posted CHECK ((status = 'POSTED') = (posted_at IS NOT NULL) AND (posted_at IS NULL) = (posted_by IS NULL)
                                               AND (status = 'POSTED') = (value_pesewas IS NOT NULL AND issue_movement_id IS NOT NULL))
);
COMMENT ON TABLE liv.feed_consumption IS 'class=DOCUMENT';
CREATE INDEX ix_feed_consumption_branch ON liv.feed_consumption (branch_id, id);
CREATE INDEX ix_feed_consumption_location ON liv.feed_consumption (location_id, consumed_on);
CREATE TRIGGER trg_feed_consumption_version BEFORE UPDATE ON liv.feed_consumption
  FOR EACH ROW EXECUTE FUNCTION platform.touch_version();
CREATE TRIGGER trg_feed_consumption_freeze BEFORE UPDATE ON liv.feed_consumption
  FOR EACH ROW EXECUTE FUNCTION platform.freeze_posted('POSTED');

-- How one feed consumption was spread across the stock units in the pen (FR-LIV-015).
CREATE TABLE liv.feed_cost_allocation (
  feed_consumption_id uuid NOT NULL CONSTRAINT fk_feed_cost_allocation_consumption REFERENCES liv.feed_consumption (id) ON DELETE RESTRICT,
  stock_unit_id       uuid NOT NULL CONSTRAINT fk_feed_cost_allocation_unit REFERENCES inv.stock_unit (id) ON DELETE RESTRICT,
  head_days           integer NOT NULL CONSTRAINT ck_feed_cost_allocation_head_days CHECK (head_days > 0),
  amount_pesewas      platform.pesewas NOT NULL,
  treatment           text NOT NULL CONSTRAINT ck_feed_cost_allocation_treatment CHECK (treatment IN ('CAPITALISED', 'EXPENSED')),
  movement_id         uuid NULL CONSTRAINT fk_feed_cost_allocation_movement REFERENCES inv.stock_movement (id) ON DELETE RESTRICT,
  recorded_at         timestamptz NOT NULL DEFAULT now(),
  actor_id            uuid NOT NULL CONSTRAINT fk_feed_cost_allocation_actor REFERENCES iam.principal (id) ON DELETE RESTRICT,
  CONSTRAINT pk_feed_cost_allocation PRIMARY KEY (feed_consumption_id, stock_unit_id),
  CONSTRAINT ck_feed_cost_allocation_movement CHECK (treatment = 'EXPENSED' OR amount_pesewas = 0 OR movement_id IS NOT NULL)
);
COMMENT ON TABLE liv.feed_cost_allocation IS 'class=LEDGER';
CREATE INDEX ix_feed_cost_allocation_unit ON liv.feed_cost_allocation (stock_unit_id);
CREATE TRIGGER trg_feed_cost_allocation_immutable BEFORE UPDATE OR DELETE ON liv.feed_cost_allocation
  FOR EACH ROW EXECUTE FUNCTION platform.reject_change();
CREATE TRIGGER trg_feed_cost_allocation_no_truncate BEFORE TRUNCATE ON liv.feed_cost_allocation
  FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_change();

CREATE FUNCTION liv.feed_consumption_spread() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  consumption_id uuid;
  consumption liv.feed_consumption;
  spread numeric;
  shares integer;
BEGIN
  IF TG_TABLE_NAME = 'feed_consumption' THEN
    consumption_id := NEW.id;
  ELSE
    consumption_id := NEW.feed_consumption_id;
  END IF;
  SELECT * INTO consumption FROM liv.feed_consumption c WHERE c.id = consumption_id;
  SELECT COALESCE(sum(a.amount_pesewas), 0), count(*) INTO spread, shares FROM liv.feed_cost_allocation a WHERE a.feed_consumption_id = consumption_id;
  IF consumption.status = 'POSTED' AND (shares = 0 OR spread <> consumption.value_pesewas) THEN
    RAISE EXCEPTION 'liv.feed_consumption %: value % but % allocations sum to %', consumption_id, consumption.value_pesewas, shares, spread
      USING ERRCODE = 'HK010', CONSTRAINT = 'ck_feed_consumption_spread';
  END IF;
  IF consumption.status <> 'POSTED' AND shares > 0 THEN
    RAISE EXCEPTION 'liv.feed_consumption %: only a posted consumption is spread', consumption_id
      USING ERRCODE = 'HK010', CONSTRAINT = 'ck_feed_consumption_spread';
  END IF;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION liv.feed_consumption_spread() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER trg_feed_consumption_spread AFTER INSERT OR UPDATE ON liv.feed_consumption
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION liv.feed_consumption_spread();
CREATE CONSTRAINT TRIGGER trg_feed_cost_allocation_spread AFTER INSERT ON liv.feed_cost_allocation
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION liv.feed_consumption_spread();

REVOKE ALL ON liv.animal, liv.weight_record, liv.health_event, liv.health_cost_allocation, liv.mortality_record, liv.ration,
  liv.feed_consumption, liv.feed_cost_allocation FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON liv.animal, liv.mortality_record, liv.ration, liv.feed_consumption TO hk_app, hk_worker;
GRANT SELECT, INSERT ON liv.weight_record, liv.health_event, liv.health_cost_allocation, liv.feed_cost_allocation TO hk_app, hk_worker;

-- migrate:down
DROP TABLE liv.feed_cost_allocation;
DROP TABLE liv.feed_consumption;
DROP FUNCTION liv.feed_consumption_spread();
DROP TABLE liv.ration;
DROP TABLE liv.mortality_record;
DROP FUNCTION liv.mortality_record_guard();
DROP TABLE liv.health_cost_allocation;
DROP TABLE liv.health_event;
DROP FUNCTION liv.health_event_spread();
DROP TABLE liv.weight_record;
DROP TABLE liv.animal;
DROP FUNCTION liv.animal_guard();
DROP SCHEMA liv;
