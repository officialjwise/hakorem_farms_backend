-- 0146_mdm_billing_reason_codes
-- B08 continued 2 (FR-BIL-007, FR-MDM-011, A-200): a debit note carries a reason from the fixed list like every other
-- correction. The list had none for a charge added to an issued invoice, so the domain BILLING_ADJUSTMENT is added
-- with two reasons. A credit note takes a REFUND or RETURN reason, which the list already holds.
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`), safe before the first debit note.

-- migrate:up
ALTER TABLE mdm.reason_code DROP CONSTRAINT ck_reason_code_domain;
ALTER TABLE mdm.reason_code ADD CONSTRAINT ck_reason_code_domain CHECK (domain IN (
  'STOCK_ADJUSTMENT', 'MORTALITY', 'CULL', 'WASTAGE', 'PRICE_OVERRIDE', 'VOID', 'REFUND', 'RETURN',
  'CANCELLATION', 'DELIVERY_FAILURE', 'CASH_MOVEMENT', 'HOLD_RELEASE', 'BILLING_ADJUSTMENT'));

INSERT INTO mdm.reason_code (code, domain, description, requires_note, loss_account_group) VALUES
  ('UNDERCHARGED', 'BILLING_ADJUSTMENT', 'Customer was undercharged', true, NULL),
  ('CHARGE_OMITTED', 'BILLING_ADJUSTMENT', 'A charge was left off the invoice', true, NULL);

-- migrate:down
DELETE FROM mdm.reason_code WHERE code IN ('UNDERCHARGED', 'CHARGE_OMITTED');
ALTER TABLE mdm.reason_code DROP CONSTRAINT ck_reason_code_domain;
ALTER TABLE mdm.reason_code ADD CONSTRAINT ck_reason_code_domain CHECK (domain IN (
  'STOCK_ADJUSTMENT', 'MORTALITY', 'CULL', 'WASTAGE', 'PRICE_OVERRIDE', 'VOID', 'REFUND', 'RETURN',
  'CANCELLATION', 'DELIVERY_FAILURE', 'CASH_MOVEMENT', 'HOLD_RELEASE'));
