-- 0036_platform_file_variants
-- The public variants of a photograph (FR-DOC-005, NFR-005, ADR-0045). When the worker's scan finds a PUBLIC image
-- CLEAN, it re-encodes it into three widths (`thumb` 320, `card` 640, `full` 1280 pixels), each as WebP with a JPEG
-- fallback, puts each rendition in the public media bucket under `p/<file id>/<variant>.<extension>`, and records it
-- here in the same transaction as the verdict. The original never leaves the private bucket. A PROJECTION written
-- only by the worker: the API role reads it and nothing else, and no role changes or deletes a row.
-- Data category: PUBLIC (renditions of product photographs, served from the public origin).
-- Rollback: tested (`pnpm db:rollback`), safe before the first variant; afterwards forward fix only, since the
-- objects in the public bucket would lose their metadata.

-- migrate:up
CREATE TABLE platform.stored_file_variant (
  file_id      uuid NOT NULL CONSTRAINT fk_stored_file_variant_file REFERENCES platform.stored_file (id) ON DELETE RESTRICT,
  variant      text NOT NULL CONSTRAINT ck_stored_file_variant_variant CHECK (variant IN ('thumb', 'card', 'full')),
  content_type text NOT NULL CONSTRAINT ck_stored_file_variant_content_type CHECK (content_type IN ('image/webp', 'image/jpeg')),
  bucket       text NOT NULL CONSTRAINT ck_stored_file_variant_bucket CHECK (length(btrim(bucket)) BETWEEN 3 AND 63),
  object_key   text NOT NULL CONSTRAINT ck_stored_file_variant_object_key CHECK (object_key ~ '^p/[0-9a-f-]{36}/(thumb|card|full)\.(webp|jpg)$'),
  width        integer NOT NULL CONSTRAINT ck_stored_file_variant_width CHECK (width BETWEEN 1 AND 1280),
  height       integer NOT NULL CONSTRAINT ck_stored_file_variant_height CHECK (height > 0),
  size_bytes   bigint NOT NULL CONSTRAINT ck_stored_file_variant_size CHECK (size_bytes > 0),
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_stored_file_variant PRIMARY KEY (file_id, variant, content_type),
  CONSTRAINT uq_stored_file_variant_object UNIQUE (bucket, object_key),
  -- FR-DOC-005: no variant at 640 pixels above 200 KB (200,000 bytes); the others keep its bytes per pixel (A-126).
  CONSTRAINT ck_stored_file_variant_budget CHECK (size_bytes <= CASE variant WHEN 'thumb' THEN 50000 WHEN 'card' THEN 200000 ELSE 800000 END)
);
COMMENT ON TABLE platform.stored_file_variant IS 'class=PROJECTION';
CREATE TRIGGER trg_stored_file_variant_immutable BEFORE UPDATE OR DELETE ON platform.stored_file_variant
  FOR EACH ROW EXECUTE FUNCTION platform.reject_change();

-- Only a PUBLIC image the scanner has passed has variants. SQLSTATE HK007, the file store's guard code.
CREATE FUNCTION platform.stored_file_variant_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  original record;
BEGIN
  SELECT classification, scan_status, content_type INTO original FROM platform.stored_file WHERE id = NEW.file_id;
  IF original.classification <> 'PUBLIC' OR original.content_type NOT IN ('image/jpeg', 'image/png', 'image/webp') THEN
    RAISE EXCEPTION 'platform.stored_file_variant: file % is not a public image; only public images have variants', NEW.file_id USING ERRCODE = 'HK007';
  END IF;
  IF original.scan_status <> 'CLEAN' THEN
    RAISE EXCEPTION 'platform.stored_file_variant: file % is %; only a CLEAN file has variants', NEW.file_id, original.scan_status USING ERRCODE = 'HK007';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION platform.stored_file_variant_guard() FROM PUBLIC;
CREATE TRIGGER trg_stored_file_variant_guard BEFORE INSERT ON platform.stored_file_variant
  FOR EACH ROW EXECUTE FUNCTION platform.stored_file_variant_guard();

-- The one rule another schema's trigger may ask of the file store (ADR-0045, tooling/architecture.json): that a file
-- exists for this use and passed its malware scan. MDM's product images call it, so an unscanned photograph or a file
-- of another use never reaches the catalogue. SQLSTATE HK008.
CREATE FUNCTION platform.require_clean_file(file_id uuid, wanted_purpose text) RETURNS void
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  file record;
BEGIN
  SELECT purpose, scan_status INTO file FROM platform.stored_file WHERE id = file_id AND deleted_at IS NULL;
  IF NOT FOUND OR file.purpose <> wanted_purpose THEN
    RAISE EXCEPTION 'file % is not a % file', file_id, wanted_purpose USING ERRCODE = 'HK008';
  END IF;
  IF file.scan_status <> 'CLEAN' THEN
    RAISE EXCEPTION 'file % is %; only a CLEAN file is used here', file_id, file.scan_status USING ERRCODE = 'HK008';
  END IF;
END
$$;
REVOKE ALL ON FUNCTION platform.require_clean_file(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.require_clean_file(uuid, text) TO hk_app, hk_worker;

REVOKE ALL ON platform.stored_file_variant FROM PUBLIC;
GRANT SELECT ON platform.stored_file_variant TO hk_app;
GRANT SELECT, INSERT ON platform.stored_file_variant TO hk_worker;

-- migrate:down
DROP FUNCTION platform.require_clean_file(uuid, text);
DROP TABLE platform.stored_file_variant;
DROP FUNCTION platform.stored_file_variant_guard();
