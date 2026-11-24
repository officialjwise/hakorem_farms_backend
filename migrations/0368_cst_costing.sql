-- 0368_cst_costing
-- B12 continued 2 (FR-CST-001 to FR-CST-008, ADR-0018, ADR-0023, ADR-0102): the costing module. CST owns no cost of
-- record: inventory holds the value of stock (ADR-0018); this schema holds the allocation runs CST posts through
-- inventory, and projections it derives from the published views of INV, BIL, ORD and MDM only.
--   cst.overhead_allocation_run   DOCUMENT: a period's labour or overhead to spread over the animals of a pen or branch
--   cst.overhead_allocation_line  DOCUMENT: one stock unit's share, from the kernel's allocate; a growing unit's share
--                                 is CAPITALISED by a value-only movement, a breeding unit's EXPENSED (no movement)
--   cst.cost_object_summary       PROJECTION: accumulated cost by element per stock unit and per processing order
--   cst.margin_fact               PROJECTION: one row per billed line of sales (REVENUE) and per sale-related cost of
--                                 sales movement (COST), each with its margin dimensions
--   cst.loss_fact                 PROJECTION: one row per write-off movement (mortality, cull, adjustment and count
--                                 losses) and its reversals
-- Rules held here:
--   * a run is created as a DRAFT with its lines and posted once; nothing of its figures changes (ck_overhead_allocation_frozen);
--   * its lines sum exactly to its total, checked at commit (HK010, ck_overhead_allocation_allocated);
--   * the person who posts is never the person who created it (ck_overhead_allocation_checker);
--   * one posted run per branch, cost element, scope and period (uq_overhead_allocation_posted);
--   * a line's movement is set once, only when its run is posted, and only for a capitalised share.
-- The projections are written only through the SECURITY DEFINER refresh functions below, which read published views,
-- so a rebuild is the same statements over every key (FR-CST-008). The application roles only read them.
-- Data category: CONFIDENTIAL (DC-09): cost and trading figures; customers and staff appear as ids only.
-- Rollback: tested (`pnpm db:rollback`) before the first run is posted; afterwards forward fix only.

-- migrate:up
CREATE SCHEMA cst AUTHORIZATION hk_owner;
REVOKE ALL ON SCHEMA cst FROM PUBLIC;
GRANT USAGE ON SCHEMA cst TO hk_app, hk_worker, hk_report;

CREATE TABLE cst.overhead_allocation_run (
  id                uuid PRIMARY KEY CONSTRAINT fk_overhead_allocation_run_document REFERENCES platform.business_document (id) ON DELETE RESTRICT,
  branch_id         uuid NOT NULL CONSTRAINT fk_overhead_allocation_run_branch REFERENCES mdm.branch (id) ON DELETE RESTRICT,
  period_start      date NOT NULL,
  period_end        date NOT NULL,
  cost_element      text NOT NULL CONSTRAINT ck_overhead_allocation_run_element CHECK (cost_element IN ('LABOUR', 'OVERHEAD')),
  basis             text NOT NULL CONSTRAINT ck_overhead_allocation_run_basis CHECK (basis IN ('HEAD_DAYS', 'WEIGHT_GAIN', 'EQUAL')),
  scope_location_id uuid NULL CONSTRAINT fk_overhead_allocation_run_scope REFERENCES mdm.location (id) ON DELETE RESTRICT,
  total_pesewas     platform.pesewas NOT NULL CONSTRAINT ck_overhead_allocation_run_total CHECK (total_pesewas > 0),
  status            text NOT NULL CONSTRAINT ck_overhead_allocation_run_status CHECK (status IN ('DRAFT', 'POSTED')),
  version           integer NOT NULL DEFAULT 1,
  created_at        timestamptz NOT NULL,
  created_by        uuid NOT NULL CONSTRAINT fk_overhead_allocation_run_created_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  updated_at        timestamptz NOT NULL,
  updated_by        uuid NOT NULL CONSTRAINT fk_overhead_allocation_run_updated_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  posted_at         timestamptz NULL,
  posted_by         uuid NULL CONSTRAINT fk_overhead_allocation_run_posted_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  CONSTRAINT ck_overhead_allocation_run_period CHECK (period_end >= period_start),
  CONSTRAINT ck_overhead_allocation_run_posted CHECK ((status = 'POSTED') = (posted_at IS NOT NULL AND posted_by IS NOT NULL)),
  CONSTRAINT ck_overhead_allocation_checker CHECK (posted_by IS DISTINCT FROM created_by)
);
COMMENT ON TABLE cst.overhead_allocation_run IS 'class=DOCUMENT';
CREATE INDEX ix_overhead_allocation_run_list ON cst.overhead_allocation_run (branch_id, created_at DESC, id DESC);
CREATE UNIQUE INDEX uq_overhead_allocation_posted ON cst.overhead_allocation_run
  (branch_id, cost_element, COALESCE(scope_location_id, '00000000-0000-0000-0000-000000000000'::uuid), period_start, period_end)
  WHERE status = 'POSTED';
CREATE TRIGGER trg_overhead_allocation_run_version BEFORE UPDATE ON cst.overhead_allocation_run FOR EACH ROW EXECUTE FUNCTION platform.touch_version();

CREATE TABLE cst.overhead_allocation_line (
  run_id         uuid NOT NULL CONSTRAINT fk_overhead_allocation_line_run REFERENCES cst.overhead_allocation_run (id) ON DELETE RESTRICT,
  stock_unit_id  uuid NOT NULL CONSTRAINT fk_overhead_allocation_line_unit REFERENCES inv.stock_unit (id) ON DELETE RESTRICT,
  weight         bigint NOT NULL CONSTRAINT ck_overhead_allocation_line_weight CHECK (weight > 0),
  amount_pesewas platform.pesewas NOT NULL,
  treatment      text NOT NULL CONSTRAINT ck_overhead_allocation_line_treatment CHECK (treatment IN ('CAPITALISED', 'EXPENSED')),
  movement_ref   uuid NULL CONSTRAINT fk_overhead_allocation_line_movement REFERENCES inv.stock_movement (id) ON DELETE RESTRICT
                   CONSTRAINT uq_overhead_allocation_line_movement UNIQUE,
  CONSTRAINT pk_overhead_allocation_line PRIMARY KEY (run_id, stock_unit_id),
  CONSTRAINT ck_overhead_allocation_line_expensed CHECK (treatment = 'CAPITALISED' OR movement_ref IS NULL)
);
COMMENT ON TABLE cst.overhead_allocation_line IS 'class=DOCUMENT';

-- A run is born a DRAFT and posted once by someone else; a line is born with its run and only learns its movement when
-- the run is posted. Nothing else of either ever changes.
CREATE FUNCTION cst.overhead_allocation_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  run_status text;
BEGIN
  IF TG_TABLE_NAME = 'overhead_allocation_run' THEN
    IF TG_OP = 'INSERT' THEN
      IF NEW.status <> 'DRAFT' THEN
        RAISE EXCEPTION 'cst.overhead_allocation_run %: a run is created as a draft', NEW.id USING ERRCODE = 'HK004', CONSTRAINT = 'ck_overhead_allocation_frozen';
      END IF;
      RETURN NEW;
    END IF;
    IF OLD.status <> 'DRAFT' OR NEW.status <> 'POSTED'
       OR (to_jsonb(NEW) - ARRAY['status', 'posted_at', 'posted_by', 'version', 'updated_at', 'updated_by'])
          IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'posted_at', 'posted_by', 'version', 'updated_at', 'updated_by']) THEN
      RAISE EXCEPTION 'cst.overhead_allocation_run %: only a draft is posted, once, and nothing else of it changes', OLD.id
        USING ERRCODE = 'HK004', CONSTRAINT = 'ck_overhead_allocation_frozen';
    END IF;
    RETURN NEW;
  END IF;
  SELECT r.status INTO run_status FROM cst.overhead_allocation_run r WHERE r.id = COALESCE(NEW.run_id, OLD.run_id);
  IF TG_OP = 'INSERT' THEN
    IF run_status <> 'DRAFT' OR NEW.movement_ref IS NOT NULL THEN
      RAISE EXCEPTION 'cst.overhead_allocation_line: a line is written with its draft run, without a movement'
        USING ERRCODE = 'HK004', CONSTRAINT = 'ck_overhead_allocation_frozen';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.movement_ref IS NOT NULL OR NEW.movement_ref IS NULL
     OR (to_jsonb(NEW) - 'movement_ref') IS DISTINCT FROM (to_jsonb(OLD) - 'movement_ref') THEN
    RAISE EXCEPTION 'cst.overhead_allocation_line %: only its movement is set, once', OLD.stock_unit_id
      USING ERRCODE = 'HK004', CONSTRAINT = 'ck_overhead_allocation_frozen';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION cst.overhead_allocation_guard() FROM PUBLIC;
CREATE TRIGGER trg_overhead_allocation_run_guard BEFORE INSERT OR UPDATE ON cst.overhead_allocation_run
  FOR EACH ROW EXECUTE FUNCTION cst.overhead_allocation_guard();
CREATE TRIGGER trg_overhead_allocation_line_guard BEFORE INSERT OR UPDATE ON cst.overhead_allocation_line
  FOR EACH ROW EXECUTE FUNCTION cst.overhead_allocation_guard();
CREATE TRIGGER trg_overhead_allocation_run_no_delete BEFORE DELETE OR TRUNCATE ON cst.overhead_allocation_run
  FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_change();
CREATE TRIGGER trg_overhead_allocation_line_no_delete BEFORE DELETE OR TRUNCATE ON cst.overhead_allocation_line
  FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_change();

-- At commit: the lines allocate exactly the total, and a posted run has a movement for every capitalised share above
-- nothing and none for an expensed one.
CREATE FUNCTION cst.overhead_allocation_check() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  rid uuid := COALESCE(to_jsonb(NEW)->>'run_id', to_jsonb(NEW)->>'id')::uuid;
  run cst.overhead_allocation_run;
  allocated numeric;
  unposted integer;
BEGIN
  SELECT * INTO run FROM cst.overhead_allocation_run WHERE id = rid;
  SELECT COALESCE(sum(l.amount_pesewas), 0),
         count(*) FILTER (WHERE l.treatment = 'CAPITALISED' AND l.amount_pesewas > 0 AND l.movement_ref IS NULL)
    INTO allocated, unposted
    FROM cst.overhead_allocation_line l WHERE l.run_id = rid;
  IF allocated <> run.total_pesewas THEN
    RAISE EXCEPTION 'cst.overhead_allocation_run %: its lines allocate % of %', rid, allocated, run.total_pesewas
      USING ERRCODE = 'HK010', CONSTRAINT = 'ck_overhead_allocation_allocated';
  END IF;
  IF run.status = 'POSTED' AND unposted > 0 THEN
    RAISE EXCEPTION 'cst.overhead_allocation_run %: posted with % capitalised shares not moved', rid, unposted
      USING ERRCODE = 'HK010', CONSTRAINT = 'ck_overhead_allocation_allocated';
  END IF;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION cst.overhead_allocation_check() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER trg_overhead_allocation_run_check AFTER INSERT OR UPDATE ON cst.overhead_allocation_run
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION cst.overhead_allocation_check();
CREATE CONSTRAINT TRIGGER trg_overhead_allocation_line_check AFTER INSERT OR UPDATE ON cst.overhead_allocation_line
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION cst.overhead_allocation_check();

CREATE TABLE cst.cost_object_summary (
  object_type         text NOT NULL CONSTRAINT ck_cost_object_summary_type CHECK (object_type IN ('STOCK_UNIT', 'PROCESSING_ORDER')),
  object_id           uuid NOT NULL,
  branch_id           uuid NOT NULL CONSTRAINT fk_cost_object_summary_branch REFERENCES mdm.branch (id) ON DELETE RESTRICT,
  product_id          uuid NULL CONSTRAINT fk_cost_object_summary_product REFERENCES mdm.product (id) ON DELETE RESTRICT,
  purchase_pesewas    bigint NOT NULL DEFAULT 0,
  feed_pesewas        bigint NOT NULL DEFAULT 0,
  veterinary_pesewas  bigint NOT NULL DEFAULT 0,
  labour_pesewas      bigint NOT NULL DEFAULT 0,
  overhead_pesewas    bigint NOT NULL DEFAULT 0,
  processing_pesewas  bigint NOT NULL DEFAULT 0,
  total_pesewas       bigint NOT NULL DEFAULT 0,
  refreshed_at        timestamptz NOT NULL,
  CONSTRAINT pk_cost_object_summary PRIMARY KEY (object_type, object_id),
  CONSTRAINT ck_cost_object_summary_total CHECK (total_pesewas = purchase_pesewas + feed_pesewas + veterinary_pesewas + labour_pesewas + overhead_pesewas + processing_pesewas)
);
COMMENT ON TABLE cst.cost_object_summary IS 'class=PROJECTION';
COMMENT ON COLUMN cst.cost_object_summary.purchase_pesewas IS 'Signed: what the element added, less any reversal of it';

CREATE TABLE cst.margin_fact (
  fact_ref               uuid PRIMARY KEY,
  fact_kind              text NOT NULL CONSTRAINT ck_margin_fact_kind CHECK (fact_kind IN ('REVENUE', 'COST')),
  document_date          date NOT NULL,
  branch_id              uuid NOT NULL CONSTRAINT fk_margin_fact_branch REFERENCES mdm.branch (id) ON DELETE RESTRICT,
  product_id             uuid NULL CONSTRAINT fk_margin_fact_product REFERENCES mdm.product (id) ON DELETE RESTRICT,
  product_line           text NOT NULL,
  channel                text NOT NULL CONSTRAINT ck_margin_fact_channel CHECK (channel IN ('POS', 'ONLINE', 'WHOLESALE', 'QUOTE', 'NONE')),
  customer_ref           uuid NULL,
  salesperson_ref        uuid NULL,
  is_credit              boolean NOT NULL,
  qty                    numeric(14,3) NULL,
  weight_kg              numeric(12,3) NULL,
  revenue_pesewas        platform.pesewas NOT NULL,
  cost_pesewas           platform.pesewas NOT NULL,
  price_variance_pesewas bigint NOT NULL DEFAULT 0,
  refreshed_at           timestamptz NOT NULL,
  CONSTRAINT ck_margin_fact_side CHECK ((fact_kind = 'REVENUE' AND cost_pesewas = 0) OR (fact_kind = 'COST' AND revenue_pesewas = 0 AND price_variance_pesewas = 0))
);
COMMENT ON TABLE cst.margin_fact IS 'class=PROJECTION';
COMMENT ON COLUMN cst.margin_fact.price_variance_pesewas IS 'Signed as BIL publishes it: above zero, agreed below the resolved price';
CREATE INDEX ix_margin_fact_date ON cst.margin_fact (document_date, branch_id);
CREATE INDEX ix_margin_fact_product ON cst.margin_fact (product_id);
CREATE INDEX ix_margin_fact_customer ON cst.margin_fact (customer_ref) WHERE customer_ref IS NOT NULL;

CREATE TABLE cst.loss_fact (
  movement_ref  uuid PRIMARY KEY,
  occurred_on   date NOT NULL,
  branch_id     uuid NOT NULL CONSTRAINT fk_loss_fact_branch REFERENCES mdm.branch (id) ON DELETE RESTRICT,
  location_id   uuid NOT NULL CONSTRAINT fk_loss_fact_location REFERENCES mdm.location (id) ON DELETE RESTRICT,
  product_id    uuid NOT NULL CONSTRAINT fk_loss_fact_product REFERENCES mdm.product (id) ON DELETE RESTRICT,
  product_line  text NOT NULL,
  loss_group    text NOT NULL CONSTRAINT ck_loss_fact_group CHECK (loss_group IN ('MORTALITY', 'SHRINKAGE', 'WASTAGE')),
  reason_code   text NULL,
  handler_ref   uuid NULL,
  is_reversal   boolean NOT NULL,
  qty           numeric(14,3) NOT NULL,
  value_pesewas platform.pesewas NOT NULL,
  refreshed_at  timestamptz NOT NULL
);
COMMENT ON TABLE cst.loss_fact IS 'class=PROJECTION';
CREATE INDEX ix_loss_fact_date ON cst.loss_fact (occurred_on, branch_id);

-- Accumulated cost per stock unit, by element, from every movement that adds cost to it (ADR-0018): a receipt,
-- opening balance or harvest is its PURCHASE, a value-only movement carries its own element, a processing output is
-- PROCESSING. A reversal takes back the element of the movement it reverses. Issues, transfers and returns move value
-- the unit already had and add nothing. NULL refreshes every unit.
CREATE FUNCTION cst.refresh_unit_costs(p_stock_unit_ids uuid[]) RETURNS integer
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
DECLARE
  written integer;
BEGIN
  DELETE FROM cst.cost_object_summary s
   WHERE s.object_type = 'STOCK_UNIT' AND (p_stock_unit_ids IS NULL OR s.object_id = ANY (p_stock_unit_ids));
  WITH flows AS (
    SELECT m.stock_unit_id, m.branch_id, m.product_id, m.occurred_at, m.id,
           CASE WHEN m.reverses_movement_id IS NULL THEN 1 ELSE -1 END * m.value_pesewas AS signed_value,
           CASE WHEN COALESCE(o.movement_type, m.movement_type) IN ('COST_CAPITALISE', 'OVERHEAD_CAPITALISE') THEN COALESCE(o.cost_element, m.cost_element)
                WHEN COALESCE(o.movement_type, m.movement_type) = 'PROCESS_OUTPUT' THEN 'PROCESSING'
                WHEN COALESCE(o.movement_type, m.movement_type) IN ('RECEIPT_PURCHASE', 'OPENING_BALANCE', 'RECEIPT_HARVEST') THEN 'PURCHASE'
           END AS element
      FROM inv.pub_movement m
      LEFT JOIN inv.pub_movement o ON o.id = m.reverses_movement_id
     WHERE m.stock_unit_id IS NOT NULL AND (p_stock_unit_ids IS NULL OR m.stock_unit_id = ANY (p_stock_unit_ids))
  ), units AS (
    SELECT f.stock_unit_id,
           (array_agg(f.branch_id ORDER BY f.occurred_at DESC, f.id DESC))[1] AS branch_id,
           (array_agg(f.product_id))[1] AS product_id,
           COALESCE(sum(f.signed_value) FILTER (WHERE f.element = 'PURCHASE'), 0) AS purchase,
           COALESCE(sum(f.signed_value) FILTER (WHERE f.element = 'FEED'), 0) AS feed,
           COALESCE(sum(f.signed_value) FILTER (WHERE f.element = 'VETERINARY'), 0) AS veterinary,
           COALESCE(sum(f.signed_value) FILTER (WHERE f.element = 'LABOUR'), 0) AS labour,
           COALESCE(sum(f.signed_value) FILTER (WHERE f.element = 'OVERHEAD'), 0) AS overhead,
           COALESCE(sum(f.signed_value) FILTER (WHERE f.element = 'PROCESSING'), 0) AS processing
      FROM flows f
     GROUP BY f.stock_unit_id
  )
  INSERT INTO cst.cost_object_summary (object_type, object_id, branch_id, product_id, purchase_pesewas, feed_pesewas, veterinary_pesewas,
                                       labour_pesewas, overhead_pesewas, processing_pesewas, total_pesewas, refreshed_at)
  SELECT 'STOCK_UNIT', u.stock_unit_id, u.branch_id, u.product_id, u.purchase, u.feed, u.veterinary, u.labour, u.overhead, u.processing,
         u.purchase + u.feed + u.veterinary + u.labour + u.overhead + u.processing, platform.app_now()
    FROM units u;
  GET DIAGNOSTICS written = ROW_COUNT;
  RETURN written;
END
$$;

-- A processing order's figures, worked out by the application from the movements (the inputs split by each consumed
-- unit's elements through allocate, the direct cost the outputs' value less the inputs'), replaced whole.
CREATE FUNCTION cst.put_processing_order_costs(p_order_ids uuid[], p_rows jsonb) RETURNS integer
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
DECLARE
  written integer;
BEGIN
  DELETE FROM cst.cost_object_summary s
   WHERE s.object_type = 'PROCESSING_ORDER' AND (p_order_ids IS NULL OR s.object_id = ANY (p_order_ids));
  INSERT INTO cst.cost_object_summary (object_type, object_id, branch_id, product_id, purchase_pesewas, feed_pesewas, veterinary_pesewas,
                                       labour_pesewas, overhead_pesewas, processing_pesewas, total_pesewas, refreshed_at)
  SELECT 'PROCESSING_ORDER', (r ->> 'objectId')::uuid, (r ->> 'branchId')::uuid, NULL,
         (r ->> 'purchase')::bigint, (r ->> 'feed')::bigint, (r ->> 'veterinary')::bigint, (r ->> 'labour')::bigint,
         (r ->> 'overhead')::bigint, (r ->> 'processing')::bigint,
         (r ->> 'purchase')::bigint + (r ->> 'feed')::bigint + (r ->> 'veterinary')::bigint + (r ->> 'labour')::bigint
           + (r ->> 'overhead')::bigint + (r ->> 'processing')::bigint,
         platform.app_now()
    FROM jsonb_array_elements(p_rows) r;
  GET DIAGNOSTICS written = ROW_COUNT;
  RETURN written;
END
$$;

-- Margin facts of billed lines (REVENUE): the line's net, which is net of levies, its price variance, and the order's
-- channel and salesperson. A credit note's line reduces revenue. The lines are those the ledger posts to sales and its
-- deductions (4000 to 4030, 4200, 4210, 4220): every product line; a charge or adjustment line, which posts to 4030 by
-- its GL group and so counts under BY_PRODUCT with no product; and every line of a credit note, which posts its whole
-- net to 4200 (a delivery fee credited back included). A delivery fee charged posts to 4100 and is not a sale of stock.
-- NULL refreshes every document.
CREATE FUNCTION cst.refresh_margin_revenue(p_document_ids uuid[]) RETURNS integer
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
DECLARE
  written integer;
BEGIN
  DELETE FROM cst.margin_fact f
   WHERE f.fact_kind = 'REVENUE'
     AND (p_document_ids IS NULL OR f.fact_ref IN (SELECT l.line_id FROM bil.pub_document_line l WHERE l.document_id = ANY (p_document_ids)));
  INSERT INTO cst.margin_fact (fact_ref, fact_kind, document_date, branch_id, product_id, product_line, channel, customer_ref, salesperson_ref,
                               is_credit, qty, weight_kg, revenue_pesewas, cost_pesewas, price_variance_pesewas, refreshed_at)
  SELECT l.line_id, 'REVENUE', l.issue_date, l.branch_id, l.product_id, COALESCE(p.product_line, 'BY_PRODUCT'), COALESCE(o.channel, 'NONE'),
         l.customer_id, o.salesperson_id, l.kind = 'CREDIT_NOTE', CASE WHEN l.product_id IS NULL THEN NULL ELSE l.qty END, l.weight_kg,
         l.net_pesewas, 0, l.price_variance_pesewas, platform.app_now()
    FROM bil.pub_document_line l
    LEFT JOIN mdm.pub_product p ON p.product_id = l.product_id
    LEFT JOIN ord.pub_sale_order o ON o.order_id = l.order_document_id
   WHERE (l.line_kind IN ('PRODUCT', 'ADJUSTMENT') OR l.kind = 'CREDIT_NOTE')
     AND (p_document_ids IS NULL OR l.document_id = ANY (p_document_ids));
  GET DIAGNOSTICS written = ROW_COUNT;
  RETURN written;
END
$$;

-- Margin facts of cost of sales (COST): each sale issue (online or offline), customer return and reversal of either
-- with a value, and each cost of stock sold ahead of receipt and its true-up (inv.pub_negative_stock_cost), with the
-- dimensions of the order line the sale was of (a return through the issue it returns, a reversal through the movement
-- it reverses). A return, a reversal of an issue and a true-up below the last known cost reduce cost. NULL refreshes
-- every movement.
CREATE FUNCTION cst.refresh_margin_cost(p_movement_ids uuid[]) RETURNS integer
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
DECLARE
  written integer;
  negative integer;
BEGIN
  DELETE FROM cst.margin_fact f
   WHERE f.fact_kind = 'COST'
     AND (p_movement_ids IS NULL OR f.fact_ref = ANY (p_movement_ids)
          OR f.fact_ref IN (SELECT n.cost_ref FROM inv.pub_negative_stock_cost n
                             WHERE n.sale_movement_id = ANY (p_movement_ids) OR n.true_up_movement_id = ANY (p_movement_ids)));
  INSERT INTO cst.margin_fact (fact_ref, fact_kind, document_date, branch_id, product_id, product_line, channel, customer_ref, salesperson_ref,
                               is_credit, qty, weight_kg, revenue_pesewas, cost_pesewas, price_variance_pesewas, refreshed_at)
  SELECT m.id, 'COST', (m.occurred_at AT TIME ZONE 'Africa/Accra')::date, m.branch_id, m.product_id, p.product_line,
         COALESCE(s.channel, 'NONE'), s.customer_id, s.salesperson_id,
         (COALESCE(r.movement_type, m.movement_type) = 'SALE_RETURN') <> (m.reverses_movement_id IS NOT NULL),
         m.qty_base, m.weight_kg, 0, m.value_pesewas, 0, platform.app_now()
    FROM inv.pub_movement m
    JOIN mdm.pub_product p ON p.product_id = m.product_id
    LEFT JOIN inv.pub_movement r ON r.id = m.reverses_movement_id
    LEFT JOIN inv.pub_movement i ON i.id = COALESCE(m.returns_movement_id, r.returns_movement_id)
    LEFT JOIN ord.pub_sale_line s ON s.line_id = COALESCE(i.source_line_ref, r.source_line_ref, m.source_line_ref)
   WHERE COALESCE(r.movement_type, m.movement_type) IN ('SALE_ISSUE', 'SALE_ISSUE_OFFLINE', 'SALE_RETURN') AND m.value_pesewas > 0
     AND (p_movement_ids IS NULL OR m.id = ANY (p_movement_ids));
  GET DIAGNOSTICS written = ROW_COUNT;
  INSERT INTO cst.margin_fact (fact_ref, fact_kind, document_date, branch_id, product_id, product_line, channel, customer_ref, salesperson_ref,
                               is_credit, qty, weight_kg, revenue_pesewas, cost_pesewas, price_variance_pesewas, refreshed_at)
  SELECT n.cost_ref, 'COST', (n.occurred_at AT TIME ZONE 'Africa/Accra')::date, n.branch_id, n.product_id, p.product_line,
         COALESCE(s.channel, 'NONE'), s.customer_id, s.salesperson_id, n.cost_pesewas < 0, NULL, NULL, 0, abs(n.cost_pesewas), 0, platform.app_now()
    FROM inv.pub_negative_stock_cost n
    JOIN mdm.pub_product p ON p.product_id = n.product_id
    JOIN inv.pub_movement m ON m.id = n.sale_movement_id
    LEFT JOIN ord.pub_sale_line s ON s.line_id = m.source_line_ref
   WHERE n.cost_pesewas <> 0
     AND (p_movement_ids IS NULL OR n.sale_movement_id = ANY (p_movement_ids) OR n.true_up_movement_id = ANY (p_movement_ids));
  GET DIAGNOSTICS negative = ROW_COUNT;
  RETURN written + negative;
END
$$;

-- Loss facts (FR-CST-007): each mortality, cull, adjustment loss and count loss, and each reversal of one, under the
-- loss group its reason posts to (MORTALITY 5100, WASTAGE 5120, otherwise SHRINKAGE 5110, as the ledger's LOSS_GROUP
-- determination), at the location it left, with the person who recorded it. NULL refreshes every movement.
CREATE FUNCTION cst.refresh_loss_facts(p_movement_ids uuid[]) RETURNS integer
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
DECLARE
  written integer;
BEGIN
  DELETE FROM cst.loss_fact f WHERE p_movement_ids IS NULL OR f.movement_ref = ANY (p_movement_ids);
  INSERT INTO cst.loss_fact (movement_ref, occurred_on, branch_id, location_id, product_id, product_line, loss_group, reason_code, handler_ref,
                             is_reversal, qty, value_pesewas, refreshed_at)
  SELECT m.id, (m.occurred_at AT TIME ZONE 'Africa/Accra')::date, m.branch_id,
         CASE WHEN m.reverses_movement_id IS NULL THEN m.from_location_id ELSE m.to_location_id END,
         m.product_id, p.product_line, COALESCE(rc.loss_account_group, 'SHRINKAGE'), COALESCE(m.reason_code, r.reason_code),
         COALESCE(r.actor_id, m.actor_id), m.reverses_movement_id IS NOT NULL, m.qty_base, m.value_pesewas, platform.app_now()
    FROM inv.pub_movement m
    JOIN mdm.pub_product p ON p.product_id = m.product_id
    LEFT JOIN inv.pub_movement r ON r.id = m.reverses_movement_id
    LEFT JOIN mdm.pub_reason_code rc ON rc.code = COALESCE(m.reason_code, r.reason_code)
   WHERE COALESCE(r.movement_type, m.movement_type) IN ('MORTALITY', 'CULL', 'ADJUST_LOSS', 'STOCKTAKE_LOSS')
     AND (p_movement_ids IS NULL OR m.id = ANY (p_movement_ids));
  GET DIAGNOSTICS written = ROW_COUNT;
  RETURN written;
END
$$;

REVOKE ALL ON FUNCTION cst.refresh_unit_costs(uuid[]), cst.put_processing_order_costs(uuid[], jsonb), cst.refresh_margin_revenue(uuid[]),
  cst.refresh_margin_cost(uuid[]), cst.refresh_loss_facts(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cst.refresh_unit_costs(uuid[]), cst.put_processing_order_costs(uuid[], jsonb), cst.refresh_margin_revenue(uuid[]),
  cst.refresh_margin_cost(uuid[]), cst.refresh_loss_facts(uuid[]) TO hk_app, hk_worker;

REVOKE ALL ON ALL TABLES IN SCHEMA cst FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON cst.overhead_allocation_run, cst.overhead_allocation_line TO hk_app, hk_worker;
GRANT SELECT ON cst.cost_object_summary, cst.margin_fact, cst.loss_fact TO hk_app, hk_worker, hk_report;

-- migrate:down
DROP FUNCTION cst.refresh_loss_facts(uuid[]);
DROP FUNCTION cst.refresh_margin_cost(uuid[]);
DROP FUNCTION cst.refresh_margin_revenue(uuid[]);
DROP FUNCTION cst.put_processing_order_costs(uuid[], jsonb);
DROP FUNCTION cst.refresh_unit_costs(uuid[]);
DROP TABLE cst.loss_fact;
DROP TABLE cst.margin_fact;
DROP TABLE cst.cost_object_summary;
DROP TABLE cst.overhead_allocation_line;
DROP TABLE cst.overhead_allocation_run;
DROP FUNCTION cst.overhead_allocation_check();
DROP FUNCTION cst.overhead_allocation_guard();
DROP SCHEMA cst;
