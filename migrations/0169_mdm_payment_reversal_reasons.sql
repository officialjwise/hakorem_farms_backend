-- 0169_mdm_payment_reversal_reasons
-- B09a continued 1b (FR-PAY-011, FR-PAY-014, FR-MDM-011, A-212): a payment reversal carries a reason from the fixed list
-- like every other correction. The list had none, so the domain PAYMENT_REVERSAL is added with two reasons, each
-- needing a note: a cheque the bank returned unpaid (the bounce), and a payment recorded in error.
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`), safe before the first payment reversal.

-- migrate:up
ALTER TABLE mdm.reason_code DROP CONSTRAINT ck_reason_code_domain;
ALTER TABLE mdm.reason_code ADD CONSTRAINT ck_reason_code_domain CHECK (domain IN (
  'STOCK_ADJUSTMENT', 'MORTALITY', 'CULL', 'WASTAGE', 'PRICE_OVERRIDE', 'VOID', 'REFUND', 'RETURN',
  'CANCELLATION', 'DELIVERY_FAILURE', 'CASH_MOVEMENT', 'HOLD_RELEASE', 'BILLING_ADJUSTMENT', 'PAYMENT_REVERSAL'));

INSERT INTO mdm.reason_code (code, domain, description, requires_note, loss_account_group) VALUES
  ('CHEQUE_DISHONOURED', 'PAYMENT_REVERSAL', 'Cheque returned unpaid by the bank', true, NULL),
  ('RECORDED_IN_ERROR', 'PAYMENT_REVERSAL', 'Payment recorded in error', true, NULL);

-- migrate:down
DELETE FROM mdm.reason_code WHERE code IN ('CHEQUE_DISHONOURED', 'RECORDED_IN_ERROR');
ALTER TABLE mdm.reason_code DROP CONSTRAINT ck_reason_code_domain;
ALTER TABLE mdm.reason_code ADD CONSTRAINT ck_reason_code_domain CHECK (domain IN (
  'STOCK_ADJUSTMENT', 'MORTALITY', 'CULL', 'WASTAGE', 'PRICE_OVERRIDE', 'VOID', 'REFUND', 'RETURN',
  'CANCELLATION', 'DELIVERY_FAILURE', 'CASH_MOVEMENT', 'HOLD_RELEASE', 'BILLING_ADJUSTMENT'));
