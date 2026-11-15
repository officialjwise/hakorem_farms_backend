-- 0080_liv_batches_breeding
-- The livestock schema, second part (docs/data-model/liv.md, ADR-0018; FR-LIV-002, FR-LIV-003, FR-LIV-006, FR-LIV-010,
-- FR-LIV-011; A-159): batches, moves between pens, breeding records and the gestation periods they are computed from,
-- and the expand of liv.animal with the batch it is managed with and the birth that produced it. Stock, location and
-- cost stay inventory's: a flock's batch shares nothing but a key with its lot, a move is a TRANSFER_INTERNAL
-- movement, and offspring enter through a BIRTH movement at nil cost.
--
-- The database holds these rules itself, whoever writes:
--   uq_batch_no, uq_batch_stock_unit  one batch per number, one batch per lot
--   liv.batch_guard                   number, species, branch, lot, start date and initial head never change; status
--                                     moves only ACTIVE -> CLOSED, with its reason; a closed batch is frozen (HK004)
--   liv.breeding_record_guard         MATED -> CONFIRMED, BORN or FAILED; CONFIRMED -> BORN or FAILED; BORN and
--                                     FAILED frozen; the dam is a FEMALE animal and the sire a MALE one (HK004)
--   ck_breeding_record_born           a BORN record has its birth date, litter and live births, live no more than
--                                     the litter, and a birth not before the mating
--   liv.animal_guard (replaced)       as 0076, and the birth that produced an animal never changes, and the sex of an
--                                     animal that is the dam of a breeding record never changes (FR-LIV-002) (HK004)
-- Additions to docs/data-model/liv.md (A-159): `branch_id`, `location_id` and the close columns on a batch;
-- `branch_id`, `stillbirths` and the DOCUMENT columns on a breeding record; the tables `liv.animal_move` and
-- `liv.gestation_period`.
-- Data category: INTERNAL (DC-10).
-- Rollback: tested (`pnpm db:rollback`), safe before the first batch, move or breeding record; afterwards forward fix
-- only, since stock units and movements cite them.

-- migrate:up
-- Gestation days per species (FR-LIV-010, SA-19), data changed only by migration: a species with a row breeds.
CREATE TABLE liv.gestation_period (
  species_code   text PRIMARY KEY CONSTRAINT ck_gestation_period_species CHECK (species_code ~ '^[A-Z][A-Z_]{1,39}$'),
  gestation_days integer NOT NULL CONSTRAINT ck_gestation_period_days CHECK (gestation_days BETWEEN 1 AND 400)
);
COMMENT ON TABLE liv.gestation_period IS 'class=LOOKUP';
INSERT INTO liv.gestation_period (species_code, gestation_days) VALUES ('GOAT', 150), ('SHEEP', 147), ('PIG', 114), ('RABBIT', 31);

-- A flock or litter managed as a group (FR-LIV-006). A lot-tracked flock's batch names its lot.
CREATE TABLE liv.batch (
  id            uuid PRIMARY KEY,
  stock_unit_id uuid NULL CONSTRAINT fk_batch_stock_unit REFERENCES inv.stock_unit (id) ON DELETE RESTRICT,
  batch_no      text NOT NULL CONSTRAINT ck_batch_no CHECK (batch_no ~ '^[A-Za-z0-9][A-Za-z0-9/_-]{0,39}$'),
  species_id    uuid NOT NULL CONSTRAINT fk_batch_species REFERENCES mdm.species (id) ON DELETE RESTRICT,
  branch_id     uuid NOT NULL CONSTRAINT fk_batch_branch REFERENCES mdm.branch (id) ON DELETE RESTRICT,
  location_id   uuid NULL CONSTRAINT fk_batch_location REFERENCES mdm.location (id) ON DELETE RESTRICT,
  started_on    date NOT NULL,
  initial_head  integer NOT NULL CONSTRAINT ck_batch_initial_head CHECK (initial_head > 0),
  purpose       text NOT NULL CONSTRAINT ck_batch_purpose CHECK (purpose IN ('GROWING', 'BREEDING', 'LAYING')),
  status        text NOT NULL DEFAULT 'ACTIVE' CONSTRAINT ck_batch_status CHECK (status IN ('ACTIVE', 'CLOSED')),
  closed_at     timestamptz NULL,
  closed_by     uuid NULL CONSTRAINT fk_batch_closed_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  close_reason  text NULL CONSTRAINT ck_batch_close_reason CHECK (length(btrim(close_reason)) BETWEEN 1 AND 500),
  version       integer NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid NOT NULL CONSTRAINT fk_batch_created_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    uuid NOT NULL CONSTRAINT fk_batch_updated_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  CONSTRAINT ck_batch_closed CHECK ((status = 'CLOSED') = (closed_at IS NOT NULL) AND (closed_at IS NULL) = (closed_by IS NULL)
                                    AND (closed_at IS NULL) = (close_reason IS NULL))
);
COMMENT ON TABLE liv.batch IS 'class=MASTER';
CREATE UNIQUE INDEX uq_batch_no ON liv.batch (batch_no);
CREATE UNIQUE INDEX uq_batch_stock_unit ON liv.batch (stock_unit_id) WHERE stock_unit_id IS NOT NULL;
CREATE INDEX ix_batch_branch ON liv.batch (branch_id, id);
CREATE TRIGGER trg_batch_version BEFORE UPDATE ON liv.batch
  FOR EACH ROW EXECUTE FUNCTION platform.touch_version();

CREATE FUNCTION liv.batch_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'ACTIVE' THEN
      RAISE EXCEPTION 'liv.batch %: a batch starts ACTIVE', NEW.id USING ERRCODE = 'HK004';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status = 'CLOSED' THEN
    RAISE EXCEPTION 'liv.batch %: a closed batch never changes', OLD.id USING ERRCODE = 'HK004';
  END IF;
  IF NEW.batch_no <> OLD.batch_no OR NEW.species_id <> OLD.species_id OR NEW.branch_id <> OLD.branch_id
     OR NEW.stock_unit_id IS DISTINCT FROM OLD.stock_unit_id OR NEW.started_on <> OLD.started_on OR NEW.initial_head <> OLD.initial_head
     OR NEW.location_id IS DISTINCT FROM OLD.location_id OR NEW.created_at <> OLD.created_at OR NEW.created_by <> OLD.created_by THEN
    RAISE EXCEPTION 'liv.batch %: number, species, branch, lot, start and initial head never change', OLD.id USING ERRCODE = 'HK004';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION liv.batch_guard() FROM PUBLIC;
CREATE TRIGGER trg_batch_guard BEFORE INSERT OR UPDATE ON liv.batch
  FOR EACH ROW EXECUTE FUNCTION liv.batch_guard();

-- A mating and its outcome (FR-LIV-010, FR-LIV-011), registered as a business document so that the offspring's stock
-- units and BIRTH movements cite it.
CREATE TABLE liv.breeding_record (
  id                uuid PRIMARY KEY CONSTRAINT fk_breeding_record_document REFERENCES platform.business_document (id) ON DELETE RESTRICT,
  dam_id            uuid NOT NULL CONSTRAINT fk_breeding_record_dam REFERENCES liv.animal (stock_unit_id) ON DELETE RESTRICT,
  sire_id           uuid NULL CONSTRAINT fk_breeding_record_sire REFERENCES liv.animal (stock_unit_id) ON DELETE RESTRICT,
  mated_on          date NOT NULL,
  expected_birth_on date NULL,
  actual_birth_on   date NULL,
  litter_size       integer NULL CONSTRAINT ck_breeding_record_litter CHECK (litter_size >= 0),
  live_births       integer NULL CONSTRAINT ck_breeding_record_live CHECK (live_births >= 0 AND live_births <= litter_size),
  stillbirths       integer NULL CONSTRAINT ck_breeding_record_still CHECK (stillbirths >= 0),
  notes             text NULL CONSTRAINT ck_breeding_record_notes CHECK (length(btrim(notes)) BETWEEN 1 AND 1000),
  fail_reason       text NULL CONSTRAINT ck_breeding_record_fail_reason CHECK (length(btrim(fail_reason)) BETWEEN 1 AND 500),
  status            text NOT NULL CONSTRAINT ck_breeding_record_status CHECK (status IN ('MATED', 'CONFIRMED', 'BORN', 'FAILED')),
  branch_id         uuid NOT NULL CONSTRAINT fk_breeding_record_branch REFERENCES mdm.branch (id) ON DELETE RESTRICT,
  version           integer NOT NULL DEFAULT 1,
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid NOT NULL CONSTRAINT fk_breeding_record_created_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  updated_by        uuid NOT NULL CONSTRAINT fk_breeding_record_updated_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  posted_at         timestamptz NULL,
  posted_by         uuid NULL CONSTRAINT fk_breeding_record_posted_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  CONSTRAINT ck_breeding_record_parents CHECK (sire_id IS DISTINCT FROM dam_id),
  CONSTRAINT ck_breeding_record_expected CHECK (expected_birth_on IS NULL OR expected_birth_on >= mated_on),
  CONSTRAINT ck_breeding_record_born CHECK ((status = 'BORN') = (actual_birth_on IS NOT NULL)
                                            AND (status = 'BORN') = (litter_size IS NOT NULL)
                                            AND (live_births IS NULL) = (litter_size IS NULL)
                                            AND (stillbirths IS NULL) = (litter_size IS NULL)
                                            AND (litter_size IS NULL OR live_births + stillbirths = litter_size)
                                            AND (actual_birth_on IS NULL OR actual_birth_on >= mated_on)),
  CONSTRAINT ck_breeding_record_failed CHECK ((status = 'FAILED') = (fail_reason IS NOT NULL)),
  CONSTRAINT ck_breeding_record_posted CHECK ((status IN ('BORN', 'FAILED')) = (posted_at IS NOT NULL) AND (posted_at IS NULL) = (posted_by IS NULL))
);
COMMENT ON TABLE liv.breeding_record IS 'class=DOCUMENT';
CREATE INDEX ix_breeding_record_branch ON liv.breeding_record (branch_id, id);
CREATE INDEX ix_breeding_record_dam ON liv.breeding_record (dam_id);
CREATE TRIGGER trg_breeding_record_version BEFORE UPDATE ON liv.breeding_record
  FOR EACH ROW EXECUTE FUNCTION platform.touch_version();
CREATE TRIGGER trg_breeding_record_freeze BEFORE UPDATE ON liv.breeding_record
  FOR EACH ROW EXECUTE FUNCTION platform.freeze_posted('BORN,FAILED');

CREATE FUNCTION liv.breeding_record_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.status <> 'MATED' AND NEW.status <> 'CONFIRMED' THEN
    RAISE EXCEPTION 'liv.breeding_record %: a record starts MATED or CONFIRMED', NEW.id USING ERRCODE = 'HK004';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'MATED' AND NEW.status IN ('CONFIRMED', 'BORN', 'FAILED'))
    OR (OLD.status = 'CONFIRMED' AND NEW.status IN ('BORN', 'FAILED'))) THEN
    RAISE EXCEPTION 'liv.breeding_record %: % cannot become %', OLD.id, OLD.status, NEW.status USING ERRCODE = 'HK004';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.dam_id <> OLD.dam_id OR NEW.sire_id IS DISTINCT FROM OLD.sire_id OR NEW.mated_on <> OLD.mated_on OR NEW.branch_id <> OLD.branch_id) THEN
    RAISE EXCEPTION 'liv.breeding_record %: the dam, the sire, the mating date and the branch never change', OLD.id USING ERRCODE = 'HK004';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM liv.animal a WHERE a.stock_unit_id = NEW.dam_id AND a.sex = 'FEMALE') THEN
      RAISE EXCEPTION 'liv.breeding_record %: the dam is a female animal', NEW.id USING ERRCODE = 'HK004';
    END IF;
    IF NEW.sire_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM liv.animal a WHERE a.stock_unit_id = NEW.sire_id AND a.sex = 'MALE') THEN
      RAISE EXCEPTION 'liv.breeding_record %: the sire is a male animal', NEW.id USING ERRCODE = 'HK004';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION liv.breeding_record_guard() FROM PUBLIC;
CREATE TRIGGER trg_breeding_record_guard BEFORE INSERT OR UPDATE ON liv.breeding_record
  FOR EACH ROW EXECUTE FUNCTION liv.breeding_record_guard();

-- A move between pens (FR-LIV-003): the record behind each TRANSFER_INTERNAL movement, for the timeline.
CREATE TABLE liv.animal_move (
  id               uuid PRIMARY KEY CONSTRAINT fk_animal_move_document REFERENCES platform.business_document (id) ON DELETE RESTRICT,
  stock_unit_id    uuid NOT NULL CONSTRAINT fk_animal_move_animal REFERENCES liv.animal (stock_unit_id) ON DELETE RESTRICT,
  branch_id        uuid NOT NULL CONSTRAINT fk_animal_move_branch REFERENCES mdm.branch (id) ON DELETE RESTRICT,
  from_location_id uuid NOT NULL CONSTRAINT fk_animal_move_from REFERENCES mdm.location (id) ON DELETE RESTRICT,
  to_location_id   uuid NOT NULL CONSTRAINT fk_animal_move_to REFERENCES mdm.location (id) ON DELETE RESTRICT,
  movement_id      uuid NOT NULL CONSTRAINT fk_animal_move_movement REFERENCES inv.stock_movement (id) ON DELETE RESTRICT,
  note             text NULL CONSTRAINT ck_animal_move_note CHECK (length(btrim(note)) BETWEEN 1 AND 500),
  occurred_at      timestamptz NOT NULL,
  recorded_at      timestamptz NOT NULL DEFAULT now(),
  actor_id         uuid NOT NULL CONSTRAINT fk_animal_move_actor REFERENCES iam.principal (id) ON DELETE RESTRICT,
  CONSTRAINT ck_animal_move_locations CHECK (from_location_id <> to_location_id)
);
COMMENT ON TABLE liv.animal_move IS 'class=LEDGER';
CREATE INDEX ix_animal_move_unit ON liv.animal_move (stock_unit_id, occurred_at);
CREATE TRIGGER trg_animal_move_immutable BEFORE UPDATE OR DELETE ON liv.animal_move
  FOR EACH ROW EXECUTE FUNCTION platform.reject_change();
CREATE TRIGGER trg_animal_move_no_truncate BEFORE TRUNCATE ON liv.animal_move
  FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_change();

-- Expand (docs/DATA_MODEL.md, Migrations): the two references 0076 left for this session. Nullable, so the previous
-- release runs against this schema unchanged.
ALTER TABLE liv.animal
  ADD COLUMN batch_id uuid NULL CONSTRAINT fk_animal_batch REFERENCES liv.batch (id) ON DELETE RESTRICT,
  ADD COLUMN breeding_record_id uuid NULL CONSTRAINT fk_animal_breeding_record REFERENCES liv.breeding_record (id) ON DELETE RESTRICT;
CREATE INDEX ix_animal_breeding_record ON liv.animal (breeding_record_id) WHERE breeding_record_id IS NOT NULL;

CREATE OR REPLACE FUNCTION liv.animal_guard() RETURNS trigger
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
     OR NEW.breeding_record_id IS DISTINCT FROM OLD.breeding_record_id OR NEW.dam_id IS DISTINCT FROM OLD.dam_id
     OR NEW.sire_id IS DISTINCT FROM OLD.sire_id OR NEW.tag_no <> OLD.tag_no
     OR NEW.created_at <> OLD.created_at OR NEW.created_by <> OLD.created_by THEN
    RAISE EXCEPTION 'liv.animal %: tag, species, product, branch, acquisition, source and parentage never change', OLD.stock_unit_id USING ERRCODE = 'HK004';
  END IF;
  IF NEW.sex <> OLD.sex AND EXISTS (SELECT 1 FROM liv.breeding_record r WHERE r.dam_id = OLD.stock_unit_id) THEN
    RAISE EXCEPTION 'liv.animal %: the sex of a dam never changes', OLD.stock_unit_id USING ERRCODE = 'HK004';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'ALIVE' AND NEW.status IN ('SOLD', 'SLAUGHTERED', 'DEAD', 'CULLED'))
    OR (OLD.status <> 'ALIVE' AND NEW.status = 'ALIVE')) THEN
    RAISE EXCEPTION 'liv.animal %: % cannot become %', OLD.stock_unit_id, OLD.status, NEW.status USING ERRCODE = 'HK004';
  END IF;
  RETURN NEW;
END
$$;

REVOKE ALL ON liv.gestation_period, liv.batch, liv.breeding_record, liv.animal_move FROM PUBLIC;
GRANT SELECT ON liv.gestation_period TO hk_app, hk_worker;
GRANT SELECT, INSERT, UPDATE ON liv.batch, liv.breeding_record TO hk_app, hk_worker;
GRANT SELECT, INSERT ON liv.animal_move TO hk_app, hk_worker;

-- migrate:down
CREATE OR REPLACE FUNCTION liv.animal_guard() RETURNS trigger
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
ALTER TABLE liv.animal DROP COLUMN breeding_record_id, DROP COLUMN batch_id;
DROP TABLE liv.animal_move;
DROP TABLE liv.breeding_record;
DROP FUNCTION liv.breeding_record_guard();
DROP TABLE liv.batch;
DROP FUNCTION liv.batch_guard();
DROP TABLE liv.gestation_period;
