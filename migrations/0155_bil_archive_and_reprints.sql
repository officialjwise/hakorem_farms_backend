-- 0155_bil_archive_and_reprints
-- B08 continued 2b (FR-BIL-003, FR-BIL-008, FR-BIL-009, ADR-0061, A-201): an issued billing document learns its
-- archived rendering after the issuing transaction has committed. This is the expand migration that adds
-- `archived_document_id` (to DOC's published key `doc.archived_document`); BIL's asynchronous subscriber to
-- `doc.DocumentArchived` sets it with `content_hash`, the SHA-256 of the archived bytes, both once and together.
-- `bil.reprint_log` records every reprint: copy numbers run 1, 2, 3 per document with no gap and no repeat, and only
-- an issued, archived document is reprinted. The database holds (SQLSTATE HK004, the rule as the constraint name):
--   ck_billing_document_frozen     now also lets `archived_document_id` be set, once
--   ck_billing_document_archive    the archived document and the content hash are set together
--   ck_reprint_log_copy_no         a reprint takes the next copy number of an issued, archived document
--   reject_change                  the reprint log refuses UPDATE, DELETE and TRUNCATE, for every role
-- Data category: CONFIDENTIAL (DC-24): who reprinted which document.
-- Rollback: tested (`pnpm db:rollback`, then applied again). Rolling back keeps every content hash and the archive and
-- drops only the link column and the reprint log; applying again relinks each hashed document to its archive. After the
-- first reprint, a rollback loses the reprint log: forward fix only.

-- migrate:up
ALTER TABLE bil.billing_document ADD COLUMN archived_document_id uuid NULL
  CONSTRAINT fk_billing_document_archived REFERENCES doc.archived_document (id) ON DELETE RESTRICT;

-- An issued document is frozen but for the listed columns; the hash and the archived document are set once.
CREATE OR REPLACE FUNCTION bil.billing_document_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  allowed text[] := ARRAY['credited_pesewas', 'content_hash', 'archived_document_id', 'certified_tax_pesewas', 'certified_gross_pesewas', 'certification_ref', 'version', 'updated_at', 'updated_by'];
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'DRAFT' THEN
      RAISE EXCEPTION 'bil.billing_document %: a document is written DRAFT and issued afterwards', NEW.id USING ERRCODE = 'HK004', CONSTRAINT = 'ck_billing_document_status';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status = 'ISSUED' THEN
    IF NEW.status <> 'ISSUED' OR (to_jsonb(NEW) - allowed) IS DISTINCT FROM (to_jsonb(OLD) - allowed) THEN
      RAISE EXCEPTION 'bil.billing_document % is issued and frozen', OLD.id USING ERRCODE = 'HK004', CONSTRAINT = 'ck_billing_document_frozen';
    END IF;
    IF (OLD.content_hash IS NOT NULL AND NEW.content_hash IS DISTINCT FROM OLD.content_hash)
       OR (OLD.archived_document_id IS NOT NULL AND NEW.archived_document_id IS DISTINCT FROM OLD.archived_document_id) THEN
      RAISE EXCEPTION 'bil.billing_document %: the content hash and the archived document are set once', OLD.id USING ERRCODE = 'HK004', CONSTRAINT = 'ck_billing_document_frozen';
    END IF;
    IF OLD.certified_gross_pesewas IS NOT NULL AND (NEW.certified_tax_pesewas, NEW.certified_gross_pesewas, NEW.certification_ref)
         IS DISTINCT FROM (OLD.certified_tax_pesewas, OLD.certified_gross_pesewas, OLD.certification_ref) THEN
      RAISE EXCEPTION 'bil.billing_document %: certified totals are set once', OLD.id USING ERRCODE = 'HK004', CONSTRAINT = 'ck_billing_document_frozen';
    END IF;
  ELSIF NEW.status NOT IN ('DRAFT', 'ISSUED') OR (NEW.status = 'ISSUED' AND NEW.credited_pesewas <> 0) THEN
    RAISE EXCEPTION 'bil.billing_document %: a draft is issued with nothing credited', OLD.id USING ERRCODE = 'HK004', CONSTRAINT = 'ck_billing_document_status';
  END IF;
  NEW.version := OLD.version + 1;
  RETURN NEW;
END
$$;

-- Applied again after a rollback, a document whose content hash survived relinks to its archive through DOC's
-- published function `doc.archived_rendering` (ADR-0047), by that hash: the archive and the hash are facts, and only
-- the link column was dropped. The deferred
-- document check runs at once, so no trigger event is pending when the table is altered below.
SET CONSTRAINTS ALL IMMEDIATE;
UPDATE bil.billing_document SET archived_document_id = doc.archived_rendering(id, content_hash), updated_at = now()
 WHERE status = 'ISSUED' AND content_hash IS NOT NULL AND archived_document_id IS NULL;
ALTER TABLE bil.billing_document ADD CONSTRAINT ck_billing_document_archive CHECK ((archived_document_id IS NULL) = (content_hash IS NULL));
CREATE UNIQUE INDEX uq_billing_document_archived ON bil.billing_document (archived_document_id) WHERE archived_document_id IS NOT NULL;

CREATE TABLE bil.reprint_log (
  id                  uuid PRIMARY KEY,
  billing_document_id uuid NOT NULL CONSTRAINT fk_reprint_log_document REFERENCES bil.billing_document (id) ON DELETE RESTRICT,
  copy_no             integer NOT NULL CONSTRAINT ck_reprint_log_copy_positive CHECK (copy_no > 0),
  channel             text NOT NULL CONSTRAINT ck_reprint_log_channel CHECK (channel IN ('THERMAL', 'PDF', 'SMS', 'WHATSAPP', 'EMAIL')),
  recorded_at         timestamptz NOT NULL DEFAULT now(),
  actor_id            uuid NOT NULL CONSTRAINT fk_reprint_log_actor REFERENCES iam.principal (id) ON DELETE RESTRICT,
  CONSTRAINT uq_reprint_log_copy UNIQUE (billing_document_id, copy_no)
);
COMMENT ON TABLE bil.reprint_log IS 'class=LEDGER';
CREATE TRIGGER trg_reprint_log_immutable BEFORE UPDATE OR DELETE ON bil.reprint_log
  FOR EACH ROW EXECUTE FUNCTION platform.reject_change();
CREATE TRIGGER trg_reprint_log_no_truncate BEFORE TRUNCATE ON bil.reprint_log
  FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_change();

CREATE FUNCTION bil.reprint_log_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM bil.billing_document d WHERE d.id = NEW.billing_document_id AND d.status = 'ISSUED' AND d.archived_document_id IS NOT NULL) THEN
    RAISE EXCEPTION 'bil.reprint_log: document % is not issued and archived', NEW.billing_document_id USING ERRCODE = 'HK004', CONSTRAINT = 'ck_reprint_log_copy_no';
  END IF;
  IF NEW.copy_no <> (SELECT COALESCE(max(r.copy_no), 0) + 1 FROM bil.reprint_log r WHERE r.billing_document_id = NEW.billing_document_id) THEN
    RAISE EXCEPTION 'bil.reprint_log: copy % of document % is not the next copy', NEW.copy_no, NEW.billing_document_id USING ERRCODE = 'HK004', CONSTRAINT = 'ck_reprint_log_copy_no';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION bil.reprint_log_guard() FROM PUBLIC;
CREATE TRIGGER trg_reprint_log_guard BEFORE INSERT ON bil.reprint_log
  FOR EACH ROW EXECUTE FUNCTION bil.reprint_log_guard();

REVOKE ALL ON bil.reprint_log FROM PUBLIC;
GRANT SELECT, INSERT ON bil.reprint_log TO hk_app, hk_worker;

-- migrate:down
DROP TABLE bil.reprint_log;
DROP FUNCTION bil.reprint_log_guard();
CREATE OR REPLACE FUNCTION bil.billing_document_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  allowed text[] := ARRAY['credited_pesewas', 'content_hash', 'certified_tax_pesewas', 'certified_gross_pesewas', 'certification_ref', 'version', 'updated_at', 'updated_by'];
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'DRAFT' THEN
      RAISE EXCEPTION 'bil.billing_document %: a document is written DRAFT and issued afterwards', NEW.id USING ERRCODE = 'HK004', CONSTRAINT = 'ck_billing_document_status';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status = 'ISSUED' THEN
    IF NEW.status <> 'ISSUED' OR (to_jsonb(NEW) - allowed) IS DISTINCT FROM (to_jsonb(OLD) - allowed) THEN
      RAISE EXCEPTION 'bil.billing_document % is issued and frozen', OLD.id USING ERRCODE = 'HK004', CONSTRAINT = 'ck_billing_document_frozen';
    END IF;
    IF OLD.content_hash IS NOT NULL AND NEW.content_hash IS DISTINCT FROM OLD.content_hash THEN
      RAISE EXCEPTION 'bil.billing_document %: the content hash is set once', OLD.id USING ERRCODE = 'HK004', CONSTRAINT = 'ck_billing_document_frozen';
    END IF;
    IF OLD.certified_gross_pesewas IS NOT NULL AND (NEW.certified_tax_pesewas, NEW.certified_gross_pesewas, NEW.certification_ref)
         IS DISTINCT FROM (OLD.certified_tax_pesewas, OLD.certified_gross_pesewas, OLD.certification_ref) THEN
      RAISE EXCEPTION 'bil.billing_document %: certified totals are set once', OLD.id USING ERRCODE = 'HK004', CONSTRAINT = 'ck_billing_document_frozen';
    END IF;
  ELSIF NEW.status NOT IN ('DRAFT', 'ISSUED') OR (NEW.status = 'ISSUED' AND NEW.credited_pesewas <> 0) THEN
    RAISE EXCEPTION 'bil.billing_document %: a draft is issued with nothing credited', OLD.id USING ERRCODE = 'HK004', CONSTRAINT = 'ck_billing_document_status';
  END IF;
  NEW.version := OLD.version + 1;
  RETURN NEW;
END
$$;
DROP INDEX bil.uq_billing_document_archived;
ALTER TABLE bil.billing_document DROP CONSTRAINT ck_billing_document_archive;
ALTER TABLE bil.billing_document DROP COLUMN archived_document_id;
