-- 0118_del_delivery_slot
-- The delivery schema's first table (docs/data-model/del.md; FR-DEL-001 without its capacity rule; ADR-0026's
-- delivery split, SA-13): `del.delivery_slot` and nothing else, created early so that the storefront checkout's
-- foreign key exists from the first checkout, as B3 created `mdm.branch` early (ADR-0011). B11 adds deliveries,
-- bookings under a row lock, cut-offs and the rest of the module around it.
-- The database holds the slot's own rules:
--   ck_delivery_slot_times     a slot ends after it starts
--   ck_delivery_slot_capacity  capacity is above zero
--   ck_delivery_slot_booked    bookings are never negative and never above capacity, so capacity cannot be reduced
--                              below what is booked, whoever writes (FR-DEL-001)
--   uq_delivery_slot_start     one live slot per zone, date and start time: generating twice adds nothing
-- Data category: INTERNAL (DC-13).
-- Rollback: tested (`pnpm db:rollback`), safe before the first checkout names a slot; afterwards forward fix only.

-- migrate:up
CREATE SCHEMA del AUTHORIZATION hk_owner;
REVOKE ALL ON SCHEMA del FROM PUBLIC;
GRANT USAGE ON SCHEMA del TO hk_app, hk_worker, hk_report;

CREATE TABLE del.delivery_slot (
  id               uuid PRIMARY KEY,
  branch_id        uuid NOT NULL CONSTRAINT fk_delivery_slot_branch REFERENCES mdm.branch (id) ON DELETE RESTRICT,
  delivery_zone_id uuid NOT NULL CONSTRAINT fk_delivery_slot_zone REFERENCES mdm.delivery_zone (id) ON DELETE RESTRICT,
  slot_date        date NOT NULL,
  starts_at        time NOT NULL,
  ends_at          time NOT NULL,
  capacity         integer NOT NULL CONSTRAINT ck_delivery_slot_capacity CHECK (capacity > 0 AND capacity <= 1000),
  booked           integer NOT NULL DEFAULT 0,
  version          integer NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid NOT NULL CONSTRAINT fk_delivery_slot_created_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       uuid NOT NULL CONSTRAINT fk_delivery_slot_updated_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  deleted_at       timestamptz NULL,
  deleted_by       uuid NULL CONSTRAINT fk_delivery_slot_deleted_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  delete_reason    text NULL,
  CONSTRAINT ck_delivery_slot_times CHECK (ends_at > starts_at),
  CONSTRAINT ck_delivery_slot_booked CHECK (booked >= 0 AND booked <= capacity),
  CONSTRAINT ck_delivery_slot_soft_delete CHECK ((deleted_at IS NULL) = (deleted_by IS NULL) AND (deleted_at IS NULL) = (delete_reason IS NULL))
);
COMMENT ON TABLE del.delivery_slot IS 'class=MASTER';
CREATE UNIQUE INDEX uq_delivery_slot_start ON del.delivery_slot (delivery_zone_id, slot_date, starts_at) WHERE deleted_at IS NULL;
CREATE INDEX ix_delivery_slot_date ON del.delivery_slot (slot_date, delivery_zone_id) WHERE deleted_at IS NULL;
-- The lists' order (CR-019's keyset): by when the slot starts, then its id.
CREATE INDEX ix_delivery_slot_start ON del.delivery_slot ((slot_date + starts_at), id) WHERE deleted_at IS NULL;
CREATE TRIGGER trg_delivery_slot_version BEFORE UPDATE ON del.delivery_slot
  FOR EACH ROW EXECUTE FUNCTION platform.touch_version();

REVOKE ALL ON del.delivery_slot FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON del.delivery_slot TO hk_app, hk_worker;

-- migrate:down
DROP TABLE del.delivery_slot;
DROP SCHEMA del;
