-- 0090_mdm_product_uom_conversion
-- A product's alternative units (FR-MDM-003, CR-011, A-157, A-163): one alternative unit of a countable product is
-- `numerator / denominator` of its base unit, two integers and never a stored decimal (a 50 kg bag of feed is 50/1 KG).
--
-- The database holds the rules itself, whoever writes:
--   ck_uom_conversion_exact      the factor is in lowest terms and its denominator divides 1,000, so it is exact to the
--                                three decimal places a quantity carries; a third (1/3, or 0.3333333) is refused (23514)
--   ck_uom_conversion_numerator  at most a billion base units per alternative unit (23514)
--   mdm.uom_conversion_guard     a conversion is made for a COUNTABLE product, from a counted unit other than its base
--                                unit, to its base unit (HK010 `ck_uom_conversion_product`, `ck_uom_conversion_unit`): a
--                                catch-weight line is charged by its weighed kilograms, so a pack-to-kilogram factor is
--                                never a conversion (A-157). Nothing but its archive columns ever changes (HK004); a new
--                                factor is a new row after the old one is archived, so a quantity converted earlier keeps
--                                the factor it was converted with.
-- One live conversion per product and alternative unit (`uq_uom_conversion_live`). A product's stock policy and base unit
-- never change once it exists (updateProduct, FR-MDM-001), so the guard's check at insert holds for the row's life.
-- The data model's primary key (product, from, to) becomes an id with a partial unique index among live rows, because an
-- archived conversion stays readable beside its replacement (A-163).
-- Data category: INTERNAL (catalogue master data).
-- Rollback: tested (`pnpm db:rollback`); afterwards forward fix only once a quantity has been converted.

-- migrate:up
CREATE TABLE mdm.product_uom_conversion (
  id            uuid PRIMARY KEY,
  product_id    uuid NOT NULL CONSTRAINT fk_uom_conversion_product REFERENCES mdm.product (id) ON DELETE RESTRICT,
  from_uom      text NOT NULL CONSTRAINT fk_uom_conversion_from REFERENCES mdm.uom (code) ON DELETE RESTRICT,
  to_uom        text NOT NULL CONSTRAINT fk_uom_conversion_to REFERENCES mdm.uom (code) ON DELETE RESTRICT,
  numerator     bigint NOT NULL CONSTRAINT ck_uom_conversion_numerator CHECK (numerator BETWEEN 1 AND 1000000000),
  denominator   bigint NOT NULL CONSTRAINT ck_uom_conversion_denominator CHECK (denominator BETWEEN 1 AND 1000),
  version       integer NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid NOT NULL CONSTRAINT fk_uom_conversion_created_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    uuid NOT NULL CONSTRAINT fk_uom_conversion_updated_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  deleted_at    timestamptz NULL,
  deleted_by    uuid NULL CONSTRAINT fk_uom_conversion_deleted_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  delete_reason text NULL CONSTRAINT ck_uom_conversion_delete_reason CHECK (delete_reason IS NULL OR length(btrim(delete_reason)) BETWEEN 1 AND 500),
  CONSTRAINT ck_uom_conversion_exact CHECK (1000 % denominator = 0 AND gcd(numerator, denominator) = 1),
  CONSTRAINT ck_uom_conversion_units CHECK (from_uom <> to_uom),
  CONSTRAINT ck_uom_conversion_soft_delete CHECK ((deleted_at IS NULL) = (deleted_by IS NULL) AND (deleted_at IS NULL) = (delete_reason IS NULL))
);
COMMENT ON TABLE mdm.product_uom_conversion IS 'class=MASTER';
CREATE UNIQUE INDEX uq_uom_conversion_live ON mdm.product_uom_conversion (product_id, from_uom) WHERE deleted_at IS NULL;
CREATE INDEX ix_uom_conversion_from ON mdm.product_uom_conversion (from_uom, product_id) WHERE deleted_at IS NULL;
CREATE TRIGGER trg_uom_conversion_version BEFORE UPDATE ON mdm.product_uom_conversion
  FOR EACH ROW EXECUTE FUNCTION platform.touch_version();

CREATE FUNCTION mdm.uom_conversion_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  product_policy text;
  product_base text;
  from_kind text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.product_id, NEW.from_uom, NEW.to_uom, NEW.numerator, NEW.denominator, NEW.created_at, NEW.created_by)
       IS DISTINCT FROM (OLD.product_id, OLD.from_uom, OLD.to_uom, OLD.numerator, OLD.denominator, OLD.created_at, OLD.created_by)
       OR OLD.deleted_at IS NOT NULL THEN
      RAISE EXCEPTION 'mdm.product_uom_conversion %: a conversion never changes; archive it and make a new one', OLD.id USING ERRCODE = 'HK004';
    END IF;
    RETURN NEW;
  END IF;
  SELECT p.stock_policy, p.base_uom INTO product_policy, product_base FROM mdm.product p WHERE p.id = NEW.product_id;
  SELECT u.kind INTO from_kind FROM mdm.uom u WHERE u.code = NEW.from_uom;
  IF product_policy IS DISTINCT FROM 'COUNTABLE' OR NEW.to_uom IS DISTINCT FROM product_base THEN
    RAISE EXCEPTION 'mdm.product_uom_conversion %: only a countable product converts, and only to its base unit', NEW.id
      USING ERRCODE = 'HK010', CONSTRAINT = 'ck_uom_conversion_product';
  END IF;
  IF from_kind IS DISTINCT FROM 'COUNT' OR NEW.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'mdm.product_uom_conversion %: a live conversion is from a counted unit', NEW.id
      USING ERRCODE = 'HK010', CONSTRAINT = 'ck_uom_conversion_unit';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION mdm.uom_conversion_guard() FROM PUBLIC;
CREATE TRIGGER trg_uom_conversion_guard BEFORE INSERT OR UPDATE ON mdm.product_uom_conversion
  FOR EACH ROW EXECUTE FUNCTION mdm.uom_conversion_guard();

REVOKE ALL ON mdm.product_uom_conversion FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON mdm.product_uom_conversion TO hk_app, hk_worker;

-- migrate:down
DROP TABLE mdm.product_uom_conversion;
DROP FUNCTION mdm.uom_conversion_guard();
