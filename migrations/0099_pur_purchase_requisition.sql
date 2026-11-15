-- 0099_pur_purchase_requisition
-- Purchase requisitions (docs/data-model/pur.md; FR-PUR-004; A-166): what a storekeeper or farm hand asks to be bought,
-- with the product, quantity in its base unit and a needed-by date, which a manager rejects with a reason or converts
-- into a draft purchase order.
--
-- The database holds the lifecycle itself, whoever writes:
--   pur.purchase_requisition_status_guard  a requisition starts DRAFT and moves DRAFT to SUBMITTED, then SUBMITTED to
--                                          CONVERTED or REJECTED; DRAFT or SUBMITTED may be CANCELLED (HK004)
--   ck_purchase_requisition_converted      a converted requisition names its purchase order, and only it does
--   ck_purchase_requisition_rejected       a rejected requisition carries its reason, and only it does
--   pur.purchase_requisition_line_guard    lines change only while their requisition is DRAFT (HK004)
-- Data category: INTERNAL (DC-13).
-- Rollback: tested (`pnpm db:rollback`), safe before the first requisition; afterwards forward fix only.

-- migrate:up
CREATE TABLE pur.purchase_requisition (
  id                uuid PRIMARY KEY CONSTRAINT fk_purchase_requisition_document REFERENCES platform.business_document (id) ON DELETE RESTRICT,
  requisition_no    text NULL CONSTRAINT uq_purchase_requisition_no UNIQUE,
  requested_by      uuid NOT NULL CONSTRAINT fk_purchase_requisition_requested_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  -- Where the goods are wanted: the location the requester's grant names, or null for a branch-wide request.
  location_id       uuid NULL CONSTRAINT fk_purchase_requisition_location REFERENCES mdm.location (id) ON DELETE RESTRICT,
  needed_by         date NULL,
  justification     text NULL CONSTRAINT ck_purchase_requisition_justification CHECK (length(btrim(justification)) BETWEEN 1 AND 500),
  purchase_order_id uuid NULL CONSTRAINT fk_purchase_requisition_order REFERENCES pur.purchase_order (id) ON DELETE RESTRICT,
  reject_reason     text NULL CONSTRAINT ck_purchase_requisition_reject_reason CHECK (length(btrim(reject_reason)) BETWEEN 1 AND 500),
  status            text NOT NULL CONSTRAINT ck_purchase_requisition_status CHECK (status IN ('DRAFT', 'SUBMITTED', 'CONVERTED', 'REJECTED', 'CANCELLED')),
  branch_id         uuid NOT NULL CONSTRAINT fk_purchase_requisition_branch REFERENCES mdm.branch (id) ON DELETE RESTRICT,
  version           integer NOT NULL DEFAULT 1,
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid NOT NULL CONSTRAINT fk_purchase_requisition_created_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  updated_by        uuid NOT NULL CONSTRAINT fk_purchase_requisition_updated_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  posted_at         timestamptz NULL,
  posted_by         uuid NULL CONSTRAINT fk_purchase_requisition_posted_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  -- FR-PUR-004: a converted requisition links its order; nothing else does.
  CONSTRAINT ck_purchase_requisition_converted CHECK ((status = 'CONVERTED') = (purchase_order_id IS NOT NULL)),
  CONSTRAINT ck_purchase_requisition_rejected CHECK ((status = 'REJECTED') = (reject_reason IS NOT NULL)),
  CONSTRAINT ck_purchase_requisition_posted CHECK ((posted_at IS NULL) = (posted_by IS NULL)
                                                   AND (status IN ('DRAFT', 'SUBMITTED')) = (posted_at IS NULL))
);
COMMENT ON TABLE pur.purchase_requisition IS 'class=DOCUMENT';
CREATE UNIQUE INDEX uq_purchase_requisition_order ON pur.purchase_requisition (purchase_order_id) WHERE purchase_order_id IS NOT NULL;
CREATE INDEX ix_purchase_requisition_branch ON pur.purchase_requisition (branch_id, created_at);
CREATE TRIGGER trg_purchase_requisition_version BEFORE UPDATE ON pur.purchase_requisition
  FOR EACH ROW EXECUTE FUNCTION platform.touch_version();
CREATE TRIGGER trg_purchase_requisition_freeze BEFORE UPDATE ON pur.purchase_requisition
  FOR EACH ROW EXECUTE FUNCTION platform.freeze_posted('CONVERTED,REJECTED,CANCELLED');

CREATE TABLE pur.purchase_requisition_line (
  id             uuid PRIMARY KEY,
  requisition_id uuid NOT NULL CONSTRAINT fk_purchase_requisition_line_requisition REFERENCES pur.purchase_requisition (id) ON DELETE RESTRICT,
  line_no        integer NOT NULL CONSTRAINT ck_purchase_requisition_line_no CHECK (line_no > 0),
  product_id     uuid NOT NULL CONSTRAINT fk_purchase_requisition_line_product REFERENCES mdm.product (id) ON DELETE RESTRICT,
  qty            platform.qty NOT NULL CONSTRAINT ck_purchase_requisition_line_qty CHECK (qty > 0),
  note           text NULL CONSTRAINT ck_purchase_requisition_line_note CHECK (length(btrim(note)) BETWEEN 1 AND 200),
  CONSTRAINT uq_purchase_requisition_line_no UNIQUE (requisition_id, line_no)
);
COMMENT ON TABLE pur.purchase_requisition_line IS 'class=DOCUMENT';

CREATE FUNCTION pur.purchase_requisition_status_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'DRAFT' THEN
      RAISE EXCEPTION 'pur.purchase_requisition %: a requisition starts DRAFT', NEW.id USING ERRCODE = 'HK004';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'DRAFT' AND NEW.status IN ('SUBMITTED', 'CANCELLED'))
    OR (OLD.status = 'SUBMITTED' AND NEW.status IN ('CONVERTED', 'REJECTED', 'CANCELLED'))) THEN
    RAISE EXCEPTION 'pur.purchase_requisition %: % cannot become %', OLD.id, OLD.status, NEW.status USING ERRCODE = 'HK004';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION pur.purchase_requisition_status_guard() FROM PUBLIC;
CREATE TRIGGER trg_purchase_requisition_status BEFORE INSERT OR UPDATE ON pur.purchase_requisition
  FOR EACH ROW EXECUTE FUNCTION pur.purchase_requisition_status_guard();

-- Lines are the requester's words while the requisition is a draft, and fixed from submission on. HK004.
CREATE FUNCTION pur.purchase_requisition_line_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  parent text;
BEGIN
  SELECT r.status INTO parent FROM pur.purchase_requisition r
   WHERE r.id = CASE WHEN TG_OP = 'DELETE' THEN OLD.requisition_id ELSE NEW.requisition_id END;
  IF parent IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION 'pur.purchase_requisition_line: lines change only while the requisition is DRAFT, not %', parent USING ERRCODE = 'HK004';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;
REVOKE ALL ON FUNCTION pur.purchase_requisition_line_guard() FROM PUBLIC;
CREATE TRIGGER trg_purchase_requisition_line_guard BEFORE INSERT OR UPDATE OR DELETE ON pur.purchase_requisition_line
  FOR EACH ROW EXECUTE FUNCTION pur.purchase_requisition_line_guard();

-- Replaces a draft's lines: DOCUMENT tables grant no DELETE, so the one removal a draft needs runs here, owned by
-- hk_owner, and the line guard still refuses it once the requisition is submitted.
CREATE FUNCTION pur.clear_purchase_requisition_lines(requisition uuid) RETURNS void
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
  DELETE FROM pur.purchase_requisition_line WHERE requisition_id = requisition;
$$;
REVOKE ALL ON FUNCTION pur.clear_purchase_requisition_lines(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pur.clear_purchase_requisition_lines(uuid) TO hk_app, hk_worker;

REVOKE ALL ON pur.purchase_requisition, pur.purchase_requisition_line FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON pur.purchase_requisition, pur.purchase_requisition_line TO hk_app, hk_worker;

-- migrate:down
DROP FUNCTION pur.clear_purchase_requisition_lines(uuid);
DROP TABLE pur.purchase_requisition_line;
DROP TABLE pur.purchase_requisition;
DROP FUNCTION pur.purchase_requisition_line_guard();
DROP FUNCTION pur.purchase_requisition_status_guard();
