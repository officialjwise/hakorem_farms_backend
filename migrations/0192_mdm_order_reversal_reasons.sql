-- 0192_mdm_order_reversal_reasons
-- B09a continued 2c (FR-ORD-014, FR-MDM-011, A-226): two reasons the order reversals need from the fixed list. A
-- cancelled order's refund of what it was paid takes the REFUND reason ORDER_CANCELLED; a voided sale's payment is
-- reversed with the PAYMENT_REVERSAL reason SALE_VOIDED (the void's own reason and note are on the void). Neither needs
-- a note of its own: the cancellation's and the void's reason and note say why.
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`), safe before the first cancellation or void.

-- migrate:up
INSERT INTO mdm.reason_code (code, domain, description, requires_note, loss_account_group) VALUES
  ('ORDER_CANCELLED', 'REFUND', 'Order cancelled before fulfilment', false, NULL),
  ('SALE_VOIDED', 'PAYMENT_REVERSAL', 'The sale it paid for was voided', false, NULL);

-- migrate:down
DELETE FROM mdm.reason_code WHERE code IN ('ORDER_CANCELLED', 'SALE_VOIDED');
