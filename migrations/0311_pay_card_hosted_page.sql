-- 0311_pay_card_hosted_page
-- B09c (FR-PAY-003, FR-PAY-005, FR-PAY-008, A-287, ADR-0063): card is an online payment on Paystack's hosted page, so
-- no card number, expiry or security code ever reaches this server. A card charge is a `pay.provider_transaction`
-- (channel CARD) written INITIATED with the payment, before Paystack hears of it; once the transaction has committed
-- the page is opened (`POST /transaction/initialize`, channels card only) and its address kept, so a replay hands the
-- same page back and never opens a second one under a new reference.
--   page_url                                  the hosted page's address, Paystack's checkout host only (never an open
--                                             redirect), on a card charge only; written once, never changed
--   ck_provider_transaction_card_network      a card charge names no mobile money network
--   trg_provider_transaction_page             the page's address is written once, while the charge is still open
--   ck_reconciliation_break_kind              adds PROVIDER_PAID_AFTER_FAILURE (a card paid on its page after its
--                                             payment had failed; nothing posted, a person refunds it) and
--                                             PROVIDER_DISPUTE_OPENED (a chargeback the provider confirmed; nothing
--                                             posted, a person answers it), both abuse case 45
-- Data category: CONFIDENTIAL (DC-09). The page's address carries Paystack's access code for one payment, which lets
-- anyone holding it pay that payment and nothing else; it is handed to the guest who placed the order.
-- Rollback: tested (`pnpm db:rollback`), safe before the first card payment or break of the two new kinds; afterwards
-- forward fix only (leave the column and the kinds).

-- migrate:up
ALTER TABLE pay.provider_transaction
  ADD COLUMN page_url text NULL
    CONSTRAINT ck_provider_transaction_page_url CHECK (page_url ~ '^https://checkout\.paystack\.com/[A-Za-z0-9]{6,64}$'),
  ADD CONSTRAINT ck_provider_transaction_page_card CHECK (page_url IS NULL OR (channel = 'CARD' AND kind = 'CHARGE')),
  ADD CONSTRAINT ck_provider_transaction_card_network CHECK (channel IS DISTINCT FROM 'CARD' OR network IS NULL);

CREATE FUNCTION pay.provider_transaction_page_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.page_url IS NOT NULL THEN
      RAISE EXCEPTION 'pay.provider_transaction %: a card page is opened after its charge is written', NEW.id USING ERRCODE = 'HK004', CONSTRAINT = 'ck_provider_transaction_page';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.page_url IS DISTINCT FROM OLD.page_url
     AND (OLD.page_url IS NOT NULL OR OLD.status NOT IN ('INITIATED', 'PENDING')) THEN
    RAISE EXCEPTION 'pay.provider_transaction %: a card page''s address is written once, while its charge is open', OLD.id USING ERRCODE = 'HK004', CONSTRAINT = 'ck_provider_transaction_page';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION pay.provider_transaction_page_guard() FROM PUBLIC;
CREATE TRIGGER trg_provider_transaction_page BEFORE INSERT OR UPDATE ON pay.provider_transaction
  FOR EACH ROW EXECUTE FUNCTION pay.provider_transaction_page_guard();

ALTER TABLE pay.reconciliation_break DROP CONSTRAINT ck_reconciliation_break_kind;
ALTER TABLE pay.reconciliation_break ADD CONSTRAINT ck_reconciliation_break_kind CHECK (kind IN (
  'UNMATCHED_PAYMENT', 'UNVERIFIED_PAYMENT', 'PROVIDER_AMOUNT_DIFFERS', 'PROVIDER_REFERENCE_UNKNOWN',
  'PROVIDER_PAYMENT_MISSING', 'SETTLEMENT_AMOUNT_DIFFERS', 'SETTLEMENT_NOT_FOUND', 'BANK_LINE_UNMATCHED',
  'LEDGER_CASH_DIFFERS', 'REFUND_FAILED', 'PROVIDER_PAID_AFTER_FAILURE', 'PROVIDER_DISPUTE_OPENED'));

-- migrate:down
ALTER TABLE pay.reconciliation_break DROP CONSTRAINT ck_reconciliation_break_kind;
ALTER TABLE pay.reconciliation_break ADD CONSTRAINT ck_reconciliation_break_kind CHECK (kind IN (
  'UNMATCHED_PAYMENT', 'UNVERIFIED_PAYMENT', 'PROVIDER_AMOUNT_DIFFERS', 'PROVIDER_REFERENCE_UNKNOWN',
  'PROVIDER_PAYMENT_MISSING', 'SETTLEMENT_AMOUNT_DIFFERS', 'SETTLEMENT_NOT_FOUND', 'BANK_LINE_UNMATCHED',
  'LEDGER_CASH_DIFFERS', 'REFUND_FAILED'));
DROP TRIGGER trg_provider_transaction_page ON pay.provider_transaction;
DROP FUNCTION pay.provider_transaction_page_guard();
ALTER TABLE pay.provider_transaction
  DROP CONSTRAINT ck_provider_transaction_card_network,
  DROP CONSTRAINT ck_provider_transaction_page_card,
  DROP COLUMN page_url;
