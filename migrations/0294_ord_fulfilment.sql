-- 0294_ord_fulfilment
-- B11 (FR-ORD-008 to FR-ORD-011, FR-ORD-013, ADR-0021, CR-053, CR-054, A-332 to A-335): pick lists, picks with their
-- weights, and what an order asks its customer, held by the database:
--   ord.fulfilment          a pick list of all or part of a confirmed order at one pick location, numbered from its own
--                           series when made (ck_fulfilment_number), at the order's branch; it moves PICK_LIST, PICKING,
--                           PACKED, then DISPATCHED or COLLECTED, or is CANCELLED before it is packed
--                           (ck_fulfilment_transition, HK004); what it is of never changes
--   ord.pick_list_line      what a pick list asks of an order line; under the order line's row lock the pick lists not
--                           cancelled never ask more of a line than it ordered (ck_pick_list_line_cap)
--   ord.fulfilment_line     each pick, its client id the key: its quantity in the line's unit, its quantity in the base
--                           unit, its weight with its source (ck_fulfilment_line_weight); never more picked of a pick
--                           list line than it asks (ck_fulfilment_line_cap, under the pick list line's row lock); written
--                           only while its pick list is open; afterwards only withdrawn, never changed or removed
--   ord.order_consent       what an order asks its customer: a higher total (HIGHER_TOTAL), a substitute (SUBSTITUTION)
--                           or a smaller quantity (SHORT_PICK), each with what it proposes (ck_order_consent_shape); one
--                           waiting per order (uq_order_consent_pending); answered once by the customer or by staff who
--                           did not ask (ck_order_consent_answered), then frozen (ck_order_consent_transition)
-- Additions to docs/data-model/ord.md: the four tables as built.
-- Data category: CONFIDENTIAL (DC-22): commercial history.
-- Rollback: tested (`pnpm db:rollback`), safe before the first pick list; afterwards forward fix only (a pick list, a pick
-- and a customer's answer are never removed).

-- migrate:up
CREATE TABLE ord.fulfilment (
  id                uuid PRIMARY KEY CONSTRAINT fk_fulfilment_document REFERENCES platform.business_document (id) ON DELETE RESTRICT,
  fulfilment_no     text NOT NULL CONSTRAINT uq_fulfilment_no UNIQUE,
  sales_order_id    uuid NOT NULL CONSTRAINT fk_fulfilment_order REFERENCES ord.sales_order (id) ON DELETE RESTRICT,
  pick_location_id  uuid NOT NULL CONSTRAINT fk_fulfilment_location REFERENCES mdm.location (id) ON DELETE RESTRICT,
  status            text NOT NULL CONSTRAINT ck_fulfilment_status CHECK (status IN ('PICK_LIST', 'PICKING', 'PACKED', 'DISPATCHED', 'COLLECTED', 'CANCELLED')),
  picker_id         uuid NULL CONSTRAINT fk_fulfilment_picker REFERENCES iam.principal (id) ON DELETE RESTRICT,
  picked_at         timestamptz NULL,
  packed_at         timestamptz NULL,
  dispatched_at     timestamptz NULL,
  package_count     integer NULL CONSTRAINT ck_fulfilment_package_count CHECK (package_count > 0),
  cancel_reason     text NULL CONSTRAINT ck_fulfilment_cancel_reason CHECK (length(btrim(cancel_reason)) BETWEEN 1 AND 500),
  cancelled_by      uuid NULL CONSTRAINT fk_fulfilment_cancelled_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  cancelled_at      timestamptz NULL,
  branch_id         uuid NOT NULL CONSTRAINT fk_fulfilment_branch REFERENCES mdm.branch (id) ON DELETE RESTRICT,
  version           integer NOT NULL DEFAULT 1,
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid NOT NULL CONSTRAINT fk_fulfilment_created_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  updated_by        uuid NOT NULL CONSTRAINT fk_fulfilment_updated_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  CONSTRAINT ck_fulfilment_picked CHECK ((picker_id IS NULL) = (picked_at IS NULL)
                                         AND (status <> 'PICK_LIST' OR picker_id IS NULL)
                                         AND (status NOT IN ('PICKING', 'PACKED', 'DISPATCHED', 'COLLECTED') OR picker_id IS NOT NULL)),
  CONSTRAINT ck_fulfilment_packed CHECK ((status IN ('PACKED', 'DISPATCHED', 'COLLECTED')) = (packed_at IS NOT NULL)
                                         AND (packed_at IS NULL) = (package_count IS NULL)),
  CONSTRAINT ck_fulfilment_cancelled CHECK ((status = 'CANCELLED') = (cancelled_by IS NOT NULL)
                                            AND (cancelled_by IS NULL) = (cancelled_at IS NULL)
                                            AND (cancelled_by IS NULL) = (cancel_reason IS NULL))
);
COMMENT ON TABLE ord.fulfilment IS 'class=DOCUMENT';
CREATE INDEX ix_fulfilment_order ON ord.fulfilment (sales_order_id);
CREATE INDEX ix_fulfilment_status ON ord.fulfilment (branch_id, status);
CREATE TRIGGER trg_fulfilment_version BEFORE UPDATE ON ord.fulfilment
  FOR EACH ROW EXECUTE FUNCTION platform.touch_version();

CREATE TABLE ord.pick_list_line (
  id                   uuid PRIMARY KEY,
  fulfilment_id        uuid NOT NULL CONSTRAINT fk_pick_list_line_fulfilment REFERENCES ord.fulfilment (id) ON DELETE RESTRICT,
  sales_order_line_id  uuid NOT NULL CONSTRAINT fk_pick_list_line_order_line REFERENCES ord.sales_order_line (id) ON DELETE RESTRICT,
  line_no              integer NOT NULL CONSTRAINT ck_pick_list_line_no CHECK (line_no > 0),
  qty_to_pick          platform.qty NOT NULL CONSTRAINT ck_pick_list_line_qty CHECK (qty_to_pick > 0),
  status               text NOT NULL CONSTRAINT ck_pick_list_line_status CHECK (status IN ('OPEN', 'CANCELLED')),
  created_at           timestamptz NOT NULL DEFAULT now(),
  created_by           uuid NOT NULL CONSTRAINT fk_pick_list_line_created_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  updated_by           uuid NOT NULL CONSTRAINT fk_pick_list_line_updated_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  CONSTRAINT uq_pick_list_line UNIQUE (fulfilment_id, sales_order_line_id),
  CONSTRAINT uq_pick_list_line_no UNIQUE (fulfilment_id, line_no)
);
COMMENT ON TABLE ord.pick_list_line IS 'class=DOCUMENT';
CREATE INDEX ix_pick_list_line_order_line ON ord.pick_list_line (sales_order_line_id);

CREATE TABLE ord.fulfilment_line (
  id                  uuid PRIMARY KEY,
  fulfilment_id       uuid NOT NULL CONSTRAINT fk_fulfilment_line_fulfilment REFERENCES ord.fulfilment (id) ON DELETE RESTRICT,
  pick_list_line_id   uuid NOT NULL CONSTRAINT fk_fulfilment_line_pick_list_line REFERENCES ord.pick_list_line (id) ON DELETE RESTRICT,
  sales_order_line_id uuid NOT NULL CONSTRAINT fk_fulfilment_line_order_line REFERENCES ord.sales_order_line (id) ON DELETE RESTRICT,
  stock_unit_id       uuid NULL CONSTRAINT fk_fulfilment_line_stock_unit REFERENCES inv.stock_unit (id) ON DELETE RESTRICT,
  pack_barcode        text NULL CONSTRAINT ck_fulfilment_line_barcode CHECK (length(btrim(pack_barcode)) BETWEEN 1 AND 64),
  qty                 platform.qty NOT NULL CONSTRAINT ck_fulfilment_line_qty CHECK (qty > 0),
  qty_base            platform.qty NOT NULL CONSTRAINT ck_fulfilment_line_qty_base CHECK (qty_base > 0),
  weight_kg           platform.kg NULL CONSTRAINT ck_fulfilment_line_weight_kg CHECK (weight_kg > 0),
  weight_source       text NULL CONSTRAINT ck_fulfilment_line_weight_source CHECK (weight_source IN ('SCALE', 'MANUAL', 'ESTIMATE')),
  stock_movement_id   uuid NULL CONSTRAINT fk_fulfilment_line_movement REFERENCES inv.stock_movement (id) ON DELETE RESTRICT
                        CONSTRAINT uq_fulfilment_line_movement UNIQUE,
  withdrawn_at        timestamptz NULL,
  withdrawn_by        uuid NULL CONSTRAINT fk_fulfilment_line_withdrawn_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  recorded_at         timestamptz NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid NOT NULL CONSTRAINT fk_fulfilment_line_created_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  updated_by          uuid NOT NULL CONSTRAINT fk_fulfilment_line_updated_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  CONSTRAINT ck_fulfilment_line_weight CHECK ((weight_kg IS NULL) = (weight_source IS NULL)),
  CONSTRAINT ck_fulfilment_line_withdrawn CHECK ((withdrawn_at IS NULL) = (withdrawn_by IS NULL) AND (withdrawn_at IS NULL OR stock_movement_id IS NULL))
);
COMMENT ON TABLE ord.fulfilment_line IS 'class=DOCUMENT';
CREATE INDEX ix_fulfilment_line_fulfilment ON ord.fulfilment_line (fulfilment_id);
CREATE INDEX ix_fulfilment_line_pick_list_line ON ord.fulfilment_line (pick_list_line_id);

CREATE TABLE ord.order_consent (
  id                           uuid PRIMARY KEY,
  sales_order_id               uuid NOT NULL CONSTRAINT fk_order_consent_order REFERENCES ord.sales_order (id) ON DELETE RESTRICT,
  sales_order_line_id          uuid NOT NULL CONSTRAINT fk_order_consent_line REFERENCES ord.sales_order_line (id) ON DELETE RESTRICT,
  kind                         text NOT NULL CONSTRAINT ck_order_consent_kind CHECK (kind IN ('HIGHER_TOTAL', 'SUBSTITUTION', 'SHORT_PICK')),
  status                       text NOT NULL CONSTRAINT ck_order_consent_status CHECK (status IN ('PENDING', 'ACCEPTED', 'REFUSED', 'WITHDRAWN')),
  proposed_product_id          uuid NULL CONSTRAINT fk_order_consent_product REFERENCES mdm.product (id) ON DELETE RESTRICT,
  proposed_stock_unit_id       uuid NULL CONSTRAINT fk_order_consent_stock_unit REFERENCES inv.stock_unit (id) ON DELETE RESTRICT,
  proposed_qty                 platform.qty NULL CONSTRAINT ck_order_consent_qty CHECK (proposed_qty >= 0),
  proposed_uom                 text NULL CONSTRAINT fk_order_consent_uom REFERENCES mdm.uom (code) ON DELETE RESTRICT,
  price_list_entry_id          uuid NULL CONSTRAINT fk_order_consent_price_entry REFERENCES mdm.price_list_entry (id) ON DELETE RESTRICT,
  price_basis                  text NULL CONSTRAINT ck_order_consent_price_basis CHECK (price_basis IN ('PER_HEAD', 'PER_UNIT')),
  resolved_unit_price_pesewas  platform.pesewas NULL,
  floor_unit_price_pesewas     platform.pesewas NULL,
  ceiling_unit_price_pesewas   platform.pesewas NULL,
  proposed_line_total_pesewas  platform.pesewas NULL,
  weighed_weight_kg            platform.kg NULL CONSTRAINT ck_order_consent_weight CHECK (weighed_weight_kg > 0),
  weighed_total_pesewas        platform.pesewas NULL,
  note                         text NULL CONSTRAINT ck_order_consent_note CHECK (length(btrim(note)) BETWEEN 1 AND 500),
  asked_at                     timestamptz NOT NULL,
  answered_by                  uuid NULL CONSTRAINT fk_order_consent_answered_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  answered_at                  timestamptz NULL,
  method                       text NULL CONSTRAINT ck_order_consent_method CHECK (method IN ('PHONE', 'IN_PERSON', 'WHATSAPP', 'SIGNED_LINK', 'CUSTOMER_ACCOUNT', 'SYSTEM')),
  answer_note                  text NULL CONSTRAINT ck_order_consent_answer_note CHECK (length(btrim(answer_note)) BETWEEN 1 AND 500),
  substitute_line_id           uuid NULL CONSTRAINT fk_order_consent_substitute REFERENCES ord.sales_order_line (id) ON DELETE RESTRICT
                                 CONSTRAINT uq_order_consent_substitute UNIQUE,
  branch_id                    uuid NOT NULL CONSTRAINT fk_order_consent_branch REFERENCES mdm.branch (id) ON DELETE RESTRICT,
  version                      integer NOT NULL DEFAULT 1,
  created_at                   timestamptz NOT NULL DEFAULT now(),
  created_by                   uuid NOT NULL CONSTRAINT fk_order_consent_created_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  updated_at                   timestamptz NOT NULL DEFAULT now(),
  updated_by                   uuid NOT NULL CONSTRAINT fk_order_consent_updated_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  CONSTRAINT ck_order_consent_shape CHECK (CASE kind
    WHEN 'SUBSTITUTION' THEN proposed_product_id IS NOT NULL AND proposed_qty > 0 AND proposed_uom IS NOT NULL AND price_list_entry_id IS NOT NULL
                             AND price_basis IS NOT NULL AND resolved_unit_price_pesewas IS NOT NULL AND floor_unit_price_pesewas IS NOT NULL
                             AND ceiling_unit_price_pesewas IS NOT NULL AND proposed_line_total_pesewas IS NOT NULL
                             AND floor_unit_price_pesewas <= resolved_unit_price_pesewas AND resolved_unit_price_pesewas <= ceiling_unit_price_pesewas
                             AND weighed_weight_kg IS NULL AND weighed_total_pesewas IS NULL
    WHEN 'SHORT_PICK' THEN proposed_qty IS NOT NULL AND proposed_product_id IS NULL AND proposed_stock_unit_id IS NULL AND price_list_entry_id IS NULL
                           AND proposed_line_total_pesewas IS NULL AND weighed_weight_kg IS NULL AND weighed_total_pesewas IS NULL
    ELSE weighed_weight_kg IS NOT NULL AND weighed_total_pesewas IS NOT NULL AND proposed_product_id IS NULL AND proposed_qty IS NULL
         AND price_list_entry_id IS NULL AND proposed_line_total_pesewas IS NULL END),
  CONSTRAINT ck_order_consent_answered CHECK ((status = 'PENDING') = (answered_at IS NULL)
                                              AND (answered_at IS NULL) = (answered_by IS NULL)
                                              AND (answered_at IS NULL) = (method IS NULL)
                                              AND (status <> 'WITHDRAWN' OR method = 'SYSTEM')
                                              AND (status NOT IN ('ACCEPTED', 'REFUSED') OR method <> 'SYSTEM')
                                              AND NOT (method IN ('PHONE', 'IN_PERSON', 'WHATSAPP') AND answered_by = created_by)),
  CONSTRAINT ck_order_consent_substituted CHECK (substitute_line_id IS NULL OR (kind = 'SUBSTITUTION' AND status = 'ACCEPTED'))
);
COMMENT ON TABLE ord.order_consent IS 'class=DOCUMENT';
CREATE UNIQUE INDEX uq_order_consent_pending ON ord.order_consent (sales_order_id) WHERE status = 'PENDING';
CREATE INDEX ix_order_consent_order ON ord.order_consent (sales_order_id);
CREATE TRIGGER trg_order_consent_version BEFORE UPDATE ON ord.order_consent
  FOR EACH ROW EXECUTE FUNCTION platform.touch_version();

-- A pick list is written PICK_LIST against a confirmed or picking order of its own branch, with its allocated number;
-- it moves only forward along its listed edges; what it is of never changes; a dispatched, collected or cancelled one is
-- frozen.
CREATE FUNCTION ord.fulfilment_guard() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
DECLARE
  sale record;
  fixed text[] := ARRAY['fulfilment_no', 'sales_order_id', 'pick_location_id', 'branch_id', 'created_at', 'created_by'];
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT s.status, s.branch_id INTO sale FROM ord.sales_order s WHERE s.id = NEW.sales_order_id;
    IF NEW.status <> 'PICK_LIST' THEN
      RAISE EXCEPTION 'ord.fulfilment %: a pick list is written PICK_LIST', NEW.id USING ERRCODE = 'HK004', CONSTRAINT = 'ck_fulfilment_transition';
    END IF;
    IF sale.status NOT IN ('CONFIRMED', 'PICKING') OR sale.branch_id <> NEW.branch_id THEN
      RAISE EXCEPTION 'ord.fulfilment %: a pick list is of a confirmed or picking order of its own branch', NEW.id USING ERRCODE = 'HK010', CONSTRAINT = 'ck_fulfilment_order';
    END IF;
    IF NOT platform.number_allocated(NEW.id, NEW.fulfilment_no, 'FULFILMENT') THEN
      RAISE EXCEPTION 'ord.fulfilment %: % is not the number allocated to it', NEW.id, NEW.fulfilment_no USING ERRCODE = 'HK010', CONSTRAINT = 'ck_fulfilment_number';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status IN ('DISPATCHED', 'COLLECTED', 'CANCELLED')
     OR EXISTS (SELECT 1 FROM unnest(fixed) AS c WHERE (to_jsonb(NEW) -> c) IS DISTINCT FROM (to_jsonb(OLD) -> c))
     OR (NEW.status IS DISTINCT FROM OLD.status AND NOT (
           (OLD.status = 'PICK_LIST' AND NEW.status IN ('PICKING', 'CANCELLED'))
        OR (OLD.status = 'PICKING' AND NEW.status IN ('PACKED', 'CANCELLED'))
        OR (OLD.status = 'PACKED' AND NEW.status IN ('DISPATCHED', 'COLLECTED')))) THEN
    RAISE EXCEPTION 'ord.fulfilment %: it moves only forward, what it is of never changes, and a dispatched, collected or cancelled pick list is frozen', OLD.id
      USING ERRCODE = 'HK004', CONSTRAINT = 'ck_fulfilment_transition';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION ord.fulfilment_guard() FROM PUBLIC;
CREATE TRIGGER trg_fulfilment_guard BEFORE INSERT OR UPDATE ON ord.fulfilment
  FOR EACH ROW EXECUTE FUNCTION ord.fulfilment_guard();

-- A pick list line is of the pick list's own order, written while the pick list is open, and, under the order line's
-- row lock, the open lines of pick lists not cancelled never ask more of an order line than it ordered. Afterwards only
-- its status changes, OPEN to CANCELLED.
CREATE FUNCTION ord.pick_list_line_guard() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
DECLARE
  f record;
  ordered record;
  asked numeric;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF (to_jsonb(NEW) - ARRAY['status', 'updated_at', 'updated_by']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'updated_at', 'updated_by'])
       OR (NEW.status IS DISTINCT FROM OLD.status AND NOT (OLD.status = 'OPEN' AND NEW.status = 'CANCELLED')) THEN
      RAISE EXCEPTION 'ord.pick_list_line %: what it asks never changes; it is only cancelled', OLD.id USING ERRCODE = 'HK004', CONSTRAINT = 'ck_pick_list_line_cap';
    END IF;
    RETURN NEW;
  END IF;
  SELECT x.sales_order_id, x.status INTO f FROM ord.fulfilment x WHERE x.id = NEW.fulfilment_id;
  SELECT l.sales_order_id, l.qty_ordered INTO ordered FROM ord.sales_order_line l WHERE l.id = NEW.sales_order_line_id FOR UPDATE;
  IF f.status NOT IN ('PICK_LIST', 'PICKING') OR ordered.sales_order_id IS DISTINCT FROM f.sales_order_id OR NEW.status <> 'OPEN' THEN
    RAISE EXCEPTION 'ord.pick_list_line %: an open line of an open pick list, of the pick list''s own order', NEW.id USING ERRCODE = 'HK010', CONSTRAINT = 'ck_pick_list_line_cap';
  END IF;
  SELECT COALESCE(sum(p.qty_to_pick), 0) INTO asked
    FROM ord.pick_list_line p JOIN ord.fulfilment x ON x.id = p.fulfilment_id
   WHERE p.sales_order_line_id = NEW.sales_order_line_id AND p.status = 'OPEN' AND x.status <> 'CANCELLED';
  IF asked + NEW.qty_to_pick > ordered.qty_ordered THEN
    RAISE EXCEPTION 'ord.pick_list_line %: % of the line was ordered and % is on pick lists already; % more is too much', NEW.id, ordered.qty_ordered, asked, NEW.qty_to_pick
      USING ERRCODE = 'HK010', CONSTRAINT = 'ck_pick_list_line_cap';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION ord.pick_list_line_guard() FROM PUBLIC;
CREATE TRIGGER trg_pick_list_line_guard BEFORE INSERT OR UPDATE ON ord.pick_list_line
  FOR EACH ROW EXECUTE FUNCTION ord.pick_list_line_guard();

-- A pick is of an open line of its own pick list, written while the pick list is open; under that line's row lock the
-- picks not withdrawn never come to more than it asks. Afterwards a pick is only withdrawn, while its pick list is open,
-- or given its movement at dispatch; nothing else of it changes.
CREATE FUNCTION ord.fulfilment_line_guard() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
DECLARE
  f_status text;
  asked record;
  picked numeric;
BEGIN
  SELECT x.status INTO f_status FROM ord.fulfilment x WHERE x.id = NEW.fulfilment_id;
  IF TG_OP = 'UPDATE' THEN
    IF (to_jsonb(NEW) - ARRAY['withdrawn_at', 'withdrawn_by', 'stock_movement_id', 'updated_at', 'updated_by'])
         IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['withdrawn_at', 'withdrawn_by', 'stock_movement_id', 'updated_at', 'updated_by'])
       OR OLD.withdrawn_at IS NOT NULL
       OR (NEW.withdrawn_at IS NOT NULL AND f_status NOT IN ('PICK_LIST', 'PICKING'))
       OR (OLD.stock_movement_id IS NOT NULL AND NEW.stock_movement_id IS DISTINCT FROM OLD.stock_movement_id) THEN
      RAISE EXCEPTION 'ord.fulfilment_line %: a pick never changes; it is withdrawn while its pick list is open, or moved once', OLD.id
        USING ERRCODE = 'HK004', CONSTRAINT = 'ck_fulfilment_line_cap';
    END IF;
    RETURN NEW;
  END IF;
  SELECT p.fulfilment_id, p.sales_order_line_id, p.qty_to_pick, p.status INTO asked FROM ord.pick_list_line p WHERE p.id = NEW.pick_list_line_id FOR UPDATE;
  IF f_status NOT IN ('PICK_LIST', 'PICKING') OR asked.status <> 'OPEN' OR asked.fulfilment_id IS DISTINCT FROM NEW.fulfilment_id
     OR asked.sales_order_line_id IS DISTINCT FROM NEW.sales_order_line_id OR NEW.withdrawn_at IS NOT NULL OR NEW.stock_movement_id IS NOT NULL THEN
    RAISE EXCEPTION 'ord.fulfilment_line %: a pick is of an open line of its own open pick list', NEW.id USING ERRCODE = 'HK010', CONSTRAINT = 'ck_fulfilment_line_cap';
  END IF;
  SELECT COALESCE(sum(l.qty), 0) INTO picked FROM ord.fulfilment_line l WHERE l.pick_list_line_id = NEW.pick_list_line_id AND l.withdrawn_at IS NULL;
  IF picked + NEW.qty > asked.qty_to_pick THEN
    RAISE EXCEPTION 'ord.fulfilment_line %: % is asked and % is picked already; % more is too much', NEW.id, asked.qty_to_pick, picked, NEW.qty
      USING ERRCODE = 'HK010', CONSTRAINT = 'ck_fulfilment_line_cap';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION ord.fulfilment_line_guard() FROM PUBLIC;
CREATE TRIGGER trg_fulfilment_line_guard BEFORE INSERT OR UPDATE ON ord.fulfilment_line
  FOR EACH ROW EXECUTE FUNCTION ord.fulfilment_line_guard();

-- A question is written PENDING of a line of its own order and branch; it is answered once (or withdrawn by the system)
-- and frozen afterwards, but for the substitute line an accepted substitution names once.
CREATE FUNCTION ord.order_consent_guard() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
DECLARE
  sale record;
  answer text[] := ARRAY['status', 'answered_by', 'answered_at', 'method', 'answer_note', 'substitute_line_id', 'version', 'updated_at', 'updated_by'];
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT s.branch_id INTO sale FROM ord.sales_order s WHERE s.id = NEW.sales_order_id;
    IF NEW.status <> 'PENDING' OR sale.branch_id IS DISTINCT FROM NEW.branch_id
       OR NOT EXISTS (SELECT 1 FROM ord.sales_order_line l WHERE l.id = NEW.sales_order_line_id AND l.sales_order_id = NEW.sales_order_id) THEN
      RAISE EXCEPTION 'ord.order_consent %: a question is written PENDING, of a line of its own order and branch', NEW.id USING ERRCODE = 'HK010', CONSTRAINT = 'ck_order_consent_transition';
    END IF;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - answer) IS DISTINCT FROM (to_jsonb(OLD) - answer)
     OR (OLD.status <> 'PENDING' AND ((to_jsonb(NEW) - ARRAY['substitute_line_id', 'version', 'updated_at', 'updated_by'])
                                        IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['substitute_line_id', 'version', 'updated_at', 'updated_by'])
                                      OR OLD.substitute_line_id IS NOT NULL)) THEN
    RAISE EXCEPTION 'ord.order_consent %: what was asked never changes, and an answer is given once', OLD.id USING ERRCODE = 'HK004', CONSTRAINT = 'ck_order_consent_transition';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION ord.order_consent_guard() FROM PUBLIC;
CREATE TRIGGER trg_order_consent_guard BEFORE INSERT OR UPDATE ON ord.order_consent
  FOR EACH ROW EXECUTE FUNCTION ord.order_consent_guard();

REVOKE ALL ON ord.fulfilment, ord.pick_list_line, ord.fulfilment_line, ord.order_consent FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON ord.fulfilment, ord.pick_list_line, ord.fulfilment_line, ord.order_consent TO hk_app, hk_worker;

-- migrate:down
DROP TABLE ord.order_consent;
DROP TABLE ord.fulfilment_line;
DROP TABLE ord.pick_list_line;
DROP TABLE ord.fulfilment;
DROP FUNCTION ord.order_consent_guard();
DROP FUNCTION ord.fulfilment_line_guard();
DROP FUNCTION ord.pick_list_line_guard();
DROP FUNCTION ord.fulfilment_guard();
