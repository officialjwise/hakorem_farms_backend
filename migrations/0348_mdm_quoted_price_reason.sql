-- 0348_mdm_quoted_price_reason
-- B11u (the owner, 2026-11-23, UAT scenario 2: "post list price to sales (4000) and the difference to price variance
-- (4210), above or below list"; A-310 (a) reversed in the booking only, A-350; FR-MDM-011): a converted quote's order
-- line now keeps the list price its quote line recorded at issue beside the quoted price it agreed, so the difference is
-- a variance, which `ck_sales_order_line_variance` holds must carry a reason. The buyer agreed the price on the quote
-- (approved at its margin step where it had to be, FR-QUO-005), so the server records it under this reason.
--   QUOTED_PRICE  a new domain of its own, never PRICE_OVERRIDE: no seller's list of override reasons offers it (the
--                 till's offline pack and the console read PRICE_OVERRIDE), and the sale path and createOrder refuse any
--                 reason outside PRICE_OVERRIDE (`VARIANCE_REASON_INVALID`), so only a quote's conversion records it.
-- Data category: none (a lookup row).
-- Rollback: tested (`pnpm db:rollback`), safe while no order line names the code (its foreign key restricts the
-- delete; afterwards forward fix only: leave the row and the domain).

-- migrate:up
ALTER TABLE mdm.reason_code DROP CONSTRAINT ck_reason_code_domain;
ALTER TABLE mdm.reason_code ADD CONSTRAINT ck_reason_code_domain CHECK (domain IN (
  'STOCK_ADJUSTMENT', 'MORTALITY', 'CULL', 'WASTAGE', 'PRICE_OVERRIDE', 'VOID', 'REFUND', 'RETURN',
  'CANCELLATION', 'DELIVERY_FAILURE', 'CASH_MOVEMENT', 'HOLD_RELEASE', 'BILLING_ADJUSTMENT', 'PAYMENT_REVERSAL',
  'GOODS_RECEIPT_REJECTION', 'COD_VARIANCE', 'QUOTED_PRICE'));

INSERT INTO mdm.reason_code (code, domain, description, requires_note, loss_account_group) VALUES
  ('QUOTED_PRICE', 'QUOTED_PRICE', 'The price agreed on an accepted quote, against the list price it recorded at issue', false, NULL)
ON CONFLICT (code) DO NOTHING;

-- migrate:down
DELETE FROM mdm.reason_code WHERE code = 'QUOTED_PRICE';
ALTER TABLE mdm.reason_code DROP CONSTRAINT ck_reason_code_domain;
ALTER TABLE mdm.reason_code ADD CONSTRAINT ck_reason_code_domain CHECK (domain IN (
  'STOCK_ADJUSTMENT', 'MORTALITY', 'CULL', 'WASTAGE', 'PRICE_OVERRIDE', 'VOID', 'REFUND', 'RETURN',
  'CANCELLATION', 'DELIVERY_FAILURE', 'CASH_MOVEMENT', 'HOLD_RELEASE', 'BILLING_ADJUSTMENT', 'PAYMENT_REVERSAL',
  'GOODS_RECEIPT_REJECTION', 'COD_VARIANCE'));
