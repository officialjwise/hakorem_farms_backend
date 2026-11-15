-- 0087_prc_processing_reversal
-- The reversing order of FR-PRC-011 (docs/data-model/prc.md; A-162): a completed processing order is frozen, and a
-- mistake is corrected by reversing its movements through INV while every output is unsold. The reversal is its own
-- document, `prc.processing_reversal` (document type PROCESSING_REVERSAL, 0086), the source document of the reversing
-- movements; the order itself stays COMPLETED and untouched. A second order row (`reverses_order_id`) is not used: an
-- order with no inputs or outputs would fail the order's own checks and appear in yield and cost reports.
--
-- The database holds the rules itself, whoever writes:
--   prc.processing_reversal_guard  a reversal names a COMPLETED order, once (uq), and is POSTED when written; it never
--                                  changes (HK004)
-- Data category: INTERNAL (DC-13).
-- Rollback: tested (`pnpm db:rollback`), safe before the first reversal; afterwards forward fix only, since a reversal
-- is the source document of its movements.

-- migrate:up
CREATE TABLE prc.processing_reversal (
  id                  uuid PRIMARY KEY CONSTRAINT fk_processing_reversal_document REFERENCES platform.business_document (id) ON DELETE RESTRICT,
  processing_order_id uuid NOT NULL CONSTRAINT uq_processing_reversal_order UNIQUE
                        CONSTRAINT fk_processing_reversal_order REFERENCES prc.processing_order (id) ON DELETE RESTRICT,
  branch_id           uuid NOT NULL CONSTRAINT fk_processing_reversal_branch REFERENCES mdm.branch (id) ON DELETE RESTRICT,
  reason              text NOT NULL CONSTRAINT ck_processing_reversal_reason CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
  status              text NOT NULL CONSTRAINT ck_processing_reversal_status CHECK (status = 'POSTED'),
  posted_at           timestamptz NOT NULL,
  posted_by           uuid NOT NULL CONSTRAINT fk_processing_reversal_posted_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  version             integer NOT NULL DEFAULT 1,
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid NOT NULL CONSTRAINT fk_processing_reversal_created_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  updated_by          uuid NOT NULL CONSTRAINT fk_processing_reversal_updated_by REFERENCES iam.principal (id) ON DELETE RESTRICT
);
COMMENT ON TABLE prc.processing_reversal IS 'class=DOCUMENT';
CREATE TRIGGER trg_processing_reversal_freeze BEFORE UPDATE ON prc.processing_reversal
  FOR EACH ROW EXECUTE FUNCTION platform.freeze_posted('POSTED');

CREATE FUNCTION prc.processing_reversal_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  order_row prc.processing_order;
BEGIN
  SELECT * INTO order_row FROM prc.processing_order o WHERE o.id = NEW.processing_order_id FOR SHARE;
  IF order_row.status IS DISTINCT FROM 'COMPLETED' OR order_row.branch_id <> NEW.branch_id THEN
    RAISE EXCEPTION 'prc.processing_reversal %: only a completed order of the branch is reversed', NEW.id USING ERRCODE = 'HK004';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION prc.processing_reversal_guard() FROM PUBLIC;
CREATE TRIGGER trg_processing_reversal_guard BEFORE INSERT ON prc.processing_reversal
  FOR EACH ROW EXECUTE FUNCTION prc.processing_reversal_guard();

REVOKE ALL ON prc.processing_reversal FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON prc.processing_reversal TO hk_app, hk_worker;

-- migrate:down
DROP TABLE prc.processing_reversal;
DROP FUNCTION prc.processing_reversal_guard();
