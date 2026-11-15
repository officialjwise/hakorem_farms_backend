-- 0021_mdm_parties_locations
-- What the parties and locations administration of B04d continued 2 needs in mdm (docs/data-model/mdm.md,
-- FR-MDM-006, FR-MDM-008, FR-MDM-021): customer numbers from a sequence, saved delivery addresses, and virtual
-- locations that nothing may change once their branch has them. The address's delivery zone column arrives with
-- mdm.delivery_zone in B04d continued 3, by an expand migration of its own (A-112).
-- Data category: CONFIDENTIAL (customer addresses and recipient phone numbers are personal data, FR-AUD-011).
-- Rollback: tested (`pnpm db:rollback`); safe before the first address is saved, afterwards a forward fix only.

-- migrate:up
-- Customer numbers C-00001 onward. Not a financial document, so a gap left by a rolled-back create is harmless.
-- The sequence starts after any number an earlier seed wrote directly.
CREATE SEQUENCE mdm.customer_no_seq AS bigint MINVALUE 1;
SELECT setval('mdm.customer_no_seq', coalesce((SELECT max(substring(customer_no FROM 3)::bigint) FROM mdm.customer), 0) + 1, false);
REVOKE ALL ON SEQUENCE mdm.customer_no_seq FROM PUBLIC;
GRANT USAGE ON SEQUENCE mdm.customer_no_seq TO hk_app, hk_worker;

CREATE TABLE mdm.customer_address (
  id                   uuid PRIMARY KEY,
  customer_id          uuid NOT NULL CONSTRAINT fk_customer_address_customer REFERENCES mdm.customer (id) ON DELETE RESTRICT,
  label                text NOT NULL CONSTRAINT ck_customer_address_label CHECK (length(btrim(label)) BETWEEN 1 AND 60),
  recipient_name       text NOT NULL CONSTRAINT ck_customer_address_recipient CHECK (length(btrim(recipient_name)) BETWEEN 1 AND 160),
  recipient_phone_e164 text NOT NULL CONSTRAINT ck_customer_address_phone CHECK (recipient_phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  line1                text NOT NULL CONSTRAINT ck_customer_address_line1 CHECK (length(line1) <= 200),
  area                 text NOT NULL CONSTRAINT ck_customer_address_area CHECK (length(btrim(area)) BETWEEN 1 AND 120),
  city                 text NOT NULL CONSTRAINT ck_customer_address_city CHECK (length(btrim(city)) BETWEEN 1 AND 120),
  region               text NOT NULL CONSTRAINT ck_customer_address_region CHECK (region IN (
                         'Ahafo', 'Ashanti', 'Bono', 'Bono East', 'Central', 'Eastern', 'Greater Accra', 'North East', 'Northern',
                         'Oti', 'Savannah', 'Upper East', 'Upper West', 'Volta', 'Western', 'Western North')),
  digital_address      text NULL CONSTRAINT ck_customer_address_digital CHECK (digital_address ~ '^[A-Z]{2}-[0-9]{3,4}-[0-9]{4}$'),
  directions           text NULL CONSTRAINT ck_customer_address_directions CHECK (length(directions) <= 1000),
  latitude             numeric(9,6) NULL CONSTRAINT ck_customer_address_latitude CHECK (latitude BETWEEN -90 AND 90),
  longitude            numeric(9,6) NULL CONSTRAINT ck_customer_address_longitude CHECK (longitude BETWEEN -180 AND 180),
  is_default           boolean NOT NULL DEFAULT false,
  version              integer NOT NULL DEFAULT 1,
  created_at           timestamptz NOT NULL DEFAULT now(),
  created_by           uuid NOT NULL CONSTRAINT fk_customer_address_created_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  updated_by           uuid NOT NULL CONSTRAINT fk_customer_address_updated_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  deleted_at           timestamptz NULL,
  deleted_by           uuid NULL CONSTRAINT fk_customer_address_deleted_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  delete_reason        text NULL,
  -- FR-MDM-008: an address needs a landmark or a digital address.
  CONSTRAINT ck_customer_address_landmark CHECK (length(btrim(line1)) > 0 OR digital_address IS NOT NULL),
  CONSTRAINT ck_customer_address_coordinates CHECK ((latitude IS NULL) = (longitude IS NULL)),
  CONSTRAINT ck_customer_address_soft_delete CHECK ((deleted_at IS NULL) = (deleted_by IS NULL) AND (deleted_at IS NULL) = (delete_reason IS NULL))
);
COMMENT ON TABLE mdm.customer_address IS 'class=MASTER';
CREATE INDEX ix_customer_address_customer ON mdm.customer_address (customer_id) WHERE deleted_at IS NULL;
-- One default address per customer among live rows.
CREATE UNIQUE INDEX uq_customer_address_default ON mdm.customer_address (customer_id) WHERE is_default AND deleted_at IS NULL;
CREATE TRIGGER trg_customer_address_version BEFORE UPDATE ON mdm.customer_address
  FOR EACH ROW EXECUTE FUNCTION platform.touch_version();
REVOKE ALL ON mdm.customer_address FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON mdm.customer_address TO hk_app, hk_worker;

-- FR-MDM-006: virtual locations are seeded with their branch and cannot be edited or archived. SQLSTATE 23514.
CREATE FUNCTION mdm.location_virtual_fixed() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'mdm.location %: a virtual location cannot be changed', OLD.id USING ERRCODE = '23514', CONSTRAINT = 'ck_location_virtual_fixed';
END
$$;
REVOKE ALL ON FUNCTION mdm.location_virtual_fixed() FROM PUBLIC;
CREATE TRIGGER trg_location_virtual_fixed BEFORE UPDATE ON mdm.location
  FOR EACH ROW WHEN (OLD.is_virtual) EXECUTE FUNCTION mdm.location_virtual_fixed();

-- migrate:down
DROP TRIGGER trg_location_virtual_fixed ON mdm.location;
DROP FUNCTION mdm.location_virtual_fixed();
DROP TABLE mdm.customer_address;
DROP SEQUENCE mdm.customer_no_seq;
