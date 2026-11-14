-- 0003_mdm_create_branch_location
-- The MDM schema and the two universally referenceable scope tables, branch and location (docs/data-model/mdm.md,
-- ADR-0007, ADR-0011). Created in B3 because role grants, the document registry and the outbox name a branch.
-- Data category: INTERNAL (branch addresses and phone numbers are the business's own).

-- migrate:up
CREATE SCHEMA mdm AUTHORIZATION hk_owner;
REVOKE ALL ON SCHEMA mdm FROM PUBLIC;
GRANT USAGE ON SCHEMA mdm TO hk_app, hk_worker;

CREATE TABLE mdm.branch (
  id            uuid PRIMARY KEY,
  code          text NOT NULL CONSTRAINT uq_branch_code UNIQUE CONSTRAINT ck_branch_code CHECK (code ~ '^[A-Z0-9]{2,5}$'),
  name          text NOT NULL CONSTRAINT ck_branch_name CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  address       text NULL,
  phone_e164    text NULL CONSTRAINT ck_branch_phone CHECK (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  is_test       boolean NOT NULL DEFAULT false,
  status        text NOT NULL CONSTRAINT ck_branch_status CHECK (status IN ('ACTIVE', 'CLOSED')),
  version       integer NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid NOT NULL CONSTRAINT fk_branch_created_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    uuid NOT NULL CONSTRAINT fk_branch_updated_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  deleted_at    timestamptz NULL,
  deleted_by    uuid NULL CONSTRAINT fk_branch_deleted_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  delete_reason text NULL,
  CONSTRAINT ck_branch_soft_delete CHECK ((deleted_at IS NULL) = (deleted_by IS NULL) AND (deleted_at IS NULL) = (delete_reason IS NULL))
);
COMMENT ON TABLE mdm.branch IS 'class=MASTER';
CREATE TRIGGER trg_branch_version BEFORE UPDATE ON mdm.branch
  FOR EACH ROW EXECUTE FUNCTION platform.touch_version();

CREATE TABLE mdm.location (
  id              uuid PRIMARY KEY,
  branch_id       uuid NOT NULL CONSTRAINT fk_location_branch REFERENCES mdm.branch (id) ON DELETE RESTRICT,
  parent_id       uuid NULL CONSTRAINT fk_location_parent REFERENCES mdm.location (id) ON DELETE RESTRICT,
  code            text NOT NULL CONSTRAINT ck_location_code CHECK (code ~ '^[A-Z0-9_-]{2,20}$'),
  name            text NOT NULL CONSTRAINT ck_location_name CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  kind            text NOT NULL CONSTRAINT ck_location_kind CHECK (kind IN (
                    'SITE', 'PEN', 'COLD_ROOM', 'STORE', 'SHOP_FLOOR', 'VEHICLE', 'RETURNS_HOLD', 'QUARANTINE', 'IN_TRANSIT',
                    'SUPPLIER', 'CUSTOMER', 'PRODUCTION', 'PROCESSING', 'CONSUMPTION', 'LOSS', 'ADJUSTMENT', 'OPENING')),
  is_virtual      boolean NOT NULL,
  is_sellable     boolean NOT NULL DEFAULT false,
  allows_negative boolean NOT NULL DEFAULT false,
  temp_class      text NULL CONSTRAINT ck_location_temp_class CHECK (temp_class IN ('AMBIENT', 'CHILLED', 'FROZEN')),
  temp_min_c      numeric(4,1) NULL,
  temp_max_c      numeric(4,1) NULL,
  capacity_head   integer NULL CONSTRAINT ck_location_capacity CHECK (capacity_head > 0),
  version         integer NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid NOT NULL CONSTRAINT fk_location_created_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      uuid NOT NULL CONSTRAINT fk_location_updated_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  deleted_at      timestamptz NULL,
  deleted_by      uuid NULL CONSTRAINT fk_location_deleted_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  delete_reason   text NULL,
  -- The last eight kinds are virtual (ADR-0002): stock is never physically there.
  CONSTRAINT ck_location_virtual CHECK (is_virtual = (kind IN ('SUPPLIER', 'CUSTOMER', 'PRODUCTION', 'PROCESSING', 'CONSUMPTION', 'LOSS', 'ADJUSTMENT', 'OPENING'))),
  CONSTRAINT ck_location_temperatures CHECK (temp_min_c IS NULL OR temp_max_c IS NULL OR temp_min_c < temp_max_c),
  CONSTRAINT ck_location_soft_delete CHECK ((deleted_at IS NULL) = (deleted_by IS NULL) AND (deleted_at IS NULL) = (delete_reason IS NULL))
);
COMMENT ON TABLE mdm.location IS 'class=MASTER';
CREATE UNIQUE INDEX uq_location_branch_code ON mdm.location (branch_id, code) WHERE deleted_at IS NULL;
CREATE INDEX ix_location_parent ON mdm.location (parent_id);
CREATE TRIGGER trg_location_version BEFORE UPDATE ON mdm.location
  FOR EACH ROW EXECUTE FUNCTION platform.touch_version();

-- A location's parent belongs to the same branch.
CREATE FUNCTION mdm.location_parent_same_branch() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.parent_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM mdm.location p WHERE p.id = NEW.parent_id AND p.branch_id = NEW.branch_id
  ) THEN
    RAISE EXCEPTION 'mdm.location %: the parent location belongs to another branch', NEW.id USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION mdm.location_parent_same_branch() FROM PUBLIC;
CREATE TRIGGER trg_location_parent_same_branch BEFORE INSERT OR UPDATE OF parent_id, branch_id ON mdm.location
  FOR EACH ROW EXECUTE FUNCTION mdm.location_parent_same_branch();

REVOKE ALL ON ALL TABLES IN SCHEMA mdm FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON mdm.branch, mdm.location TO hk_app, hk_worker;

-- migrate:down
DROP TABLE mdm.location;
DROP FUNCTION mdm.location_parent_same_branch();
DROP TABLE mdm.branch;
DROP SCHEMA mdm;
