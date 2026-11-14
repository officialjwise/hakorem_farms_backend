-- 0001_platform_create_schema
-- The platform schema, the four value domains every module stores money, quantity, weight and rates in,
-- and the two shared trigger functions every LEDGER, MASTER and DOCUMENT table uses
-- (docs/data-model/platform.md, ADR-0001, ADR-0012). No tables.
-- Data category: none (no data is stored by this migration).

-- migrate:up
CREATE SCHEMA platform AUTHORIZATION hk_owner;
REVOKE ALL ON SCHEMA platform FROM PUBLIC;
GRANT USAGE ON SCHEMA platform TO hk_app, hk_worker, hk_sealer, hk_report;

-- Money: integer pesewas, never negative, never above the largest integer JSON and JavaScript carry exactly.
CREATE DOMAIN platform.pesewas AS bigint
  CONSTRAINT ck_pesewas_range CHECK (VALUE >= 0 AND VALUE <= 9007199254740991);
CREATE DOMAIN platform.qty AS numeric(14,3)
  CONSTRAINT ck_qty_not_negative CHECK (VALUE >= 0);
CREATE DOMAIN platform.kg AS numeric(10,3)
  CONSTRAINT ck_kg_not_negative CHECK (VALUE >= 0);
CREATE DOMAIN platform.percent AS numeric(7,4)
  CONSTRAINT ck_percent_range CHECK (VALUE >= 0 AND VALUE <= 100);

-- Attached BEFORE UPDATE OR DELETE (per row) and BEFORE TRUNCATE (per statement) to every LEDGER table.
-- SQLSTATE HK001 lets a repository recognise the refusal without matching on text.
CREATE FUNCTION platform.reject_change() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION '%.% is insert-only: % is not allowed; correct it with a reversing row', TG_TABLE_SCHEMA, TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'HK001';
END
$$;

-- Attached BEFORE UPDATE to every MASTER and DOCUMENT table: optimistic locking enforced in the database.
-- SQLSTATE HK002 is a version conflict, answered as 409 VERSION_CONFLICT.
CREATE FUNCTION platform.touch_version() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.version IS DISTINCT FROM OLD.version + 1 THEN
    RAISE EXCEPTION '%.%: version must move from % to %, not %', TG_TABLE_SCHEMA, TG_TABLE_NAME, OLD.version, OLD.version + 1, NEW.version
      USING ERRCODE = 'HK002';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION platform.reject_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.touch_version() FROM PUBLIC;

-- migrate:down
DROP FUNCTION platform.touch_version();
DROP FUNCTION platform.reject_change();
DROP DOMAIN platform.percent;
DROP DOMAIN platform.kg;
DROP DOMAIN platform.qty;
DROP DOMAIN platform.pesewas;
DROP SCHEMA platform;
