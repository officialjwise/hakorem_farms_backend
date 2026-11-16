-- 0163_ord_sales_orders
-- B9a (FR-ORD-001 to FR-ORD-004, FR-ORD-006, FR-ORD-007, ADR-0004, ADR-0010, ADR-0026, A-208): schema `ord` with the
-- one order record of every channel, its lines carrying the full pricing record, and its status history. The database
-- holds:
--   ck_sales_order_status_value        the thirteen statuses of the machine and no other (FR-ORD-002)
--   ck_sales_order_transition          a status moves only along DOMAIN_MODEL section 7's machine; COMPLETED, CANCELLED and
--                                      VOIDED are frozen but for the void (status and its approval)
--   ck_sales_order_pos_shift           a POS order names the shift that made it
--   ck_sales_order_completed           a COMPLETED order has its completion time, its billing document and its final total
--   ck_sales_order_voided              a VOIDED order names its supervisor's approval
--   ck_sales_order_number              at commit, an order's number is the one platform.allocate_number gave it
--   ck_sales_order_line_band           floor <= resolved <= ceiling (FR-ORD-003)
--   ck_sales_order_line_price_source   an ENGINE line names its price list entry, a QUOTE line its quote line
--   ck_sales_order_line_outside_band   an agreed price outside floor and ceiling is flagged as needing approval
--   ck_sales_order_line_variance       a variance has its direction and its reason; no variance has neither
--   ck_sales_order_line_weight         a weight carries its source
--   ck_sales_order_line_serial         a line for a serialised product names one stock unit and has quantity one (FR-ORD-004)
--   ck_sales_order_line_frozen         a line changes only while its order is PLACED or in fulfilment, never once posted
--   ck_sales_order_settled_lines       at commit, every line of an order past PLACED that needs approval has it, and every
--                                      line of a COMPLETED order has its movement or its stock exception (FR-ORD-007)
-- `ord.order_status_history` is LEDGER: insert-only for every role.
-- Columns of later sessions are added by their own expand migration: `delivery_id` (B11, `del.delivery`), and the
-- adjustments table with promotions applied at order level (the session that applies them).
-- Data category: CONFIDENTIAL (DC-22): orders and commercial history, a guest's name and phone.
-- Rollback: tested (`pnpm db:rollback`), safe before the first order; afterwards forward fix only (a posted sale is never
-- removed).

-- migrate:up
CREATE SCHEMA ord AUTHORIZATION hk_owner;
REVOKE ALL ON SCHEMA ord FROM PUBLIC;
GRANT USAGE ON SCHEMA ord TO hk_app, hk_worker, hk_report;

CREATE TABLE ord.sales_order (
  id                        uuid PRIMARY KEY CONSTRAINT fk_sales_order_document REFERENCES platform.business_document (id) ON DELETE RESTRICT,
  order_no                  text NULL CONSTRAINT uq_sales_order_no UNIQUE,
  channel                   text NOT NULL CONSTRAINT ck_sales_order_channel CHECK (channel IN ('POS', 'ONLINE', 'WHOLESALE', 'QUOTE')),
  customer_id               uuid NULL CONSTRAINT fk_sales_order_customer REFERENCES mdm.customer (id) ON DELETE RESTRICT,
  contact_name              text NULL CONSTRAINT ck_sales_order_contact_name CHECK (length(btrim(contact_name)) BETWEEN 1 AND 160),
  contact_phone_e164        text NULL CONSTRAINT ck_sales_order_contact_phone CHECK (contact_phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  status                    text NOT NULL CONSTRAINT ck_sales_order_status_value CHECK (status IN ('PLACED', 'CONFIRMED', 'PICKING', 'AWAITING_CUSTOMER', 'PACKED',
                              'READY_FOR_COLLECTION', 'DISPATCHED', 'DELIVERED', 'DELIVERY_FAILED', 'RETURNED', 'COMPLETED', 'CANCELLED', 'VOIDED')),
  payment_terms             text NOT NULL CONSTRAINT ck_sales_order_payment_terms CHECK (payment_terms IN ('IMMEDIATE', 'PREPAID', 'COD', 'CREDIT')),
  fulfilment_mode           text NOT NULL CONSTRAINT ck_sales_order_fulfilment_mode CHECK (fulfilment_mode IN ('COUNTER', 'COLLECTION', 'DELIVERY')),
  source_document_id        uuid NULL CONSTRAINT fk_sales_order_source REFERENCES platform.business_document (id) ON DELETE RESTRICT,
  parent_order_id           uuid NULL CONSTRAINT fk_sales_order_parent REFERENCES ord.sales_order (id) ON DELETE RESTRICT,
  shift_document_id         uuid NULL CONSTRAINT fk_sales_order_shift REFERENCES platform.business_document (id) ON DELETE RESTRICT,
  salesperson_id            uuid NULL CONSTRAINT fk_sales_order_salesperson REFERENCES iam.principal (id) ON DELETE RESTRICT,
  delivery_address_id       uuid NULL CONSTRAINT fk_sales_order_delivery_address REFERENCES mdm.customer_address (id) ON DELETE RESTRICT,
  delivery_address_snapshot jsonb NULL,
  delivery_zone_id          uuid NULL CONSTRAINT fk_sales_order_delivery_zone REFERENCES mdm.delivery_zone (id) ON DELETE RESTRICT,
  delivery_fee_pesewas      platform.pesewas NOT NULL DEFAULT 0,
  currency                  char(3) NOT NULL DEFAULT 'GHS' CONSTRAINT ck_sales_order_currency CHECK (currency = 'GHS'),
  tax_inclusive             boolean NOT NULL,
  estimated_total_pesewas   platform.pesewas NOT NULL,
  maximum_total_pesewas     platform.pesewas NOT NULL,
  final_total_pesewas       platform.pesewas NULL,
  billing_document_id       uuid NULL CONSTRAINT fk_sales_order_billing_document REFERENCES bil.billing_document (id) ON DELETE RESTRICT
                              CONSTRAINT uq_sales_order_billing_document UNIQUE,
  credit_check              text NULL CONSTRAINT ck_sales_order_credit_check CHECK (credit_check IN ('PASSED', 'OVERRIDDEN', 'NOT_REQUIRED')),
  customer_consent          jsonb NULL,
  cancel_reason_code        text NULL CONSTRAINT fk_sales_order_cancel_reason REFERENCES mdm.reason_code (code) ON DELETE RESTRICT,
  void_approval_request_id  uuid NULL CONSTRAINT fk_sales_order_void_approval REFERENCES iam.approval_request (id) ON DELETE RESTRICT,
  is_offline                boolean NOT NULL DEFAULT false,
  placed_at                 timestamptz NOT NULL,
  completed_at              timestamptz NULL,
  recorded_at               timestamptz NOT NULL DEFAULT now(),
  notes                     text NULL CONSTRAINT ck_sales_order_notes CHECK (length(btrim(notes)) BETWEEN 1 AND 500),
  branch_id                 uuid NOT NULL CONSTRAINT fk_sales_order_branch REFERENCES mdm.branch (id) ON DELETE RESTRICT,
  version                   integer NOT NULL DEFAULT 1,
  created_at                timestamptz NOT NULL DEFAULT now(),
  created_by                uuid NOT NULL CONSTRAINT fk_sales_order_created_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  updated_at                timestamptz NOT NULL DEFAULT now(),
  updated_by                uuid NOT NULL CONSTRAINT fk_sales_order_updated_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  posted_at                 timestamptz NULL,
  posted_by                 uuid NULL CONSTRAINT fk_sales_order_posted_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  CONSTRAINT ck_sales_order_maximum CHECK (maximum_total_pesewas >= estimated_total_pesewas),
  CONSTRAINT ck_sales_order_pos_shift CHECK (channel <> 'POS' OR shift_document_id IS NOT NULL),
  CONSTRAINT ck_sales_order_completed CHECK ((completed_at IS NULL) = (status NOT IN ('COMPLETED', 'VOIDED'))
                                             AND (status NOT IN ('COMPLETED', 'VOIDED') OR (billing_document_id IS NOT NULL AND final_total_pesewas IS NOT NULL))),
  CONSTRAINT ck_sales_order_posted CHECK ((posted_at IS NULL) = (posted_by IS NULL) AND (posted_at IS NULL) = (status NOT IN ('COMPLETED', 'CANCELLED', 'VOIDED'))),
  CONSTRAINT ck_sales_order_voided CHECK (status <> 'VOIDED' OR void_approval_request_id IS NOT NULL),
  CONSTRAINT ck_sales_order_cancelled CHECK (status <> 'CANCELLED' OR cancel_reason_code IS NOT NULL)
);
COMMENT ON TABLE ord.sales_order IS 'class=DOCUMENT';
CREATE INDEX ix_sales_order_customer ON ord.sales_order (customer_id, placed_at);
CREATE INDEX ix_sales_order_status ON ord.sales_order (status, branch_id);
CREATE INDEX ix_sales_order_shift ON ord.sales_order (shift_document_id);
CREATE INDEX ix_sales_order_placed ON ord.sales_order (branch_id, placed_at);
CREATE TRIGGER trg_sales_order_version BEFORE UPDATE ON ord.sales_order
  FOR EACH ROW EXECUTE FUNCTION platform.touch_version();

-- The machine of DOMAIN_MODEL section 7, held by the database: an order is written PLACED (a counter sale may complete
-- in the same transaction), moves only along a listed edge, and once COMPLETED changes only to be VOIDED.
CREATE FUNCTION ord.sales_order_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  allowed text[];
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'PLACED' THEN
      RAISE EXCEPTION 'ord.sales_order %: an order is written PLACED', NEW.id USING ERRCODE = 'HK004', CONSTRAINT = 'ck_sales_order_transition';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status IN ('CANCELLED', 'VOIDED') AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
    RAISE EXCEPTION 'ord.sales_order % is % and frozen', OLD.id, OLD.status USING ERRCODE = 'HK004', CONSTRAINT = 'ck_sales_order_transition';
  END IF;
  IF OLD.status = 'COMPLETED'
     AND (to_jsonb(NEW) - ARRAY['status', 'void_approval_request_id', 'version', 'updated_at', 'updated_by'])
         IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'void_approval_request_id', 'version', 'updated_at', 'updated_by']) THEN
    RAISE EXCEPTION 'ord.sales_order % is completed and frozen', OLD.id USING ERRCODE = 'HK004', CONSTRAINT = 'ck_sales_order_transition';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    allowed := CASE OLD.status
      WHEN 'PLACED' THEN ARRAY['CONFIRMED', 'COMPLETED', 'CANCELLED']
      WHEN 'CONFIRMED' THEN ARRAY['PICKING', 'CANCELLED']
      WHEN 'PICKING' THEN ARRAY['AWAITING_CUSTOMER', 'PACKED', 'CANCELLED']
      WHEN 'AWAITING_CUSTOMER' THEN ARRAY['PICKING', 'CANCELLED']
      WHEN 'PACKED' THEN ARRAY['READY_FOR_COLLECTION', 'DISPATCHED']
      WHEN 'READY_FOR_COLLECTION' THEN ARRAY['COMPLETED']
      WHEN 'DISPATCHED' THEN ARRAY['DELIVERED', 'DELIVERY_FAILED']
      WHEN 'DELIVERY_FAILED' THEN ARRAY['DISPATCHED', 'RETURNED']
      WHEN 'DELIVERED' THEN ARRAY['COMPLETED']
      WHEN 'RETURNED' THEN ARRAY['CANCELLED']
      WHEN 'COMPLETED' THEN ARRAY['VOIDED']
      ELSE ARRAY[]::text[] END;
    IF NOT (NEW.status = ANY (allowed)) THEN
      RAISE EXCEPTION 'ord.sales_order %: % cannot move to %', OLD.id, OLD.status, NEW.status USING ERRCODE = 'HK004', CONSTRAINT = 'ck_sales_order_transition';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION ord.sales_order_guard() FROM PUBLIC;
CREATE TRIGGER trg_sales_order_guard BEFORE INSERT OR UPDATE ON ord.sales_order
  FOR EACH ROW EXECUTE FUNCTION ord.sales_order_guard();

CREATE TABLE ord.sales_order_line (
  id                           uuid PRIMARY KEY,
  sales_order_id               uuid NOT NULL CONSTRAINT fk_sales_order_line_order REFERENCES ord.sales_order (id) ON DELETE RESTRICT,
  line_no                      integer NOT NULL CONSTRAINT ck_sales_order_line_no CHECK (line_no > 0),
  product_id                   uuid NOT NULL CONSTRAINT fk_sales_order_line_product REFERENCES mdm.product (id) ON DELETE RESTRICT,
  stock_unit_id                uuid NULL CONSTRAINT fk_sales_order_line_stock_unit REFERENCES inv.stock_unit (id) ON DELETE RESTRICT,
  qty_ordered                  platform.qty NOT NULL CONSTRAINT ck_sales_order_line_qty CHECK (qty_ordered > 0),
  uom                          text NOT NULL CONSTRAINT fk_sales_order_line_uom REFERENCES mdm.uom (code) ON DELETE RESTRICT,
  estimated_weight_kg          platform.kg NULL CONSTRAINT ck_sales_order_line_estimated_weight CHECK (estimated_weight_kg > 0),
  tolerance_percent            platform.percent NULL CONSTRAINT ck_sales_order_line_tolerance CHECK (tolerance_percent >= 0),
  qty_fulfilled                platform.qty NOT NULL DEFAULT 0 CONSTRAINT ck_sales_order_line_fulfilled CHECK (qty_fulfilled >= 0),
  fulfilled_weight_kg          platform.kg NULL CONSTRAINT ck_sales_order_line_fulfilled_weight CHECK (fulfilled_weight_kg > 0),
  weight_source                text NULL CONSTRAINT ck_sales_order_line_weight_source CHECK (weight_source IN ('SCALE', 'MANUAL', 'ESTIMATE')),
  qty_backordered              platform.qty NOT NULL DEFAULT 0 CONSTRAINT ck_sales_order_line_backordered CHECK (qty_backordered >= 0),
  price_source                 text NOT NULL CONSTRAINT ck_sales_order_line_price_source_value CHECK (price_source IN ('ENGINE', 'QUOTE', 'MANUAL_APPROVED')),
  price_basis                  text NOT NULL CONSTRAINT ck_sales_order_line_price_basis CHECK (price_basis IN ('PER_HEAD', 'PER_KG', 'PER_UNIT')),
  price_list_entry_id          uuid NULL CONSTRAINT fk_sales_order_line_price_entry REFERENCES mdm.price_list_entry (id) ON DELETE RESTRICT,
  quote_line_ref               uuid NULL,
  resolved_unit_price_pesewas  platform.pesewas NOT NULL,
  floor_unit_price_pesewas     platform.pesewas NOT NULL,
  ceiling_unit_price_pesewas   platform.pesewas NOT NULL,
  agreed_unit_price_pesewas    platform.pesewas NOT NULL,
  variance_pesewas             platform.pesewas NOT NULL DEFAULT 0,
  variance_direction           text NULL CONSTRAINT ck_sales_order_line_variance_direction CHECK (variance_direction IN ('BELOW', 'ABOVE')),
  variance_reason_code         text NULL CONSTRAINT fk_sales_order_line_variance_reason REFERENCES mdm.reason_code (code) ON DELETE RESTRICT,
  variance_requires_approval   boolean NOT NULL DEFAULT false,
  variance_approval_request_id uuid NULL CONSTRAINT fk_sales_order_line_variance_approval REFERENCES iam.approval_request (id) ON DELETE RESTRICT,
  discount_pesewas             platform.pesewas NOT NULL DEFAULT 0,
  estimated_line_total_pesewas platform.pesewas NOT NULL,
  final_line_total_pesewas     platform.pesewas NULL,
  reservation_id               uuid NULL CONSTRAINT fk_sales_order_line_reservation REFERENCES inv.stock_reservation (id) ON DELETE RESTRICT,
  stock_movement_id            uuid NULL CONSTRAINT fk_sales_order_line_movement REFERENCES inv.stock_movement (id) ON DELETE RESTRICT
                                 CONSTRAINT uq_sales_order_line_movement UNIQUE,
  stock_exception_id           uuid NULL CONSTRAINT fk_sales_order_line_exception REFERENCES inv.stock_exception (id) ON DELETE RESTRICT,
  substituted_for_line_id      uuid NULL CONSTRAINT fk_sales_order_line_substituted REFERENCES ord.sales_order_line (id) ON DELETE RESTRICT,
  line_status                  text NOT NULL CONSTRAINT ck_sales_order_line_status CHECK (line_status IN ('OPEN', 'FULFILLED', 'PARTIAL', 'BACKORDERED', 'SUBSTITUTED', 'CANCELLED', 'RETURNED')),
  CONSTRAINT uq_sales_order_line UNIQUE (sales_order_id, line_no),
  CONSTRAINT ck_sales_order_line_band CHECK (floor_unit_price_pesewas <= resolved_unit_price_pesewas AND resolved_unit_price_pesewas <= ceiling_unit_price_pesewas),
  CONSTRAINT ck_sales_order_line_price_source CHECK ((price_source <> 'ENGINE' OR price_list_entry_id IS NOT NULL) AND (price_source <> 'QUOTE' OR quote_line_ref IS NOT NULL)),
  CONSTRAINT ck_sales_order_line_outside_band CHECK (variance_requires_approval
                                                     OR (agreed_unit_price_pesewas >= floor_unit_price_pesewas AND agreed_unit_price_pesewas <= ceiling_unit_price_pesewas)),
  CONSTRAINT ck_sales_order_line_variance CHECK (
    (variance_direction IS NULL) = (agreed_unit_price_pesewas = resolved_unit_price_pesewas)
    AND (variance_direction IS NULL OR variance_direction = CASE WHEN agreed_unit_price_pesewas < resolved_unit_price_pesewas THEN 'BELOW' ELSE 'ABOVE' END)
    AND (variance_direction IS NULL) = (variance_reason_code IS NULL)
    AND (variance_direction IS NOT NULL OR variance_pesewas = 0)),
  CONSTRAINT ck_sales_order_line_weight CHECK ((fulfilled_weight_kg IS NULL) = (weight_source IS NULL)),
  CONSTRAINT ck_sales_order_line_movement_or_exception CHECK (stock_movement_id IS NULL OR stock_exception_id IS NULL)
);
COMMENT ON TABLE ord.sales_order_line IS 'class=DOCUMENT';
CREATE INDEX ix_sales_order_line_stock_unit ON ord.sales_order_line (stock_unit_id) WHERE stock_unit_id IS NOT NULL;

-- A line for a serialised product names one animal and sells one; a line changes only while its order is open.
CREATE FUNCTION ord.sales_order_line_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  order_status text;
  order_id uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.sales_order_id ELSE NEW.sales_order_id END;
BEGIN
  SELECT o.status INTO order_status FROM ord.sales_order o WHERE o.id = order_id;
  IF order_status IN ('COMPLETED', 'CANCELLED', 'VOIDED') THEN
    RAISE EXCEPTION 'ord.sales_order_line: order % is % and its lines are frozen', order_id, order_status USING ERRCODE = 'HK004', CONSTRAINT = 'ck_sales_order_line_frozen';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ord.sales_order_line %: a line is cancelled, never removed', OLD.id USING ERRCODE = 'HK004', CONSTRAINT = 'ck_sales_order_line_frozen';
  END IF;
  IF mdm.product_tracking(NEW.product_id) = 'SERIAL' AND (NEW.stock_unit_id IS NULL OR NEW.qty_ordered <> 1) THEN
    RAISE EXCEPTION 'ord.sales_order_line %: a serialised product is sold one named animal to a line', NEW.id USING ERRCODE = 'HK010', CONSTRAINT = 'ck_sales_order_line_serial';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION ord.sales_order_line_guard() FROM PUBLIC;
CREATE TRIGGER trg_sales_order_line_guard BEFORE INSERT OR UPDATE OR DELETE ON ord.sales_order_line
  FOR EACH ROW EXECUTE FUNCTION ord.sales_order_line_guard();

-- At commit: the order's number is its allocation; past PLACED every line needing approval has it; a COMPLETED order's
-- lines each have their movement or their stock exception (FR-ORD-007; a product kept out of stock is not sold on an
-- order line, A-208), and it has at least one line.
CREATE FUNCTION ord.sales_order_check() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  o record;
BEGIN
  SELECT s.id, s.order_no, s.status INTO o FROM ord.sales_order s WHERE s.id = NEW.id;
  IF o.order_no IS NOT NULL AND NOT platform.number_allocated(o.id, o.order_no, 'SALES_ORDER') THEN
    RAISE EXCEPTION 'ord.sales_order %: % is not the number allocated to it', o.id, o.order_no USING ERRCODE = 'HK010', CONSTRAINT = 'ck_sales_order_number';
  END IF;
  IF o.status <> 'PLACED' AND EXISTS (SELECT 1 FROM ord.sales_order_line l WHERE l.sales_order_id = o.id AND l.variance_requires_approval AND l.variance_approval_request_id IS NULL) THEN
    RAISE EXCEPTION 'ord.sales_order %: a price outside the band or beyond the limit has no approval', o.id USING ERRCODE = 'HK010', CONSTRAINT = 'ck_sales_order_settled_lines';
  END IF;
  IF o.status = 'COMPLETED' THEN
    IF NOT EXISTS (SELECT 1 FROM ord.sales_order_line l WHERE l.sales_order_id = o.id) THEN
      RAISE EXCEPTION 'ord.sales_order %: a completed order has at least one line', o.id USING ERRCODE = 'HK010', CONSTRAINT = 'ck_sales_order_settled_lines';
    END IF;
    IF EXISTS (SELECT 1 FROM ord.sales_order_line l
                WHERE l.sales_order_id = o.id AND l.line_status NOT IN ('CANCELLED', 'SUBSTITUTED')
                  AND l.stock_movement_id IS NULL AND l.stock_exception_id IS NULL) THEN
      RAISE EXCEPTION 'ord.sales_order %: a completed line has neither a stock movement nor a stock exception', o.id USING ERRCODE = 'HK010', CONSTRAINT = 'ck_sales_order_settled_lines';
    END IF;
  END IF;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION ord.sales_order_check() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER trg_sales_order_check AFTER INSERT OR UPDATE ON ord.sales_order
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ord.sales_order_check();

CREATE TABLE ord.order_status_history (
  id             uuid PRIMARY KEY,
  sales_order_id uuid NOT NULL CONSTRAINT fk_order_status_history_order REFERENCES ord.sales_order (id) ON DELETE RESTRICT,
  from_status    text NULL,
  to_status      text NOT NULL,
  reason         text NULL CONSTRAINT ck_order_status_history_reason CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
  occurred_at    timestamptz NOT NULL,
  recorded_at    timestamptz NOT NULL DEFAULT now(),
  actor_id       uuid NOT NULL CONSTRAINT fk_order_status_history_actor REFERENCES iam.principal (id) ON DELETE RESTRICT
);
COMMENT ON TABLE ord.order_status_history IS 'class=LEDGER';
CREATE INDEX ix_order_status_history_order ON ord.order_status_history (sales_order_id, recorded_at);
CREATE TRIGGER trg_order_status_history_immutable BEFORE UPDATE OR DELETE ON ord.order_status_history
  FOR EACH ROW EXECUTE FUNCTION platform.reject_change();
CREATE TRIGGER trg_order_status_history_no_truncate BEFORE TRUNCATE ON ord.order_status_history
  FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_change();

REVOKE ALL ON ALL TABLES IN SCHEMA ord FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON ord.sales_order, ord.sales_order_line TO hk_app, hk_worker;
GRANT SELECT, INSERT ON ord.order_status_history TO hk_app, hk_worker;

-- migrate:down
DROP TABLE ord.order_status_history;
DROP TRIGGER trg_sales_order_check ON ord.sales_order;
DROP FUNCTION ord.sales_order_check();
DROP TABLE ord.sales_order_line;
DROP FUNCTION ord.sales_order_line_guard();
DROP TABLE ord.sales_order;
DROP FUNCTION ord.sales_order_guard();
DROP SCHEMA ord;
