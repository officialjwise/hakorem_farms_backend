-- 0212_mdm_party_public_ids
-- B09q (owner, 2026-11-17; ADR-0073): customers and suppliers carry an unguessable public ID, a type prefix (cus_,
-- sup_) and sixteen characters of Crockford base32 (no I, L, O or U) from a cryptographically secure source, 80 bits:
-- shown in responses and accepted in search in place of the sequential customer and supplier numbers, which stay in
-- their columns for internal use (master data is never hard-deleted). UUIDs stay the primary keys.
-- * `mdm.new_public_id(prefix)`: the database's generator, from `gen_random_uuid()` (PostgreSQL's strong random
--   source), taking only bytes a version 4 UUID leaves random and five bits of each. It backfills existing rows and is
--   the column default, so a row inserted by the previous API version, or by a fixture, still gets one. The
--   application generates its own (`PublicIds`) and retries on a collision.
-- * `public_id` is NOT NULL, unique over every row ever made (`uq_customer_public_id`, `uq_supplier_public_id`), so an
--   archived party's ID is never given again, matches its pattern (`ck_*_public_id`) and never changes, for any role
--   (HK004 `ck_customer_public_id_fixed`, `ck_supplier_public_id_fixed`).
-- Data category: INTERNAL (an identifier, not personal data on its own).
-- Rollback: tested (`pnpm db:rollback`): the columns go, the sequential numbers were never touched.

-- migrate:up
CREATE FUNCTION mdm.new_public_id(p_prefix text) RETURNS text
  LANGUAGE plpgsql
  VOLATILE
  SET search_path = pg_catalog
AS $$
DECLARE
  alphabet constant text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  -- Bytes 1 to 6 and 10 to 16 of a version 4 UUID are wholly random (byte 7 holds the version, byte 9 the variant).
  random bytea := substring(uuid_send(gen_random_uuid()) FROM 1 FOR 6)
               || substring(uuid_send(gen_random_uuid()) FROM 10 FOR 7)
               || substring(uuid_send(gen_random_uuid()) FROM 1 FOR 6);
  body text := '';
BEGIN
  FOR i IN 0..15 LOOP
    body := body || substr(alphabet, (get_byte(random, i) & 31) + 1, 1);
  END LOOP;
  RETURN p_prefix || '_' || body;
END
$$;
REVOKE ALL ON FUNCTION mdm.new_public_id(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mdm.new_public_id(text) TO hk_app, hk_worker;

-- A volatile default is evaluated for each existing row as the column is added: every row gets its own ID, and no
-- row is updated, so no version moves.
ALTER TABLE mdm.customer ADD COLUMN public_id text NOT NULL DEFAULT mdm.new_public_id('cus')
  CONSTRAINT ck_customer_public_id CHECK (public_id ~ '^cus_[0-9A-HJKMNP-TV-Z]{16}$');
ALTER TABLE mdm.customer ADD CONSTRAINT uq_customer_public_id UNIQUE (public_id);
ALTER TABLE mdm.supplier ADD COLUMN public_id text NOT NULL DEFAULT mdm.new_public_id('sup')
  CONSTRAINT ck_supplier_public_id CHECK (public_id ~ '^sup_[0-9A-HJKMNP-TV-Z]{16}$');
ALTER TABLE mdm.supplier ADD CONSTRAINT uq_supplier_public_id UNIQUE (public_id);

CREATE FUNCTION mdm.public_id_fixed() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION '%.% %: a public ID never changes', TG_TABLE_SCHEMA, TG_TABLE_NAME, OLD.id
    USING ERRCODE = 'HK004', CONSTRAINT = 'ck_' || TG_TABLE_NAME || '_public_id_fixed';
END
$$;
REVOKE ALL ON FUNCTION mdm.public_id_fixed() FROM PUBLIC;
CREATE TRIGGER trg_customer_public_id_fixed BEFORE UPDATE OF public_id ON mdm.customer
  FOR EACH ROW WHEN (OLD.public_id IS DISTINCT FROM NEW.public_id) EXECUTE FUNCTION mdm.public_id_fixed();
CREATE TRIGGER trg_supplier_public_id_fixed BEFORE UPDATE OF public_id ON mdm.supplier
  FOR EACH ROW WHEN (OLD.public_id IS DISTINCT FROM NEW.public_id) EXECUTE FUNCTION mdm.public_id_fixed();

-- migrate:down
DROP TRIGGER trg_supplier_public_id_fixed ON mdm.supplier;
DROP TRIGGER trg_customer_public_id_fixed ON mdm.customer;
DROP FUNCTION mdm.public_id_fixed();
ALTER TABLE mdm.supplier DROP COLUMN public_id;
ALTER TABLE mdm.customer DROP COLUMN public_id;
DROP FUNCTION mdm.new_public_id(text);
