-- 0051_inv_stock_control_documents
-- The stock documents that move stock a person decides on (docs/data-model/inv.md): transfers through in-transit with
-- a receipt confirmation and its variance (FR-INV-010, FR-INV-011), adjustments with a reason from the fixed list and
-- approval at the threshold (FR-INV-012), and reversals of a movement (FR-INV-004). Every movement they cause is
-- written through Stock.postIn in the same serializable transaction; these tables record what was asked, by whom,
-- and which movements it produced.
--
-- The database holds the document rules itself, whoever writes:
--   inv.document_status_guard  a document starts in its first status and moves only along its listed transitions
--                              (SQLSTATE HK004, as a frozen document's change is)
--   freeze_posted              a received or cancelled transfer, a posted or rejected adjustment and a posted or
--                              rejected reversal are final; a dispatched transfer changes only to be received; a
--                              pending adjustment only to be decided
--   inv.stock_document_part_guard  lines are written while their document is a DRAFT; afterwards only the columns the
--                              next step fills, once, from null
--   ck_stock_adjustment_approved, ck_stock_reversal_approved  a posted adjustment or reversal whose value is at or
--                              above the threshold it was judged against names its approval request
-- The threshold is copied onto the document when it is submitted, from IAM's approval policy through IAM's interface
-- (A-139): the check compares the row with itself and reads no other schema's table (ADR-0047 is not widened).
-- The movement and stock-unit columns on transfer and adjustment lines, `in_transit_location_id`, the weight source
-- of an adjustment line, the thresholds and `inv.stock_reversal` are additions to the data model, recorded there.
-- Data category: INTERNAL (DC-13): quantities, values, locations and reasons; no personal data.
-- Rollback: tested (`pnpm db:rollback`), safe before the first document; afterwards forward fix only, since a posted
-- document is the source document of its movements.

-- migrate:up

-- A document starts in one of the statuses of TG_ARGV[0] and moves only along TG_ARGV[1] ('FROM>TO,FROM>TO').
CREATE FUNCTION inv.document_status_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT (NEW.status = ANY (string_to_array(TG_ARGV[0], ','))) THEN
      RAISE EXCEPTION '%.% %: a new document starts in %, not %', TG_TABLE_SCHEMA, TG_TABLE_NAME, NEW.id, TG_ARGV[0], NEW.status USING ERRCODE = 'HK004';
    END IF;
  ELSIF NEW.status <> OLD.status AND NOT ((OLD.status || '>' || NEW.status) = ANY (string_to_array(TG_ARGV[1], ','))) THEN
    RAISE EXCEPTION '%.% %: % cannot become %', TG_TABLE_SCHEMA, TG_TABLE_NAME, OLD.id, OLD.status, NEW.status USING ERRCODE = 'HK004';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION inv.document_status_guard() FROM PUBLIC;

-- Transfers (FR-INV-010, FR-INV-011): dispatched to the source branch's in-transit location, received at the
-- destination, any shortfall posted as a loss with a reason.
CREATE TABLE inv.stock_transfer (
  id                     uuid PRIMARY KEY CONSTRAINT fk_stock_transfer_document REFERENCES platform.business_document (id) ON DELETE RESTRICT,
  transfer_no            text NULL CONSTRAINT uq_stock_transfer_no UNIQUE,
  from_location_id       uuid NOT NULL CONSTRAINT fk_stock_transfer_from REFERENCES mdm.location (id) ON DELETE RESTRICT,
  to_location_id         uuid NOT NULL CONSTRAINT fk_stock_transfer_to REFERENCES mdm.location (id) ON DELETE RESTRICT,
  to_branch_id           uuid NOT NULL CONSTRAINT fk_stock_transfer_to_branch REFERENCES mdm.branch (id) ON DELETE RESTRICT,
  in_transit_location_id uuid NULL CONSTRAINT fk_stock_transfer_in_transit REFERENCES mdm.location (id) ON DELETE RESTRICT,
  dispatched_at          timestamptz NULL,
  dispatched_by          uuid NULL CONSTRAINT fk_stock_transfer_dispatched_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  received_at            timestamptz NULL,
  received_by            uuid NULL CONSTRAINT fk_stock_transfer_received_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  cancel_reason          text NULL CONSTRAINT ck_stock_transfer_cancel_reason CHECK (length(btrim(cancel_reason)) BETWEEN 1 AND 500),
  status                 text NOT NULL CONSTRAINT ck_stock_transfer_status CHECK (status IN ('DRAFT', 'DISPATCHED', 'RECEIVED', 'CANCELLED')),
  branch_id              uuid NOT NULL CONSTRAINT fk_stock_transfer_branch REFERENCES mdm.branch (id) ON DELETE RESTRICT,
  version                integer NOT NULL DEFAULT 1,
  created_at             timestamptz NOT NULL DEFAULT now(),
  created_by             uuid NOT NULL CONSTRAINT fk_stock_transfer_created_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  updated_at             timestamptz NOT NULL DEFAULT now(),
  updated_by             uuid NOT NULL CONSTRAINT fk_stock_transfer_updated_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  CONSTRAINT ck_stock_transfer_locations CHECK (from_location_id <> to_location_id),
  CONSTRAINT ck_stock_transfer_dispatched CHECK ((status IN ('DISPATCHED', 'RECEIVED')) = (dispatched_at IS NOT NULL)
                                                 AND (dispatched_at IS NULL) = (dispatched_by IS NULL)
                                                 AND (dispatched_at IS NULL) = (in_transit_location_id IS NULL)),
  CONSTRAINT ck_stock_transfer_received CHECK ((status = 'RECEIVED') = (received_at IS NOT NULL) AND (received_at IS NULL) = (received_by IS NULL)),
  CONSTRAINT ck_stock_transfer_cancelled CHECK ((status = 'CANCELLED') = (cancel_reason IS NOT NULL))
);
COMMENT ON TABLE inv.stock_transfer IS 'class=DOCUMENT';
CREATE INDEX ix_stock_transfer_branch ON inv.stock_transfer (branch_id, status);
CREATE INDEX ix_stock_transfer_to_branch ON inv.stock_transfer (to_branch_id, status);
CREATE TRIGGER trg_stock_transfer_version BEFORE UPDATE ON inv.stock_transfer
  FOR EACH ROW EXECUTE FUNCTION platform.touch_version();
CREATE TRIGGER trg_stock_transfer_status BEFORE INSERT OR UPDATE ON inv.stock_transfer
  FOR EACH ROW EXECUTE FUNCTION inv.document_status_guard('DRAFT', 'DRAFT>DISPATCHED,DRAFT>CANCELLED,DISPATCHED>RECEIVED');
CREATE TRIGGER trg_stock_transfer_freeze BEFORE UPDATE ON inv.stock_transfer
  FOR EACH ROW EXECUTE FUNCTION platform.freeze_posted('RECEIVED,CANCELLED');
-- A dispatched transfer changes only to be received.
CREATE TRIGGER trg_stock_transfer_freeze_dispatched BEFORE UPDATE ON inv.stock_transfer
  FOR EACH ROW EXECUTE FUNCTION platform.freeze_posted('DISPATCHED', 'status', 'received_at', 'received_by', 'version', 'updated_at', 'updated_by');

CREATE TABLE inv.stock_transfer_line (
  id                   uuid PRIMARY KEY,
  stock_transfer_id    uuid NOT NULL CONSTRAINT fk_stock_transfer_line_transfer REFERENCES inv.stock_transfer (id) ON DELETE RESTRICT,
  line_no              integer NOT NULL CONSTRAINT ck_stock_transfer_line_no CHECK (line_no > 0),
  product_id           uuid NOT NULL CONSTRAINT fk_stock_transfer_line_product REFERENCES mdm.product (id) ON DELETE RESTRICT,
  stock_unit_id        uuid NULL CONSTRAINT fk_stock_transfer_line_unit REFERENCES inv.stock_unit (id) ON DELETE RESTRICT,
  qty_dispatched       platform.qty NOT NULL CONSTRAINT ck_stock_transfer_line_qty CHECK (qty_dispatched > 0),
  qty_received         platform.qty NULL,
  variance_qty         platform.qty NULL,
  variance_reason_code text NULL CONSTRAINT fk_stock_transfer_line_reason REFERENCES mdm.reason_code (code) ON DELETE RESTRICT,
  dispatch_movement_id uuid NULL CONSTRAINT fk_stock_transfer_line_dispatch REFERENCES inv.stock_movement (id) ON DELETE RESTRICT,
  receipt_movement_id  uuid NULL CONSTRAINT fk_stock_transfer_line_receipt REFERENCES inv.stock_movement (id) ON DELETE RESTRICT,
  variance_movement_id uuid NULL CONSTRAINT fk_stock_transfer_line_variance REFERENCES inv.stock_movement (id) ON DELETE RESTRICT,
  CONSTRAINT uq_stock_transfer_line UNIQUE (stock_transfer_id, line_no),
  -- FR-INV-011: what arrived plus the recorded variance is what was dispatched; a shortfall has its reason.
  CONSTRAINT ck_stock_transfer_line_received CHECK ((qty_received IS NULL) = (variance_qty IS NULL)
                                                   AND (qty_received IS NULL OR qty_received + variance_qty = qty_dispatched)),
  CONSTRAINT ck_stock_transfer_line_variance_reason CHECK ((COALESCE(variance_qty, 0) > 0) = (variance_reason_code IS NOT NULL)),
  CONSTRAINT ck_stock_transfer_line_movements CHECK ((COALESCE(qty_received, 0) > 0) = (receipt_movement_id IS NOT NULL)
                                                     AND (COALESCE(variance_qty, 0) > 0) = (variance_movement_id IS NOT NULL))
);
COMMENT ON TABLE inv.stock_transfer_line IS 'class=DOCUMENT';
CREATE INDEX ix_stock_transfer_line_unit ON inv.stock_transfer_line (stock_unit_id) WHERE stock_unit_id IS NOT NULL;

-- Adjustments (FR-INV-012): a reason from the fixed list, lines valued from the cost pool, approval at the threshold.
CREATE TABLE inv.stock_adjustment (
  id                         uuid PRIMARY KEY CONSTRAINT fk_stock_adjustment_document REFERENCES platform.business_document (id) ON DELETE RESTRICT,
  adjustment_no              text NULL CONSTRAINT uq_stock_adjustment_no UNIQUE,
  location_id                uuid NOT NULL CONSTRAINT fk_stock_adjustment_location REFERENCES mdm.location (id) ON DELETE RESTRICT,
  reason_code                text NOT NULL CONSTRAINT fk_stock_adjustment_reason REFERENCES mdm.reason_code (code) ON DELETE RESTRICT,
  note                       text NULL CONSTRAINT ck_stock_adjustment_note CHECK (length(btrim(note)) BETWEEN 1 AND 1000),
  total_value_pesewas        platform.pesewas NOT NULL DEFAULT 0,
  approval_threshold_pesewas platform.pesewas NULL,
  approval_request_id        uuid NULL CONSTRAINT fk_stock_adjustment_approval REFERENCES iam.approval_request (id) ON DELETE RESTRICT,
  exception_id               uuid NULL CONSTRAINT fk_stock_adjustment_exception REFERENCES inv.stock_exception (id) ON DELETE RESTRICT,
  status                     text NOT NULL CONSTRAINT ck_stock_adjustment_status CHECK (status IN ('DRAFT', 'PENDING_APPROVAL', 'POSTED', 'REJECTED')),
  branch_id                  uuid NOT NULL CONSTRAINT fk_stock_adjustment_branch REFERENCES mdm.branch (id) ON DELETE RESTRICT,
  version                    integer NOT NULL DEFAULT 1,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  created_by                 uuid NOT NULL CONSTRAINT fk_stock_adjustment_created_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  updated_by                 uuid NOT NULL CONSTRAINT fk_stock_adjustment_updated_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  posted_at                  timestamptz NULL,
  posted_by                  uuid NULL CONSTRAINT fk_stock_adjustment_posted_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  CONSTRAINT ck_stock_adjustment_posted CHECK ((status = 'POSTED') = (posted_at IS NOT NULL) AND (posted_at IS NULL) = (posted_by IS NULL)),
  CONSTRAINT ck_stock_adjustment_judged CHECK (status = 'DRAFT' OR approval_threshold_pesewas IS NOT NULL),
  CONSTRAINT ck_stock_adjustment_pending CHECK (status NOT IN ('PENDING_APPROVAL', 'REJECTED') OR approval_request_id IS NOT NULL),
  -- The abuse case "an adjustment used to hide a shortage": at or above the threshold, never posted without approval.
  CONSTRAINT ck_stock_adjustment_approved CHECK (status <> 'POSTED' OR total_value_pesewas < approval_threshold_pesewas OR approval_request_id IS NOT NULL)
);
COMMENT ON TABLE inv.stock_adjustment IS 'class=DOCUMENT';
CREATE INDEX ix_stock_adjustment_branch ON inv.stock_adjustment (branch_id, status);
CREATE INDEX ix_stock_adjustment_created_by ON inv.stock_adjustment (created_by);
CREATE TRIGGER trg_stock_adjustment_version BEFORE UPDATE ON inv.stock_adjustment
  FOR EACH ROW EXECUTE FUNCTION platform.touch_version();
CREATE TRIGGER trg_stock_adjustment_status BEFORE INSERT OR UPDATE ON inv.stock_adjustment
  FOR EACH ROW EXECUTE FUNCTION inv.document_status_guard('DRAFT', 'DRAFT>PENDING_APPROVAL,DRAFT>POSTED,PENDING_APPROVAL>POSTED,PENDING_APPROVAL>REJECTED');
CREATE TRIGGER trg_stock_adjustment_freeze BEFORE UPDATE ON inv.stock_adjustment
  FOR EACH ROW EXECUTE FUNCTION platform.freeze_posted('POSTED,REJECTED');
-- A pending adjustment changes only to be decided.
CREATE TRIGGER trg_stock_adjustment_freeze_pending BEFORE UPDATE ON inv.stock_adjustment
  FOR EACH ROW EXECUTE FUNCTION platform.freeze_posted('PENDING_APPROVAL', 'status', 'posted_at', 'posted_by', 'version', 'updated_at', 'updated_by');

CREATE TABLE inv.stock_adjustment_line (
  id                  uuid PRIMARY KEY,
  stock_adjustment_id uuid NOT NULL CONSTRAINT fk_stock_adjustment_line_adjustment REFERENCES inv.stock_adjustment (id) ON DELETE RESTRICT,
  line_no             integer NOT NULL CONSTRAINT ck_stock_adjustment_line_no CHECK (line_no > 0),
  product_id          uuid NOT NULL CONSTRAINT fk_stock_adjustment_line_product REFERENCES mdm.product (id) ON DELETE RESTRICT,
  stock_unit_id       uuid NULL CONSTRAINT fk_stock_adjustment_line_unit REFERENCES inv.stock_unit (id) ON DELETE RESTRICT,
  direction           text NOT NULL CONSTRAINT ck_stock_adjustment_line_direction CHECK (direction IN ('GAIN', 'LOSS')),
  qty                 platform.qty NOT NULL CONSTRAINT ck_stock_adjustment_line_qty CHECK (qty > 0),
  weight_kg           platform.kg NULL CONSTRAINT ck_stock_adjustment_line_weight_positive CHECK (weight_kg > 0),
  weight_source       text NULL CONSTRAINT ck_stock_adjustment_line_weight_source CHECK (weight_source IN ('SCALE', 'MANUAL', 'ESTIMATE')),
  value_pesewas       platform.pesewas NOT NULL DEFAULT 0,
  movement_id         uuid NULL CONSTRAINT uq_stock_adjustment_line_movement UNIQUE
                        CONSTRAINT fk_stock_adjustment_line_movement REFERENCES inv.stock_movement (id) ON DELETE RESTRICT,
  CONSTRAINT uq_stock_adjustment_line UNIQUE (stock_adjustment_id, line_no),
  CONSTRAINT ck_stock_adjustment_line_weight CHECK ((weight_kg IS NULL) = (weight_source IS NULL))
);
COMMENT ON TABLE inv.stock_adjustment_line IS 'class=DOCUMENT';

-- Reversals (FR-INV-004): the request to reverse one movement, and the reversing movement once it is posted.
CREATE TABLE inv.stock_reversal (
  id                         uuid PRIMARY KEY CONSTRAINT fk_stock_reversal_document REFERENCES platform.business_document (id) ON DELETE RESTRICT,
  movement_id                uuid NOT NULL CONSTRAINT fk_stock_reversal_movement REFERENCES inv.stock_movement (id) ON DELETE RESTRICT,
  reason_code                text NOT NULL CONSTRAINT fk_stock_reversal_reason REFERENCES mdm.reason_code (code) ON DELETE RESTRICT,
  note                       text NOT NULL CONSTRAINT ck_stock_reversal_note CHECK (length(btrim(note)) BETWEEN 1 AND 1000),
  value_pesewas              platform.pesewas NOT NULL,
  approval_threshold_pesewas platform.pesewas NOT NULL,
  approval_request_id        uuid NULL CONSTRAINT fk_stock_reversal_approval REFERENCES iam.approval_request (id) ON DELETE RESTRICT,
  reversal_movement_id       uuid NULL CONSTRAINT uq_stock_reversal_reversing UNIQUE
                               CONSTRAINT fk_stock_reversal_reversing REFERENCES inv.stock_movement (id) ON DELETE RESTRICT,
  status                     text NOT NULL CONSTRAINT ck_stock_reversal_status CHECK (status IN ('PENDING_APPROVAL', 'POSTED', 'REJECTED')),
  branch_id                  uuid NOT NULL CONSTRAINT fk_stock_reversal_branch REFERENCES mdm.branch (id) ON DELETE RESTRICT,
  version                    integer NOT NULL DEFAULT 1,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  created_by                 uuid NOT NULL CONSTRAINT fk_stock_reversal_created_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  updated_by                 uuid NOT NULL CONSTRAINT fk_stock_reversal_updated_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  posted_at                  timestamptz NULL,
  posted_by                  uuid NULL CONSTRAINT fk_stock_reversal_posted_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  CONSTRAINT ck_stock_reversal_posted CHECK ((status = 'POSTED') = (posted_at IS NOT NULL) AND (posted_at IS NULL) = (posted_by IS NULL)
                                             AND (status = 'POSTED') = (reversal_movement_id IS NOT NULL)),
  CONSTRAINT ck_stock_reversal_pending CHECK (status = 'POSTED' OR approval_request_id IS NOT NULL),
  CONSTRAINT ck_stock_reversal_approved CHECK (status <> 'POSTED' OR value_pesewas < approval_threshold_pesewas OR approval_request_id IS NOT NULL)
);
COMMENT ON TABLE inv.stock_reversal IS 'class=DOCUMENT';
-- One movement has at most one reversal asked for or done; a rejected request may be asked again.
CREATE UNIQUE INDEX uq_stock_reversal_open ON inv.stock_reversal (movement_id) WHERE status <> 'REJECTED';
CREATE TRIGGER trg_stock_reversal_version BEFORE UPDATE ON inv.stock_reversal
  FOR EACH ROW EXECUTE FUNCTION platform.touch_version();
CREATE TRIGGER trg_stock_reversal_status BEFORE INSERT OR UPDATE ON inv.stock_reversal
  FOR EACH ROW EXECUTE FUNCTION inv.document_status_guard('PENDING_APPROVAL,POSTED', 'PENDING_APPROVAL>POSTED,PENDING_APPROVAL>REJECTED');
CREATE TRIGGER trg_stock_reversal_freeze BEFORE UPDATE ON inv.stock_reversal
  FOR EACH ROW EXECUTE FUNCTION platform.freeze_posted('POSTED,REJECTED');
CREATE TRIGGER trg_stock_reversal_freeze_pending BEFORE UPDATE ON inv.stock_reversal
  FOR EACH ROW EXECUTE FUNCTION platform.freeze_posted('PENDING_APPROVAL', 'status', 'reversal_movement_id', 'posted_at', 'posted_by', 'version', 'updated_at', 'updated_by');

-- Lines are written while their document is a DRAFT. Afterwards only what the next step fills may change, once,
-- from null: the receipt of a dispatched transfer, the movement of a pending adjustment's line. HK004.
CREATE FUNCTION inv.stock_document_part_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  parent_status text;
  fillable text[];
  filled text;
BEGIN
  IF TG_TABLE_NAME = 'stock_transfer_line' THEN
    SELECT t.status INTO parent_status FROM inv.stock_transfer t WHERE t.id = NEW.stock_transfer_id;
    IF TG_OP = 'UPDATE' AND NEW.stock_transfer_id <> OLD.stock_transfer_id THEN
      parent_status := NULL;
    END IF;
    fillable := CASE parent_status WHEN 'DISPATCHED' THEN ARRAY['qty_received', 'variance_qty', 'variance_reason_code', 'receipt_movement_id', 'variance_movement_id'] END;
  ELSE
    SELECT a.status INTO parent_status FROM inv.stock_adjustment a WHERE a.id = NEW.stock_adjustment_id;
    IF TG_OP = 'UPDATE' AND NEW.stock_adjustment_id <> OLD.stock_adjustment_id THEN
      parent_status := NULL;
    END IF;
    fillable := CASE parent_status WHEN 'PENDING_APPROVAL' THEN ARRAY['movement_id'] END;
  END IF;
  IF parent_status = 'DRAFT' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND fillable IS NOT NULL AND (to_jsonb(NEW) - fillable) = (to_jsonb(OLD) - fillable) THEN
    FOREACH filled IN ARRAY fillable LOOP
      IF to_jsonb(OLD) -> filled <> 'null'::jsonb AND to_jsonb(OLD) -> filled IS DISTINCT FROM to_jsonb(NEW) -> filled THEN
        RAISE EXCEPTION '%.% %: % is filled once', TG_TABLE_SCHEMA, TG_TABLE_NAME, OLD.id, filled USING ERRCODE = 'HK004';
      END IF;
    END LOOP;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '%.% is frozen with its document (status %)', TG_TABLE_SCHEMA, TG_TABLE_NAME, parent_status USING ERRCODE = 'HK004';
END
$$;
REVOKE ALL ON FUNCTION inv.stock_document_part_guard() FROM PUBLIC;
CREATE TRIGGER trg_stock_transfer_line_guard BEFORE INSERT OR UPDATE ON inv.stock_transfer_line
  FOR EACH ROW EXECUTE FUNCTION inv.stock_document_part_guard();
CREATE TRIGGER trg_stock_adjustment_line_guard BEFORE INSERT OR UPDATE ON inv.stock_adjustment_line
  FOR EACH ROW EXECUTE FUNCTION inv.stock_document_part_guard();

REVOKE ALL ON inv.stock_transfer, inv.stock_transfer_line, inv.stock_adjustment, inv.stock_adjustment_line, inv.stock_reversal FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON inv.stock_transfer, inv.stock_transfer_line, inv.stock_adjustment, inv.stock_adjustment_line, inv.stock_reversal TO hk_app, hk_worker;

-- migrate:down
DROP TRIGGER trg_stock_adjustment_line_guard ON inv.stock_adjustment_line;
DROP TRIGGER trg_stock_transfer_line_guard ON inv.stock_transfer_line;
DROP FUNCTION inv.stock_document_part_guard();
DROP TABLE inv.stock_reversal;
DROP TABLE inv.stock_adjustment_line;
DROP TABLE inv.stock_adjustment;
DROP TABLE inv.stock_transfer_line;
DROP TABLE inv.stock_transfer;
DROP FUNCTION inv.document_status_guard();
