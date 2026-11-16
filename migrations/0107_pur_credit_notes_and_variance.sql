-- 0107_pur_credit_notes_and_variance
-- Supplier credit notes (FR-PUR-011) and the approved variance (FR-PUR-010), B07 continued 1b (A-172). Both change
-- what a supplier is owed, so both wait for a different person through IAM's approval mechanism (ADR-0017), and the
-- database holds their caps itself, whoever writes:
--   ck_supplier_credit_note_cap         deferred: the credit notes alive against an invoice (any not CANCELLED) and
--                                       the live payments promised to it never exceed its gross; a credit is entered
--                                       only against an APPROVED invoice of the same supplier and branch (HK010)
--   pur.supplier_credit_note_applied    when a credit note is APPROVED its gross is added to the invoice's
--                                       `credited_pesewas`, which is PAID once a payment was made and payments and
--                                       credits reach the gross; `ck_supplier_invoice_credited` (deferred) holds
--                                       credited to the sum of approved credit notes (HK010)
--   pur.supplier_payment_allocation_guard
--                                       a payment allocates only what credits and earlier payments leave, to an invoice
--                                       MATCHED, NOT_REQUIRED or VARIANCE_APPROVED (HK010)
--   ck_supplier_invoice_variance        a VARIANCE_APPROVED invoice is an approved invoice naming its approval request
--                                       and reason, approved by someone other than whoever entered it
--   pur.supplier_invoice_variance_cover a variance covers only lines whose mismatch is the price or a levy, never
--                                       goods not received, no order line or another product (HK010)
--   ck_supplier_invoice_credit_approved an approved credit note names its approval request and was approved by
--                                       someone other than whoever entered it
--   pur.supplier_invoice_status_guard   a credit note goes DRAFT to APPROVED (or CANCELLED) and an approved one is never
--                                       cancelled; a MISMATCH invoice is APPROVED only as VARIANCE_APPROVED; an invoice
--                                       with a live credit note is not cancelled (HK004)
--   pur.supplier_invoice_part_guard     the lines of a DRAFT credit note waiting for approval are frozen (HK004)
-- A credit note's line may name where returned goods leave from (`return_location_id`, and the lot or animal); the
-- supplier-return movement itself is INV's, posted through its published interface when the credit is approved.
-- Data category: CONFIDENTIAL (DC-11).
-- Rollback: tested (`pnpm db:rollback`), safe before the first credit note or variance; afterwards forward fix only,
-- since an approved credit changed what the supplier is owed.

-- migrate:up
ALTER TABLE pur.supplier_invoice
  ADD COLUMN credited_pesewas platform.pesewas NOT NULL DEFAULT 0,
  ADD COLUMN approval_request_id uuid NULL CONSTRAINT fk_supplier_invoice_approval REFERENCES iam.approval_request (id) ON DELETE RESTRICT,
  ADD COLUMN variance_reason text NULL CONSTRAINT ck_supplier_invoice_variance_reason CHECK (length(btrim(variance_reason)) BETWEEN 1 AND 500),
  ADD COLUMN return_reason_code text NULL CONSTRAINT fk_supplier_invoice_return_reason REFERENCES mdm.reason_code (code) ON DELETE RESTRICT;

ALTER TABLE pur.supplier_invoice DROP CONSTRAINT ck_supplier_invoice_match_status;
ALTER TABLE pur.supplier_invoice ADD CONSTRAINT ck_supplier_invoice_match_status
  CHECK (match_status IN ('UNMATCHED', 'MATCHED', 'MISMATCH', 'NOT_REQUIRED', 'VARIANCE_APPROVED'));
ALTER TABLE pur.supplier_invoice DROP CONSTRAINT ck_supplier_invoice_paid;
ALTER TABLE pur.supplier_invoice ADD CONSTRAINT ck_supplier_invoice_paid
  CHECK (paid_pesewas + credited_pesewas <= gross_pesewas
     AND (status = 'PAID') = (paid_pesewas > 0 AND paid_pesewas + credited_pesewas = gross_pesewas AND status <> 'CANCELLED'));
ALTER TABLE pur.supplier_invoice DROP CONSTRAINT ck_supplier_invoice_payable;
ALTER TABLE pur.supplier_invoice ADD CONSTRAINT ck_supplier_invoice_payable
  CHECK (status NOT IN ('MATCHED', 'APPROVED', 'PAID') OR match_status IN ('MATCHED', 'NOT_REQUIRED', 'VARIANCE_APPROVED'));
-- A credit note is never matched, paid or credited; it is approved needing no match.
ALTER TABLE pur.supplier_invoice ADD CONSTRAINT ck_supplier_invoice_credit_kind
  CHECK (kind = 'INVOICE' OR (status IN ('DRAFT', 'APPROVED', 'CANCELLED') AND match_status IN ('UNMATCHED', 'NOT_REQUIRED')
                              AND credited_pesewas = 0 AND paid_pesewas = 0 AND variance_reason IS NULL));
ALTER TABLE pur.supplier_invoice ADD CONSTRAINT ck_supplier_invoice_return_reason CHECK (kind = 'CREDIT_NOTE' OR return_reason_code IS NULL);
ALTER TABLE pur.supplier_invoice ADD CONSTRAINT ck_supplier_invoice_credit_approved
  CHECK (kind = 'INVOICE' OR status <> 'APPROVED' OR (approval_request_id IS NOT NULL AND posted_by <> created_by));
-- An invoice's approval request is its variance's: asked for with a reason, and while it waits the invoice stays MISMATCH.
ALTER TABLE pur.supplier_invoice ADD CONSTRAINT ck_supplier_invoice_variance_request
  CHECK (kind = 'CREDIT_NOTE' OR ((approval_request_id IS NULL) = (variance_reason IS NULL)
                                  AND (approval_request_id IS NULL OR status IN ('MISMATCH', 'CANCELLED') OR match_status = 'VARIANCE_APPROVED')));
ALTER TABLE pur.supplier_invoice ADD CONSTRAINT ck_supplier_invoice_variance
  CHECK (match_status <> 'VARIANCE_APPROVED' OR (kind = 'INVOICE' AND status IN ('APPROVED', 'PAID', 'CANCELLED') AND approval_request_id IS NOT NULL
                                                 AND posted_by <> created_by));
CREATE INDEX ix_supplier_invoice_original ON pur.supplier_invoice (original_invoice_id) WHERE original_invoice_id IS NOT NULL;

ALTER TABLE pur.supplier_invoice_line
  ADD COLUMN return_location_id uuid NULL CONSTRAINT fk_supplier_invoice_line_return_location REFERENCES mdm.location (id) ON DELETE RESTRICT,
  ADD COLUMN return_stock_unit_id uuid NULL CONSTRAINT fk_supplier_invoice_line_return_unit REFERENCES inv.stock_unit (id) ON DELETE RESTRICT;
ALTER TABLE pur.supplier_invoice_line ADD CONSTRAINT ck_supplier_invoice_line_return
  CHECK ((return_location_id IS NULL OR product_id IS NOT NULL) AND (return_stock_unit_id IS NULL OR return_location_id IS NOT NULL));

-- An approved invoice changes only by being paid, credited or cancelled.
DROP TRIGGER trg_supplier_invoice_freeze_approved ON pur.supplier_invoice;
CREATE TRIGGER trg_supplier_invoice_freeze_approved BEFORE UPDATE ON pur.supplier_invoice
  FOR EACH ROW EXECUTE FUNCTION platform.freeze_posted('APPROVED', 'paid_pesewas', 'credited_pesewas', 'status', 'cancel_reason', 'version', 'updated_at', 'updated_by');

CREATE OR REPLACE FUNCTION pur.supplier_invoice_part_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  invoice_status text;
  pending uuid;
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
  SELECT i.status, i.approval_request_id INTO invoice_status, pending FROM pur.supplier_invoice i WHERE i.id = invoice_id;
  IF invoice_status = 'DRAFT' AND pending IS NULL THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_TABLE_NAME = 'supplier_invoice_line' AND TG_OP = 'UPDATE' AND invoice_status IN ('MATCHED', 'MISMATCH') AND pending IS NULL
     AND (to_jsonb(NEW) - ARRAY['qty_variance', 'price_variance_pesewas', 'price_variance_direction', 'match_status', 'match_reasons'])
       = (to_jsonb(OLD) - ARRAY['qty_variance', 'price_variance_pesewas', 'price_variance_direction', 'match_status', 'match_reasons']) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '%.% is frozen with its invoice (status %, approval %)', TG_TABLE_SCHEMA, TG_TABLE_NAME, invoice_status, pending USING ERRCODE = 'HK004';
END
$$;

CREATE OR REPLACE FUNCTION pur.supplier_invoice_status_guard() RETURNS trigger
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
  IF OLD.kind = 'CREDIT_NOTE' THEN
    IF NOT (OLD.status = 'DRAFT' AND NEW.status IN ('APPROVED', 'CANCELLED')) THEN
      RAISE EXCEPTION 'pur.supplier_invoice %: a credit note % cannot become %', OLD.id, OLD.status, NEW.status USING ERRCODE = 'HK004';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT ((OLD.status = 'DRAFT' AND NEW.status IN ('MATCHED', 'MISMATCH', 'CANCELLED'))
       OR (OLD.status IN ('MATCHED', 'MISMATCH') AND NEW.status IN ('DRAFT', 'MATCHED', 'MISMATCH', 'CANCELLED'))
       OR (OLD.status = 'MATCHED' AND NEW.status = 'APPROVED')
       OR (OLD.status = 'MISMATCH' AND NEW.status = 'APPROVED' AND NEW.match_status = 'VARIANCE_APPROVED')
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
    SELECT count(*) INTO live FROM pur.supplier_invoice c WHERE c.original_invoice_id = OLD.id AND c.status <> 'CANCELLED';
    IF live > 0 THEN
      RAISE EXCEPTION 'pur.supplier_invoice %: a credit note is entered against it', OLD.id USING ERRCODE = 'HK004', CONSTRAINT = 'ck_supplier_invoice_cancel_credited';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

-- FR-PUR-011 in the database: the cap on credits, at commit, with the invoice row locked so two credits queue.
CREATE FUNCTION pur.supplier_credit_note_cap() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  credit pur.supplier_invoice;
  original pur.supplier_invoice;
  credits numeric;
  promised numeric;
BEGIN
  SELECT * INTO credit FROM pur.supplier_invoice i WHERE i.id = NEW.id;
  IF NOT FOUND OR credit.kind <> 'CREDIT_NOTE' OR credit.status = 'CANCELLED' THEN
    RETURN NULL;
  END IF;
  SELECT * INTO original FROM pur.supplier_invoice i WHERE i.id = credit.original_invoice_id FOR UPDATE;
  IF original.kind <> 'INVOICE' OR original.supplier_id <> credit.supplier_id OR original.branch_id <> credit.branch_id
     OR (original.purchase_order_id IS DISTINCT FROM credit.purchase_order_id AND credit.purchase_order_id IS NOT NULL) THEN
    RAISE EXCEPTION 'pur.supplier_invoice %: a credit note reduces an invoice of its own supplier, branch and order', credit.id
      USING ERRCODE = 'HK010', CONSTRAINT = 'ck_supplier_credit_note_original';
  END IF;
  IF credit.status = 'DRAFT' AND original.status <> 'APPROVED' THEN
    RAISE EXCEPTION 'pur.supplier_invoice %: credit against invoice %, which is %, not APPROVED', credit.id, original.id, original.status
      USING ERRCODE = 'HK010', CONSTRAINT = 'ck_supplier_credit_note_original';
  END IF;
  SELECT COALESCE(sum(c.gross_pesewas), 0) INTO credits FROM pur.supplier_invoice c WHERE c.original_invoice_id = original.id AND c.status <> 'CANCELLED';
  SELECT COALESCE(sum(a.amount_pesewas), 0) INTO promised
    FROM pur.supplier_payment_allocation a JOIN pur.supplier_payment p ON p.id = a.supplier_payment_id
   WHERE a.supplier_invoice_id = original.id AND p.status NOT IN ('REJECTED', 'CANCELLED');
  IF credits + promised > original.gross_pesewas THEN
    RAISE EXCEPTION 'pur.supplier_invoice %: credits % and payments % would exceed the gross % of invoice %', credit.id, credits, promised, original.gross_pesewas, original.id
      USING ERRCODE = 'HK010', CONSTRAINT = 'ck_supplier_credit_note_cap';
  END IF;
  IF credit.return_reason_code IS NULL AND EXISTS (SELECT 1 FROM pur.supplier_invoice_line l WHERE l.supplier_invoice_id = credit.id AND l.return_location_id IS NOT NULL) THEN
    RAISE EXCEPTION 'pur.supplier_invoice %: goods sent back need a return reason', credit.id
      USING ERRCODE = 'HK010', CONSTRAINT = 'ck_supplier_credit_note_return_reason';
  END IF;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION pur.supplier_credit_note_cap() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER trg_supplier_credit_note_cap AFTER INSERT OR UPDATE ON pur.supplier_invoice
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.kind = 'CREDIT_NOTE') EXECUTE FUNCTION pur.supplier_credit_note_cap();

-- An approved credit reduces what its invoice is owed, in the same statement.
CREATE FUNCTION pur.supplier_credit_note_applied() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  UPDATE pur.supplier_invoice i
     SET version = i.version + 1,
         credited_pesewas = i.credited_pesewas + NEW.gross_pesewas,
         status = CASE WHEN i.paid_pesewas > 0 AND i.paid_pesewas + i.credited_pesewas + NEW.gross_pesewas = i.gross_pesewas THEN 'PAID' ELSE i.status END,
         updated_at = NEW.updated_at,
         updated_by = NEW.updated_by
   WHERE i.id = NEW.original_invoice_id;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION pur.supplier_credit_note_applied() FROM PUBLIC;
CREATE TRIGGER trg_supplier_credit_note_applied AFTER UPDATE OF status ON pur.supplier_invoice
  FOR EACH ROW WHEN (NEW.kind = 'CREDIT_NOTE' AND NEW.status = 'APPROVED' AND OLD.status <> 'APPROVED') EXECUTE FUNCTION pur.supplier_credit_note_applied();

-- At commit: an invoice's credited amount is the gross of its approved credit notes.
CREATE FUNCTION pur.supplier_invoice_credited() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  header pur.supplier_invoice;
  approved numeric;
BEGIN
  SELECT * INTO header FROM pur.supplier_invoice i WHERE i.id = NEW.id;
  IF NOT FOUND OR header.kind <> 'INVOICE' THEN
    RETURN NULL;
  END IF;
  SELECT COALESCE(sum(c.gross_pesewas), 0) INTO approved FROM pur.supplier_invoice c WHERE c.original_invoice_id = header.id AND c.status = 'APPROVED';
  IF header.credited_pesewas <> approved THEN
    RAISE EXCEPTION 'pur.supplier_invoice %: credited % must be %, the gross of its approved credit notes', header.id, header.credited_pesewas, approved
      USING ERRCODE = 'HK010', CONSTRAINT = 'ck_supplier_invoice_credited';
  END IF;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION pur.supplier_invoice_credited() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER trg_supplier_invoice_credited AFTER INSERT OR UPDATE ON pur.supplier_invoice
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.kind = 'INVOICE') EXECUTE FUNCTION pur.supplier_invoice_credited();

-- FR-PUR-010: a variance covers a price or a levy difference, never goods that were not received.
CREATE FUNCTION pur.supplier_invoice_variance_cover() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pur.supplier_invoice_line l WHERE l.supplier_invoice_id = NEW.id AND l.match_status = 'MISMATCH')
     OR EXISTS (SELECT 1 FROM pur.supplier_invoice_line l
                 WHERE l.supplier_invoice_id = NEW.id AND NOT (l.match_reasons <@ ARRAY['PRICE_OUTSIDE_TOLERANCE', 'LEVY_DIFFERS']::text[])) THEN
    RAISE EXCEPTION 'pur.supplier_invoice %: a variance covers price and levy differences on a mismatched invoice only', NEW.id
      USING ERRCODE = 'HK010', CONSTRAINT = 'ck_supplier_invoice_variance_cover';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION pur.supplier_invoice_variance_cover() FROM PUBLIC;
CREATE TRIGGER trg_supplier_invoice_variance_cover BEFORE UPDATE OF match_status ON pur.supplier_invoice
  FOR EACH ROW WHEN (NEW.match_status = 'VARIANCE_APPROVED' AND OLD.match_status <> 'VARIANCE_APPROVED') EXECUTE FUNCTION pur.supplier_invoice_variance_cover();

-- FR-PUR-010 to FR-PUR-012: a payment pays what credits and earlier payments leave, of a payable invoice.
CREATE OR REPLACE FUNCTION pur.supplier_payment_allocation_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  payment pur.supplier_payment;
  invoice pur.supplier_invoice;
  promised numeric;
  credits numeric;
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
  IF invoice.status <> 'APPROVED' OR invoice.match_status NOT IN ('MATCHED', 'NOT_REQUIRED', 'VARIANCE_APPROVED') THEN
    RAISE EXCEPTION 'pur.supplier_invoice %: % with match %, so it cannot be paid', invoice.id, invoice.status, invoice.match_status
      USING ERRCODE = 'HK010', CONSTRAINT = 'ck_supplier_payment_allocation_matched';
  END IF;
  SELECT COALESCE(sum(a.amount_pesewas), 0) INTO promised
    FROM pur.supplier_payment_allocation a JOIN pur.supplier_payment p ON p.id = a.supplier_payment_id
   WHERE a.supplier_invoice_id = invoice.id AND p.status NOT IN ('REJECTED', 'CANCELLED');
  SELECT COALESCE(sum(c.gross_pesewas), 0) INTO credits FROM pur.supplier_invoice c WHERE c.original_invoice_id = invoice.id AND c.status <> 'CANCELLED';
  IF promised + credits + NEW.amount_pesewas > invoice.gross_pesewas THEN
    RAISE EXCEPTION 'pur.supplier_invoice %: % allocated and % credited, % more would exceed the gross %', invoice.id, promised, credits, NEW.amount_pesewas, invoice.gross_pesewas
      USING ERRCODE = 'HK010', CONSTRAINT = 'ck_supplier_payment_allocation_outstanding';
  END IF;
  RETURN NEW;
END
$$;

-- When a payment is paid, each invoice it allocates to carries the amount, and is PAID once payments and credits settle it.
CREATE OR REPLACE FUNCTION pur.supplier_payment_settle() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  UPDATE pur.supplier_invoice i
     SET version = i.version + 1,
         paid_pesewas = i.paid_pesewas + a.amount_pesewas,
         status = CASE WHEN i.paid_pesewas + a.amount_pesewas + i.credited_pesewas = i.gross_pesewas THEN 'PAID' ELSE i.status END,
         updated_at = NEW.updated_at,
         updated_by = NEW.updated_by
    FROM pur.supplier_payment_allocation a
   WHERE a.supplier_payment_id = NEW.id AND i.id = a.supplier_invoice_id;
  RETURN NULL;
END
$$;

-- migrate:down
CREATE OR REPLACE FUNCTION pur.supplier_payment_settle() RETURNS trigger
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
CREATE OR REPLACE FUNCTION pur.supplier_payment_allocation_guard() RETURNS trigger
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
DROP TRIGGER trg_supplier_invoice_variance_cover ON pur.supplier_invoice;
DROP FUNCTION pur.supplier_invoice_variance_cover();
DROP TRIGGER trg_supplier_invoice_credited ON pur.supplier_invoice;
DROP FUNCTION pur.supplier_invoice_credited();
DROP TRIGGER trg_supplier_credit_note_applied ON pur.supplier_invoice;
DROP FUNCTION pur.supplier_credit_note_applied();
DROP TRIGGER trg_supplier_credit_note_cap ON pur.supplier_invoice;
DROP FUNCTION pur.supplier_credit_note_cap();
CREATE OR REPLACE FUNCTION pur.supplier_invoice_status_guard() RETURNS trigger
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
CREATE OR REPLACE FUNCTION pur.supplier_invoice_part_guard() RETURNS trigger
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
DROP TRIGGER trg_supplier_invoice_freeze_approved ON pur.supplier_invoice;
CREATE TRIGGER trg_supplier_invoice_freeze_approved BEFORE UPDATE ON pur.supplier_invoice
  FOR EACH ROW EXECUTE FUNCTION platform.freeze_posted('APPROVED', 'paid_pesewas', 'status', 'cancel_reason', 'version', 'updated_at', 'updated_by');
ALTER TABLE pur.supplier_invoice_line DROP CONSTRAINT ck_supplier_invoice_line_return;
ALTER TABLE pur.supplier_invoice_line DROP COLUMN return_stock_unit_id, DROP COLUMN return_location_id;
DROP INDEX pur.ix_supplier_invoice_original;
ALTER TABLE pur.supplier_invoice DROP CONSTRAINT ck_supplier_invoice_variance, DROP CONSTRAINT ck_supplier_invoice_variance_request,
  DROP CONSTRAINT ck_supplier_invoice_credit_approved, DROP CONSTRAINT ck_supplier_invoice_return_reason, DROP CONSTRAINT ck_supplier_invoice_credit_kind;
ALTER TABLE pur.supplier_invoice DROP CONSTRAINT ck_supplier_invoice_payable;
ALTER TABLE pur.supplier_invoice ADD CONSTRAINT ck_supplier_invoice_payable CHECK (status NOT IN ('MATCHED', 'APPROVED', 'PAID') OR match_status IN ('MATCHED', 'NOT_REQUIRED'));
ALTER TABLE pur.supplier_invoice DROP CONSTRAINT ck_supplier_invoice_paid;
ALTER TABLE pur.supplier_invoice ADD CONSTRAINT ck_supplier_invoice_paid
  CHECK (paid_pesewas <= gross_pesewas AND (status = 'PAID') = (paid_pesewas = gross_pesewas AND gross_pesewas > 0 AND status <> 'CANCELLED'));
ALTER TABLE pur.supplier_invoice DROP CONSTRAINT ck_supplier_invoice_match_status;
ALTER TABLE pur.supplier_invoice ADD CONSTRAINT ck_supplier_invoice_match_status CHECK (match_status IN ('UNMATCHED', 'MATCHED', 'MISMATCH', 'NOT_REQUIRED'));
ALTER TABLE pur.supplier_invoice DROP COLUMN return_reason_code, DROP COLUMN variance_reason, DROP COLUMN approval_request_id, DROP COLUMN credited_pesewas;
