-- 0047_inv_goods_receipts
-- Goods receipts (FR-INV-005, FR-INV-009; docs/data-model/inv.md): the header, its lines, and the animals a line of a
-- serialised product lists one by one. A receipt is a DRAFT that anyone holding inv.goods_receipt.create may change,
-- until it is POSTED (its movements written through Stock.postIn in the same transaction) or CANCELLED; both are
-- final and frozen (HK004). Lines and animals change only while their receipt is a DRAFT; hk_app holds no DELETE on
-- a DOCUMENT table (ADR-0024), so replacing a draft's lines is one SECURITY DEFINER function that can only empty a
-- DRAFT receipt. The animals table and cancel_reason are additions to the data model, recorded there (A-136).
-- Data category: INTERNAL (DC-13): quantities, values, supplier references; no personal data.
-- Rollback: tested (`pnpm db:rollback`), safe before the first posted receipt; afterwards forward fix only, since a
-- posted receipt is the source document of its movements.

-- migrate:up
CREATE TABLE inv.goods_receipt (
  id                uuid PRIMARY KEY CONSTRAINT fk_goods_receipt_document REFERENCES platform.business_document (id) ON DELETE RESTRICT,
  receipt_no        text NULL CONSTRAINT uq_goods_receipt_no UNIQUE,
  kind              text NOT NULL CONSTRAINT ck_goods_receipt_kind CHECK (kind IN ('PURCHASE', 'HARVEST', 'OPENING')),
  supplier_id       uuid NULL CONSTRAINT fk_goods_receipt_supplier REFERENCES mdm.supplier (id) ON DELETE RESTRICT,
  location_id       uuid NOT NULL CONSTRAINT fk_goods_receipt_location REFERENCES mdm.location (id) ON DELETE RESTRICT,
  order_document_id uuid NULL CONSTRAINT fk_goods_receipt_order REFERENCES platform.business_document (id) ON DELETE RESTRICT,
  delivery_note_ref text NULL CONSTRAINT ck_goods_receipt_delivery_note CHECK (length(btrim(delivery_note_ref)) BETWEEN 1 AND 60),
  received_at       timestamptz NOT NULL,
  notes             text NULL CONSTRAINT ck_goods_receipt_notes CHECK (length(notes) <= 2000),
  cancel_reason     text NULL CONSTRAINT ck_goods_receipt_cancel_reason CHECK (length(btrim(cancel_reason)) BETWEEN 1 AND 500),
  status            text NOT NULL CONSTRAINT ck_goods_receipt_status CHECK (status IN ('DRAFT', 'POSTED', 'CANCELLED')),
  branch_id         uuid NOT NULL CONSTRAINT fk_goods_receipt_branch REFERENCES mdm.branch (id) ON DELETE RESTRICT,
  version           integer NOT NULL DEFAULT 1,
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid NOT NULL CONSTRAINT fk_goods_receipt_created_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  updated_by        uuid NOT NULL CONSTRAINT fk_goods_receipt_updated_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  posted_at         timestamptz NULL,
  posted_by         uuid NULL CONSTRAINT fk_goods_receipt_posted_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  -- A purchase names its supplier; a harvest or an opening balance has none (FR-INV-009).
  CONSTRAINT ck_goods_receipt_supplier CHECK ((kind = 'PURCHASE') = (supplier_id IS NOT NULL)),
  CONSTRAINT ck_goods_receipt_posted CHECK ((status = 'POSTED') = (posted_at IS NOT NULL) AND (posted_at IS NULL) = (posted_by IS NULL)),
  CONSTRAINT ck_goods_receipt_cancelled CHECK ((status = 'CANCELLED') = (cancel_reason IS NOT NULL))
);
COMMENT ON TABLE inv.goods_receipt IS 'class=DOCUMENT';
CREATE INDEX ix_goods_receipt_branch ON inv.goods_receipt (branch_id, received_at);
CREATE INDEX ix_goods_receipt_supplier ON inv.goods_receipt (supplier_id) WHERE supplier_id IS NOT NULL;
CREATE TRIGGER trg_goods_receipt_version BEFORE UPDATE ON inv.goods_receipt
  FOR EACH ROW EXECUTE FUNCTION platform.touch_version();
-- Posted and cancelled receipts are final: nothing on them changes (FR-INV-009).
CREATE TRIGGER trg_goods_receipt_freeze BEFORE UPDATE ON inv.goods_receipt
  FOR EACH ROW EXECUTE FUNCTION platform.freeze_posted('POSTED,CANCELLED');

CREATE TABLE inv.goods_receipt_line (
  id               uuid PRIMARY KEY,
  goods_receipt_id uuid NOT NULL CONSTRAINT fk_goods_receipt_line_receipt REFERENCES inv.goods_receipt (id) ON DELETE RESTRICT,
  line_no          integer NOT NULL CONSTRAINT ck_goods_receipt_line_no CHECK (line_no > 0),
  product_id       uuid NOT NULL CONSTRAINT fk_goods_receipt_line_product REFERENCES mdm.product (id) ON DELETE RESTRICT,
  order_line_ref   uuid NULL,
  qty_received     platform.qty NOT NULL CONSTRAINT ck_goods_receipt_line_qty CHECK (qty_received > 0),
  qty_rejected     platform.qty NOT NULL DEFAULT 0,
  weight_kg        platform.kg NULL CONSTRAINT ck_goods_receipt_line_weight_positive CHECK (weight_kg > 0),
  weight_source    text NULL CONSTRAINT ck_goods_receipt_line_weight_source CHECK (weight_source IN ('SCALE', 'MANUAL', 'ESTIMATE')),
  value_pesewas    platform.pesewas NOT NULL,
  stock_unit_id    uuid NULL CONSTRAINT fk_goods_receipt_line_unit REFERENCES inv.stock_unit (id) ON DELETE RESTRICT,
  batch_no         text NULL CONSTRAINT ck_goods_receipt_line_batch CHECK (batch_no ~ '^[A-Za-z0-9][A-Za-z0-9/_-]{0,39}$'),
  expires_on       date NULL,
  CONSTRAINT uq_goods_receipt_line UNIQUE (goods_receipt_id, line_no),
  CONSTRAINT ck_goods_receipt_line_weight CHECK ((weight_kg IS NULL) = (weight_source IS NULL))
);
COMMENT ON TABLE inv.goods_receipt_line IS 'class=DOCUMENT';
CREATE INDEX ix_goods_receipt_line_product ON inv.goods_receipt_line (product_id);
CREATE INDEX ix_goods_receipt_line_unit ON inv.goods_receipt_line (stock_unit_id) WHERE stock_unit_id IS NOT NULL;

-- One animal of a serialised line: its tag, and what the livestock register takes from the arrival (B6).
CREATE TABLE inv.goods_receipt_animal (
  id                    uuid PRIMARY KEY,
  goods_receipt_line_id uuid NOT NULL CONSTRAINT fk_goods_receipt_animal_line REFERENCES inv.goods_receipt_line (id) ON DELETE RESTRICT,
  seq_no                integer NOT NULL CONSTRAINT ck_goods_receipt_animal_seq CHECK (seq_no > 0),
  tag_no                text NOT NULL CONSTRAINT ck_goods_receipt_animal_tag CHECK (tag_no ~ '^[A-Za-z0-9][A-Za-z0-9/_-]{0,39}$'),
  sex                   text NOT NULL CONSTRAINT ck_goods_receipt_animal_sex CHECK (sex IN ('MALE', 'FEMALE', 'UNKNOWN')),
  breed                 text NULL CONSTRAINT ck_goods_receipt_animal_breed CHECK (length(btrim(breed)) BETWEEN 1 AND 80),
  weight_kg             platform.kg NULL CONSTRAINT ck_goods_receipt_animal_weight_positive CHECK (weight_kg > 0),
  weight_source         text NULL CONSTRAINT ck_goods_receipt_animal_weight_source CHECK (weight_source IN ('SCALE', 'MANUAL', 'ESTIMATE')),
  date_of_birth         date NULL,
  purpose               text NOT NULL CONSTRAINT ck_goods_receipt_animal_purpose CHECK (purpose IN ('GROWING', 'BREEDING')),
  stock_unit_id         uuid NULL CONSTRAINT fk_goods_receipt_animal_unit REFERENCES inv.stock_unit (id) ON DELETE RESTRICT,
  CONSTRAINT uq_goods_receipt_animal_seq UNIQUE (goods_receipt_line_id, seq_no),
  CONSTRAINT uq_goods_receipt_animal_tag UNIQUE (goods_receipt_line_id, tag_no),
  CONSTRAINT ck_goods_receipt_animal_weight CHECK ((weight_kg IS NULL) = (weight_source IS NULL))
);
COMMENT ON TABLE inv.goods_receipt_animal IS 'class=DOCUMENT';

-- Lines and animals change only while their receipt is a DRAFT; afterwards they are frozen with it. HK004.
CREATE FUNCTION inv.goods_receipt_part_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  receipt_status text;
  receipt_id uuid;
BEGIN
  IF TG_TABLE_NAME = 'goods_receipt_line' THEN
    receipt_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.goods_receipt_id ELSE NEW.goods_receipt_id END;
    IF TG_OP = 'UPDATE' AND NEW.goods_receipt_id <> OLD.goods_receipt_id THEN
      receipt_id := NULL;
    END IF;
  ELSE
    SELECT l.goods_receipt_id INTO receipt_id FROM inv.goods_receipt_line l
     WHERE l.id = CASE WHEN TG_OP = 'DELETE' THEN OLD.goods_receipt_line_id ELSE NEW.goods_receipt_line_id END;
    IF TG_OP = 'UPDATE' AND NEW.goods_receipt_line_id <> OLD.goods_receipt_line_id THEN
      receipt_id := NULL;
    END IF;
  END IF;
  SELECT r.status INTO receipt_status FROM inv.goods_receipt r WHERE r.id = receipt_id;
  IF receipt_status IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION '%.% is frozen with its goods receipt (status %)', TG_TABLE_SCHEMA, TG_TABLE_NAME, receipt_status USING ERRCODE = 'HK004';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;
REVOKE ALL ON FUNCTION inv.goods_receipt_part_guard() FROM PUBLIC;
CREATE TRIGGER trg_goods_receipt_line_guard BEFORE INSERT OR UPDATE OR DELETE ON inv.goods_receipt_line
  FOR EACH ROW EXECUTE FUNCTION inv.goods_receipt_part_guard();
CREATE TRIGGER trg_goods_receipt_animal_guard BEFORE INSERT OR UPDATE OR DELETE ON inv.goods_receipt_animal
  FOR EACH ROW EXECUTE FUNCTION inv.goods_receipt_part_guard();

-- updateGoodsReceipt replaces a draft's lines outright. The guards above refuse it for anything but a DRAFT.
CREATE FUNCTION inv.clear_draft_goods_receipt_lines(p_receipt_id uuid) RETURNS integer
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
DECLARE
  removed integer;
BEGIN
  DELETE FROM inv.goods_receipt_animal a USING inv.goods_receipt_line l WHERE a.goods_receipt_line_id = l.id AND l.goods_receipt_id = p_receipt_id;
  DELETE FROM inv.goods_receipt_line WHERE goods_receipt_id = p_receipt_id;
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END
$$;
REVOKE ALL ON FUNCTION inv.clear_draft_goods_receipt_lines(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION inv.clear_draft_goods_receipt_lines(uuid) TO hk_app, hk_worker;

REVOKE ALL ON inv.goods_receipt, inv.goods_receipt_line, inv.goods_receipt_animal FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON inv.goods_receipt, inv.goods_receipt_line, inv.goods_receipt_animal TO hk_app, hk_worker;

-- migrate:down
DROP FUNCTION inv.clear_draft_goods_receipt_lines(uuid);
DROP TRIGGER trg_goods_receipt_animal_guard ON inv.goods_receipt_animal;
DROP TRIGGER trg_goods_receipt_line_guard ON inv.goods_receipt_line;
DROP FUNCTION inv.goods_receipt_part_guard();
DROP TABLE inv.goods_receipt_animal;
DROP TABLE inv.goods_receipt_line;
DROP TABLE inv.goods_receipt;
