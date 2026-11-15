-- 0039_mdm_import_job
-- Spreadsheet imports and exports of master data (FR-MDM-019, FR-MDM-020, ADR-0046). An import refers to an IMPORT
-- file in the platform file store and is validated as a dry run that writes only the job and its row errors; it is
-- applied, all rows or none, only when no row has an error. An export refers to the EXPORT file the server wrote and
-- records its row count. The database holds the rules a bug in code must not get past (SQLSTATE HK009): an import's
-- file is a CLEAN import file (asked through `platform.require_clean_file`, never by reading its table); what a job
-- is about never changes; the status moves only forward; an import is applied only with every row valid and no
-- error recorded, and then all its rows are applied. Once APPLIED, FAILED or CANCELLED a job is frozen (HK004).
-- `branch_id` is the head office branch: master data is not branch-scoped (A-128), as for price list versions.
-- Data category: INTERNAL (DC-13). Row error messages name a row, a column and a rule, never the cell's value.
-- Rollback: tested (`pnpm db:rollback`), safe before the first job; afterwards forward fix only.

-- migrate:up
CREATE TABLE mdm.import_job (
  id              uuid PRIMARY KEY,
  entity          text NOT NULL CONSTRAINT ck_import_job_entity CHECK (entity IN ('PRODUCT', 'CUSTOMER', 'SUPPLIER', 'PRICE_LIST_ENTRY', 'LOCATION', 'OPENING_STOCK')),
  direction       text NOT NULL CONSTRAINT ck_import_job_direction CHECK (direction IN ('IMPORT', 'EXPORT')),
  file_id         uuid NOT NULL CONSTRAINT fk_import_job_file REFERENCES platform.stored_file (id) ON DELETE RESTRICT,
  status          text NOT NULL CONSTRAINT ck_import_job_status CHECK (status IN ('UPLOADED', 'VALIDATED', 'APPLIED', 'FAILED', 'CANCELLED')),
  rows_total      integer NULL CONSTRAINT ck_import_job_rows_total CHECK (rows_total >= 0),
  rows_valid      integer NULL CONSTRAINT ck_import_job_rows_valid CHECK (rows_valid >= 0),
  rows_applied    integer NULL CONSTRAINT ck_import_job_rows_applied CHECK (rows_applied >= 0),
  rows_to_create  integer NULL CONSTRAINT ck_import_job_rows_to_create CHECK (rows_to_create >= 0),
  rows_to_update  integer NULL CONSTRAINT ck_import_job_rows_to_update CHECK (rows_to_update >= 0),
  branch_id       uuid NOT NULL CONSTRAINT fk_import_job_branch REFERENCES mdm.branch (id) ON DELETE RESTRICT,
  version         integer NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid NOT NULL CONSTRAINT fk_import_job_created_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      uuid NOT NULL CONSTRAINT fk_import_job_updated_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  posted_at       timestamptz NULL,
  posted_by       uuid NULL CONSTRAINT fk_import_job_posted_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  CONSTRAINT ck_import_job_valid_within_total CHECK (rows_valid IS NULL OR rows_total IS NULL OR rows_valid <= rows_total),
  -- An applied import applied every row, and every row was valid; an export records how many rows it wrote.
  CONSTRAINT ck_import_job_applied CHECK (status <> 'APPLIED' OR (rows_total IS NOT NULL AND rows_valid = rows_total AND rows_applied = rows_total)),
  CONSTRAINT ck_import_job_export CHECK (direction <> 'EXPORT' OR status IN ('APPLIED', 'FAILED')),
  CONSTRAINT ck_import_job_posted CHECK ((status IN ('APPLIED', 'FAILED', 'CANCELLED')) = (posted_at IS NOT NULL AND posted_by IS NOT NULL))
);
COMMENT ON TABLE mdm.import_job IS 'class=DOCUMENT';
CREATE UNIQUE INDEX uq_import_job_file ON mdm.import_job (file_id) WHERE direction = 'EXPORT';
CREATE INDEX ix_import_job_list ON mdm.import_job (id DESC);
CREATE TRIGGER trg_import_job_version BEFORE UPDATE ON mdm.import_job
  FOR EACH ROW EXECUTE FUNCTION platform.touch_version();
CREATE TRIGGER trg_import_job_freeze BEFORE UPDATE ON mdm.import_job
  FOR EACH ROW EXECUTE FUNCTION platform.freeze_posted('APPLIED,FAILED,CANCELLED');

CREATE TABLE mdm.import_job_error (
  id             uuid PRIMARY KEY,
  import_job_id  uuid NOT NULL CONSTRAINT fk_import_job_error_job REFERENCES mdm.import_job (id) ON DELETE RESTRICT,
  row_no         integer NOT NULL CONSTRAINT ck_import_job_error_row_no CHECK (row_no >= 1),
  column_name    text NULL CONSTRAINT ck_import_job_error_column CHECK (column_name IS NULL OR length(column_name) BETWEEN 1 AND 60),
  message        text NOT NULL CONSTRAINT ck_import_job_error_message CHECK (length(message) BETWEEN 1 AND 300),
  created_at     timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE mdm.import_job_error IS 'class=WORK';
CREATE INDEX ix_import_job_error_job ON mdm.import_job_error (import_job_id, row_no, id);

-- The job's own rules (FR-MDM-019). SQLSTATE HK009.
CREATE FUNCTION mdm.import_job_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.direction = 'IMPORT' THEN
      IF NEW.status NOT IN ('UPLOADED', 'VALIDATED', 'FAILED') THEN
        RAISE EXCEPTION 'mdm.import_job %: an import starts UPLOADED, VALIDATED or FAILED, not %', NEW.id, NEW.status USING ERRCODE = 'HK009';
      END IF;
      -- The file store's own rule (migration 0036), asked through its shared function.
      PERFORM platform.require_clean_file(NEW.file_id, 'IMPORT');
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.entity, NEW.direction, NEW.file_id, NEW.branch_id, NEW.created_at, NEW.created_by)
     IS DISTINCT FROM (OLD.entity, OLD.direction, OLD.file_id, OLD.branch_id, OLD.created_at, OLD.created_by) THEN
    RAISE EXCEPTION 'mdm.import_job %: what a job is about never changes', OLD.id USING ERRCODE = 'HK009';
  END IF;
  IF NOT ((OLD.status = NEW.status AND OLD.status IN ('UPLOADED', 'VALIDATED'))
       OR (OLD.status = 'UPLOADED' AND NEW.status IN ('VALIDATED', 'FAILED', 'CANCELLED'))
       OR (OLD.status = 'VALIDATED' AND NEW.status IN ('APPLIED', 'CANCELLED'))) THEN
    RAISE EXCEPTION 'mdm.import_job %: % cannot become %', OLD.id, OLD.status, NEW.status USING ERRCODE = 'HK009';
  END IF;
  IF NEW.status = 'APPLIED' AND EXISTS (SELECT 1 FROM mdm.import_job_error e WHERE e.import_job_id = NEW.id) THEN
    RAISE EXCEPTION 'mdm.import_job %: an import with row errors is never applied', OLD.id USING ERRCODE = 'HK009';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION mdm.import_job_guard() FROM PUBLIC;
CREATE TRIGGER trg_import_job_guard BEFORE INSERT OR UPDATE ON mdm.import_job
  FOR EACH ROW EXECUTE FUNCTION mdm.import_job_guard();

REVOKE ALL ON mdm.import_job, mdm.import_job_error FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON mdm.import_job TO hk_app, hk_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON mdm.import_job_error TO hk_app, hk_worker;

-- migrate:down
DROP TABLE mdm.import_job_error;
DROP TABLE mdm.import_job;
DROP FUNCTION mdm.import_job_guard();
