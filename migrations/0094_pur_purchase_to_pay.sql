-- 0094_pur_purchase_to_pay
-- The procurement schema's purchase-to-pay half (docs/data-model/pur.md; FR-PUR-005 to FR-PUR-010, FR-PUR-012; A-164):
-- purchase orders with their approval limit, the received quantity each goods receipt adds to an order line, supplier
-- invoices with levy rows and the three-way match, and supplier payments with their allocations. Supplier profiles,
-- documents, requisitions, credit notes and scores arrive with the rest of procurement (B07 continued).
--
-- The database holds the document rules itself, whoever writes:
--   pur.purchase_order_status_guard     an order starts DRAFT and moves only along its lifecycle; it is cancelled only
--                                       before anything is received against it (HK004)
--   ck_purchase_order_approved          an order that is approved, sent or received at or above the approval threshold
--                                       it was judged against names its approval request (FR-PUR-005)
--   pur.purchase_order_line_guard       lines change only while their order is DRAFT, except the received quantity,
--                                       which only a receipt changes while the order is SENT or being received (HK004)
--   ck_purchase_order_line_tolerance    received never exceeds ordered plus the line's tolerance (FR-PUR-007)
--   ck_purchase_order_totals            deferred: net, tax and gross are the sums of the lines (HK010)
--   pur.supplier_invoice_status_guard   the invoice lifecycle; an approved invoice is cancelled only with no payment
--                                       allocated to it (HK004)
--   ck_supplier_invoice_payable         an approved or paid invoice is MATCHED or NOT_REQUIRED (FR-PUR-010)
--   ck_supplier_invoice_totals          deferred: net, tax and gross are the sums of the lines and levy rows, and paid
--                                       is the sum of allocations of PAID payments (HK010)
--   pur.supplier_payment_allocation_guard
--                                       an allocation is made only while its payment is DRAFT, to an APPROVED invoice of
--                                       the same supplier whose match is MATCHED or NOT_REQUIRED, and never takes the
--                                       invoice's live allocations above its gross (HK010, FR-PUR-010, FR-PUR-012)
--   ck_supplier_payment_allocated       deferred: a payment's amount is the sum of its allocations (HK010)
--   ck_supplier_payment_paid            a paid payment names its approval request, the time and the reference
-- Maker and checker of an order above the limit and of every payment differ by iam.approval_request's own check.
-- `bank_account_id` and `remittance_document_id` on a payment arrive with their tables in B8 (DATA_MODEL.md,
-- Migrations). `qty_invoiced` on an order line is derived from the invoices that hold it, not stored (A-164).
-- Data category: INTERNAL (DC-13) for orders; CONFIDENTIAL (DC-11) for invoices and payments.
-- Rollback: tested (`pnpm db:rollback`), safe before the first payment; afterwards forward fix only, since a payment
-- is the source of the money that left.

-- migrate:up
CREATE SCHEMA pur AUTHORIZATION hk_owner;
REVOKE ALL ON SCHEMA pur FROM PUBLIC;
GRANT USAGE ON SCHEMA pur TO hk_app, hk_worker, hk_report;

CREATE TABLE pur.purchase_order (
  id                         uuid PRIMARY KEY CONSTRAINT fk_purchase_order_document REFERENCES platform.business_document (id) ON DELETE RESTRICT,
  order_no                   text NULL CONSTRAINT uq_purchase_order_no UNIQUE,
  supplier_id                uuid NOT NULL CONSTRAINT fk_purchase_order_supplier REFERENCES mdm.supplier (id) ON DELETE RESTRICT,
  deliver_to_location_id     uuid NOT NULL CONSTRAINT fk_purchase_order_location REFERENCES mdm.location (id) ON DELETE RESTRICT,
  order_date                 date NOT NULL,
  expected_on                date NULL,
  currency                   char(3) NOT NULL DEFAULT 'GHS' CONSTRAINT ck_purchase_order_currency CHECK (currency = 'GHS'),
  tax_inclusive              boolean NOT NULL DEFAULT false,
  tax_scheme_version_id      uuid NOT NULL CONSTRAINT fk_purchase_order_tax_scheme REFERENCES mdm.tax_scheme_version (id) ON DELETE RESTRICT,
  net_pesewas                platform.pesewas NOT NULL DEFAULT 0,
  tax_pesewas                platform.pesewas NOT NULL DEFAULT 0,
  gross_pesewas              platform.pesewas NOT NULL DEFAULT 0,
  approval_threshold_pesewas platform.pesewas NULL,
  approval_request_id        uuid NULL CONSTRAINT fk_purchase_order_approval REFERENCES iam.approval_request (id) ON DELETE RESTRICT,
  sent_at                    timestamptz NULL,
  sent_by                    uuid NULL CONSTRAINT fk_purchase_order_sent_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  close_reason               text NULL CONSTRAINT ck_purchase_order_close_reason CHECK (length(btrim(close_reason)) BETWEEN 1 AND 500),
  cancel_reason              text NULL CONSTRAINT ck_purchase_order_cancel_reason CHECK (length(btrim(cancel_reason)) BETWEEN 1 AND 500),
  status                     text NOT NULL CONSTRAINT ck_purchase_order_status CHECK (status IN (
                               'DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SENT', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED', 'CANCELLED')),
  branch_id                  uuid NOT NULL CONSTRAINT fk_purchase_order_branch REFERENCES mdm.branch (id) ON DELETE RESTRICT,
  version                    integer NOT NULL DEFAULT 1,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  created_by                 uuid NOT NULL CONSTRAINT fk_purchase_order_created_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  updated_by                 uuid NOT NULL CONSTRAINT fk_purchase_order_updated_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  posted_at                  timestamptz NULL,
  posted_by                  uuid NULL CONSTRAINT fk_purchase_order_posted_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  CONSTRAINT ck_purchase_order_expected CHECK (expected_on IS NULL OR expected_on >= order_date),
  CONSTRAINT ck_purchase_order_gross CHECK (gross_pesewas = net_pesewas + tax_pesewas),
  CONSTRAINT ck_purchase_order_judged CHECK (status IN ('DRAFT', 'CANCELLED') OR approval_threshold_pesewas IS NOT NULL),
  CONSTRAINT ck_purchase_order_pending CHECK (status <> 'PENDING_APPROVAL' OR approval_request_id IS NOT NULL),
  -- FR-PUR-005: an order at or above its threshold is never approved, sent or received without a second person.
  CONSTRAINT ck_purchase_order_approved CHECK (status NOT IN ('APPROVED', 'SENT', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED')
                                               OR gross_pesewas < approval_threshold_pesewas OR approval_request_id IS NOT NULL),
  CONSTRAINT ck_purchase_order_posted CHECK ((posted_at IS NULL) = (posted_by IS NULL)
                                             AND (status IN ('DRAFT', 'PENDING_APPROVAL') OR status = 'CANCELLED' OR posted_at IS NOT NULL)),
  CONSTRAINT ck_purchase_order_sent CHECK ((sent_at IS NULL) = (sent_by IS NULL)
                                           AND (status NOT IN ('SENT', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED') OR sent_at IS NOT NULL)),
  CONSTRAINT ck_purchase_order_closed CHECK ((status = 'CLOSED') = (close_reason IS NOT NULL)),
  CONSTRAINT ck_purchase_order_cancelled CHECK ((status = 'CANCELLED') = (cancel_reason IS NOT NULL))
);
COMMENT ON TABLE pur.purchase_order IS 'class=DOCUMENT';
CREATE INDEX ix_purchase_order_branch ON pur.purchase_order (branch_id, created_at);
CREATE INDEX ix_purchase_order_supplier ON pur.purchase_order (supplier_id, status);
CREATE TRIGGER trg_purchase_order_version BEFORE UPDATE ON pur.purchase_order
  FOR EACH ROW EXECUTE FUNCTION platform.touch_version();
CREATE TRIGGER trg_purchase_order_freeze BEFORE UPDATE ON pur.purchase_order
  FOR EACH ROW EXECUTE FUNCTION platform.freeze_posted('CLOSED,CANCELLED');

CREATE TABLE pur.purchase_order_line (
  id                             uuid PRIMARY KEY,
  purchase_order_id              uuid NOT NULL CONSTRAINT fk_purchase_order_line_order REFERENCES pur.purchase_order (id) ON DELETE RESTRICT,
  line_no                        integer NOT NULL CONSTRAINT ck_purchase_order_line_no CHECK (line_no > 0),
  product_id                     uuid NOT NULL CONSTRAINT fk_purchase_order_line_product REFERENCES mdm.product (id) ON DELETE RESTRICT,
  description                    text NULL CONSTRAINT ck_purchase_order_line_description CHECK (length(btrim(description)) BETWEEN 1 AND 200),
  -- What the supplier is asked for, in the unit it is bought by (a 50 kg bag), and the same in the base unit by
  -- MDM's exact conversion (MasterDataRefs.toBaseIn, A-163).
  uom                            text NOT NULL CONSTRAINT fk_purchase_order_line_uom REFERENCES mdm.uom (code) ON DELETE RESTRICT,
  qty_ordered                    platform.qty NOT NULL CONSTRAINT ck_purchase_order_line_qty CHECK (qty_ordered > 0),
  qty_ordered_base               platform.qty NOT NULL CONSTRAINT ck_purchase_order_line_qty_base CHECK (qty_ordered_base > 0),
  unit_price_pesewas             platform.pesewas NOT NULL,
  line_net_pesewas               platform.pesewas NOT NULL,
  tax_category_id                uuid NOT NULL CONSTRAINT fk_purchase_order_line_tax_category REFERENCES mdm.tax_category (id) ON DELETE RESTRICT,
  tax_pesewas                    platform.pesewas NOT NULL DEFAULT 0,
  qty_received                   platform.qty NOT NULL DEFAULT 0 CONSTRAINT ck_purchase_order_line_received CHECK (qty_received >= 0),
  over_receipt_tolerance_percent platform.percent NOT NULL DEFAULT 0
                                   CONSTRAINT ck_purchase_order_line_tolerance_range CHECK (over_receipt_tolerance_percent BETWEEN 0 AND 100),
  expense_category               text NULL CONSTRAINT ck_purchase_order_line_expense CHECK (length(btrim(expense_category)) BETWEEN 1 AND 60),
  CONSTRAINT uq_purchase_order_line_no UNIQUE (purchase_order_id, line_no),
  -- The line anchor, rounded half-up once (ADR-0001): round() on a positive numeric rounds a half away from zero.
  CONSTRAINT ck_purchase_order_line_net CHECK (line_net_pesewas = round(qty_ordered * unit_price_pesewas)),
  -- FR-PUR-007: never more received than ordered plus the line's tolerance.
  CONSTRAINT ck_purchase_order_line_tolerance CHECK (qty_received * 100 <= qty_ordered_base * (100 + over_receipt_tolerance_percent))
);
COMMENT ON TABLE pur.purchase_order_line IS 'class=DOCUMENT';
CREATE INDEX ix_purchase_order_line_product ON pur.purchase_order_line (product_id);

CREATE FUNCTION pur.purchase_order_status_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  received numeric;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'DRAFT' THEN
      RAISE EXCEPTION 'pur.purchase_order %: an order starts DRAFT', NEW.id USING ERRCODE = 'HK004';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;
  IF NOT ((OLD.status = 'DRAFT' AND NEW.status IN ('PENDING_APPROVAL', 'APPROVED', 'CANCELLED'))
       OR (OLD.status = 'PENDING_APPROVAL' AND NEW.status IN ('APPROVED', 'DRAFT', 'CANCELLED'))
       OR (OLD.status = 'APPROVED' AND NEW.status IN ('SENT', 'CANCELLED'))
       OR (OLD.status = 'SENT' AND NEW.status IN ('PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED'))
       OR (OLD.status = 'PARTIALLY_RECEIVED' AND NEW.status IN ('RECEIVED', 'CLOSED'))
       OR (OLD.status = 'RECEIVED' AND NEW.status = 'CLOSED')) THEN
    RAISE EXCEPTION 'pur.purchase_order %: % cannot become %', OLD.id, OLD.status, NEW.status USING ERRCODE = 'HK004';
  END IF;
  IF NEW.status = 'CANCELLED' THEN
    SELECT COALESCE(sum(l.qty_received), 0) INTO received FROM pur.purchase_order_line l WHERE l.purchase_order_id = NEW.id;
    IF received > 0 THEN
      RAISE EXCEPTION 'pur.purchase_order %: goods were received against it, so it can be closed but not cancelled', OLD.id
        USING ERRCODE = 'HK004', CONSTRAINT = 'ck_purchase_order_cancel_unreceived';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION pur.purchase_order_status_guard() FROM PUBLIC;
CREATE TRIGGER trg_purchase_order_status BEFORE INSERT OR UPDATE ON pur.purchase_order
  FOR EACH ROW EXECUTE FUNCTION pur.purchase_order_status_guard();

-- Lines change only while their order is DRAFT. Afterwards only qty_received changes, and only while the order is
-- SENT, PARTIALLY_RECEIVED or RECEIVED (a receipt within the line's tolerance after the order is fully received). HK004.
CREATE FUNCTION pur.purchase_order_line_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  order_status text;
  order_id uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.purchase_order_id ELSE NEW.purchase_order_id END;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.purchase_order_id <> OLD.purchase_order_id THEN
    order_id := NULL;
  END IF;
  SELECT o.status INTO order_status FROM pur.purchase_order o WHERE o.id = order_id;
  IF order_status = 'DRAFT' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_OP = 'UPDATE' AND order_status IN ('SENT', 'PARTIALLY_RECEIVED', 'RECEIVED')
     AND (to_jsonb(NEW) - 'qty_received') = (to_jsonb(OLD) - 'qty_received') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'pur.purchase_order_line is frozen with its order (status %)', order_status USING ERRCODE = 'HK004';
END
$$;
REVOKE ALL ON FUNCTION pur.purchase_order_line_guard() FROM PUBLIC;
CREATE TRIGGER trg_purchase_order_line_guard BEFORE INSERT OR UPDATE OR DELETE ON pur.purchase_order_line
  FOR EACH ROW EXECUTE FUNCTION pur.purchase_order_line_guard();

-- At commit, an order's totals are the sums of its lines, whoever wrote them.
CREATE FUNCTION pur.purchase_order_totals() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  row_data jsonb := to_jsonb(CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END);
  order_id uuid := (CASE WHEN TG_TABLE_NAME = 'purchase_order' THEN row_data ->> 'id' ELSE row_data ->> 'purchase_order_id' END)::uuid;
  header pur.purchase_order;
  lines_net numeric;
  lines_tax numeric;
BEGIN
  SELECT * INTO header FROM pur.purchase_order o WHERE o.id = order_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  SELECT COALESCE(sum(l.line_net_pesewas), 0), COALESCE(sum(l.tax_pesewas), 0) INTO lines_net, lines_tax
    FROM pur.purchase_order_line l WHERE l.purchase_order_id = order_id;
  IF header.net_pesewas <> lines_net OR header.tax_pesewas <> lines_tax THEN
    RAISE EXCEPTION 'pur.purchase_order %: net % and tax % must be the sums of the lines, % and %', order_id, header.net_pesewas, header.tax_pesewas, lines_net, lines_tax
      USING ERRCODE = 'HK010', CONSTRAINT = 'ck_purchase_order_totals';
  END IF;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION pur.purchase_order_totals() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER trg_purchase_order_totals AFTER INSERT OR UPDATE ON pur.purchase_order
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION pur.purchase_order_totals();
CREATE CONSTRAINT TRIGGER trg_purchase_order_line_totals AFTER INSERT OR UPDATE OR DELETE ON pur.purchase_order_line
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION pur.purchase_order_totals();

CREATE TABLE pur.supplier_invoice (
  id                    uuid PRIMARY KEY CONSTRAINT fk_supplier_invoice_document REFERENCES platform.business_document (id) ON DELETE RESTRICT,
  kind                  text NOT NULL CONSTRAINT ck_supplier_invoice_kind CHECK (kind IN ('INVOICE', 'CREDIT_NOTE')),
  supplier_id           uuid NOT NULL CONSTRAINT fk_supplier_invoice_supplier REFERENCES mdm.supplier (id) ON DELETE RESTRICT,
  supplier_invoice_no   text NOT NULL CONSTRAINT ck_supplier_invoice_no CHECK (supplier_invoice_no = btrim(supplier_invoice_no) AND length(supplier_invoice_no) BETWEEN 1 AND 60),
  invoice_date          date NOT NULL,
  due_date              date NOT NULL,
  purchase_order_id     uuid NULL CONSTRAINT fk_supplier_invoice_order REFERENCES pur.purchase_order (id) ON DELETE RESTRICT,
  original_invoice_id   uuid NULL CONSTRAINT fk_supplier_invoice_original REFERENCES pur.supplier_invoice (id) ON DELETE RESTRICT,
  currency              char(3) NOT NULL DEFAULT 'GHS' CONSTRAINT ck_supplier_invoice_currency CHECK (currency = 'GHS'),
  net_pesewas           platform.pesewas NOT NULL DEFAULT 0,
  tax_pesewas           platform.pesewas NOT NULL DEFAULT 0,
  gross_pesewas         platform.pesewas NOT NULL DEFAULT 0,
  -- The total printed on the supplier's document, when the accountant keys it: the lines must add up to it.
  stated_gross_pesewas  platform.pesewas NULL,
  paid_pesewas          platform.pesewas NOT NULL DEFAULT 0,
  match_status          text NOT NULL DEFAULT 'UNMATCHED' CONSTRAINT ck_supplier_invoice_match_status CHECK (match_status IN ('UNMATCHED', 'MATCHED', 'MISMATCH', 'NOT_REQUIRED')),
  matched_at            timestamptz NULL,
  file_id               uuid NULL CONSTRAINT fk_supplier_invoice_file REFERENCES platform.stored_file (id) ON DELETE RESTRICT,
  tax_scheme_version_id uuid NOT NULL CONSTRAINT fk_supplier_invoice_tax_scheme REFERENCES mdm.tax_scheme_version (id) ON DELETE RESTRICT,
  cancel_reason         text NULL CONSTRAINT ck_supplier_invoice_cancel_reason CHECK (length(btrim(cancel_reason)) BETWEEN 1 AND 500),
  status                text NOT NULL CONSTRAINT ck_supplier_invoice_status CHECK (status IN ('DRAFT', 'MATCHED', 'MISMATCH', 'APPROVED', 'PAID', 'CANCELLED')),
  branch_id             uuid NOT NULL CONSTRAINT fk_supplier_invoice_branch REFERENCES mdm.branch (id) ON DELETE RESTRICT,
  version               integer NOT NULL DEFAULT 1,
  created_at            timestamptz NOT NULL DEFAULT now(),
  created_by            uuid NOT NULL CONSTRAINT fk_supplier_invoice_created_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  updated_at            timestamptz NOT NULL DEFAULT now(),
  updated_by            uuid NOT NULL CONSTRAINT fk_supplier_invoice_updated_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  posted_at             timestamptz NULL,
  posted_by             uuid NULL CONSTRAINT fk_supplier_invoice_posted_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  CONSTRAINT ck_supplier_invoice_due CHECK (due_date >= invoice_date),
  CONSTRAINT ck_supplier_invoice_gross CHECK (gross_pesewas = net_pesewas + tax_pesewas),
  CONSTRAINT ck_supplier_invoice_stated CHECK (stated_gross_pesewas IS NULL OR stated_gross_pesewas = gross_pesewas),
  CONSTRAINT ck_supplier_invoice_paid CHECK (paid_pesewas <= gross_pesewas AND (status = 'PAID') = (paid_pesewas = gross_pesewas AND gross_pesewas > 0 AND status <> 'CANCELLED')),
  CONSTRAINT ck_supplier_invoice_credit CHECK ((kind = 'CREDIT_NOTE') = (original_invoice_id IS NOT NULL)),
  CONSTRAINT ck_supplier_invoice_unmatched CHECK ((status = 'DRAFT') = (match_status = 'UNMATCHED' AND status <> 'CANCELLED') OR status = 'CANCELLED'),
  CONSTRAINT ck_supplier_invoice_mismatch CHECK ((status = 'MISMATCH') = (match_status = 'MISMATCH') OR status = 'CANCELLED'),
  -- FR-PUR-010: only a matched invoice, or one that needs no match, is approved and paid.
  CONSTRAINT ck_supplier_invoice_payable CHECK (status NOT IN ('MATCHED', 'APPROVED', 'PAID') OR match_status IN ('MATCHED', 'NOT_REQUIRED')),
  CONSTRAINT ck_supplier_invoice_matched_at CHECK ((match_status = 'UNMATCHED') = (matched_at IS NULL)),
  CONSTRAINT ck_supplier_invoice_posted CHECK ((posted_at IS NULL) = (posted_by IS NULL) AND (status NOT IN ('APPROVED', 'PAID') OR posted_at IS NOT NULL)),
  CONSTRAINT ck_supplier_invoice_cancelled CHECK ((status = 'CANCELLED') = (cancel_reason IS NOT NULL))
);
COMMENT ON TABLE pur.supplier_invoice IS 'class=DOCUMENT';
-- FR-PUR-008: one supplier's invoice number is entered once; a cancelled entry does not block entering it again.
CREATE UNIQUE INDEX uq_supplier_invoice_no ON pur.supplier_invoice (supplier_id, supplier_invoice_no) WHERE status <> 'CANCELLED';
CREATE INDEX ix_supplier_invoice_branch ON pur.supplier_invoice (branch_id, created_at);
CREATE INDEX ix_supplier_invoice_order ON pur.supplier_invoice (purchase_order_id) WHERE purchase_order_id IS NOT NULL;
CREATE TRIGGER trg_supplier_invoice_version BEFORE UPDATE ON pur.supplier_invoice
  FOR EACH ROW EXECUTE FUNCTION platform.touch_version();
CREATE TRIGGER trg_supplier_invoice_freeze BEFORE UPDATE ON pur.supplier_invoice
  FOR EACH ROW EXECUTE FUNCTION platform.freeze_posted('PAID,CANCELLED');
-- An approved invoice changes only by being paid or cancelled.
CREATE TRIGGER trg_supplier_invoice_freeze_approved BEFORE UPDATE ON pur.supplier_invoice
  FOR EACH ROW EXECUTE FUNCTION platform.freeze_posted('APPROVED', 'paid_pesewas', 'status', 'cancel_reason', 'version', 'updated_at', 'updated_by');

CREATE TABLE pur.supplier_invoice_line (
  id                       uuid PRIMARY KEY,
  supplier_invoice_id      uuid NOT NULL CONSTRAINT fk_supplier_invoice_line_invoice REFERENCES pur.supplier_invoice (id) ON DELETE RESTRICT,
  line_no                  integer NOT NULL CONSTRAINT ck_supplier_invoice_line_no CHECK (line_no > 0),
  product_id               uuid NULL CONSTRAINT fk_supplier_invoice_line_product REFERENCES mdm.product (id) ON DELETE RESTRICT,
  description              text NOT NULL CONSTRAINT ck_supplier_invoice_line_description CHECK (length(btrim(description)) BETWEEN 1 AND 200),
  purchase_order_line_id   uuid NULL CONSTRAINT fk_supplier_invoice_line_order_line REFERENCES pur.purchase_order_line (id) ON DELETE RESTRICT,
  goods_receipt_line_id    uuid NULL CONSTRAINT fk_supplier_invoice_line_receipt_line REFERENCES inv.goods_receipt_line (id) ON DELETE RESTRICT,
  -- The unit the supplier charges by: its order line's, else the product's base unit; none for a pure expense line.
  uom                      text NULL CONSTRAINT fk_supplier_invoice_line_uom REFERENCES mdm.uom (code) ON DELETE RESTRICT,
  qty                      platform.qty NOT NULL CONSTRAINT ck_supplier_invoice_line_qty CHECK (qty > 0),
  qty_base                 platform.qty NULL CONSTRAINT ck_supplier_invoice_line_qty_base CHECK (qty_base > 0),
  unit_price_pesewas       platform.pesewas NOT NULL,
  line_net_pesewas         platform.pesewas NOT NULL,
  tax_category_id          uuid NOT NULL CONSTRAINT fk_supplier_invoice_line_tax_category REFERENCES mdm.tax_category (id) ON DELETE RESTRICT,
  expense_category         text NULL CONSTRAINT ck_supplier_invoice_line_expense CHECK (length(btrim(expense_category)) BETWEEN 1 AND 60),
  qty_variance             numeric(14,3) NULL,
  price_variance_pesewas   platform.pesewas NULL,
  price_variance_direction text NULL CONSTRAINT ck_supplier_invoice_line_direction CHECK (price_variance_direction IN ('OVER', 'UNDER')),
  match_status             text NOT NULL DEFAULT 'UNMATCHED' CONSTRAINT ck_supplier_invoice_line_match_status CHECK (match_status IN ('UNMATCHED', 'MATCHED', 'MISMATCH', 'NOT_REQUIRED')),
  match_reasons            text[] NOT NULL DEFAULT '{}',
  CONSTRAINT uq_supplier_invoice_line_no UNIQUE (supplier_invoice_id, line_no),
  CONSTRAINT ck_supplier_invoice_line_net CHECK (line_net_pesewas = round(qty * unit_price_pesewas)),
  CONSTRAINT ck_supplier_invoice_line_product_uom CHECK ((product_id IS NULL) = (uom IS NULL) AND (product_id IS NULL) = (qty_base IS NULL)),
  CONSTRAINT ck_supplier_invoice_line_order_product CHECK (purchase_order_line_id IS NULL OR product_id IS NOT NULL),
  CONSTRAINT ck_supplier_invoice_line_variance CHECK ((price_variance_pesewas IS NULL OR price_variance_pesewas = 0) = (price_variance_direction IS NULL)),
  CONSTRAINT ck_supplier_invoice_line_reasons CHECK ((match_status = 'MISMATCH') = (cardinality(match_reasons) > 0))
);
COMMENT ON TABLE pur.supplier_invoice_line IS 'class=DOCUMENT';
CREATE INDEX ix_supplier_invoice_line_order_line ON pur.supplier_invoice_line (purchase_order_line_id) WHERE purchase_order_line_id IS NOT NULL;

-- Levy rows (ADR-0020), snapshots: what the supplier charged and what the calculator makes of the line.
CREATE TABLE pur.supplier_invoice_line_tax (
  supplier_invoice_line_id  uuid NOT NULL CONSTRAINT fk_supplier_invoice_line_tax_line REFERENCES pur.supplier_invoice_line (id) ON DELETE RESTRICT,
  levy_id                   uuid NOT NULL CONSTRAINT fk_supplier_invoice_line_tax_levy REFERENCES mdm.tax_levy (id) ON DELETE RESTRICT,
  levy_code                 text NOT NULL,
  levy_name                 text NOT NULL,
  treatment                 text NOT NULL CONSTRAINT ck_supplier_invoice_line_tax_treatment CHECK (treatment IN ('STANDARD', 'ZERO_RATED', 'EXEMPT', 'OUT_OF_SCOPE')),
  rate_percent              platform.percent NOT NULL,
  base_pesewas              platform.pesewas NOT NULL,
  amount_pesewas            platform.pesewas NOT NULL,
  calculated_amount_pesewas platform.pesewas NOT NULL,
  is_reclaimable            boolean NOT NULL,
  calc_order                integer NOT NULL,
  CONSTRAINT pk_supplier_invoice_line_tax PRIMARY KEY (supplier_invoice_line_id, levy_id)
);
COMMENT ON TABLE pur.supplier_invoice_line_tax IS 'class=DOCUMENT';

-- Lines and levy rows change only while the invoice is DRAFT; matching writes the result columns of a line while the
-- invoice is DRAFT, MATCHED or MISMATCH. HK004.
CREATE FUNCTION pur.supplier_invoice_part_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  invoice_status text;
  invoice_id uuid;
  row_data jsonb := to_jsonb(CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END);
BEGIN
  IF TG_TABLE_NAME = 'supplier_invoice_line' THEN
    invoice_id := (row_data ->> 'supplier_invoice_id')::uuid;
  ELSE
    SELECT l.supplier_invoice_id INTO invoice_id FROM pur.supplier_invoice_line l WHERE l.id = (row_data ->> 'supplier_invoice_line_id')::uuid;
  END IF;
  IF TG_OP = 'UPDATE' AND (to_jsonb(NEW) ->> 'id') IS DISTINCT FROM (to_jsonb(OLD) ->> 'id') THEN
    invoice_id := NULL;
  END IF;
  SELECT i.status INTO invoice_status FROM pur.supplier_invoice i WHERE i.id = invoice_id;
  IF invoice_status = 'DRAFT' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_TABLE_NAME = 'supplier_invoice_line' AND TG_OP = 'UPDATE' AND invoice_status IN ('MATCHED', 'MISMATCH')
     AND (to_jsonb(NEW) - ARRAY['qty_variance', 'price_variance_pesewas', 'price_variance_direction', 'match_status', 'match_reasons'])
       = (to_jsonb(OLD) - ARRAY['qty_variance', 'price_variance_pesewas', 'price_variance_direction', 'match_status', 'match_reasons']) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '%.% is frozen with its invoice (status %)', TG_TABLE_SCHEMA, TG_TABLE_NAME, invoice_status USING ERRCODE = 'HK004';
END
$$;
REVOKE ALL ON FUNCTION pur.supplier_invoice_part_guard() FROM PUBLIC;
CREATE TRIGGER trg_supplier_invoice_line_guard BEFORE INSERT OR UPDATE OR DELETE ON pur.supplier_invoice_line
  FOR EACH ROW EXECUTE FUNCTION pur.supplier_invoice_part_guard();
CREATE TRIGGER trg_supplier_invoice_line_tax_guard BEFORE INSERT OR UPDATE OR DELETE ON pur.supplier_invoice_line_tax
  FOR EACH ROW EXECUTE FUNCTION pur.supplier_invoice_part_guard();

CREATE TABLE pur.supplier_payment (
  id                  uuid PRIMARY KEY CONSTRAINT fk_supplier_payment_document REFERENCES platform.business_document (id) ON DELETE RESTRICT,
  payment_no          text NULL CONSTRAINT uq_supplier_payment_no UNIQUE,
  supplier_id         uuid NOT NULL CONSTRAINT fk_supplier_payment_supplier REFERENCES mdm.supplier (id) ON DELETE RESTRICT,
  method              text NOT NULL CONSTRAINT ck_supplier_payment_method CHECK (method IN ('BANK', 'MOBILE_MONEY', 'CASH', 'CHEQUE')),
  amount_pesewas      platform.pesewas NOT NULL CONSTRAINT ck_supplier_payment_amount CHECK (amount_pesewas > 0),
  currency            char(3) NOT NULL DEFAULT 'GHS' CONSTRAINT ck_supplier_payment_currency CHECK (currency = 'GHS'),
  scheduled_for       date NULL,
  paid_at             timestamptz NULL,
  external_reference  text NULL CONSTRAINT ck_supplier_payment_reference CHECK (external_reference = btrim(external_reference) AND length(external_reference) BETWEEN 1 AND 80),
  approval_request_id uuid NULL CONSTRAINT fk_supplier_payment_approval REFERENCES iam.approval_request (id) ON DELETE RESTRICT,
  cancel_reason       text NULL CONSTRAINT ck_supplier_payment_cancel_reason CHECK (length(btrim(cancel_reason)) BETWEEN 1 AND 500),
  status              text NOT NULL CONSTRAINT ck_supplier_payment_status CHECK (status IN ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'PAID', 'REJECTED', 'CANCELLED')),
  branch_id           uuid NOT NULL CONSTRAINT fk_supplier_payment_branch REFERENCES mdm.branch (id) ON DELETE RESTRICT,
  version             integer NOT NULL DEFAULT 1,
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid NOT NULL CONSTRAINT fk_supplier_payment_created_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  updated_by          uuid NOT NULL CONSTRAINT fk_supplier_payment_updated_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  posted_at           timestamptz NULL,
  posted_by           uuid NULL CONSTRAINT fk_supplier_payment_posted_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  -- FR-PUR-012: a payment is paid only once a different person approved it, with the time and the bank or wallet reference.
  CONSTRAINT ck_supplier_payment_paid CHECK ((status = 'PAID') = (paid_at IS NOT NULL) AND (paid_at IS NULL) = (external_reference IS NULL)
                                             AND (paid_at IS NULL) = (posted_at IS NULL) AND (posted_at IS NULL) = (posted_by IS NULL)),
  CONSTRAINT ck_supplier_payment_approval CHECK (status IN ('DRAFT', 'CANCELLED') OR approval_request_id IS NOT NULL),
  CONSTRAINT ck_supplier_payment_cancelled CHECK ((status = 'CANCELLED') = (cancel_reason IS NOT NULL))
);
COMMENT ON TABLE pur.supplier_payment IS 'class=DOCUMENT';
-- A bank or mobile money reference is recorded once: a replayed confirmation collides rather than paying twice.
CREATE UNIQUE INDEX uq_supplier_payment_reference ON pur.supplier_payment (method, external_reference) WHERE external_reference IS NOT NULL;
CREATE INDEX ix_supplier_payment_branch ON pur.supplier_payment (branch_id, created_at);
CREATE TRIGGER trg_supplier_payment_version BEFORE UPDATE ON pur.supplier_payment
  FOR EACH ROW EXECUTE FUNCTION platform.touch_version();
CREATE TRIGGER trg_supplier_payment_freeze BEFORE UPDATE ON pur.supplier_payment
  FOR EACH ROW EXECUTE FUNCTION platform.freeze_posted('PAID,REJECTED,CANCELLED');

CREATE TABLE pur.supplier_payment_allocation (
  id                  uuid PRIMARY KEY,
  supplier_payment_id uuid NOT NULL CONSTRAINT fk_supplier_payment_allocation_payment REFERENCES pur.supplier_payment (id) ON DELETE RESTRICT,
  supplier_invoice_id uuid NOT NULL CONSTRAINT fk_supplier_payment_allocation_invoice REFERENCES pur.supplier_invoice (id) ON DELETE RESTRICT,
  amount_pesewas      platform.pesewas NOT NULL CONSTRAINT ck_supplier_payment_allocation_amount CHECK (amount_pesewas > 0),
  recorded_at         timestamptz NOT NULL DEFAULT now(),
  actor_id            uuid NOT NULL CONSTRAINT fk_supplier_payment_allocation_actor REFERENCES iam.principal (id) ON DELETE RESTRICT,
  CONSTRAINT uq_supplier_payment_allocation UNIQUE (supplier_payment_id, supplier_invoice_id)
);
COMMENT ON TABLE pur.supplier_payment_allocation IS 'class=LEDGER';
CREATE INDEX ix_supplier_payment_allocation_invoice ON pur.supplier_payment_allocation (supplier_invoice_id);
CREATE TRIGGER trg_supplier_payment_allocation_immutable BEFORE UPDATE OR DELETE ON pur.supplier_payment_allocation
  FOR EACH ROW EXECUTE FUNCTION platform.reject_change();
CREATE TRIGGER trg_supplier_payment_allocation_no_truncate BEFORE TRUNCATE ON pur.supplier_payment_allocation
  FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_change();

-- FR-PUR-010 and FR-PUR-012 in the database: the three-way match blocks payment, and no invoice is promised more than
-- its gross across the payments still alive (not REJECTED or CANCELLED). The invoice row is locked, so two payments
-- racing for one invoice queue behind each other. HK010.
CREATE FUNCTION pur.supplier_payment_allocation_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  payment pur.supplier_payment;
  invoice pur.supplier_invoice;
  promised numeric;
BEGIN
  SELECT * INTO payment FROM pur.supplier_payment p WHERE p.id = NEW.supplier_payment_id;
  SELECT * INTO invoice FROM pur.supplier_invoice i WHERE i.id = NEW.supplier_invoice_id FOR UPDATE;
  IF payment.status <> 'DRAFT' THEN
    RAISE EXCEPTION 'pur.supplier_payment %: allocations are made while it is DRAFT, not %', payment.id, payment.status
      USING ERRCODE = 'HK010', CONSTRAINT = 'ck_supplier_payment_allocation_draft';
  END IF;
  IF invoice.supplier_id <> payment.supplier_id OR invoice.kind <> 'INVOICE' THEN
    RAISE EXCEPTION 'pur.supplier_invoice %: not an invoice of the supplier the payment is for', invoice.id
      USING ERRCODE = 'HK010', CONSTRAINT = 'ck_supplier_payment_allocation_supplier';
  END IF;
  IF invoice.status <> 'APPROVED' OR invoice.match_status NOT IN ('MATCHED', 'NOT_REQUIRED') THEN
    RAISE EXCEPTION 'pur.supplier_invoice %: % with match %, so it cannot be paid', invoice.id, invoice.status, invoice.match_status
      USING ERRCODE = 'HK010', CONSTRAINT = 'ck_supplier_payment_allocation_matched';
  END IF;
  SELECT COALESCE(sum(a.amount_pesewas), 0) INTO promised
    FROM pur.supplier_payment_allocation a JOIN pur.supplier_payment p ON p.id = a.supplier_payment_id
   WHERE a.supplier_invoice_id = invoice.id AND p.status NOT IN ('REJECTED', 'CANCELLED');
  IF promised + NEW.amount_pesewas > invoice.gross_pesewas THEN
    RAISE EXCEPTION 'pur.supplier_invoice %: % already allocated, % more would exceed the gross %', invoice.id, promised, NEW.amount_pesewas, invoice.gross_pesewas
      USING ERRCODE = 'HK010', CONSTRAINT = 'ck_supplier_payment_allocation_outstanding';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION pur.supplier_payment_allocation_guard() FROM PUBLIC;
CREATE TRIGGER trg_supplier_payment_allocation_guard BEFORE INSERT ON pur.supplier_payment_allocation
  FOR EACH ROW EXECUTE FUNCTION pur.supplier_payment_allocation_guard();

CREATE FUNCTION pur.supplier_payment_status_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'DRAFT' THEN
      RAISE EXCEPTION 'pur.supplier_payment %: a payment starts DRAFT', NEW.id USING ERRCODE = 'HK004';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'DRAFT' AND NEW.status IN ('PENDING_APPROVAL', 'CANCELLED'))
    OR (OLD.status = 'PENDING_APPROVAL' AND NEW.status IN ('APPROVED', 'REJECTED', 'CANCELLED'))
    OR (OLD.status = 'APPROVED' AND NEW.status IN ('PAID', 'CANCELLED'))) THEN
    RAISE EXCEPTION 'pur.supplier_payment %: % cannot become %', OLD.id, OLD.status, NEW.status USING ERRCODE = 'HK004';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION pur.supplier_payment_status_guard() FROM PUBLIC;
CREATE TRIGGER trg_supplier_payment_status BEFORE INSERT OR UPDATE ON pur.supplier_payment
  FOR EACH ROW EXECUTE FUNCTION pur.supplier_payment_status_guard();

-- When a payment is paid, each invoice it allocates to carries the amount in paid_pesewas, and is PAID once settled.
CREATE FUNCTION pur.supplier_payment_settle() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  UPDATE pur.supplier_invoice i
     SET version = i.version + 1,
         paid_pesewas = i.paid_pesewas + a.amount_pesewas,
         status = CASE WHEN i.paid_pesewas + a.amount_pesewas = i.gross_pesewas THEN 'PAID' ELSE i.status END,
         updated_at = NEW.updated_at,
         updated_by = NEW.updated_by
    FROM pur.supplier_payment_allocation a
   WHERE a.supplier_payment_id = NEW.id AND i.id = a.supplier_invoice_id;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION pur.supplier_payment_settle() FROM PUBLIC;
CREATE TRIGGER trg_supplier_payment_settle AFTER UPDATE OF status ON pur.supplier_payment
  FOR EACH ROW WHEN (NEW.status = 'PAID' AND OLD.status <> 'PAID') EXECUTE FUNCTION pur.supplier_payment_settle();

-- An invoice cancelled after approval must hold no allocation of a payment still alive.
CREATE FUNCTION pur.supplier_invoice_status_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  live integer;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'DRAFT' THEN
      RAISE EXCEPTION 'pur.supplier_invoice %: an invoice starts DRAFT', NEW.id USING ERRCODE = 'HK004';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;
  IF NOT ((OLD.status = 'DRAFT' AND NEW.status IN ('MATCHED', 'MISMATCH', 'CANCELLED'))
       OR (OLD.status IN ('MATCHED', 'MISMATCH') AND NEW.status IN ('DRAFT', 'MATCHED', 'MISMATCH', 'CANCELLED'))
       OR (OLD.status = 'MATCHED' AND NEW.status = 'APPROVED')
       OR (OLD.status = 'APPROVED' AND NEW.status IN ('PAID', 'CANCELLED'))) THEN
    RAISE EXCEPTION 'pur.supplier_invoice %: % cannot become %', OLD.id, OLD.status, NEW.status USING ERRCODE = 'HK004';
  END IF;
  IF NEW.status = 'CANCELLED' THEN
    SELECT count(*) INTO live
      FROM pur.supplier_payment_allocation a JOIN pur.supplier_payment p ON p.id = a.supplier_payment_id
     WHERE a.supplier_invoice_id = OLD.id AND p.status NOT IN ('REJECTED', 'CANCELLED');
    IF live > 0 THEN
      RAISE EXCEPTION 'pur.supplier_invoice %: a payment is allocated to it', OLD.id USING ERRCODE = 'HK004', CONSTRAINT = 'ck_supplier_invoice_cancel_unpaid';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION pur.supplier_invoice_status_guard() FROM PUBLIC;
CREATE TRIGGER trg_supplier_invoice_status BEFORE INSERT OR UPDATE ON pur.supplier_invoice
  FOR EACH ROW EXECUTE FUNCTION pur.supplier_invoice_status_guard();

-- At commit: an invoice's totals are the sums of its lines and levy rows, and paid is what PAID payments allocated.
CREATE FUNCTION pur.supplier_invoice_totals() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  invoice_id uuid;
  header pur.supplier_invoice;
  lines_net numeric;
  lines_tax numeric;
  paid numeric;
  row_data jsonb := to_jsonb(CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END);
BEGIN
  IF TG_TABLE_NAME = 'supplier_invoice' THEN
    invoice_id := (row_data ->> 'id')::uuid;
  ELSIF TG_TABLE_NAME = 'supplier_invoice_line' THEN
    invoice_id := (row_data ->> 'supplier_invoice_id')::uuid;
  ELSE
    SELECT l.supplier_invoice_id INTO invoice_id FROM pur.supplier_invoice_line l WHERE l.id = (row_data ->> 'supplier_invoice_line_id')::uuid;
  END IF;
  SELECT * INTO header FROM pur.supplier_invoice i WHERE i.id = invoice_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  SELECT COALESCE(sum(l.line_net_pesewas), 0) INTO lines_net FROM pur.supplier_invoice_line l WHERE l.supplier_invoice_id = invoice_id;
  SELECT COALESCE(sum(t.amount_pesewas), 0) INTO lines_tax
    FROM pur.supplier_invoice_line_tax t JOIN pur.supplier_invoice_line l ON l.id = t.supplier_invoice_line_id WHERE l.supplier_invoice_id = invoice_id;
  SELECT COALESCE(sum(a.amount_pesewas), 0) INTO paid
    FROM pur.supplier_payment_allocation a JOIN pur.supplier_payment p ON p.id = a.supplier_payment_id
   WHERE a.supplier_invoice_id = invoice_id AND p.status = 'PAID';
  IF header.net_pesewas <> lines_net OR header.tax_pesewas <> lines_tax OR header.paid_pesewas <> paid THEN
    RAISE EXCEPTION 'pur.supplier_invoice %: net %, tax % and paid % must be %, % and % from its lines, levies and paid allocations',
      invoice_id, header.net_pesewas, header.tax_pesewas, header.paid_pesewas, lines_net, lines_tax, paid
      USING ERRCODE = 'HK010', CONSTRAINT = 'ck_supplier_invoice_totals';
  END IF;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION pur.supplier_invoice_totals() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER trg_supplier_invoice_totals AFTER INSERT OR UPDATE ON pur.supplier_invoice
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION pur.supplier_invoice_totals();
CREATE CONSTRAINT TRIGGER trg_supplier_invoice_line_totals AFTER INSERT OR UPDATE OR DELETE ON pur.supplier_invoice_line
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION pur.supplier_invoice_totals();
CREATE CONSTRAINT TRIGGER trg_supplier_invoice_line_tax_totals AFTER INSERT OR UPDATE OR DELETE ON pur.supplier_invoice_line_tax
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION pur.supplier_invoice_totals();

-- At commit: a payment's amount is the sum of its allocations.
CREATE FUNCTION pur.supplier_payment_allocated() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  payment_id uuid := (CASE WHEN TG_TABLE_NAME = 'supplier_payment' THEN to_jsonb(NEW) ->> 'id' ELSE to_jsonb(NEW) ->> 'supplier_payment_id' END)::uuid;
  amount numeric;
  allocated numeric;
BEGIN
  SELECT p.amount_pesewas INTO amount FROM pur.supplier_payment p WHERE p.id = payment_id;
  SELECT COALESCE(sum(a.amount_pesewas), 0) INTO allocated FROM pur.supplier_payment_allocation a WHERE a.supplier_payment_id = payment_id;
  IF amount <> allocated THEN
    RAISE EXCEPTION 'pur.supplier_payment %: amount % must be the sum of its allocations, %', payment_id, amount, allocated
      USING ERRCODE = 'HK010', CONSTRAINT = 'ck_supplier_payment_allocated';
  END IF;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION pur.supplier_payment_allocated() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER trg_supplier_payment_allocated AFTER INSERT OR UPDATE ON pur.supplier_payment
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION pur.supplier_payment_allocated();
CREATE CONSTRAINT TRIGGER trg_supplier_payment_allocation_allocated AFTER INSERT ON pur.supplier_payment_allocation
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION pur.supplier_payment_allocated();

-- updatePurchaseOrder and updateSupplierInvoice replace the lines outright. hk_app holds no DELETE on a DOCUMENT table
-- (ADR-0024), so each removal is one function, which the guards above limit to a document that may still change.
CREATE FUNCTION pur.clear_purchase_order_lines(p_order_id uuid) RETURNS integer
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
DECLARE
  removed integer;
BEGIN
  DELETE FROM pur.purchase_order_line WHERE purchase_order_id = p_order_id;
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END
$$;
REVOKE ALL ON FUNCTION pur.clear_purchase_order_lines(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pur.clear_purchase_order_lines(uuid) TO hk_app, hk_worker;

CREATE FUNCTION pur.clear_supplier_invoice_lines(p_invoice_id uuid) RETURNS integer
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
DECLARE
  removed integer;
BEGIN
  DELETE FROM pur.supplier_invoice_line_tax t USING pur.supplier_invoice_line l
   WHERE l.id = t.supplier_invoice_line_id AND l.supplier_invoice_id = p_invoice_id;
  DELETE FROM pur.supplier_invoice_line WHERE supplier_invoice_id = p_invoice_id;
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END
$$;
REVOKE ALL ON FUNCTION pur.clear_supplier_invoice_lines(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pur.clear_supplier_invoice_lines(uuid) TO hk_app, hk_worker;

REVOKE ALL ON pur.purchase_order, pur.purchase_order_line, pur.supplier_invoice, pur.supplier_invoice_line, pur.supplier_invoice_line_tax,
  pur.supplier_payment, pur.supplier_payment_allocation FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON pur.purchase_order, pur.purchase_order_line, pur.supplier_invoice, pur.supplier_invoice_line,
  pur.supplier_invoice_line_tax, pur.supplier_payment TO hk_app, hk_worker;
GRANT SELECT, INSERT ON pur.supplier_payment_allocation TO hk_app, hk_worker;

-- migrate:down
DROP FUNCTION pur.clear_supplier_invoice_lines(uuid);
DROP FUNCTION pur.clear_purchase_order_lines(uuid);
DROP TABLE pur.supplier_payment_allocation;
DROP TABLE pur.supplier_payment;
DROP TABLE pur.supplier_invoice_line_tax;
DROP TABLE pur.supplier_invoice_line;
DROP TABLE pur.supplier_invoice;
DROP TABLE pur.purchase_order_line;
DROP TABLE pur.purchase_order;
DROP FUNCTION pur.supplier_payment_allocated();
DROP FUNCTION pur.supplier_invoice_totals();
DROP FUNCTION pur.supplier_invoice_status_guard();
DROP FUNCTION pur.supplier_payment_settle();
DROP FUNCTION pur.supplier_payment_status_guard();
DROP FUNCTION pur.supplier_payment_allocation_guard();
DROP FUNCTION pur.supplier_invoice_part_guard();
DROP FUNCTION pur.purchase_order_totals();
DROP FUNCTION pur.purchase_order_line_guard();
DROP FUNCTION pur.purchase_order_status_guard();
DROP SCHEMA pur;
