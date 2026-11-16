-- 0113_liv_mortality_confirmation_and_evidence
-- B06r (owner, 2026-11-15; ADR-0053, A-175; threat model abuse case 2): the Farm hand's death reports wait for someone
-- above them, the photograph may be submitted while it is still being scanned, a rejected scan returns the report to
-- its maker, and a photograph's exact bytes are kept so that a reused one is found.
--
-- The database holds these rules itself, whoever writes:
--   ck_mortality_record_confirmed   a POSTED record marked confirmation_required (its reporter may not post a write-off)
--                                   was approved
--   ck_mortality_record_checker     an approved record was posted by someone other than its reporter
--   ck_mortality_record_returned    a RETURNED record says why (EVIDENCE_INFECTED, EVIDENCE_UNSCANNABLE), and only it
--   liv.mortality_record_guard      REPORTED -> PENDING_APPROVAL or POSTED; PENDING_APPROVAL -> POSTED, REJECTED or
--                                   RETURNED; POSTED, REJECTED and RETURNED frozen (HK004); the photograph and its hash
--                                   never change; posting a record with a photograph requires it to be a CLEAN EVIDENCE
--                                   file (platform.require_clean_file, HK008). The scan is checked at posting, no longer
--                                   at report, so a report may carry a photograph still PENDING its scan.
-- Additions to docs/data-model/liv.md: `confirmation_required`, `returned_reason`, `photo_sha256`, status RETURNED.
-- `photo_sha256` is copied from the stored file by the application at report: the database of LIV cannot read the
-- file store's table (ADR-0011), and records reported before this migration keep a null hash.
-- Data category: INTERNAL (DC-10; DC-34 for the photograph's id and hash).
-- Rollback: tested (`pnpm db:rollback`), safe before the first RETURNED record or confirmation; afterwards forward fix
-- only, since the previous checks cannot hold such a record.

-- migrate:up
ALTER TABLE liv.mortality_record
  ADD COLUMN confirmation_required boolean NOT NULL DEFAULT false,
  ADD COLUMN returned_reason text NULL CONSTRAINT ck_mortality_record_returned_reason CHECK (returned_reason IN ('EVIDENCE_INFECTED', 'EVIDENCE_UNSCANNABLE')),
  ADD COLUMN photo_sha256 bytea NULL CONSTRAINT ck_mortality_record_photo_sha256 CHECK (photo_sha256 IS NULL OR (octet_length(photo_sha256) = 32 AND photo_file_id IS NOT NULL));
ALTER TABLE liv.mortality_record
  DROP CONSTRAINT ck_mortality_record_status,
  ADD CONSTRAINT ck_mortality_record_status CHECK (status IN ('REPORTED', 'PENDING_APPROVAL', 'POSTED', 'REJECTED', 'RETURNED')),
  ADD CONSTRAINT ck_mortality_record_returned CHECK ((status = 'RETURNED') = (returned_reason IS NOT NULL)),
  ADD CONSTRAINT ck_mortality_record_confirmed CHECK (status <> 'POSTED' OR NOT confirmation_required OR approval_request_id IS NOT NULL),
  ADD CONSTRAINT ck_mortality_record_checker CHECK (approval_request_id IS NULL OR posted_by IS NULL OR posted_by <> reported_by);
CREATE INDEX ix_mortality_record_photo_sha256 ON liv.mortality_record (photo_sha256) WHERE photo_sha256 IS NOT NULL;
CREATE INDEX ix_mortality_record_waiting_photo ON liv.mortality_record (id) WHERE status = 'PENDING_APPROVAL' AND photo_file_id IS NOT NULL;

DROP TRIGGER trg_mortality_record_freeze ON liv.mortality_record;
CREATE TRIGGER trg_mortality_record_freeze BEFORE UPDATE ON liv.mortality_record
  FOR EACH ROW EXECUTE FUNCTION platform.freeze_posted('POSTED,REJECTED,RETURNED');

CREATE OR REPLACE FUNCTION liv.mortality_record_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.status <> 'REPORTED' THEN
    RAISE EXCEPTION 'liv.mortality_record %: a record starts REPORTED', NEW.id USING ERRCODE = 'HK004';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'REPORTED' AND NEW.status IN ('PENDING_APPROVAL', 'POSTED'))
    OR (OLD.status = 'PENDING_APPROVAL' AND NEW.status IN ('POSTED', 'REJECTED', 'RETURNED'))) THEN
    RAISE EXCEPTION 'liv.mortality_record %: % cannot become %', OLD.id, OLD.status, NEW.status USING ERRCODE = 'HK004';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.reported_by <> OLD.reported_by OR NEW.stock_unit_id <> OLD.stock_unit_id OR NEW.kind <> OLD.kind
                           OR NEW.photo_file_id IS DISTINCT FROM OLD.photo_file_id OR NEW.photo_sha256 IS DISTINCT FROM OLD.photo_sha256) THEN
    RAISE EXCEPTION 'liv.mortality_record %: the animal, the kind, the reporter and the photograph never change', OLD.id USING ERRCODE = 'HK004';
  END IF;
  IF NEW.status = 'POSTED' AND NEW.photo_file_id IS NOT NULL AND (TG_OP = 'INSERT' OR OLD.status <> 'POSTED') THEN
    PERFORM platform.require_clean_file(NEW.photo_file_id, 'EVIDENCE');
  END IF;
  RETURN NEW;
END
$$;

-- migrate:down
CREATE OR REPLACE FUNCTION liv.mortality_record_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.status <> 'REPORTED' THEN
    RAISE EXCEPTION 'liv.mortality_record %: a record starts REPORTED', NEW.id USING ERRCODE = 'HK004';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'REPORTED' AND NEW.status IN ('PENDING_APPROVAL', 'POSTED'))
    OR (OLD.status = 'PENDING_APPROVAL' AND NEW.status IN ('POSTED', 'REJECTED'))) THEN
    RAISE EXCEPTION 'liv.mortality_record %: % cannot become %', OLD.id, OLD.status, NEW.status USING ERRCODE = 'HK004';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.reported_by <> OLD.reported_by OR NEW.stock_unit_id <> OLD.stock_unit_id OR NEW.kind <> OLD.kind) THEN
    RAISE EXCEPTION 'liv.mortality_record %: the animal, the kind and the reporter never change', OLD.id USING ERRCODE = 'HK004';
  END IF;
  IF NEW.photo_file_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.photo_file_id IS DISTINCT FROM OLD.photo_file_id) THEN
    PERFORM platform.require_clean_file(NEW.photo_file_id, 'EVIDENCE');
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER trg_mortality_record_freeze ON liv.mortality_record;
CREATE TRIGGER trg_mortality_record_freeze BEFORE UPDATE ON liv.mortality_record
  FOR EACH ROW EXECUTE FUNCTION platform.freeze_posted('POSTED,REJECTED');
DROP INDEX liv.ix_mortality_record_waiting_photo;
DROP INDEX liv.ix_mortality_record_photo_sha256;
ALTER TABLE liv.mortality_record
  DROP CONSTRAINT ck_mortality_record_checker,
  DROP CONSTRAINT ck_mortality_record_confirmed,
  DROP CONSTRAINT ck_mortality_record_returned,
  DROP CONSTRAINT ck_mortality_record_status,
  ADD CONSTRAINT ck_mortality_record_status CHECK (status IN ('REPORTED', 'PENDING_APPROVAL', 'POSTED', 'REJECTED'));
ALTER TABLE liv.mortality_record DROP COLUMN photo_sha256, DROP COLUMN returned_reason, DROP COLUMN confirmation_required;
