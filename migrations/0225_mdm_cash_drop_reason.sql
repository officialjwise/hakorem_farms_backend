-- 0225_mdm_cash_drop_reason
-- B9b (FR-POS-016, A-273 (c)): the reason a cash drop carries. FR-POS-016 refuses a drop without a reason, and the
-- fixed CASH_MOVEMENT list held only pay-out and pay-in reasons. A drop moves cash from the till to the safe.
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`); refused by the foreign key once a drop names it, which is why 0226 is rolled
-- back first.

-- migrate:up
INSERT INTO mdm.reason_code (code, domain, description, requires_note, loss_account_group) VALUES
  ('SAFE_DROP', 'CASH_MOVEMENT', 'Cash taken from the till to the safe', false, NULL);

-- migrate:down
DELETE FROM mdm.reason_code WHERE code = 'SAFE_DROP';
