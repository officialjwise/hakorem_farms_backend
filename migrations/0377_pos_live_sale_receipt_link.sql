-- 0377_pos_live_sale_receipt_link
-- B12 continued 5 (BL-133; the owner, 2026-11-24, A-396; the parent session's leave in POS, 2026-11-25; ADR-0083
-- Amendments, A-398): every till sale where the buyer gave a phone number gets the receipt text, online or offline, and
-- the text links only the till's own receipt (ADR-0084). A live counter sale's till now makes its link as an offline one
-- does: `completeCounterSale` takes the till's token and, in the sale's own transaction, stores its hash in
-- `pos.receipt_link`, or records its refusal in `pos.receipt_token_refusal`, through the store the synced sale uses.
-- 0292's guards admitted only a sale applied at sync (`ck_receipt_link_synced`, `ck_receipt_token_refusal_synced`).
-- Expand only: each guard is 0292's, with one more case admitted, a live sale's own row, and nothing else:
--   a registered document (the foreign key) other than the shift itself that no sync ever logged (no `pos.sale_sync`
--   row of any outcome), on an OPEN shift, the row written by that shift's cashier; a link's `issued_at` is its
--   `recorded_at` (a live sale is posted at the server's time).
-- A live sale is what POS can see without naming another module's table (ADR-0011, MODULE_BOUNDARIES section 7's data
-- check 2): that the document is the sale just posted is the application's, which writes the row only in the sale's own
-- transaction, after ORD's `SalePosting` registered it.
-- Every other rule of 0292 stands unchanged: the device of the shift's till at the branch, one TILL link per sale
-- (`uq_receipt_link_sale`), one sale per token (`uq_receipt_link_token`), the twelve-month expiry, the refusal's bound
-- sale holding a link of the hash and the refused sale holding none, every row immutable.
--   pos.receipt_link_guard          0292's, also admitting a live sale's own link
--   pos.receipt_token_refusal_guard 0292's, also admitting a live sale's own refusal
-- Nothing here reads now() (ADR-0067). Data category: unchanged (DC-43 for the hashes, DC-22 for the tenders).
-- Rollback: tested (`pnpm db:rollback`): restores 0292's guards. Before the first live link only; afterwards a live
-- sale's rows are evidence and only a forward fix is safe.

-- migrate:up
CREATE OR REPLACE FUNCTION pos.receipt_link_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pos.shift s JOIN pos.device_enrolment d ON d.register_id = s.register_id
                  WHERE s.id = NEW.shift_id AND d.id = NEW.device_id AND s.branch_id = NEW.branch_id) THEN
    RAISE EXCEPTION 'pos.receipt_link %: shift % is not of the till device % is enrolled on', NEW.id, NEW.shift_id, NEW.device_id
      USING ERRCODE = 'HK010', CONSTRAINT = 'ck_receipt_link_device_shift';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pos.sale_sync y
                  WHERE y.order_document_id = NEW.order_document_id AND y.shift_id = NEW.shift_id
                    AND y.outcome IN ('APPLIED', 'APPLIED_WITH_EXCEPTION'))
     AND NOT (NEW.issued_at = NEW.recorded_at AND (NEW.order_document_id <> NEW.shift_id
              AND NOT EXISTS (SELECT 1 FROM pos.sale_sync y WHERE y.order_document_id = NEW.order_document_id)
              AND EXISTS (SELECT 1 FROM pos.shift s WHERE s.id = NEW.shift_id AND s.branch_id = NEW.branch_id AND s.status = 'OPEN' AND s.cashier_id = NEW.actor_id))) THEN
    RAISE EXCEPTION 'pos.receipt_link %: sale % is not applied on shift %, nor sold live on it by its cashier', NEW.id, NEW.order_document_id, NEW.shift_id
      USING ERRCODE = 'HK010', CONSTRAINT = 'ck_receipt_link_synced';
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION pos.receipt_token_refusal_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pos.shift s JOIN pos.device_enrolment d ON d.register_id = s.register_id
                  WHERE s.id = NEW.shift_id AND d.id = NEW.device_id AND s.branch_id = NEW.branch_id AND s.cashier_id = NEW.cashier_id) THEN
    RAISE EXCEPTION 'pos.receipt_token_refusal %: shift % is not the cashier''s shift on the till device % is enrolled on', NEW.order_document_id, NEW.shift_id, NEW.device_id
      USING ERRCODE = 'HK010', CONSTRAINT = 'ck_receipt_token_refusal_device_shift';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pos.sale_sync y
                  WHERE y.order_document_id = NEW.order_document_id AND y.shift_id = NEW.shift_id
                    AND y.outcome IN ('APPLIED', 'APPLIED_WITH_EXCEPTION'))
     AND NOT (NEW.order_document_id <> NEW.shift_id
              AND NOT EXISTS (SELECT 1 FROM pos.sale_sync y WHERE y.order_document_id = NEW.order_document_id)
              AND EXISTS (SELECT 1 FROM pos.shift s WHERE s.id = NEW.shift_id AND s.branch_id = NEW.branch_id AND s.status = 'OPEN' AND s.cashier_id = NEW.actor_id)) THEN
    RAISE EXCEPTION 'pos.receipt_token_refusal %: the sale is not applied on shift %, nor sold live on it by its cashier', NEW.order_document_id, NEW.shift_id
      USING ERRCODE = 'HK010', CONSTRAINT = 'ck_receipt_token_refusal_synced';
  END IF;
  IF NEW.reason = 'TOKEN_ALREADY_BOUND' AND NOT EXISTS (
       SELECT 1 FROM pos.receipt_link l WHERE l.order_document_id = NEW.bound_order_document_id AND l.token_hash = NEW.token_hash) THEN
    RAISE EXCEPTION 'pos.receipt_token_refusal %: sale % holds no link of this token', NEW.order_document_id, NEW.bound_order_document_id
      USING ERRCODE = 'HK010', CONSTRAINT = 'ck_receipt_token_refusal_bound';
  END IF;
  IF EXISTS (SELECT 1 FROM pos.receipt_link l WHERE l.order_document_id = NEW.order_document_id) THEN
    RAISE EXCEPTION 'pos.receipt_token_refusal %: the sale already holds a link', NEW.order_document_id
      USING ERRCODE = 'HK010', CONSTRAINT = 'ck_receipt_token_refusal_unlinked';
  END IF;
  RETURN NEW;
END
$$;

-- migrate:down
CREATE OR REPLACE FUNCTION pos.receipt_token_refusal_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pos.shift s JOIN pos.device_enrolment d ON d.register_id = s.register_id
                  WHERE s.id = NEW.shift_id AND d.id = NEW.device_id AND s.branch_id = NEW.branch_id AND s.cashier_id = NEW.cashier_id) THEN
    RAISE EXCEPTION 'pos.receipt_token_refusal %: shift % is not the cashier''s shift on the till device % is enrolled on', NEW.order_document_id, NEW.shift_id, NEW.device_id
      USING ERRCODE = 'HK010', CONSTRAINT = 'ck_receipt_token_refusal_device_shift';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pos.sale_sync y
                  WHERE y.order_document_id = NEW.order_document_id AND y.shift_id = NEW.shift_id
                    AND y.outcome IN ('APPLIED', 'APPLIED_WITH_EXCEPTION')) THEN
    RAISE EXCEPTION 'pos.receipt_token_refusal %: the sale is not applied on shift %', NEW.order_document_id, NEW.shift_id
      USING ERRCODE = 'HK010', CONSTRAINT = 'ck_receipt_token_refusal_synced';
  END IF;
  IF NEW.reason = 'TOKEN_ALREADY_BOUND' AND NOT EXISTS (
       SELECT 1 FROM pos.receipt_link l WHERE l.order_document_id = NEW.bound_order_document_id AND l.token_hash = NEW.token_hash) THEN
    RAISE EXCEPTION 'pos.receipt_token_refusal %: sale % holds no link of this token', NEW.order_document_id, NEW.bound_order_document_id
      USING ERRCODE = 'HK010', CONSTRAINT = 'ck_receipt_token_refusal_bound';
  END IF;
  IF EXISTS (SELECT 1 FROM pos.receipt_link l WHERE l.order_document_id = NEW.order_document_id) THEN
    RAISE EXCEPTION 'pos.receipt_token_refusal %: the sale already holds a link', NEW.order_document_id
      USING ERRCODE = 'HK010', CONSTRAINT = 'ck_receipt_token_refusal_unlinked';
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION pos.receipt_link_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pos.shift s JOIN pos.device_enrolment d ON d.register_id = s.register_id
                  WHERE s.id = NEW.shift_id AND d.id = NEW.device_id AND s.branch_id = NEW.branch_id) THEN
    RAISE EXCEPTION 'pos.receipt_link %: shift % is not of the till device % is enrolled on', NEW.id, NEW.shift_id, NEW.device_id
      USING ERRCODE = 'HK010', CONSTRAINT = 'ck_receipt_link_device_shift';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pos.sale_sync y
                  WHERE y.order_document_id = NEW.order_document_id AND y.shift_id = NEW.shift_id
                    AND y.outcome IN ('APPLIED', 'APPLIED_WITH_EXCEPTION')) THEN
    RAISE EXCEPTION 'pos.receipt_link %: sale % is not applied on shift %', NEW.id, NEW.order_document_id, NEW.shift_id
      USING ERRCODE = 'HK010', CONSTRAINT = 'ck_receipt_link_synced';
  END IF;
  RETURN NEW;
END
$$;
