-- 0054_inv_stock_takes
-- Stock takes and cycle counts (FR-INV-013, FR-INV-014, docs/data-model/inv.md): a count of one location, of every
-- product there (FULL) or of the listed products (CYCLE). Starting it freezes each balance in scope as the line's
-- expected figure; the counter records counts blind; closing counting shows the variances and flags every line that
-- differs for a recount; submitting posts a STOCKTAKE_GAIN or STOCKTAKE_LOSS per variance through Stock.postIn, or
-- waits for a different person's approval when the variance value is at or above the STOCK_WRITE_OFF threshold.
--
-- The database holds the document rules itself, whoever writes:
--   inv.document_status_guard  a take starts DRAFT and moves only along its listed transitions (HK004)
--   freeze_posted              a posted or cancelled take is final; a pending one changes only to be decided
--   inv.stock_take_part_guard  the product scope is written while DRAFT; lines are written while DRAFT; while
--                              COUNTING only the counts change; in REVIEW only the recount (once), the variance and
--                              the movement (once); while PENDING_APPROVAL only the movement (once) (HK004)
--   inv.stock_take_overlap     two takes of one location whose scopes share a product are never counting, in review
--                              or pending together (FR-INV-014); a FULL take shares every product. The check takes
--                              an advisory lock on the location first, so it holds at any isolation level (HK010
--                              ck_stock_take_overlap)
--   ck_stock_take_approved     a posted take whose variance value is at or above the threshold it was judged against
--                              names its approval request
-- The threshold is copied onto the take when it is submitted, through IAM's Approvals.judgeIn (as A-139 does for an
-- adjustment): the check reads no other schema's table, so ADR-0047 is not widened. gain_value_pesewas,
-- loss_value_pesewas, approval_threshold_pesewas, cancel_reason, posted_at/by, inv.stock_take_product and the line's
-- counted_weight_source are additions to the data model, recorded there (A-141).
-- Data category: INTERNAL (DC-13): quantities, values, locations; no personal data.
-- Rollback: tested (`pnpm db:rollback`), safe before the first take; afterwards forward fix only, since a posted take
-- is the source document of its movements.

-- migrate:up

CREATE TABLE inv.stock_take (
  id                         uuid PRIMARY KEY CONSTRAINT fk_stock_take_document REFERENCES platform.business_document (id) ON DELETE RESTRICT,
  stock_take_no              text NULL CONSTRAINT uq_stock_take_no UNIQUE,
  location_id                uuid NOT NULL CONSTRAINT fk_stock_take_location REFERENCES mdm.location (id) ON DELETE RESTRICT,
  scope                      text NOT NULL CONSTRAINT ck_stock_take_scope CHECK (scope IN ('FULL', 'CYCLE')),
  snapshot_at                timestamptz NULL,
  counted_by                 uuid NULL CONSTRAINT fk_stock_take_counted_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  gain_value_pesewas         platform.pesewas NULL,
  loss_value_pesewas         platform.pesewas NULL,
  variance_value_pesewas     platform.pesewas NULL,
  approval_threshold_pesewas platform.pesewas NULL,
  approval_request_id        uuid NULL CONSTRAINT fk_stock_take_approval REFERENCES iam.approval_request (id) ON DELETE RESTRICT,
  cancel_reason              text NULL CONSTRAINT ck_stock_take_cancel_reason CHECK (length(btrim(cancel_reason)) BETWEEN 1 AND 500),
  status                     text NOT NULL CONSTRAINT ck_stock_take_status CHECK (status IN ('DRAFT', 'COUNTING', 'REVIEW', 'PENDING_APPROVAL', 'POSTED', 'CANCELLED')),
  branch_id                  uuid NOT NULL CONSTRAINT fk_stock_take_branch REFERENCES mdm.branch (id) ON DELETE RESTRICT,
  version                    integer NOT NULL DEFAULT 1,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  created_by                 uuid NOT NULL CONSTRAINT fk_stock_take_created_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  updated_by                 uuid NOT NULL CONSTRAINT fk_stock_take_updated_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  posted_at                  timestamptz NULL,
  posted_by                  uuid NULL CONSTRAINT fk_stock_take_posted_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  -- Expected figures are frozen when counting starts, never before.
  CONSTRAINT ck_stock_take_snapshot CHECK (status = 'CANCELLED' OR (status = 'DRAFT') = (snapshot_at IS NULL)),
  -- The variance value compared with the threshold is the gains and the losses together.
  CONSTRAINT ck_stock_take_variance CHECK ((gain_value_pesewas IS NULL) = (loss_value_pesewas IS NULL)
                                           AND (gain_value_pesewas IS NULL) = (variance_value_pesewas IS NULL)
                                           AND (variance_value_pesewas IS NULL OR variance_value_pesewas = gain_value_pesewas + loss_value_pesewas)),
  CONSTRAINT ck_stock_take_judged CHECK (status NOT IN ('PENDING_APPROVAL', 'POSTED') OR (approval_threshold_pesewas IS NOT NULL AND variance_value_pesewas IS NOT NULL)),
  CONSTRAINT ck_stock_take_pending CHECK (status <> 'PENDING_APPROVAL' OR approval_request_id IS NOT NULL),
  CONSTRAINT ck_stock_take_posted CHECK ((status = 'POSTED') = (posted_at IS NOT NULL) AND (posted_at IS NULL) = (posted_by IS NULL)),
  CONSTRAINT ck_stock_take_cancelled CHECK ((status = 'CANCELLED') = (cancel_reason IS NOT NULL)),
  -- A variance at or above the threshold is never posted without a different person's approval.
  CONSTRAINT ck_stock_take_approved CHECK (status <> 'POSTED' OR variance_value_pesewas < approval_threshold_pesewas OR approval_request_id IS NOT NULL)
);
COMMENT ON TABLE inv.stock_take IS 'class=DOCUMENT';
CREATE INDEX ix_stock_take_location ON inv.stock_take (location_id, status);
CREATE INDEX ix_stock_take_branch ON inv.stock_take (branch_id, status);
CREATE TRIGGER trg_stock_take_version BEFORE UPDATE ON inv.stock_take
  FOR EACH ROW EXECUTE FUNCTION platform.touch_version();
CREATE TRIGGER trg_stock_take_status BEFORE INSERT OR UPDATE ON inv.stock_take
  FOR EACH ROW EXECUTE FUNCTION inv.document_status_guard('DRAFT',
    'DRAFT>COUNTING,DRAFT>CANCELLED,COUNTING>REVIEW,COUNTING>CANCELLED,REVIEW>POSTED,REVIEW>PENDING_APPROVAL,REVIEW>CANCELLED,PENDING_APPROVAL>POSTED,PENDING_APPROVAL>CANCELLED');
CREATE TRIGGER trg_stock_take_freeze BEFORE UPDATE ON inv.stock_take
  FOR EACH ROW EXECUTE FUNCTION platform.freeze_posted('POSTED,CANCELLED');
-- A pending take changes only to be decided: posted on approval, cancelled on rejection.
CREATE TRIGGER trg_stock_take_freeze_pending BEFORE UPDATE ON inv.stock_take
  FOR EACH ROW EXECUTE FUNCTION platform.freeze_posted('PENDING_APPROVAL', 'status', 'posted_at', 'posted_by', 'cancel_reason', 'version', 'updated_at', 'updated_by');

-- The products a cycle count covers. A FULL take lists none: it covers every product at its location.
CREATE TABLE inv.stock_take_product (
  stock_take_id uuid NOT NULL CONSTRAINT fk_stock_take_product_take REFERENCES inv.stock_take (id) ON DELETE RESTRICT,
  product_id    uuid NOT NULL CONSTRAINT fk_stock_take_product_product REFERENCES mdm.product (id) ON DELETE RESTRICT,
  CONSTRAINT pk_stock_take_product PRIMARY KEY (stock_take_id, product_id)
);
COMMENT ON TABLE inv.stock_take_product IS 'class=DOCUMENT';
CREATE INDEX ix_stock_take_product_product ON inv.stock_take_product (product_id);

CREATE TABLE inv.stock_take_line (
  id                     uuid PRIMARY KEY,
  stock_take_id          uuid NOT NULL CONSTRAINT fk_stock_take_line_take REFERENCES inv.stock_take (id) ON DELETE RESTRICT,
  product_id             uuid NOT NULL CONSTRAINT fk_stock_take_line_product REFERENCES mdm.product (id) ON DELETE RESTRICT,
  stock_unit_id          uuid NULL CONSTRAINT fk_stock_take_line_unit REFERENCES inv.stock_unit (id) ON DELETE RESTRICT,
  expected_qty           numeric(14,3) NOT NULL,
  counted_qty            platform.qty NULL,
  recount_qty            platform.qty NULL,
  counted_weight_kg      platform.kg NULL,
  counted_weight_source  text NULL CONSTRAINT ck_stock_take_line_weight_source CHECK (counted_weight_source IN ('SCALE', 'MANUAL', 'ESTIMATE')),
  variance_qty           numeric(14,3) NULL,
  variance_value_pesewas platform.pesewas NULL,
  movement_id            uuid NULL CONSTRAINT uq_stock_take_line_movement UNIQUE
                           CONSTRAINT fk_stock_take_line_movement REFERENCES inv.stock_movement (id) ON DELETE RESTRICT,
  CONSTRAINT uq_stock_take_line UNIQUE NULLS NOT DISTINCT (stock_take_id, product_id, stock_unit_id),
  CONSTRAINT ck_stock_take_line_weight CHECK ((counted_weight_kg IS NULL) = (counted_weight_source IS NULL)),
  CONSTRAINT ck_stock_take_line_recount CHECK (recount_qty IS NULL OR counted_qty IS NOT NULL),
  -- The variance is the final count less the frozen expected figure, and has a value exactly when it is known.
  CONSTRAINT ck_stock_take_line_variance CHECK ((variance_qty IS NULL) = (variance_value_pesewas IS NULL)
                                                AND (variance_qty IS NULL OR (counted_qty IS NOT NULL
                                                     AND variance_qty = COALESCE(recount_qty, counted_qty) - expected_qty))),
  CONSTRAINT ck_stock_take_line_movement CHECK (movement_id IS NULL OR COALESCE(variance_qty, 0) <> 0)
);
COMMENT ON TABLE inv.stock_take_line IS 'class=DOCUMENT';
CREATE INDEX ix_stock_take_line_take ON inv.stock_take_line (stock_take_id);

-- What each step of a take may write in its scope and lines (HK004).
CREATE FUNCTION inv.stock_take_part_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  parent_status text;
  fillable text[];
  once text[];
  filled text;
BEGIN
  SELECT t.status INTO parent_status FROM inv.stock_take t WHERE t.id = NEW.stock_take_id;
  IF TG_OP = 'UPDATE' AND NEW.stock_take_id <> OLD.stock_take_id THEN
    parent_status := NULL;
  END IF;
  IF parent_status = 'DRAFT' AND (TG_OP = 'INSERT' OR TG_TABLE_NAME = 'stock_take_line') THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'stock_take_line' THEN
    fillable := CASE parent_status
                  WHEN 'COUNTING' THEN ARRAY['counted_qty', 'counted_weight_kg', 'counted_weight_source']
                  WHEN 'REVIEW' THEN ARRAY['recount_qty', 'variance_qty', 'variance_value_pesewas', 'movement_id']
                  WHEN 'PENDING_APPROVAL' THEN ARRAY['movement_id'] END;
    once := ARRAY['recount_qty', 'movement_id'];
    IF fillable IS NOT NULL AND (to_jsonb(NEW) - fillable) = (to_jsonb(OLD) - fillable) THEN
      FOREACH filled IN ARRAY once LOOP
        IF filled = ANY (fillable) AND to_jsonb(OLD) -> filled <> 'null'::jsonb AND to_jsonb(OLD) -> filled IS DISTINCT FROM to_jsonb(NEW) -> filled THEN
          RAISE EXCEPTION '%.% %: % is filled once', TG_TABLE_SCHEMA, TG_TABLE_NAME, OLD.id, filled USING ERRCODE = 'HK004';
        END IF;
      END LOOP;
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION '%.% is frozen with its stock take (status %)', TG_TABLE_SCHEMA, TG_TABLE_NAME, parent_status USING ERRCODE = 'HK004';
END
$$;
REVOKE ALL ON FUNCTION inv.stock_take_part_guard() FROM PUBLIC;
CREATE TRIGGER trg_stock_take_product_guard BEFORE INSERT OR UPDATE ON inv.stock_take_product
  FOR EACH ROW EXECUTE FUNCTION inv.stock_take_part_guard();
CREATE TRIGGER trg_stock_take_line_guard BEFORE INSERT OR UPDATE ON inv.stock_take_line
  FOR EACH ROW EXECUTE FUNCTION inv.stock_take_part_guard();

-- FR-INV-014: when a take starts counting, no other take of its location whose scope shares a product is counting,
-- in review or pending. The advisory lock on the location makes a second start wait for the first to commit; at read
-- committed it then sees the first, and at serializable the conflict aborts it (40001) and the retry sees it.
CREATE FUNCTION inv.stock_take_overlap() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  other uuid;
BEGIN
  IF NEW.status = 'COUNTING' AND OLD.status = 'DRAFT' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('inv.stock_take:' || NEW.location_id::text, 0));
    SELECT o.id INTO other
      FROM inv.stock_take o
     WHERE o.location_id = NEW.location_id
       AND o.id <> NEW.id
       AND o.status IN ('COUNTING', 'REVIEW', 'PENDING_APPROVAL')
       AND (o.scope = 'FULL' OR NEW.scope = 'FULL'
            OR EXISTS (SELECT 1 FROM inv.stock_take_product a JOIN inv.stock_take_product b ON b.product_id = a.product_id
                        WHERE a.stock_take_id = NEW.id AND b.stock_take_id = o.id))
     LIMIT 1;
    IF other IS NOT NULL THEN
      PERFORM inv.refuse('ck_stock_take_overlap', format('stock take %s overlaps stock take %s at the same location', NEW.id, other));
    END IF;
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION inv.stock_take_overlap() FROM PUBLIC;
CREATE TRIGGER trg_stock_take_overlap BEFORE UPDATE ON inv.stock_take
  FOR EACH ROW EXECUTE FUNCTION inv.stock_take_overlap();

REVOKE ALL ON inv.stock_take, inv.stock_take_product, inv.stock_take_line FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON inv.stock_take, inv.stock_take_product, inv.stock_take_line TO hk_app, hk_worker;

-- migrate:down
DROP TRIGGER trg_stock_take_overlap ON inv.stock_take;
DROP TRIGGER trg_stock_take_line_guard ON inv.stock_take_line;
DROP TRIGGER trg_stock_take_product_guard ON inv.stock_take_product;
DROP FUNCTION inv.stock_take_overlap();
DROP FUNCTION inv.stock_take_part_guard();
DROP TABLE inv.stock_take_line;
DROP TABLE inv.stock_take_product;
DROP TABLE inv.stock_take;
