-- 0033_platform_file_store
-- The file store (ADR-0009, ADR-0044; FR-DOC-006, FR-DOC-007, SEC-027). `platform.stored_file` is the metadata of every
-- uploaded object: the object sits under a random key in the private bucket, its type is what content sniffing found,
-- and it is not served until the worker's malware scan says CLEAN. Three rules are the database's, not only the code's:
-- the content of a stored file never changes (only its scan status and soft-delete columns do); a file is stored
-- PENDING and its scan status moves once, from PENDING to CLEAN, INFECTED or FAILED; and only the worker role
-- (`hk_worker`, which runs the scanner) can move it, so the API cannot mark its own upload clean.
-- `platform.file_access_log` records every signed URL issued, insert-only.
-- Data category: CONFIDENTIAL (file names a person chose; the address a signed URL was issued to).
-- Rollback: tested (`pnpm db:rollback`), safe before the first upload; afterwards forward fix only, since the
-- objects in storage would lose their metadata.

-- migrate:up
CREATE TABLE platform.stored_file (
  id             uuid PRIMARY KEY,
  bucket         text NOT NULL CONSTRAINT ck_stored_file_bucket CHECK (length(btrim(bucket)) BETWEEN 3 AND 63),
  object_key     text NOT NULL CONSTRAINT ck_stored_file_object_key CHECK (object_key ~ '^[a-z]+(-[a-z]+)*/[0-9a-f-]{36}$'),
  original_name  text NOT NULL CONSTRAINT ck_stored_file_original_name CHECK (length(original_name) BETWEEN 1 AND 255),
  content_type   text NOT NULL CONSTRAINT ck_stored_file_content_type CHECK (content_type ~ '^[a-z]+/[a-z0-9.+-]+$'),
  size_bytes     bigint NOT NULL CONSTRAINT ck_stored_file_size CHECK (size_bytes > 0),
  sha256         bytea NOT NULL CONSTRAINT ck_stored_file_sha256 CHECK (length(sha256) = 32),
  purpose        text NOT NULL CONSTRAINT ck_stored_file_purpose CHECK (purpose IN (
                   'PRODUCT_IMAGE', 'PROOF_OF_DELIVERY', 'SIGNATURE', 'SUPPLIER_DOCUMENT', 'SUPPLIER_INVOICE',
                   'INVESTOR_DOCUMENT', 'IMPORT', 'EVIDENCE', 'STATEMENT', 'AGREEMENT')),
  classification text NOT NULL CONSTRAINT ck_stored_file_classification CHECK (classification IN ('PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED')),
  scan_status    text NOT NULL DEFAULT 'PENDING' CONSTRAINT ck_stored_file_scan_status CHECK (scan_status IN ('PENDING', 'CLEAN', 'INFECTED', 'FAILED')),
  scanned_at     timestamptz NULL,
  scan_verdict   text NULL CONSTRAINT ck_stored_file_scan_verdict CHECK (scan_verdict IS NULL OR length(scan_verdict) BETWEEN 1 AND 200),
  owner_module   text NOT NULL CONSTRAINT ck_stored_file_owner_module CHECK (owner_module ~ '^[a-z]{3,8}$'),
  version        integer NOT NULL DEFAULT 1,
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid NOT NULL CONSTRAINT fk_stored_file_created_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     uuid NOT NULL CONSTRAINT fk_stored_file_updated_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  deleted_at     timestamptz NULL,
  deleted_by     uuid NULL CONSTRAINT fk_stored_file_deleted_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  delete_reason  text NULL,
  CONSTRAINT uq_stored_file_object UNIQUE (bucket, object_key),
  CONSTRAINT ck_stored_file_scanned CHECK ((scan_status = 'PENDING') = (scanned_at IS NULL)),
  CONSTRAINT ck_stored_file_soft_delete CHECK ((deleted_at IS NULL) = (deleted_by IS NULL) AND (deleted_at IS NULL) = (delete_reason IS NULL))
);
COMMENT ON TABLE platform.stored_file IS 'class=MASTER';
CREATE INDEX ix_stored_file_pending ON platform.stored_file (created_at) WHERE scan_status = 'PENDING';

-- Content is immutable and the scan verdict is the worker's, given once. SQLSTATE HK007.
CREATE FUNCTION platform.stored_file_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.scan_status <> 'PENDING' OR NEW.scanned_at IS NOT NULL OR NEW.scan_verdict IS NOT NULL THEN
      RAISE EXCEPTION 'platform.stored_file %: a file is stored PENDING; only the scanner decides its status', NEW.id USING ERRCODE = 'HK007';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW.bucket, NEW.object_key, NEW.original_name, NEW.content_type, NEW.size_bytes, NEW.sha256, NEW.purpose,
      NEW.classification, NEW.owner_module, NEW.created_at, NEW.created_by)
     IS DISTINCT FROM
     (OLD.id, OLD.bucket, OLD.object_key, OLD.original_name, OLD.content_type, OLD.size_bytes, OLD.sha256, OLD.purpose,
      OLD.classification, OLD.owner_module, OLD.created_at, OLD.created_by) THEN
    RAISE EXCEPTION 'platform.stored_file %: the content of a stored file never changes', OLD.id USING ERRCODE = 'HK007';
  END IF;
  IF (NEW.scan_status, NEW.scanned_at, NEW.scan_verdict) IS DISTINCT FROM (OLD.scan_status, OLD.scanned_at, OLD.scan_verdict) THEN
    IF OLD.scan_status <> 'PENDING' THEN
      RAISE EXCEPTION 'platform.stored_file %: the scan status % is final', OLD.id, OLD.scan_status USING ERRCODE = 'HK007';
    END IF;
    IF current_user <> 'hk_worker' THEN
      RAISE EXCEPTION 'platform.stored_file %: only the scanner (hk_worker) records a scan', OLD.id USING ERRCODE = 'HK007';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION platform.stored_file_guard() FROM PUBLIC;
CREATE TRIGGER trg_stored_file_guard BEFORE INSERT OR UPDATE ON platform.stored_file
  FOR EACH ROW EXECUTE FUNCTION platform.stored_file_guard();
CREATE TRIGGER trg_stored_file_version BEFORE UPDATE ON platform.stored_file
  FOR EACH ROW EXECUTE FUNCTION platform.touch_version();

CREATE TABLE platform.file_access_log (
  id             uuid PRIMARY KEY,
  file_id        uuid NOT NULL CONSTRAINT fk_file_access_log_file REFERENCES platform.stored_file (id) ON DELETE RESTRICT,
  purpose        text NOT NULL CONSTRAINT ck_file_access_log_purpose CHECK (length(btrim(purpose)) BETWEEN 1 AND 100),
  url_expires_at timestamptz NOT NULL,
  ip             inet NULL,
  recorded_at    timestamptz NOT NULL DEFAULT now(),
  actor_id       uuid NOT NULL CONSTRAINT fk_file_access_log_actor REFERENCES iam.principal (id) ON DELETE RESTRICT,
  CONSTRAINT ck_file_access_log_expires CHECK (url_expires_at > recorded_at)
);
COMMENT ON TABLE platform.file_access_log IS 'class=LEDGER';
CREATE INDEX ix_file_access_log_file ON platform.file_access_log (file_id, recorded_at);
CREATE TRIGGER trg_file_access_log_immutable BEFORE UPDATE OR DELETE ON platform.file_access_log
  FOR EACH ROW EXECUTE FUNCTION platform.reject_change();
CREATE TRIGGER trg_file_access_log_no_truncate BEFORE TRUNCATE ON platform.file_access_log
  FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_change();

REVOKE ALL ON platform.stored_file, platform.file_access_log FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON platform.stored_file TO hk_app, hk_worker;
GRANT SELECT, INSERT ON platform.file_access_log TO hk_app, hk_worker;

-- migrate:down
DROP TABLE platform.file_access_log;
DROP TABLE platform.stored_file;
DROP FUNCTION platform.stored_file_guard();
