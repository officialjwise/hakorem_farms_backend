-- 0200_ord_order_return
-- B09a continued 2d (FR-ORD-015, FR-PAY-012, ADR-0066, abuse case 12, A-228): a return against the original sale, and
-- the rules the database holds for it.
--   ord.order_return            written REQUESTED against a COMPLETED sale and its own receipt, numbered from its
--                               ORDER_RETURN series (ck_order_return_number); then PENDING_APPROVAL with its RETURN approval,
--                               submitted only by its maker (ck_order_return_submitted); then COMPLETED with its credit note
--                               (and its refund when one is owed), or REJECTED; then frozen. What was asked never changes
--                               (ck_order_return_transition, HK004). Decided by someone other than its maker
--                               (ck_order_return_decided).
--   ord.order_return_line       one line per sold line per return; what returns not REJECTED take back of a sold line never
--                               exceeds what it fulfilled (ck_order_return_line_cap), decided under the sold line's row lock,
--                               so two returns of the last of a line at once leave one; a line is of the return's own sale;
--                               a WRITE_OFF line moves no stock, and a completed return's other lines name their movement;
--                               only the refund and the movement are written after the line, and only while the return is
--                               open (HK004).
-- Additions to docs/data-model/ord.md: `refund_destination`, `note`, `submitted_*`, `decided_*` on `ord.order_return`;
-- `line_no` and `refund_pesewas` on `ord.order_return_line`.
-- Data category: CONFIDENTIAL (DC-22): commercial history.
-- Rollback: tested (`pnpm db:rollback`), safe before the first return; afterwards forward fix only (a return is never
-- removed).

-- migrate:up
CREATE TABLE ord.order_return (
  id                           uuid PRIMARY KEY CONSTRAINT fk_order_return_document REFERENCES platform.business_document (id) ON DELETE RESTRICT,
  return_no                    text NOT NULL CONSTRAINT uq_order_return_no UNIQUE,
  sales_order_id               uuid NOT NULL CONSTRAINT fk_order_return_order REFERENCES ord.sales_order (id) ON DELETE RESTRICT,
  original_billing_document_id uuid NOT NULL CONSTRAINT fk_order_return_original REFERENCES bil.billing_document (id) ON DELETE RESTRICT,
  kind                         text NOT NULL CONSTRAINT ck_order_return_kind CHECK (kind IN ('RETURN', 'EXCHANGE')),
  reason_code                  text NOT NULL CONSTRAINT fk_order_return_reason REFERENCES mdm.reason_code (code) ON DELETE RESTRICT,
  refund_destination           text NOT NULL CONSTRAINT ck_order_return_destination CHECK (refund_destination IN ('ORIGINAL_METHOD', 'STORE_CREDIT', 'CASH')),
  note                         text NULL CONSTRAINT ck_order_return_note CHECK (length(btrim(note)) BETWEEN 1 AND 500),
  status                       text NOT NULL CONSTRAINT ck_order_return_status CHECK (status IN ('REQUESTED', 'PENDING_APPROVAL', 'COMPLETED', 'REJECTED')),
  approval_request_id          uuid NULL CONSTRAINT fk_order_return_approval REFERENCES iam.approval_request (id) ON DELETE RESTRICT
                                 CONSTRAINT uq_order_return_approval UNIQUE,
  credit_note_id               uuid NULL CONSTRAINT fk_order_return_credit_note REFERENCES bil.billing_document (id) ON DELETE RESTRICT
                                 CONSTRAINT uq_order_return_credit_note UNIQUE,
  refund_id                    uuid NULL CONSTRAINT fk_order_return_refund REFERENCES pay.refund (id) ON DELETE RESTRICT
                                 CONSTRAINT uq_order_return_refund UNIQUE,
  exchange_order_id            uuid NULL CONSTRAINT fk_order_return_exchange REFERENCES ord.sales_order (id) ON DELETE RESTRICT,
  submitted_by                 uuid NULL CONSTRAINT fk_order_return_submitted_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  submitted_at                 timestamptz NULL,
  decided_by                   uuid NULL CONSTRAINT fk_order_return_decided_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  decided_at                   timestamptz NULL,
  branch_id                    uuid NOT NULL CONSTRAINT fk_order_return_branch REFERENCES mdm.branch (id) ON DELETE RESTRICT,
  version                      integer NOT NULL DEFAULT 1,
  created_at                   timestamptz NOT NULL DEFAULT now(),
  created_by                   uuid NOT NULL CONSTRAINT fk_order_return_created_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  updated_at                   timestamptz NOT NULL DEFAULT now(),
  updated_by                   uuid NOT NULL CONSTRAINT fk_order_return_updated_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  CONSTRAINT ck_order_return_submitted CHECK ((status = 'REQUESTED') = (submitted_by IS NULL)
                                              AND (submitted_by IS NULL) = (submitted_at IS NULL)
                                              AND (submitted_by IS NULL) = (approval_request_id IS NULL)
                                              AND (submitted_by IS NULL OR submitted_by = created_by)),
  CONSTRAINT ck_order_return_decided CHECK ((status IN ('COMPLETED', 'REJECTED')) = (decided_by IS NOT NULL)
                                            AND (decided_by IS NULL) = (decided_at IS NULL)
                                            AND decided_by IS DISTINCT FROM created_by),
  CONSTRAINT ck_order_return_completed CHECK ((status = 'COMPLETED') = (credit_note_id IS NOT NULL)
                                              AND (refund_id IS NULL OR status = 'COMPLETED')
                                              AND exchange_order_id IS NULL)
);
COMMENT ON TABLE ord.order_return IS 'class=DOCUMENT';
CREATE INDEX ix_order_return_order ON ord.order_return (sales_order_id);
CREATE INDEX ix_order_return_status ON ord.order_return (status, branch_id);
CREATE TRIGGER trg_order_return_version BEFORE UPDATE ON ord.order_return
  FOR EACH ROW EXECUTE FUNCTION platform.touch_version();

CREATE TABLE ord.order_return_line (
  id                  uuid PRIMARY KEY,
  order_return_id     uuid NOT NULL CONSTRAINT fk_order_return_line_return REFERENCES ord.order_return (id) ON DELETE RESTRICT,
  sales_order_line_id uuid NOT NULL CONSTRAINT fk_order_return_line_order_line REFERENCES ord.sales_order_line (id) ON DELETE RESTRICT,
  line_no             integer NOT NULL CONSTRAINT ck_order_return_line_no CHECK (line_no > 0),
  qty                 platform.qty NOT NULL CONSTRAINT ck_order_return_line_qty CHECK (qty > 0),
  weight_kg           platform.kg NULL,
  disposition         text NOT NULL CONSTRAINT ck_order_return_line_disposition CHECK (disposition IN ('RESTOCK', 'RETURNS_HOLD', 'WRITE_OFF')),
  refund_pesewas      platform.pesewas NOT NULL DEFAULT 0,
  stock_movement_id   uuid NULL CONSTRAINT fk_order_return_line_movement REFERENCES inv.stock_movement (id) ON DELETE RESTRICT
                        CONSTRAINT uq_order_return_line_movement UNIQUE,
  CONSTRAINT uq_order_return_line UNIQUE (order_return_id, line_no),
  CONSTRAINT uq_order_return_line_sold UNIQUE (order_return_id, sales_order_line_id),
  CONSTRAINT ck_order_return_line_write_off CHECK (disposition <> 'WRITE_OFF' OR stock_movement_id IS NULL)
);
COMMENT ON TABLE ord.order_return_line IS 'class=DOCUMENT';
CREATE INDEX ix_order_return_line_sold ON ord.order_return_line (sales_order_line_id);

-- A return is written REQUESTED against a completed sale and its own receipt, with its allocated number; it moves
-- REQUESTED, PENDING_APPROVAL, then COMPLETED or REJECTED; what was asked never changes; a decided return is frozen.
CREATE FUNCTION ord.order_return_guard() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
DECLARE
  sale record;
  decision text[] := ARRAY['status', 'approval_request_id', 'credit_note_id', 'refund_id', 'submitted_by', 'submitted_at', 'decided_by', 'decided_at',
                           'version', 'updated_at', 'updated_by'];
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT s.status, s.billing_document_id, s.branch_id INTO sale FROM ord.sales_order s WHERE s.id = NEW.sales_order_id;
    IF NEW.status <> 'REQUESTED' THEN
      RAISE EXCEPTION 'ord.order_return %: a return is written REQUESTED', NEW.id USING ERRCODE = 'HK004', CONSTRAINT = 'ck_order_return_transition';
    END IF;
    IF sale.status <> 'COMPLETED' OR sale.billing_document_id IS DISTINCT FROM NEW.original_billing_document_id OR sale.branch_id <> NEW.branch_id THEN
      RAISE EXCEPTION 'ord.order_return %: a return is against a completed sale, its own receipt and its branch', NEW.id USING ERRCODE = 'HK010', CONSTRAINT = 'ck_order_return_sale';
    END IF;
    IF NOT platform.number_allocated(NEW.id, NEW.return_no, 'ORDER_RETURN') THEN
      RAISE EXCEPTION 'ord.order_return %: % is not the number allocated to it', NEW.id, NEW.return_no USING ERRCODE = 'HK010', CONSTRAINT = 'ck_order_return_number';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status IN ('COMPLETED', 'REJECTED')
     OR (to_jsonb(NEW) - decision) IS DISTINCT FROM (to_jsonb(OLD) - decision)
     OR (NEW.status IS DISTINCT FROM OLD.status AND NOT (
           (OLD.status = 'REQUESTED' AND NEW.status = 'PENDING_APPROVAL')
        OR (OLD.status = 'PENDING_APPROVAL' AND NEW.status IN ('COMPLETED', 'REJECTED')))) THEN
    RAISE EXCEPTION 'ord.order_return %: what was asked never changes, it moves only forward, and a decided return is frozen', OLD.id
      USING ERRCODE = 'HK004', CONSTRAINT = 'ck_order_return_transition';
  END IF;
  IF NEW.status = 'COMPLETED' AND EXISTS (
    SELECT 1 FROM ord.order_return_line l WHERE l.order_return_id = NEW.id AND l.disposition <> 'WRITE_OFF' AND l.stock_movement_id IS NULL
  ) THEN
    RAISE EXCEPTION 'ord.order_return %: a completed return has the movement of every line it takes back into stock', NEW.id
      USING ERRCODE = 'HK010', CONSTRAINT = 'ck_order_return_completed';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION ord.order_return_guard() FROM PUBLIC;
CREATE TRIGGER trg_order_return_guard BEFORE INSERT OR UPDATE ON ord.order_return
  FOR EACH ROW EXECUTE FUNCTION ord.order_return_guard();

-- A return line takes back no more of its sold line than the sold line fulfilled, less what returns not REJECTED hold
-- already, under the sold line's row lock. Only its refund and its movement are written afterwards, while it is open.
CREATE FUNCTION ord.order_return_line_guard() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
DECLARE
  sold record;
  ret record;
  held numeric;
BEGIN
  SELECT r.status, r.sales_order_id INTO ret FROM ord.order_return r WHERE r.id = NEW.order_return_id;
  IF TG_OP = 'UPDATE' THEN
    IF ret.status IN ('COMPLETED', 'REJECTED')
       OR (to_jsonb(NEW) - ARRAY['refund_pesewas', 'stock_movement_id']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['refund_pesewas', 'stock_movement_id']) THEN
      RAISE EXCEPTION 'ord.order_return_line %: only its refund and its movement are written, while its return is open', OLD.id
        USING ERRCODE = 'HK004', CONSTRAINT = 'ck_order_return_transition';
    END IF;
    RETURN NEW;
  END IF;
  IF ret.status <> 'REQUESTED' THEN
    RAISE EXCEPTION 'ord.order_return_line %: lines are written while the return is REQUESTED', NEW.id USING ERRCODE = 'HK004', CONSTRAINT = 'ck_order_return_transition';
  END IF;
  SELECT l.sales_order_id, l.qty_fulfilled INTO sold FROM ord.sales_order_line l WHERE l.id = NEW.sales_order_line_id FOR UPDATE;
  IF sold.sales_order_id IS DISTINCT FROM ret.sales_order_id THEN
    RAISE EXCEPTION 'ord.order_return_line %: the line is not of the return''s sale', NEW.id USING ERRCODE = 'HK010', CONSTRAINT = 'ck_order_return_line_cap';
  END IF;
  SELECT COALESCE(sum(rl.qty), 0) INTO held
    FROM ord.order_return_line rl JOIN ord.order_return r ON r.id = rl.order_return_id
   WHERE rl.sales_order_line_id = NEW.sales_order_line_id AND r.status <> 'REJECTED';
  IF held + NEW.qty > sold.qty_fulfilled THEN
    RAISE EXCEPTION 'ord.order_return_line %: % of the line was sold and % is returned already; % more is too much', NEW.id, sold.qty_fulfilled, held, NEW.qty
      USING ERRCODE = 'HK010', CONSTRAINT = 'ck_order_return_line_cap';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION ord.order_return_line_guard() FROM PUBLIC;
CREATE TRIGGER trg_order_return_line_guard BEFORE INSERT OR UPDATE ON ord.order_return_line
  FOR EACH ROW EXECUTE FUNCTION ord.order_return_line_guard();

REVOKE ALL ON ord.order_return, ord.order_return_line FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON ord.order_return, ord.order_return_line TO hk_app, hk_worker;

-- migrate:down
DROP TABLE ord.order_return_line;
DROP TABLE ord.order_return;
DROP FUNCTION ord.order_return_line_guard();
DROP FUNCTION ord.order_return_guard();
