-- 0302_mdm_dispatch_and_cod_reasons
-- B11 continued (FR-ORD-011, FR-DEL-009, ADR-0021, A-338, A-340; FR-MDM-011): two reasons the fixed list lacked.
--   WEIGHED_BELOW_PAID  REFUND: the weighed total came to less than the customer paid ahead; dispatch asks for the
--                       difference back to the original method (ADR-0021's settlement, "a defined refund reason").
--   COD_VARIANCE        a new domain: why a driver collected less than the amount due on delivery (FR-DEL-009, "a
--                       collected amount different from the amount due needs a reason and is flagged").
--                       CUSTOMER_PAID_SHORT (a note needed: what the customer said) and CUSTOMER_PAYS_LATER (a note needed:
--                       how the rest will be paid). A driver never collects more than is due (A-340).
--   mdm.reason_code_domain  a published read-only function (ADR-0047): the domain of a reason code, null for none; DEL's
--                       proof guard (0303) calls it, so no other schema reads mdm.reason_code.
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`), safe while no refund or proof names a new code.

-- migrate:up
ALTER TABLE mdm.reason_code DROP CONSTRAINT ck_reason_code_domain;
ALTER TABLE mdm.reason_code ADD CONSTRAINT ck_reason_code_domain CHECK (domain IN (
  'STOCK_ADJUSTMENT', 'MORTALITY', 'CULL', 'WASTAGE', 'PRICE_OVERRIDE', 'VOID', 'REFUND', 'RETURN',
  'CANCELLATION', 'DELIVERY_FAILURE', 'CASH_MOVEMENT', 'HOLD_RELEASE', 'BILLING_ADJUSTMENT', 'PAYMENT_REVERSAL',
  'GOODS_RECEIPT_REJECTION', 'COD_VARIANCE'));

INSERT INTO mdm.reason_code (code, domain, description, requires_note, loss_account_group) VALUES
  ('WEIGHED_BELOW_PAID', 'REFUND', 'The weighed total came to less than was paid', false, NULL),
  ('CUSTOMER_PAID_SHORT', 'COD_VARIANCE', 'The customer paid less than was due on delivery', true, NULL),
  ('CUSTOMER_PAYS_LATER', 'COD_VARIANCE', 'The customer will pay the rest later', true, NULL)
ON CONFLICT (code) DO NOTHING;

CREATE FUNCTION mdm.reason_code_domain(p_code text) RETURNS text
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
  SELECT r.domain FROM mdm.reason_code r WHERE r.code = p_code;
$$;
REVOKE ALL ON FUNCTION mdm.reason_code_domain(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mdm.reason_code_domain(text) TO hk_app, hk_worker;

-- migrate:down
DROP FUNCTION mdm.reason_code_domain(text);
DELETE FROM mdm.reason_code WHERE code IN ('WEIGHED_BELOW_PAID', 'CUSTOMER_PAID_SHORT', 'CUSTOMER_PAYS_LATER');
ALTER TABLE mdm.reason_code DROP CONSTRAINT ck_reason_code_domain;
ALTER TABLE mdm.reason_code ADD CONSTRAINT ck_reason_code_domain CHECK (domain IN (
  'STOCK_ADJUSTMENT', 'MORTALITY', 'CULL', 'WASTAGE', 'PRICE_OVERRIDE', 'VOID', 'REFUND', 'RETURN',
  'CANCELLATION', 'DELIVERY_FAILURE', 'CASH_MOVEMENT', 'HOLD_RELEASE', 'BILLING_ADJUSTMENT', 'PAYMENT_REVERSAL',
  'GOODS_RECEIPT_REJECTION'));
