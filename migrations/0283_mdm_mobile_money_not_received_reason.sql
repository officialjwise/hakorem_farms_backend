-- 0283_mdm_mobile_money_not_received_reason
-- B09b continued 3c (OFFLINE_SYNC 9.9, the owner's decision 3 of 2026-11-18, A-282 (d)): an unverified offline mobile
-- money tender the provider never paid is reversed under approval with its own reason, never as a dishonoured cheque.
-- One new PAYMENT_REVERSAL reason, needing a note (the statement or the provider's answer that shows no such payment).
-- No existing row changes.
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`), safe before the first such reversal.

-- migrate:up
INSERT INTO mdm.reason_code (code, domain, description, requires_note, loss_account_group) VALUES
  ('MOBILE_MONEY_NOT_RECEIVED', 'PAYMENT_REVERSAL', 'Mobile money taken offline that the provider never paid', true, NULL);

-- migrate:down
DELETE FROM mdm.reason_code WHERE code = 'MOBILE_MONEY_NOT_RECEIVED';
