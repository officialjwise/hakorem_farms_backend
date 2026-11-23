-- 0323_ord_delivery_return
-- B11 continued 4 (FR-DEL-011, the owner's van rule of 2026-11-23, ADR-0092, A-360): how a failed delivery's goods
-- left the van other than by delivery, and what the customer was credited and refunded for them.
--   ord.delivery_return     DOCUMENT. One per way out of a FAILED delivery: RETURN_TO_STOCK (the goods moved from the
--                           vehicle to the named returns hold) or WRITE_OFF (through INV's STOCK_ADJUSTMENT at the vehicle,
--                           with its reason). A return is written POSTED; a write-off is written POSTED when its adjustment
--                           posted at once, or PENDING_APPROVAL while it waits for the stock write-off approval, then
--                           POSTED or REJECTED. POSTED names the credit note of the delivery's document, drafted or issued
--                           (ck_delivery_return_posted); the refund of what the customer paid is named once, after the
--                           credit note (ck_delivery_return_refund). What was asked never changes, a REJECTED row is
--                           frozen, and the credit note and refund are each set once (ck_delivery_return_transition,
--                           HK004). One live way out per delivery (uq_delivery_return_live).
-- Data category: CONFIDENTIAL (DC-22): commercial history.
-- Rollback: tested (`pnpm db:rollback`), safe before the first return to stock; afterwards forward fix only.

-- migrate:up
CREATE TABLE ord.delivery_return (
  id                           uuid PRIMARY KEY,
  delivery_id                  uuid NOT NULL CONSTRAINT fk_delivery_return_delivery REFERENCES del.delivery (id) ON DELETE RESTRICT,
  sales_order_id               uuid NOT NULL CONSTRAINT fk_delivery_return_order REFERENCES ord.sales_order (id) ON DELETE RESTRICT,
  original_billing_document_id uuid NOT NULL CONSTRAINT fk_delivery_return_original REFERENCES bil.billing_document (id) ON DELETE RESTRICT,
  way_out                      text NOT NULL CONSTRAINT ck_delivery_return_way_out_kind CHECK (way_out IN ('RETURN_TO_STOCK', 'WRITE_OFF')),
  returns_location_id          uuid NULL CONSTRAINT fk_delivery_return_location REFERENCES mdm.location (id) ON DELETE RESTRICT,
  reason_code                  text NULL CONSTRAINT fk_delivery_return_reason REFERENCES mdm.reason_code (code) ON DELETE RESTRICT,
  stock_adjustment_id          uuid NULL CONSTRAINT fk_delivery_return_adjustment REFERENCES platform.business_document (id) ON DELETE RESTRICT
                                 CONSTRAINT uq_delivery_return_adjustment UNIQUE,
  note                         text NULL CONSTRAINT ck_delivery_return_note CHECK (length(btrim(note)) BETWEEN 1 AND 500),
  refund_destination           text NOT NULL CONSTRAINT ck_delivery_return_destination CHECK (refund_destination IN ('ORIGINAL_METHOD', 'STORE_CREDIT')),
  status                       text NOT NULL CONSTRAINT ck_delivery_return_status CHECK (status IN ('PENDING_APPROVAL', 'POSTED', 'REJECTED')),
  credit_note_id               uuid NULL CONSTRAINT fk_delivery_return_credit_note REFERENCES bil.billing_document (id) ON DELETE RESTRICT
                                 CONSTRAINT uq_delivery_return_credit_note UNIQUE,
  refund_id                    uuid NULL CONSTRAINT fk_delivery_return_refund REFERENCES pay.refund (id) ON DELETE RESTRICT
                                 CONSTRAINT uq_delivery_return_refund UNIQUE,
  branch_id                    uuid NOT NULL CONSTRAINT fk_delivery_return_branch REFERENCES mdm.branch (id) ON DELETE RESTRICT,
  version                      integer NOT NULL DEFAULT 1,
  created_at                   timestamptz NOT NULL,
  created_by                   uuid NOT NULL CONSTRAINT fk_delivery_return_created_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  updated_at                   timestamptz NOT NULL,
  updated_by                   uuid NOT NULL CONSTRAINT fk_delivery_return_updated_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  posted_at                    timestamptz NULL,
  posted_by                    uuid NULL CONSTRAINT fk_delivery_return_posted_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  CONSTRAINT ck_delivery_return_way_out CHECK ((way_out = 'RETURN_TO_STOCK') = (returns_location_id IS NOT NULL)
                                              AND (way_out = 'WRITE_OFF') = (reason_code IS NOT NULL)
                                              AND (way_out = 'WRITE_OFF') = (stock_adjustment_id IS NOT NULL)
                                              AND (way_out = 'WRITE_OFF' OR status = 'POSTED')),
  CONSTRAINT ck_delivery_return_posted CHECK ((status = 'POSTED') = (posted_at IS NOT NULL)
                                             AND (posted_at IS NULL) = (posted_by IS NULL)
                                             AND (status = 'POSTED') = (credit_note_id IS NOT NULL)),
  CONSTRAINT ck_delivery_return_refund CHECK (refund_id IS NULL OR credit_note_id IS NOT NULL)
);
COMMENT ON TABLE ord.delivery_return IS 'class=DOCUMENT';
CREATE UNIQUE INDEX uq_delivery_return_live ON ord.delivery_return (delivery_id) WHERE status <> 'REJECTED';
CREATE INDEX ix_delivery_return_order ON ord.delivery_return (sales_order_id);
CREATE TRIGGER trg_delivery_return_version BEFORE UPDATE ON ord.delivery_return
  FOR EACH ROW EXECUTE FUNCTION platform.touch_version();

-- What was asked never changes; PENDING_APPROVAL moves to POSTED or REJECTED once; a REJECTED row is frozen; the credit
-- note and the refund are each set once and never changed.
CREATE FUNCTION ord.delivery_return_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  fixed text[] := ARRAY['id', 'delivery_id', 'sales_order_id', 'original_billing_document_id', 'way_out', 'returns_location_id', 'reason_code',
                        'stock_adjustment_id', 'note', 'refund_destination', 'branch_id', 'created_at', 'created_by'];
  k text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.refund_id IS NOT NULL THEN
      RAISE EXCEPTION 'ord.delivery_return %: written with no refund', NEW.id USING ERRCODE = 'HK004', CONSTRAINT = 'ck_delivery_return_transition';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status = 'REJECTED' THEN
    RAISE EXCEPTION 'ord.delivery_return % is REJECTED and frozen', OLD.id USING ERRCODE = 'HK004', CONSTRAINT = 'ck_delivery_return_transition';
  END IF;
  FOREACH k IN ARRAY fixed LOOP
    IF to_jsonb(NEW) -> k IS DISTINCT FROM to_jsonb(OLD) -> k THEN
      RAISE EXCEPTION 'ord.delivery_return %: % never changes', OLD.id, k USING ERRCODE = 'HK004', CONSTRAINT = 'ck_delivery_return_transition';
    END IF;
  END LOOP;
  IF (NEW.status IS DISTINCT FROM OLD.status AND OLD.status <> 'PENDING_APPROVAL')
     OR (OLD.credit_note_id IS NOT NULL AND NEW.credit_note_id IS DISTINCT FROM OLD.credit_note_id)
     OR (OLD.refund_id IS NOT NULL AND NEW.refund_id IS DISTINCT FROM OLD.refund_id)
     OR (OLD.posted_at IS NOT NULL AND (NEW.posted_at IS DISTINCT FROM OLD.posted_at OR NEW.posted_by IS DISTINCT FROM OLD.posted_by)) THEN
    RAISE EXCEPTION 'ord.delivery_return %: % cannot move to % or change what it posted', OLD.id, OLD.status, NEW.status USING ERRCODE = 'HK004', CONSTRAINT = 'ck_delivery_return_transition';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION ord.delivery_return_guard() FROM PUBLIC;
CREATE TRIGGER trg_delivery_return_guard BEFORE INSERT OR UPDATE ON ord.delivery_return
  FOR EACH ROW EXECUTE FUNCTION ord.delivery_return_guard();

REVOKE ALL ON ord.delivery_return FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON ord.delivery_return TO hk_app, hk_worker;

-- migrate:down
DROP TABLE ord.delivery_return;
DROP FUNCTION ord.delivery_return_guard();
