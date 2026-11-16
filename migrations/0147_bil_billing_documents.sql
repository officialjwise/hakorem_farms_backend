-- 0147_bil_billing_documents
-- B08 continued 2 (FR-BIL-001, FR-BIL-002, FR-BIL-004, FR-BIL-006, FR-BIL-007, FR-BIL-011, FR-BIL-012, ADR-0001,
-- ADR-0015, ADR-0020, A-200): schema `bil` with its billing documents, their lines and one levy row per line and levy,
-- and the settlement summary each document shows. The database holds:
--   ck_billing_document_status        a document is written DRAFT and becomes ISSUED once; it never goes back
--   ck_billing_document_frozen        an ISSUED document never changes, except its credited amount (from its credit
--                                     notes), its content hash (set once, by DOC) and its certified totals (FR-BIL-012)
--   ck_billing_document_line_frozen   a line or levy row is written, changed or removed only while its document is DRAFT
--   ck_billing_document_totals        at commit, an ISSUED document's net, tax and gross are the sums of its lines, each
--                                     line's tax is the sum of its levy rows, and it has at least one line
--   ck_billing_document_number        at commit, an ISSUED document's number is the one platform.allocate_number gave it
--   ck_billing_document_original      a credit or debit note corrects an ISSUED invoice or receipt of the same branch
--                                     and customer
--   ck_billing_document_credit_cap    credit notes never exceed the original's gross (credited <= gross), and at commit
--                                     the credited amount is exactly the sum of its ISSUED credit notes
-- `bil.document_settlement` (PROJECTION) is written only by the SECURITY DEFINER trigger below: allocated stays 0
-- until PAY's subscribers arrive in B9a. Published: `bil.pub_document` (issued documents with their due date and
-- outstanding amount, no names or addresses) for RPT's receivables.
-- Data category: CONFIDENTIAL (DC-09, DC-03): the farm's sales, and a customer's name, TIN and address as printed.
-- Rollback: tested (`pnpm db:rollback`), safe before the first billing document; afterwards forward fix only (an
-- issued document is never removed).

-- migrate:up
CREATE SCHEMA bil AUTHORIZATION hk_owner;
REVOKE ALL ON SCHEMA bil FROM PUBLIC;
GRANT USAGE ON SCHEMA bil TO hk_app, hk_worker, hk_report;

CREATE TABLE bil.billing_document (
  id                      uuid PRIMARY KEY CONSTRAINT fk_billing_document_registry REFERENCES platform.business_document (id) ON DELETE RESTRICT,
  kind                    text NOT NULL CONSTRAINT ck_billing_document_kind CHECK (kind IN ('PROFORMA', 'INVOICE', 'RECEIPT', 'CREDIT_NOTE', 'DEBIT_NOTE')),
  status                  text NOT NULL CONSTRAINT ck_billing_document_status_value CHECK (status IN ('DRAFT', 'ISSUED')),
  branch_id               uuid NOT NULL CONSTRAINT fk_billing_document_branch REFERENCES mdm.branch (id) ON DELETE RESTRICT,
  document_no             text NULL CONSTRAINT uq_billing_document_no UNIQUE,
  provisional_ref         text NULL CONSTRAINT uq_billing_document_provisional UNIQUE
                            CONSTRAINT ck_billing_document_provisional CHECK (provisional_ref ~ '^P-[A-Z0-9]{1,10}-[0-9]{1,6}-[0-9]{1,6}$'),
  customer_id             uuid NULL CONSTRAINT fk_billing_document_customer REFERENCES mdm.customer (id) ON DELETE RESTRICT,
  customer_name           text NULL CONSTRAINT ck_billing_document_customer_name CHECK (length(btrim(customer_name)) BETWEEN 1 AND 160),
  customer_tin            text NULL CONSTRAINT ck_billing_document_customer_tin CHECK (length(btrim(customer_tin)) BETWEEN 1 AND 30),
  billing_address         text NULL CONSTRAINT ck_billing_document_address CHECK (length(btrim(billing_address)) BETWEEN 1 AND 400),
  order_document_id       uuid NULL CONSTRAINT fk_billing_document_order REFERENCES platform.business_document (id) ON DELETE RESTRICT,
  original_document_id    uuid NULL CONSTRAINT fk_billing_document_original REFERENCES bil.billing_document (id) ON DELETE RESTRICT,
  issue_date              date NULL,
  due_date                date NULL,
  currency                char(3) NOT NULL DEFAULT 'GHS' CONSTRAINT ck_billing_document_currency CHECK (currency = 'GHS'),
  tax_inclusive           boolean NOT NULL,
  tax_scheme_version_id   uuid NOT NULL CONSTRAINT fk_billing_document_tax_scheme REFERENCES mdm.tax_scheme_version (id) ON DELETE RESTRICT,
  net_pesewas             platform.pesewas NOT NULL DEFAULT 0,
  tax_pesewas             platform.pesewas NOT NULL DEFAULT 0,
  gross_pesewas           platform.pesewas NOT NULL DEFAULT 0,
  credited_pesewas        platform.pesewas NOT NULL DEFAULT 0,
  certified_tax_pesewas   platform.pesewas NULL,
  certified_gross_pesewas platform.pesewas NULL,
  certification_ref       text NULL,
  reason_code             text NULL CONSTRAINT fk_billing_document_reason REFERENCES mdm.reason_code (code) ON DELETE RESTRICT,
  note                    text NULL CONSTRAINT ck_billing_document_note_text CHECK (length(btrim(note)) BETWEEN 1 AND 500),
  approval_request_id     uuid NULL CONSTRAINT fk_billing_document_approval REFERENCES iam.approval_request (id) ON DELETE RESTRICT,
  content_hash            bytea NULL CONSTRAINT ck_billing_document_hash CHECK (octet_length(content_hash) = 32),
  issued_at               timestamptz NULL,
  issued_by               uuid NULL CONSTRAINT fk_billing_document_issued_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  occurred_at             timestamptz NULL,
  version                 integer NOT NULL DEFAULT 1,
  created_at              timestamptz NOT NULL DEFAULT now(),
  created_by              uuid NOT NULL CONSTRAINT fk_billing_document_created_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  updated_at              timestamptz NOT NULL DEFAULT now(),
  updated_by              uuid NOT NULL CONSTRAINT fk_billing_document_updated_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  CONSTRAINT ck_billing_document_issued CHECK (status = 'DRAFT' OR (document_no IS NOT NULL AND issue_date IS NOT NULL AND issued_at IS NOT NULL AND issued_by IS NOT NULL)),
  CONSTRAINT ck_billing_document_note CHECK ((kind IN ('CREDIT_NOTE', 'DEBIT_NOTE')) = (original_document_id IS NOT NULL)
                                             AND (kind NOT IN ('CREDIT_NOTE', 'DEBIT_NOTE') OR reason_code IS NOT NULL)),
  CONSTRAINT ck_billing_document_sum CHECK (net_pesewas + tax_pesewas = gross_pesewas),
  CONSTRAINT ck_billing_document_credit_cap CHECK (credited_pesewas <= gross_pesewas AND (credited_pesewas = 0 OR kind IN ('INVOICE', 'RECEIPT'))),
  CONSTRAINT ck_billing_document_due CHECK (due_date IS NULL OR (issue_date IS NOT NULL AND due_date >= issue_date)),
  CONSTRAINT ck_billing_document_certified CHECK ((certified_tax_pesewas IS NULL) = (certified_gross_pesewas IS NULL)
                                                  AND (certified_tax_pesewas IS NULL) = (certification_ref IS NULL))
);
COMMENT ON TABLE bil.billing_document IS 'class=DOCUMENT';
CREATE INDEX ix_billing_document_customer ON bil.billing_document (customer_id, issue_date);
CREATE INDEX ix_billing_document_order ON bil.billing_document (order_document_id);
CREATE INDEX ix_billing_document_original ON bil.billing_document (original_document_id);
CREATE INDEX ix_billing_document_branch ON bil.billing_document (branch_id, issue_date, id);

CREATE TABLE bil.billing_document_line (
  id                          uuid PRIMARY KEY,
  billing_document_id         uuid NOT NULL CONSTRAINT fk_billing_document_line_document REFERENCES bil.billing_document (id) ON DELETE RESTRICT,
  line_no                     integer NOT NULL CONSTRAINT ck_billing_document_line_no CHECK (line_no > 0),
  line_kind                   text NOT NULL CONSTRAINT ck_billing_document_line_kind CHECK (line_kind IN ('PRODUCT', 'DELIVERY_FEE', 'ADJUSTMENT')),
  product_id                  uuid NULL CONSTRAINT fk_billing_document_line_product REFERENCES mdm.product (id) ON DELETE RESTRICT,
  description                 text NOT NULL CONSTRAINT ck_billing_document_line_description CHECK (length(btrim(description)) BETWEEN 1 AND 200),
  stock_unit_id               uuid NULL CONSTRAINT fk_billing_document_line_stock_unit REFERENCES inv.stock_unit (id) ON DELETE RESTRICT,
  stock_unit_identifier       text NULL CONSTRAINT ck_billing_document_line_unit_identifier CHECK (length(btrim(stock_unit_identifier)) BETWEEN 1 AND 60),
  stock_unit_tracking         text NULL CONSTRAINT ck_billing_document_line_unit_tracking CHECK (stock_unit_tracking IN ('SERIAL', 'LOT')),
  order_line_ref              uuid NULL,
  credits_line_id             uuid NULL CONSTRAINT fk_billing_document_line_credits REFERENCES bil.billing_document_line (id) ON DELETE RESTRICT,
  qty                         platform.qty NOT NULL CONSTRAINT ck_billing_document_line_qty CHECK (qty > 0),
  uom                         text NOT NULL CONSTRAINT fk_billing_document_line_uom REFERENCES mdm.uom (code) ON DELETE RESTRICT,
  weight_kg                   platform.kg NULL CONSTRAINT ck_billing_document_line_weight CHECK (weight_kg > 0),
  unit_price_pesewas          platform.pesewas NOT NULL,
  resolved_unit_price_pesewas platform.pesewas NOT NULL,
  discount_pesewas            platform.pesewas NOT NULL DEFAULT 0,
  tax_category_id             uuid NOT NULL CONSTRAINT fk_billing_document_line_tax_category REFERENCES mdm.tax_category (id) ON DELETE RESTRICT,
  line_net_pesewas            platform.pesewas NOT NULL,
  line_tax_pesewas            platform.pesewas NOT NULL,
  line_gross_pesewas          platform.pesewas NOT NULL,
  gl_group                    text NOT NULL CONSTRAINT ck_billing_document_line_gl_group CHECK (gl_group ~ '^[A-Z][A-Z_]{1,39}$'),
  CONSTRAINT uq_billing_document_line_no UNIQUE (billing_document_id, line_no),
  CONSTRAINT ck_billing_document_line_sum CHECK (line_net_pesewas + line_tax_pesewas = line_gross_pesewas),
  CONSTRAINT ck_billing_document_line_unit CHECK ((stock_unit_id IS NULL) = (stock_unit_identifier IS NULL) AND (stock_unit_id IS NULL) = (stock_unit_tracking IS NULL)),
  CONSTRAINT ck_billing_document_line_product_kind CHECK ((line_kind = 'PRODUCT') = (product_id IS NOT NULL))
);
COMMENT ON TABLE bil.billing_document_line IS 'class=DOCUMENT';
CREATE INDEX ix_billing_document_line_credits ON bil.billing_document_line (credits_line_id) WHERE credits_line_id IS NOT NULL;

CREATE TABLE bil.billing_document_line_tax (
  billing_document_line_id uuid NOT NULL CONSTRAINT fk_billing_document_line_tax_line REFERENCES bil.billing_document_line (id) ON DELETE RESTRICT,
  levy_id                  uuid NOT NULL CONSTRAINT fk_billing_document_line_tax_levy REFERENCES mdm.tax_levy (id) ON DELETE RESTRICT,
  levy_code                text NOT NULL,
  levy_name                text NOT NULL,
  treatment                text NOT NULL CONSTRAINT ck_billing_document_line_tax_treatment CHECK (treatment IN ('STANDARD', 'ZERO_RATED', 'EXEMPT', 'OUT_OF_SCOPE')),
  rate_percent             platform.percent NOT NULL,
  base_pesewas             platform.pesewas NOT NULL,
  amount_pesewas           platform.pesewas NOT NULL,
  calc_order               integer NOT NULL CONSTRAINT ck_billing_document_line_tax_order CHECK (calc_order > 0),
  CONSTRAINT pk_billing_document_line_tax PRIMARY KEY (billing_document_line_id, levy_id)
);
COMMENT ON TABLE bil.billing_document_line_tax IS 'class=DOCUMENT';

-- What has been paid and credited on each issued document (bil.md): one row per document, from its issue.
CREATE TABLE bil.document_settlement (
  billing_document_id uuid PRIMARY KEY CONSTRAINT fk_document_settlement_document REFERENCES bil.billing_document (id) ON DELETE RESTRICT,
  allocated_pesewas   platform.pesewas NOT NULL DEFAULT 0,
  credited_pesewas    platform.pesewas NOT NULL DEFAULT 0,
  outstanding_pesewas platform.pesewas NOT NULL,
  payment_status      text NOT NULL CONSTRAINT ck_document_settlement_status CHECK (payment_status IN ('UNPAID', 'PART_PAID', 'PAID', 'CREDITED', 'NOT_APPLICABLE')),
  settled_at          timestamptz NULL,
  as_of               timestamptz NOT NULL
);
COMMENT ON TABLE bil.document_settlement IS 'class=PROJECTION';

-- A document is written DRAFT, becomes ISSUED once and is then frozen but for the listed columns; its hash is set once.
CREATE FUNCTION bil.billing_document_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  allowed text[] := ARRAY['credited_pesewas', 'content_hash', 'certified_tax_pesewas', 'certified_gross_pesewas', 'certification_ref', 'version', 'updated_at', 'updated_by'];
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'DRAFT' THEN
      RAISE EXCEPTION 'bil.billing_document %: a document is written DRAFT and issued afterwards', NEW.id USING ERRCODE = 'HK004', CONSTRAINT = 'ck_billing_document_status';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status = 'ISSUED' THEN
    IF NEW.status <> 'ISSUED' OR (to_jsonb(NEW) - allowed) IS DISTINCT FROM (to_jsonb(OLD) - allowed) THEN
      RAISE EXCEPTION 'bil.billing_document % is issued and frozen', OLD.id USING ERRCODE = 'HK004', CONSTRAINT = 'ck_billing_document_frozen';
    END IF;
    IF OLD.content_hash IS NOT NULL AND NEW.content_hash IS DISTINCT FROM OLD.content_hash THEN
      RAISE EXCEPTION 'bil.billing_document %: the content hash is set once', OLD.id USING ERRCODE = 'HK004', CONSTRAINT = 'ck_billing_document_frozen';
    END IF;
    IF OLD.certified_gross_pesewas IS NOT NULL AND (NEW.certified_tax_pesewas, NEW.certified_gross_pesewas, NEW.certification_ref)
         IS DISTINCT FROM (OLD.certified_tax_pesewas, OLD.certified_gross_pesewas, OLD.certification_ref) THEN
      RAISE EXCEPTION 'bil.billing_document %: certified totals are set once', OLD.id USING ERRCODE = 'HK004', CONSTRAINT = 'ck_billing_document_frozen';
    END IF;
  ELSIF NEW.status NOT IN ('DRAFT', 'ISSUED') OR (NEW.status = 'ISSUED' AND NEW.credited_pesewas <> 0) THEN
    RAISE EXCEPTION 'bil.billing_document %: a draft is issued with nothing credited', OLD.id USING ERRCODE = 'HK004', CONSTRAINT = 'ck_billing_document_status';
  END IF;
  NEW.version := OLD.version + 1;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION bil.billing_document_guard() FROM PUBLIC;
CREATE TRIGGER trg_billing_document_guard BEFORE INSERT OR UPDATE ON bil.billing_document
  FOR EACH ROW EXECUTE FUNCTION bil.billing_document_guard();

-- Lines and levy rows change only while their document is a draft.
CREATE FUNCTION bil.billing_document_line_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  rows_touched jsonb[];
  row_data jsonb;
  doc_id uuid;
  doc_status text;
BEGIN
  rows_touched := CASE TG_OP WHEN 'INSERT' THEN ARRAY[to_jsonb(NEW)] WHEN 'DELETE' THEN ARRAY[to_jsonb(OLD)] ELSE ARRAY[to_jsonb(OLD), to_jsonb(NEW)] END;
  FOREACH row_data IN ARRAY rows_touched LOOP
    IF TG_TABLE_NAME = 'billing_document_line' THEN
      doc_id := (row_data ->> 'billing_document_id')::uuid;
    ELSE
      SELECT l.billing_document_id INTO doc_id FROM bil.billing_document_line l WHERE l.id = (row_data ->> 'billing_document_line_id')::uuid;
    END IF;
    SELECT d.status INTO doc_status FROM bil.billing_document d WHERE d.id = doc_id;
    IF doc_status IS DISTINCT FROM 'DRAFT' THEN
      RAISE EXCEPTION 'bil.%: document % is not a draft', TG_TABLE_NAME, doc_id USING ERRCODE = 'HK004', CONSTRAINT = 'ck_billing_document_line_frozen';
    END IF;
  END LOOP;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;
REVOKE ALL ON FUNCTION bil.billing_document_line_guard() FROM PUBLIC;
CREATE TRIGGER trg_billing_document_line_guard BEFORE INSERT OR UPDATE OR DELETE ON bil.billing_document_line
  FOR EACH ROW EXECUTE FUNCTION bil.billing_document_line_guard();
CREATE TRIGGER trg_billing_document_line_tax_guard BEFORE INSERT OR UPDATE OR DELETE ON bil.billing_document_line_tax
  FOR EACH ROW EXECUTE FUNCTION bil.billing_document_line_guard();

-- At issue, a credit note raises its original's credited amount, never past the original's gross.
CREATE FUNCTION bil.credit_note_applied() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  original bil.billing_document;
BEGIN
  SELECT * INTO original FROM bil.billing_document d WHERE d.id = NEW.original_document_id FOR UPDATE;
  IF original.credited_pesewas + NEW.gross_pesewas > original.gross_pesewas THEN
    RAISE EXCEPTION 'bil.billing_document %: a credit of % exceeds the % pesewas % has left', NEW.id, NEW.gross_pesewas,
      original.gross_pesewas - original.credited_pesewas, original.document_no USING ERRCODE = 'HK010', CONSTRAINT = 'ck_billing_document_credit_cap';
  END IF;
  UPDATE bil.billing_document SET credited_pesewas = credited_pesewas + NEW.gross_pesewas, updated_at = NEW.updated_at, updated_by = NEW.updated_by
   WHERE id = NEW.original_document_id;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION bil.credit_note_applied() FROM PUBLIC;
CREATE TRIGGER trg_billing_document_credit_applied AFTER UPDATE OF status ON bil.billing_document
  FOR EACH ROW WHEN (NEW.kind = 'CREDIT_NOTE' AND NEW.status = 'ISSUED' AND OLD.status = 'DRAFT') EXECUTE FUNCTION bil.credit_note_applied();

-- At commit: an issued document's totals are the sums of its lines and levy rows, its number is its own allocation,
-- a note's original is an issued invoice or receipt of the same branch and customer, and what it has credited is
-- exactly its issued credit notes.
CREATE FUNCTION bil.billing_document_check() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  d bil.billing_document;
  original bil.billing_document;
  lines integer;
  lines_net numeric;
  lines_tax numeric;
  lines_gross numeric;
  levy_mismatch integer;
  credited numeric;
BEGIN
  SELECT * INTO d FROM bil.billing_document x WHERE x.id = NEW.id;
  IF d.status <> 'ISSUED' THEN
    RETURN NULL;
  END IF;
  SELECT count(*), COALESCE(sum(l.line_net_pesewas), 0), COALESCE(sum(l.line_tax_pesewas), 0), COALESCE(sum(l.line_gross_pesewas), 0)
    INTO lines, lines_net, lines_tax, lines_gross
    FROM bil.billing_document_line l WHERE l.billing_document_id = d.id;
  SELECT count(*) INTO levy_mismatch
    FROM bil.billing_document_line l
   WHERE l.billing_document_id = d.id
     AND l.line_tax_pesewas <> (SELECT COALESCE(sum(t.amount_pesewas), 0) FROM bil.billing_document_line_tax t WHERE t.billing_document_line_id = l.id);
  IF lines = 0 OR levy_mismatch > 0 OR lines_net <> d.net_pesewas OR lines_tax <> d.tax_pesewas OR lines_gross <> d.gross_pesewas THEN
    RAISE EXCEPTION 'bil.billing_document %: totals % + % = % are not the sums of its % lines (% + % = %; % lines with levies off)', d.id,
      d.net_pesewas, d.tax_pesewas, d.gross_pesewas, lines, lines_net, lines_tax, lines_gross, levy_mismatch
      USING ERRCODE = 'HK010', CONSTRAINT = 'ck_billing_document_totals';
  END IF;
  IF NOT platform.number_allocated(d.id, d.document_no, d.kind) THEN
    RAISE EXCEPTION 'bil.billing_document %: % was not allocated to it', d.id, d.document_no USING ERRCODE = 'HK010', CONSTRAINT = 'ck_billing_document_number';
  END IF;
  IF d.original_document_id IS NOT NULL THEN
    SELECT * INTO original FROM bil.billing_document x WHERE x.id = d.original_document_id;
    IF original.status <> 'ISSUED' OR original.kind NOT IN ('INVOICE', 'RECEIPT') OR original.branch_id <> d.branch_id
       OR original.customer_id IS DISTINCT FROM d.customer_id THEN
      RAISE EXCEPTION 'bil.billing_document %: % corrects an issued invoice or receipt of its own branch and customer', d.id, d.kind
        USING ERRCODE = 'HK010', CONSTRAINT = 'ck_billing_document_original';
    END IF;
  END IF;
  IF d.kind IN ('INVOICE', 'RECEIPT') THEN
    SELECT COALESCE(sum(c.gross_pesewas), 0) INTO credited FROM bil.billing_document c
     WHERE c.original_document_id = d.id AND c.kind = 'CREDIT_NOTE' AND c.status = 'ISSUED';
    IF credited <> d.credited_pesewas THEN
      RAISE EXCEPTION 'bil.billing_document %: credited % is not its issued credit notes (%)', d.id, d.credited_pesewas, credited
        USING ERRCODE = 'HK010', CONSTRAINT = 'ck_billing_document_credit_cap';
    END IF;
  END IF;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION bil.billing_document_check() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER trg_billing_document_check AFTER INSERT OR UPDATE ON bil.billing_document
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION bil.billing_document_check();

-- The settlement summary of an issued document, kept with it: written at issue and whenever its credited amount moves.
CREATE FUNCTION bil.document_settlement_keep() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
DECLARE
  allocated numeric := 0;
  outstanding numeric;
  payment_status text;
BEGIN
  SELECT s.allocated_pesewas INTO allocated FROM bil.document_settlement s WHERE s.billing_document_id = NEW.id;
  allocated := COALESCE(allocated, 0);
  IF NEW.kind IN ('PROFORMA', 'CREDIT_NOTE') THEN
    outstanding := 0;
    payment_status := 'NOT_APPLICABLE';
  ELSE
    outstanding := NEW.gross_pesewas - NEW.credited_pesewas - allocated;
    payment_status := CASE
      WHEN outstanding > 0 AND allocated = 0 AND NEW.credited_pesewas = 0 THEN 'UNPAID'
      WHEN outstanding > 0 THEN 'PART_PAID'
      WHEN allocated = 0 THEN 'CREDITED'
      ELSE 'PAID' END;
  END IF;
  INSERT INTO bil.document_settlement (billing_document_id, allocated_pesewas, credited_pesewas, outstanding_pesewas, payment_status, settled_at, as_of)
  VALUES (NEW.id, allocated, NEW.credited_pesewas, outstanding, payment_status,
          CASE WHEN outstanding = 0 AND payment_status <> 'NOT_APPLICABLE' THEN NEW.updated_at END, NEW.updated_at)
  ON CONFLICT (billing_document_id) DO UPDATE
     SET credited_pesewas = EXCLUDED.credited_pesewas, outstanding_pesewas = EXCLUDED.outstanding_pesewas, payment_status = EXCLUDED.payment_status,
         settled_at = COALESCE(bil.document_settlement.settled_at, EXCLUDED.settled_at), as_of = EXCLUDED.as_of;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION bil.document_settlement_keep() FROM PUBLIC;
CREATE TRIGGER trg_billing_document_settlement AFTER UPDATE ON bil.billing_document
  FOR EACH ROW WHEN (NEW.status = 'ISSUED' AND (OLD.status = 'DRAFT' OR NEW.credited_pesewas <> OLD.credited_pesewas)) EXECUTE FUNCTION bil.document_settlement_keep();

-- Published for RPT and CST (bil.md): issued documents, no names or addresses.
CREATE VIEW bil.pub_document AS
SELECT d.id, d.kind, d.document_no, d.branch_id, d.customer_id, d.issue_date, d.due_date, d.net_pesewas, d.tax_pesewas, d.gross_pesewas,
       d.credited_pesewas, s.allocated_pesewas, s.outstanding_pesewas, d.order_document_id, d.original_document_id
  FROM bil.billing_document d JOIN bil.document_settlement s ON s.billing_document_id = d.id
 WHERE d.status = 'ISSUED';

REVOKE ALL ON ALL TABLES IN SCHEMA bil FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON bil.billing_document, bil.billing_document_line, bil.billing_document_line_tax TO hk_app, hk_worker;
GRANT SELECT ON bil.document_settlement TO hk_app, hk_worker;
GRANT SELECT ON bil.pub_document TO hk_app, hk_worker, hk_report;

-- migrate:down
DROP VIEW bil.pub_document;
DROP TRIGGER trg_billing_document_settlement ON bil.billing_document;
DROP FUNCTION bil.document_settlement_keep();
DROP TRIGGER trg_billing_document_check ON bil.billing_document;
DROP FUNCTION bil.billing_document_check();
DROP TRIGGER trg_billing_document_credit_applied ON bil.billing_document;
DROP FUNCTION bil.credit_note_applied();
DROP TRIGGER trg_billing_document_line_tax_guard ON bil.billing_document_line_tax;
DROP TRIGGER trg_billing_document_line_guard ON bil.billing_document_line;
DROP FUNCTION bil.billing_document_line_guard();
DROP TRIGGER trg_billing_document_guard ON bil.billing_document;
DROP FUNCTION bil.billing_document_guard();
DROP TABLE bil.document_settlement;
DROP TABLE bil.billing_document_line_tax;
DROP TABLE bil.billing_document_line;
DROP TABLE bil.billing_document;
DROP SCHEMA bil;
