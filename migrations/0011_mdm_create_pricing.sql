-- 0011_mdm_create_pricing
-- The pricing sub-domain (docs/data-model/mdm.md, ADR-0004, ADR-0036): grades and weight bands per species,
-- customer tiers (seeded) and customers as pricing inputs, price lists, their effective-dated versions with
-- maker-checker activation, their entries, and the price list assigned to a customer.
-- Every overlap the engine could otherwise have to break a tie on is made impossible here: weight bands of one
-- species, ACTIVE versions of one list, entries of one version, assignments of one customer.
-- Promotions, coupons, the tax scheme and the reference data tables arrive with B04 continued.
-- Data category: PUBLIC (grades, bands, tiers), INTERNAL (price lists and entries), CONFIDENTIAL (customer name,
-- phone and email; the TIN is RESTRICTED and encrypted, ADR-0022).
-- Rollback: tested (`pnpm db:rollback`) while the tables are empty of business data; once a version has priced a
-- sale, forward fix only.

-- migrate:up
CREATE TABLE mdm.grade (
  id            uuid PRIMARY KEY,
  species_id    uuid NOT NULL CONSTRAINT fk_grade_species REFERENCES mdm.species (id) ON DELETE RESTRICT,
  code          text NOT NULL CONSTRAINT ck_grade_code CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{0,19}$'),
  name          text NOT NULL CONSTRAINT ck_grade_name CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  description   text NULL CONSTRAINT ck_grade_description CHECK (length(description) <= 500),
  sort_order    integer NOT NULL DEFAULT 0,
  version       integer NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid NOT NULL CONSTRAINT fk_grade_created_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    uuid NOT NULL CONSTRAINT fk_grade_updated_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  deleted_at    timestamptz NULL,
  deleted_by    uuid NULL CONSTRAINT fk_grade_deleted_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  delete_reason text NULL,
  CONSTRAINT ck_grade_soft_delete CHECK ((deleted_at IS NULL) = (deleted_by IS NULL) AND (deleted_at IS NULL) = (delete_reason IS NULL))
);
COMMENT ON TABLE mdm.grade IS 'class=MASTER';
CREATE UNIQUE INDEX uq_grade_species_code ON mdm.grade (species_id, code) WHERE deleted_at IS NULL;
CREATE TRIGGER trg_grade_version BEFORE UPDATE ON mdm.grade
  FOR EACH ROW EXECUTE FUNCTION platform.touch_version();

CREATE TABLE mdm.weight_band (
  id            uuid PRIMARY KEY,
  species_id    uuid NOT NULL CONSTRAINT fk_weight_band_species REFERENCES mdm.species (id) ON DELETE RESTRICT,
  code          text NOT NULL CONSTRAINT ck_weight_band_code CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{0,19}$'),
  min_kg        platform.kg NOT NULL,
  max_kg        platform.kg NOT NULL,
  version       integer NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid NOT NULL CONSTRAINT fk_weight_band_created_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    uuid NOT NULL CONSTRAINT fk_weight_band_updated_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  deleted_at    timestamptz NULL,
  deleted_by    uuid NULL CONSTRAINT fk_weight_band_deleted_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  delete_reason text NULL,
  CONSTRAINT ck_weight_band_range CHECK (max_kg > min_kg),
  CONSTRAINT ck_weight_band_soft_delete CHECK ((deleted_at IS NULL) = (deleted_by IS NULL) AND (deleted_at IS NULL) = (delete_reason IS NULL)),
  -- Half-open [min, max): 20.000 kg falls in exactly one band (FR-MDM-005).
  CONSTRAINT ex_weight_band_no_overlap EXCLUDE USING gist (species_id WITH =, numrange(min_kg, max_kg, '[)') WITH &&) WHERE (deleted_at IS NULL)
);
COMMENT ON TABLE mdm.weight_band IS 'class=MASTER';
CREATE UNIQUE INDEX uq_weight_band_species_code ON mdm.weight_band (species_id, code) WHERE deleted_at IS NULL;
CREATE TRIGGER trg_weight_band_version BEFORE UPDATE ON mdm.weight_band
  FOR EACH ROW EXECUTE FUNCTION platform.touch_version();

CREATE TABLE mdm.customer_tier (
  id            uuid PRIMARY KEY,
  code          text NOT NULL CONSTRAINT ck_customer_tier_code CHECK (code ~ '^[A-Z][A-Z_]{1,39}$'),
  name          text NOT NULL CONSTRAINT ck_customer_tier_name CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  version       integer NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid NOT NULL CONSTRAINT fk_customer_tier_created_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    uuid NOT NULL CONSTRAINT fk_customer_tier_updated_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  deleted_at    timestamptz NULL,
  deleted_by    uuid NULL CONSTRAINT fk_customer_tier_deleted_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  delete_reason text NULL,
  CONSTRAINT ck_customer_tier_soft_delete CHECK ((deleted_at IS NULL) = (deleted_by IS NULL) AND (deleted_at IS NULL) = (delete_reason IS NULL))
);
COMMENT ON TABLE mdm.customer_tier IS 'class=MASTER';
CREATE UNIQUE INDEX uq_customer_tier_code ON mdm.customer_tier (code) WHERE deleted_at IS NULL;
CREATE TRIGGER trg_customer_tier_version BEFORE UPDATE ON mdm.customer_tier
  FOR EACH ROW EXECUTE FUNCTION platform.touch_version();
INSERT INTO mdm.customer_tier (id, code, name, created_by, updated_by) VALUES
  ('01900000-0000-7000-8000-000000000301', 'RETAIL', 'Retail', '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001'),
  ('01900000-0000-7000-8000-000000000302', 'WHOLESALE', 'Wholesale', '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001'),
  ('01900000-0000-7000-8000-000000000303', 'RESELLER', 'Reseller', '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001');

CREATE TABLE mdm.customer (
  id                   uuid PRIMARY KEY,
  customer_no          text NOT NULL CONSTRAINT uq_customer_no UNIQUE CONSTRAINT ck_customer_no CHECK (customer_no ~ '^C-[0-9]{5,10}$'),
  kind                 text NOT NULL CONSTRAINT ck_customer_kind CHECK (kind IN ('INDIVIDUAL', 'BUSINESS')),
  name                 text NOT NULL CONSTRAINT ck_customer_name CHECK (length(btrim(name)) BETWEEN 1 AND 160),
  phone_e164           text NULL CONSTRAINT ck_customer_phone CHECK (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  phone_hash           bytea NULL CONSTRAINT ck_customer_phone_hash CHECK (length(phone_hash) = 32),
  email                text NULL CONSTRAINT ck_customer_email CHECK (length(email) <= 254 AND email ~ '^[^@[:space:]]+@[^@[:space:]]+$'),
  tier_id              uuid NOT NULL CONSTRAINT fk_customer_tier REFERENCES mdm.customer_tier (id) ON DELETE RESTRICT,
  principal_id         uuid NULL CONSTRAINT uq_customer_principal UNIQUE CONSTRAINT fk_customer_principal REFERENCES iam.principal (id) ON DELETE RESTRICT,
  tin_enc              bytea NULL,
  marketing_consent_at timestamptz NULL,
  status               text NOT NULL CONSTRAINT ck_customer_status CHECK (status IN ('ACTIVE', 'BLOCKED', 'ANONYMISED')),
  version              integer NOT NULL DEFAULT 1,
  created_at           timestamptz NOT NULL DEFAULT now(),
  created_by           uuid NOT NULL CONSTRAINT fk_customer_created_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  updated_by           uuid NOT NULL CONSTRAINT fk_customer_updated_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  deleted_at           timestamptz NULL,
  deleted_by           uuid NULL CONSTRAINT fk_customer_deleted_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  delete_reason        text NULL,
  CONSTRAINT ck_customer_phone_pair CHECK ((phone_e164 IS NULL) = (phone_hash IS NULL)),
  CONSTRAINT ck_customer_soft_delete CHECK ((deleted_at IS NULL) = (deleted_by IS NULL) AND (deleted_at IS NULL) = (delete_reason IS NULL))
);
COMMENT ON TABLE mdm.customer IS 'class=MASTER';
-- One live customer per phone number, found by keyed hash so the number itself is never indexed (FR-MDM-008).
CREATE UNIQUE INDEX uq_customer_phone_hash ON mdm.customer (phone_hash) WHERE deleted_at IS NULL AND phone_hash IS NOT NULL;
CREATE INDEX ix_customer_tier ON mdm.customer (tier_id) WHERE deleted_at IS NULL;
CREATE TRIGGER trg_customer_version BEFORE UPDATE ON mdm.customer
  FOR EACH ROW EXECUTE FUNCTION platform.touch_version();

CREATE TABLE mdm.price_list (
  id               uuid PRIMARY KEY,
  code             text NOT NULL CONSTRAINT ck_price_list_code CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{1,39}$'),
  name             text NOT NULL CONSTRAINT ck_price_list_name CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  kind             text NOT NULL CONSTRAINT ck_price_list_kind CHECK (kind IN ('BASE', 'CHANNEL', 'TIER', 'CUSTOMER')),
  channel          text NULL CONSTRAINT ck_price_list_channel CHECK (channel IN ('POS', 'ONLINE', 'WHOLESALE', 'QUOTE')),
  customer_tier_id uuid NULL CONSTRAINT fk_price_list_customer_tier REFERENCES mdm.customer_tier (id) ON DELETE RESTRICT,
  branch_id        uuid NULL CONSTRAINT fk_price_list_branch REFERENCES mdm.branch (id) ON DELETE RESTRICT,
  tax_inclusive    boolean NOT NULL,
  currency         char(3) NOT NULL DEFAULT 'GHS' CONSTRAINT ck_price_list_currency CHECK (currency = 'GHS'),
  version          integer NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid NOT NULL CONSTRAINT fk_price_list_created_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       uuid NOT NULL CONSTRAINT fk_price_list_updated_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  deleted_at       timestamptz NULL,
  deleted_by       uuid NULL CONSTRAINT fk_price_list_deleted_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  delete_reason    text NULL,
  -- The slot in the resolution order (ADR-0004): TIER is tier and channel, CHANNEL is channel, BASE and CUSTOMER neither.
  CONSTRAINT ck_price_list_slot CHECK (
    (kind = 'TIER' AND channel IS NOT NULL AND customer_tier_id IS NOT NULL)
    OR (kind = 'CHANNEL' AND channel IS NOT NULL AND customer_tier_id IS NULL)
    OR (kind IN ('BASE', 'CUSTOMER') AND channel IS NULL AND customer_tier_id IS NULL)),
  CONSTRAINT ck_price_list_soft_delete CHECK ((deleted_at IS NULL) = (deleted_by IS NULL) AND (deleted_at IS NULL) = (delete_reason IS NULL))
);
COMMENT ON TABLE mdm.price_list IS 'class=MASTER';
CREATE UNIQUE INDEX uq_price_list_code ON mdm.price_list (code) WHERE deleted_at IS NULL;
-- One list per slot, so the walk never has two lists to choose between.
CREATE UNIQUE INDEX uq_price_list_slot ON mdm.price_list (kind, channel, customer_tier_id, branch_id) NULLS NOT DISTINCT
  WHERE deleted_at IS NULL AND kind <> 'CUSTOMER';
CREATE TRIGGER trg_price_list_version BEFORE UPDATE ON mdm.price_list
  FOR EACH ROW EXECUTE FUNCTION platform.touch_version();

CREATE TABLE mdm.price_list_version (
  id                  uuid PRIMARY KEY CONSTRAINT fk_price_list_version_document REFERENCES platform.business_document (id) ON DELETE RESTRICT,
  price_list_id       uuid NOT NULL CONSTRAINT fk_price_list_version_list REFERENCES mdm.price_list (id) ON DELETE RESTRICT,
  version_no          integer NOT NULL CONSTRAINT ck_price_list_version_no CHECK (version_no > 0),
  status              text NOT NULL CONSTRAINT ck_price_list_version_status CHECK (status IN ('DRAFT', 'PENDING_APPROVAL', 'ACTIVE', 'SUPERSEDED', 'REJECTED')),
  valid_from          timestamptz NOT NULL,
  valid_to            timestamptz NULL,
  approval_request_id uuid NULL CONSTRAINT fk_price_list_version_approval REFERENCES iam.approval_request (id) ON DELETE RESTRICT,
  activated_at        timestamptz NULL,
  activated_by        uuid NULL CONSTRAINT fk_price_list_version_activated_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  notes               text NULL CONSTRAINT ck_price_list_version_notes CHECK (length(notes) <= 500),
  branch_id           uuid NOT NULL CONSTRAINT fk_price_list_version_branch REFERENCES mdm.branch (id) ON DELETE RESTRICT,
  version             integer NOT NULL DEFAULT 1,
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid NOT NULL CONSTRAINT fk_price_list_version_created_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  updated_by          uuid NOT NULL CONSTRAINT fk_price_list_version_updated_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  CONSTRAINT uq_price_list_version_no UNIQUE (price_list_id, version_no),
  CONSTRAINT ck_price_list_version_window CHECK (valid_to IS NULL OR valid_to > valid_from),
  -- Nothing is active without an approval, and an activation records who and when.
  CONSTRAINT ck_price_list_version_approved CHECK (status NOT IN ('PENDING_APPROVAL', 'ACTIVE', 'SUPERSEDED') OR approval_request_id IS NOT NULL),
  CONSTRAINT ck_price_list_version_activation CHECK ((status IN ('ACTIVE', 'SUPERSEDED')) = (activated_at IS NOT NULL AND activated_by IS NOT NULL)),
  CONSTRAINT ex_price_list_version_no_overlap EXCLUDE USING gist (price_list_id WITH =, tstzrange(valid_from, valid_to, '[)') WITH &&) WHERE (status = 'ACTIVE')
);
COMMENT ON TABLE mdm.price_list_version IS 'class=DOCUMENT';
CREATE INDEX ix_price_list_version_active ON mdm.price_list_version (price_list_id, valid_from) WHERE status = 'ACTIVE';
CREATE UNIQUE INDEX uq_price_list_version_draft ON mdm.price_list_version (price_list_id) WHERE status IN ('DRAFT', 'PENDING_APPROVAL');
CREATE TRIGGER trg_price_list_version_version BEFORE UPDATE ON mdm.price_list_version
  FOR EACH ROW EXECUTE FUNCTION platform.touch_version();

-- The version lifecycle (FR-MDM-015): DRAFT -> PENDING_APPROVAL -> ACTIVE or REJECTED; ACTIVE -> SUPERSEDED. Once
-- submitted nothing but the lifecycle columns moves; once ACTIVE only status (to SUPERSEDED) and an earlier
-- valid_to may change, so a sale line's rule reference reproduces its price forever. Activation may move
-- valid_from later, to the moment of approval, never earlier: approving late cannot reprice the past (ADR-0036).
-- SQLSTATE HK004.
CREATE FUNCTION mdm.price_list_version_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  lifecycle text[] := ARRAY['status', 'approval_request_id', 'activated_at', 'activated_by', 'valid_from', 'valid_to', 'version', 'updated_at', 'updated_by'];
BEGIN
  IF OLD.status = 'DRAFT' AND NEW.status IN ('DRAFT', 'PENDING_APPROVAL') THEN
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - lifecycle) IS DISTINCT FROM (to_jsonb(OLD) - lifecycle)
     OR NOT ((OLD.status = 'PENDING_APPROVAL' AND NEW.status IN ('ACTIVE', 'REJECTED'))
          OR (OLD.status = 'ACTIVE' AND NEW.status IN ('ACTIVE', 'SUPERSEDED')))
     OR (NEW.valid_from IS DISTINCT FROM OLD.valid_from
         AND NOT (OLD.status = 'PENDING_APPROVAL' AND NEW.status = 'ACTIVE' AND NEW.valid_from > OLD.valid_from))
     OR (NEW.valid_to IS DISTINCT FROM OLD.valid_to
         AND (OLD.status <> 'ACTIVE' OR NEW.valid_to IS NULL OR (OLD.valid_to IS NOT NULL AND NEW.valid_to > OLD.valid_to)))
     OR (OLD.status = 'ACTIVE' AND (NEW.approval_request_id, NEW.activated_at, NEW.activated_by)
                                   IS DISTINCT FROM (OLD.approval_request_id, OLD.activated_at, OLD.activated_by)) THEN
    RAISE EXCEPTION 'mdm.price_list_version % is frozen in status %; it cannot become % with these values', OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'HK004';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION mdm.price_list_version_guard() FROM PUBLIC;
CREATE TRIGGER trg_price_list_version_guard BEFORE UPDATE ON mdm.price_list_version
  FOR EACH ROW EXECUTE FUNCTION mdm.price_list_version_guard();

CREATE TABLE mdm.price_list_entry (
  id                    uuid PRIMARY KEY,
  version_id            uuid NOT NULL CONSTRAINT fk_price_list_entry_version REFERENCES mdm.price_list_version (id) ON DELETE RESTRICT,
  product_id            uuid NOT NULL CONSTRAINT fk_price_list_entry_product REFERENCES mdm.product (id) ON DELETE RESTRICT,
  grade_id              uuid NULL CONSTRAINT fk_price_list_entry_grade REFERENCES mdm.grade (id) ON DELETE RESTRICT,
  weight_band_id        uuid NULL CONSTRAINT fk_price_list_entry_weight_band REFERENCES mdm.weight_band (id) ON DELETE RESTRICT,
  basis                 text NOT NULL CONSTRAINT ck_price_list_entry_basis CHECK (basis IN ('PER_HEAD', 'PER_KG', 'PER_UNIT')),
  list_price_pesewas    platform.pesewas NOT NULL,
  floor_price_pesewas   platform.pesewas NOT NULL,
  ceiling_price_pesewas platform.pesewas NOT NULL,
  quote_only            boolean NOT NULL DEFAULT false,
  min_qty               platform.qty NOT NULL DEFAULT 0,
  version               integer NOT NULL DEFAULT 1,
  created_at            timestamptz NOT NULL DEFAULT now(),
  created_by            uuid NOT NULL CONSTRAINT fk_price_list_entry_created_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  updated_at            timestamptz NOT NULL DEFAULT now(),
  updated_by            uuid NOT NULL CONSTRAINT fk_price_list_entry_updated_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  CONSTRAINT ck_price_list_entry_band CHECK (floor_price_pesewas <= list_price_pesewas AND list_price_pesewas <= ceiling_price_pesewas),
  -- Never a zero price: a priced entry has a floor above nothing; a quote-only entry sends the buyer to a quote.
  CONSTRAINT ck_price_list_entry_priced CHECK (quote_only OR floor_price_pesewas > 0)
);
COMMENT ON TABLE mdm.price_list_entry IS 'class=MASTER';
-- No two entries can match the same request (missing grade and band count as values).
CREATE UNIQUE INDEX uq_price_list_entry_match ON mdm.price_list_entry (version_id, product_id, grade_id, weight_band_id, min_qty) NULLS NOT DISTINCT;
CREATE INDEX ix_price_list_entry_product ON mdm.price_list_entry (product_id, version_id);
CREATE TRIGGER trg_price_list_entry_version BEFORE UPDATE ON mdm.price_list_entry
  FOR EACH ROW EXECUTE FUNCTION platform.touch_version();

-- Entries change only while their version is a DRAFT; afterwards they are frozen with it. SQLSTATE HK004.
CREATE FUNCTION mdm.price_list_entry_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  version_status text;
BEGIN
  SELECT v.status INTO version_status FROM mdm.price_list_version v
   WHERE v.id = CASE WHEN TG_OP = 'DELETE' THEN OLD.version_id ELSE NEW.version_id END;
  IF version_status IS DISTINCT FROM 'DRAFT' OR (TG_OP = 'UPDATE' AND NEW.version_id <> OLD.version_id) THEN
    RAISE EXCEPTION 'price list entries are frozen once their version leaves DRAFT (version is %)', version_status
      USING ERRCODE = 'HK004';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;
REVOKE ALL ON FUNCTION mdm.price_list_entry_guard() FROM PUBLIC;
CREATE TRIGGER trg_price_list_entry_guard BEFORE INSERT OR UPDATE OR DELETE ON mdm.price_list_entry
  FOR EACH ROW EXECUTE FUNCTION mdm.price_list_entry_guard();

-- replacePriceListEntries removes a draft's entries outright (mdm.md: "a draft entry is removed outright, an active
-- one never"). hk_app holds no DELETE on a MASTER table (ADR-0024), so the removal is this one function, owned by
-- hk_owner, which can only empty a DRAFT version (the guard trigger above refuses anything else).
CREATE FUNCTION mdm.clear_draft_price_list_entries(p_version_id uuid) RETURNS integer
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
DECLARE
  removed integer;
BEGIN
  DELETE FROM mdm.price_list_entry WHERE version_id = p_version_id;
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END
$$;
REVOKE ALL ON FUNCTION mdm.clear_draft_price_list_entries(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mdm.clear_draft_price_list_entries(uuid) TO hk_app, hk_worker;

CREATE TABLE mdm.customer_price_list (
  id            uuid PRIMARY KEY,
  customer_id   uuid NOT NULL CONSTRAINT fk_customer_price_list_customer REFERENCES mdm.customer (id) ON DELETE RESTRICT,
  price_list_id uuid NOT NULL CONSTRAINT fk_customer_price_list_list REFERENCES mdm.price_list (id) ON DELETE RESTRICT,
  valid_from    timestamptz NOT NULL,
  valid_to      timestamptz NULL,
  version       integer NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid NOT NULL CONSTRAINT fk_customer_price_list_created_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    uuid NOT NULL CONSTRAINT fk_customer_price_list_updated_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  deleted_at    timestamptz NULL,
  deleted_by    uuid NULL CONSTRAINT fk_customer_price_list_deleted_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  delete_reason text NULL,
  CONSTRAINT ck_customer_price_list_window CHECK (valid_to IS NULL OR valid_to > valid_from),
  CONSTRAINT ck_customer_price_list_soft_delete CHECK ((deleted_at IS NULL) = (deleted_by IS NULL) AND (deleted_at IS NULL) = (delete_reason IS NULL)),
  -- A customer has at most one assigned list at a time (FR-MDM-021).
  CONSTRAINT ex_customer_price_list_one_at_a_time EXCLUDE USING gist (customer_id WITH =, tstzrange(valid_from, valid_to, '[)') WITH &&) WHERE (deleted_at IS NULL)
);
COMMENT ON TABLE mdm.customer_price_list IS 'class=MASTER';
CREATE TRIGGER trg_customer_price_list_version BEFORE UPDATE ON mdm.customer_price_list
  FOR EACH ROW EXECUTE FUNCTION platform.touch_version();

-- Only a CUSTOMER list can be assigned to a customer. SQLSTATE 23514, as a CHECK would raise.
CREATE FUNCTION mdm.customer_price_list_kind() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM mdm.price_list l WHERE l.id = NEW.price_list_id AND l.kind = 'CUSTOMER') THEN
    RAISE EXCEPTION 'price list % is not a CUSTOMER list', NEW.price_list_id USING ERRCODE = '23514', CONSTRAINT = 'ck_customer_price_list_kind';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION mdm.customer_price_list_kind() FROM PUBLIC;
CREATE TRIGGER trg_customer_price_list_kind BEFORE INSERT OR UPDATE OF price_list_id ON mdm.customer_price_list
  FOR EACH ROW EXECUTE FUNCTION mdm.customer_price_list_kind();

REVOKE ALL ON mdm.grade, mdm.weight_band, mdm.customer_tier, mdm.customer, mdm.price_list, mdm.price_list_version,
  mdm.price_list_entry, mdm.customer_price_list FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON mdm.grade, mdm.weight_band, mdm.customer_tier, mdm.customer, mdm.price_list,
  mdm.price_list_version, mdm.price_list_entry, mdm.customer_price_list TO hk_app, hk_worker;

-- migrate:down
DROP TABLE mdm.customer_price_list;
DROP FUNCTION mdm.customer_price_list_kind();
DROP FUNCTION mdm.clear_draft_price_list_entries(uuid);
DROP TABLE mdm.price_list_entry;
DROP FUNCTION mdm.price_list_entry_guard();
DROP TABLE mdm.price_list_version;
DROP FUNCTION mdm.price_list_version_guard();
DROP TABLE mdm.price_list;
DROP TABLE mdm.customer;
DROP TABLE mdm.customer_tier;
DROP TABLE mdm.weight_band;
DROP TABLE mdm.grade;
