-- 0223_pur_supplier_claims
-- B09e continued 3 (the owner's decision 5 of 2026-11-17, CR-036, ADR-0076): a claim raised from a posted purchase
-- receipt's rejected lines, settled once, by the invoice that left the rejected goods out or by a credit note drafted
-- from it against the invoice that charged them.
--   pur.supplier_claim          DOCUMENT: one per goods receipt (uq_supplier_claim_receipt), its supplier, order,
--                               receipt, the person who posted the receipt (`received_by`), the claimed total, and its
--                               settlement once SETTLED (`settlement`, `settled_by_invoice_id`, `posted_*`).
--                               pur.supplier_claim_guard (HK004, HK010): inserted OPEN with nothing settled; only
--                               the settlement ever changes, once, from OPEN to SETTLED.
--                               - By INVOICE: an APPROVED or PAID invoice of the claim's order.
--                               - By CREDIT_NOTE: the APPROVED credit note drafted from this claim, approved by someone
--                                 who neither raised the claim nor received the goods.
--   pur.supplier_claim_line     DOCUMENT, never changed after insert: each rejected receipt line with its order line,
--                               product, reason (FK mdm.reason_code), accepted and rejected base quantities, and the
--                               delivery's value at the order price split exactly into accepted and claimed
--                               (ck_supplier_claim_line_split). The claim's total is its lines' claimed values (HK010,
--                               deferred).
--   pur.supplier_invoice.supplier_claim_id
--                               a credit note drafted from a claim; at most one not cancelled per claim
--                               (uq_supplier_invoice_claim).
--   pur.supplier_invoice_line.supplier_claim_line_id
--                               a claim credit note's line, whose quantity and net are the claim line's rejected
--                               base quantity and claimed value by a composite foreign key. Its unit price is 0, since
--                               a claim line's value is a share of the delivery, not a quantity times a price; the
--                               check that a net is round(qty x price) is lifted for these lines only. The claim line
--                               belongs to the credit note's own claim (pur.supplier_claim_credit_line_guard, HK010).
-- Nothing here moves stock or posts: the credit note posts as every credit note does, when it is approved.
-- Additions to docs/data-model/pur.md: both tables and both columns.
-- Data category: CONFIDENTIAL (DC-11, what a supplier is owed).
-- Rollback: tested (`pnpm db:rollback`), safe before the first claim; afterwards forward fix only, since a credit
-- note drafted from a claim cannot satisfy the restored round(qty x price) check.

-- migrate:up
CREATE TABLE pur.supplier_claim (
  id                     uuid PRIMARY KEY CONSTRAINT fk_supplier_claim_document REFERENCES platform.business_document (id) ON DELETE RESTRICT,
  supplier_id            uuid NOT NULL CONSTRAINT fk_supplier_claim_supplier REFERENCES mdm.supplier (id) ON DELETE RESTRICT,
  purchase_order_id      uuid NOT NULL CONSTRAINT fk_supplier_claim_order REFERENCES pur.purchase_order (id) ON DELETE RESTRICT,
  goods_receipt_id       uuid NOT NULL CONSTRAINT fk_supplier_claim_receipt REFERENCES inv.goods_receipt (id) ON DELETE RESTRICT,
  received_by            uuid NOT NULL CONSTRAINT fk_supplier_claim_received_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  note                   text NULL CONSTRAINT ck_supplier_claim_note CHECK (length(btrim(note)) BETWEEN 1 AND 500),
  claimed_pesewas        platform.pesewas NOT NULL CONSTRAINT ck_supplier_claim_claimed CHECK (claimed_pesewas > 0),
  currency               char(3) NOT NULL DEFAULT 'GHS' CONSTRAINT ck_supplier_claim_currency CHECK (currency = 'GHS'),
  settlement             text NULL CONSTRAINT ck_supplier_claim_settlement CHECK (settlement IN ('INVOICE', 'CREDIT_NOTE')),
  settled_by_invoice_id  uuid NULL CONSTRAINT fk_supplier_claim_settled_by REFERENCES pur.supplier_invoice (id) ON DELETE RESTRICT,
  status                 text NOT NULL CONSTRAINT ck_supplier_claim_status CHECK (status IN ('OPEN', 'SETTLED')),
  branch_id              uuid NOT NULL CONSTRAINT fk_supplier_claim_branch REFERENCES mdm.branch (id) ON DELETE RESTRICT,
  version                integer NOT NULL DEFAULT 1,
  created_at             timestamptz NOT NULL,
  created_by             uuid NOT NULL CONSTRAINT fk_supplier_claim_created_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  updated_at             timestamptz NOT NULL,
  updated_by             uuid NOT NULL CONSTRAINT fk_supplier_claim_updated_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  posted_at              timestamptz NULL,
  posted_by              uuid NULL CONSTRAINT fk_supplier_claim_posted_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  CONSTRAINT ck_supplier_claim_settled CHECK (
    (status = 'SETTLED') = (settlement IS NOT NULL)
    AND (settlement IS NULL) = (settled_by_invoice_id IS NULL)
    AND (settlement IS NULL) = (posted_at IS NULL)
    AND (posted_at IS NULL) = (posted_by IS NULL))
);
COMMENT ON TABLE pur.supplier_claim IS 'class=DOCUMENT';
CREATE UNIQUE INDEX uq_supplier_claim_receipt ON pur.supplier_claim (goods_receipt_id);
CREATE INDEX ix_supplier_claim_supplier ON pur.supplier_claim (supplier_id, status, created_at);
CREATE INDEX ix_supplier_claim_order ON pur.supplier_claim (purchase_order_id);
CREATE INDEX ix_supplier_claim_branch ON pur.supplier_claim (branch_id, created_at);
CREATE TRIGGER trg_supplier_claim_version BEFORE UPDATE ON pur.supplier_claim
  FOR EACH ROW EXECUTE FUNCTION platform.touch_version();
CREATE TRIGGER trg_supplier_claim_freeze BEFORE UPDATE ON pur.supplier_claim
  FOR EACH ROW EXECUTE FUNCTION platform.freeze_posted('SETTLED');

CREATE TABLE pur.supplier_claim_line (
  id                       uuid PRIMARY KEY,
  supplier_claim_id        uuid NOT NULL CONSTRAINT fk_supplier_claim_line_claim REFERENCES pur.supplier_claim (id) ON DELETE RESTRICT,
  line_no                  integer NOT NULL CONSTRAINT ck_supplier_claim_line_no CHECK (line_no > 0),
  goods_receipt_line_id    uuid NOT NULL CONSTRAINT fk_supplier_claim_line_receipt_line REFERENCES inv.goods_receipt_line (id) ON DELETE RESTRICT,
  purchase_order_line_id   uuid NOT NULL CONSTRAINT fk_supplier_claim_line_order_line REFERENCES pur.purchase_order_line (id) ON DELETE RESTRICT,
  product_id               uuid NOT NULL CONSTRAINT fk_supplier_claim_line_product REFERENCES mdm.product (id) ON DELETE RESTRICT,
  rejection_reason_code    text NOT NULL CONSTRAINT fk_supplier_claim_line_reason REFERENCES mdm.reason_code (code) ON DELETE RESTRICT,
  qty_accepted_base        platform.qty NOT NULL CONSTRAINT ck_supplier_claim_line_accepted CHECK (qty_accepted_base >= 0),
  qty_rejected_base        platform.qty NOT NULL CONSTRAINT ck_supplier_claim_line_rejected CHECK (qty_rejected_base > 0),
  line_value_pesewas       platform.pesewas NOT NULL,
  accepted_value_pesewas   platform.pesewas NOT NULL,
  claimed_value_pesewas    platform.pesewas NOT NULL CONSTRAINT ck_supplier_claim_line_claimed CHECK (claimed_value_pesewas > 0),
  CONSTRAINT ck_supplier_claim_line_split CHECK (accepted_value_pesewas + claimed_value_pesewas = line_value_pesewas),
  CONSTRAINT uq_supplier_claim_line_no UNIQUE (supplier_claim_id, line_no),
  CONSTRAINT uq_supplier_claim_line_receipt_line UNIQUE (goods_receipt_line_id),
  -- The target of a claim credit note line's composite key: its quantity and net are this line's.
  CONSTRAINT uq_supplier_claim_line_credit UNIQUE (id, qty_rejected_base, claimed_value_pesewas)
);
COMMENT ON TABLE pur.supplier_claim_line IS 'class=DOCUMENT';
CREATE INDEX ix_supplier_claim_line_order_line ON pur.supplier_claim_line (purchase_order_line_id);
CREATE TRIGGER trg_supplier_claim_line_immutable BEFORE UPDATE OR DELETE ON pur.supplier_claim_line
  FOR EACH ROW EXECUTE FUNCTION platform.reject_change();

ALTER TABLE pur.supplier_invoice
  ADD COLUMN supplier_claim_id uuid NULL CONSTRAINT fk_supplier_invoice_claim REFERENCES pur.supplier_claim (id) ON DELETE RESTRICT,
  ADD CONSTRAINT ck_supplier_invoice_claim_kind CHECK (supplier_claim_id IS NULL OR kind = 'CREDIT_NOTE');
CREATE UNIQUE INDEX uq_supplier_invoice_claim ON pur.supplier_invoice (supplier_claim_id) WHERE supplier_claim_id IS NOT NULL AND status <> 'CANCELLED';

ALTER TABLE pur.supplier_invoice_line ADD COLUMN supplier_claim_line_id uuid NULL;
ALTER TABLE pur.supplier_invoice_line
  ADD CONSTRAINT fk_supplier_invoice_line_claim_line FOREIGN KEY (supplier_claim_line_id, qty_base, line_net_pesewas)
    REFERENCES pur.supplier_claim_line (id, qty_rejected_base, claimed_value_pesewas) ON DELETE RESTRICT,
  ADD CONSTRAINT ck_supplier_invoice_line_claim_price CHECK (supplier_claim_line_id IS NULL OR (unit_price_pesewas = 0 AND qty_base IS NOT NULL));
ALTER TABLE pur.supplier_invoice_line DROP CONSTRAINT ck_supplier_invoice_line_net;
ALTER TABLE pur.supplier_invoice_line ADD CONSTRAINT ck_supplier_invoice_line_net
  CHECK (supplier_claim_line_id IS NOT NULL OR line_net_pesewas = round(qty * unit_price_pesewas));
CREATE INDEX ix_supplier_invoice_line_claim_line ON pur.supplier_invoice_line (supplier_claim_line_id) WHERE supplier_claim_line_id IS NOT NULL;

-- The claim's total is its lines' claimed values, checked at commit (HK010).
CREATE FUNCTION pur.supplier_claim_total_check() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  claim_id uuid;
  total bigint;
  lines bigint;
BEGIN
  IF TG_TABLE_NAME = 'supplier_claim' THEN
    claim_id := (to_jsonb(NEW) ->> 'id')::uuid;
  ELSE
    claim_id := (to_jsonb(NEW) ->> 'supplier_claim_id')::uuid;
  END IF;
  SELECT c.claimed_pesewas INTO total FROM pur.supplier_claim c WHERE c.id = claim_id;
  SELECT COALESCE(sum(l.claimed_value_pesewas), 0) INTO lines FROM pur.supplier_claim_line l WHERE l.supplier_claim_id = claim_id;
  IF total IS DISTINCT FROM lines THEN
    RAISE EXCEPTION 'pur.supplier_claim %: claimed % is not the sum of its lines %', claim_id, total, lines USING ERRCODE = 'HK010';
  END IF;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION pur.supplier_claim_total_check() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER trg_supplier_claim_total AFTER INSERT ON pur.supplier_claim
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION pur.supplier_claim_total_check();
CREATE CONSTRAINT TRIGGER trg_supplier_claim_line_total AFTER INSERT ON pur.supplier_claim_line
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION pur.supplier_claim_total_check();

-- A claim is inserted OPEN and only its settlement changes, once (HK004); the settling document is the right one (HK010).
CREATE FUNCTION pur.supplier_claim_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  settling record;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'OPEN' THEN
      RAISE EXCEPTION 'pur.supplier_claim %: a claim starts OPEN', NEW.id USING ERRCODE = 'HK004';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.supplier_id, NEW.purchase_order_id, NEW.goods_receipt_id, NEW.received_by, NEW.note, NEW.claimed_pesewas, NEW.branch_id, NEW.created_at, NEW.created_by)
     IS DISTINCT FROM (OLD.supplier_id, OLD.purchase_order_id, OLD.goods_receipt_id, OLD.received_by, OLD.note, OLD.claimed_pesewas, OLD.branch_id, OLD.created_at, OLD.created_by) THEN
    RAISE EXCEPTION 'pur.supplier_claim %: only its settlement changes', NEW.id USING ERRCODE = 'HK004';
  END IF;
  IF NEW.status = 'OPEN' THEN
    RETURN NEW;
  END IF;
  SELECT i.kind, i.status, i.purchase_order_id, i.supplier_claim_id, i.posted_by INTO settling FROM pur.supplier_invoice i WHERE i.id = NEW.settled_by_invoice_id;
  IF NEW.settlement = 'INVOICE' AND NOT (settling.kind = 'INVOICE' AND settling.status IN ('APPROVED', 'PAID') AND settling.purchase_order_id = NEW.purchase_order_id) THEN
    RAISE EXCEPTION 'pur.supplier_claim %: settled by an invoice only when it is an approved invoice of the claim''s order', NEW.id USING ERRCODE = 'HK010';
  END IF;
  IF NEW.settlement = 'CREDIT_NOTE' AND NOT (settling.kind = 'CREDIT_NOTE' AND settling.status = 'APPROVED' AND settling.supplier_claim_id = NEW.id
                                             AND settling.posted_by <> NEW.created_by AND settling.posted_by <> NEW.received_by) THEN
    RAISE EXCEPTION 'pur.supplier_claim %: settled by a credit note only when its own credit note was approved by someone who neither raised the claim nor received the goods', NEW.id
      USING ERRCODE = 'HK010';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION pur.supplier_claim_guard() FROM PUBLIC;
CREATE TRIGGER trg_supplier_claim_guard BEFORE INSERT OR UPDATE ON pur.supplier_claim
  FOR EACH ROW EXECUTE FUNCTION pur.supplier_claim_guard();

-- A claim credit note's line belongs to that credit note's own claim (HK010).
CREATE FUNCTION pur.supplier_claim_credit_line_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  invoice_claim uuid;
  line_claim uuid;
BEGIN
  IF NEW.supplier_claim_line_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT i.supplier_claim_id INTO invoice_claim FROM pur.supplier_invoice i WHERE i.id = NEW.supplier_invoice_id;
  SELECT l.supplier_claim_id INTO line_claim FROM pur.supplier_claim_line l WHERE l.id = NEW.supplier_claim_line_id;
  IF invoice_claim IS DISTINCT FROM line_claim THEN
    RAISE EXCEPTION 'pur.supplier_invoice_line %: a claim line belongs on its own claim''s credit note', NEW.id USING ERRCODE = 'HK010';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION pur.supplier_claim_credit_line_guard() FROM PUBLIC;
CREATE TRIGGER trg_supplier_claim_credit_line_guard BEFORE INSERT OR UPDATE ON pur.supplier_invoice_line
  FOR EACH ROW EXECUTE FUNCTION pur.supplier_claim_credit_line_guard();

REVOKE ALL ON pur.supplier_claim, pur.supplier_claim_line FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON pur.supplier_claim, pur.supplier_claim_line TO hk_app, hk_worker;

-- migrate:down
DROP TRIGGER trg_supplier_claim_credit_line_guard ON pur.supplier_invoice_line;
DROP FUNCTION pur.supplier_claim_credit_line_guard();
DROP INDEX pur.ix_supplier_invoice_line_claim_line;
ALTER TABLE pur.supplier_invoice_line DROP CONSTRAINT ck_supplier_invoice_line_net;
ALTER TABLE pur.supplier_invoice_line ADD CONSTRAINT ck_supplier_invoice_line_net CHECK (line_net_pesewas = round(qty * unit_price_pesewas));
ALTER TABLE pur.supplier_invoice_line DROP CONSTRAINT ck_supplier_invoice_line_claim_price, DROP CONSTRAINT fk_supplier_invoice_line_claim_line;
ALTER TABLE pur.supplier_invoice_line DROP COLUMN supplier_claim_line_id;
DROP INDEX pur.uq_supplier_invoice_claim;
ALTER TABLE pur.supplier_invoice DROP CONSTRAINT ck_supplier_invoice_claim_kind;
ALTER TABLE pur.supplier_invoice DROP COLUMN supplier_claim_id;
DROP TABLE pur.supplier_claim_line;
DROP TABLE pur.supplier_claim;
DROP FUNCTION pur.supplier_claim_guard();
DROP FUNCTION pur.supplier_claim_total_check();
