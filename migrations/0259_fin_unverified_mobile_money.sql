-- 0259_fin_unverified_mobile_money
-- B09b continued 2c (OFFLINE_SYNC 9.9, ADR-0003, ADR-0027 principle 8, A-279 (h)): where an unverified offline mobile
-- money tender is held until it is matched. pay.PaymentCleared marked `unverified` debits its tender by the determinant
-- UNVERIFIED_MOBILE_MONEY, which takes 1110 Mobile money wallets against the farm's wallet (a BANK_ACCOUNT party), as
-- OFFLINE_SYNC 9.9 shows, and never 1120 Payment provider clearing: no provider took it. One new determination row; no
-- existing rule or row changes. The id sits in lane A's block (280), so a parallel lane's next row cannot collide.
-- Data category: CONFIDENTIAL (DC-09): the farm's books.
-- Rollback: tested (`pnpm db:rollback`) before the first unverified tender posts; afterwards forward fix only.

-- migrate:up
INSERT INTO fin.account_determination (id, determinant_type, determinant_key, role, account_id, valid_from, created_by, updated_by) VALUES
  ('01900000-0000-7000-8200-000000000280', 'PAYMENT_METHOD_KIND', 'UNVERIFIED_MOBILE_MONEY', 'TENDER', '01900000-0000-7000-8100-000000001110', DATE '2020-01-01',
   '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001');

-- migrate:down
DELETE FROM fin.account_determination WHERE id = '01900000-0000-7000-8200-000000000280';
