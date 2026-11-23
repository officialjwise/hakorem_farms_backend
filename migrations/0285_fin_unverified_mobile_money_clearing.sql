-- 0285_fin_unverified_mobile_money_clearing
-- B09b continued 3c (the owner's decision 3 of 2026-11-18, ADR-0003 Amendments, A-282): an unverified offline mobile
-- money tender is booked to its own clearing account until verified, never straight to 1110, the way a cheque waits
-- in 1130. 1120 Payment provider clearing holds provider-cleared receipts awaiting settlement against the provider, not
-- a payment nobody has confirmed, so a new account:
--   1115 Mobile money awaiting verification (asset, debit, against the wallet it is expected in: BANK_ACCOUNT)
--   pay.PaymentCleared marked `unverified` debits its tender by the new determinant MOBILE_MONEY_AWAITING_VERIFICATION,
--                      which takes 1115 (determination 281). 0263's UNVERIFIED_MOBILE_MONEY row (1110) stays as data
--                      and is no longer named by any posting.
--   pay.UnverifiedPaymentVerified  verified: Dr 1110 Mobile money wallets, Cr 1115, both against the wallet, exactly
--                      once per verification (uq_journal_entry_unverified_verified), and so once per payment.
-- A tender reversed as never received mirrors its receipt (pay.PaymentReversed): Dr 1200, Cr 1115; 1110 is never touched.
-- New rows only; no existing rule, account or determination changes.
-- Data category: CONFIDENTIAL (DC-09): the farm's books.
-- Rollback: tested (`pnpm db:rollback`) before the first unverified tender posts to 1115; afterwards forward fix only.

-- migrate:up
INSERT INTO fin.account (id, code, name, type, normal_side, is_postable, subledger_kind, cash_flow_category, status, created_by, updated_by) VALUES
  ('01900000-0000-7000-8100-000000001115', '1115', 'Mobile money awaiting verification', 'ASSET', 'D', true, 'BANK_ACCOUNT', NULL, 'ACTIVE',
   '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001');

INSERT INTO fin.account_determination (id, determinant_type, determinant_key, role, account_id, valid_from, created_by, updated_by) VALUES
  ('01900000-0000-7000-8200-000000000281', 'PAYMENT_METHOD_KIND', 'MOBILE_MONEY_AWAITING_VERIFICATION', 'TENDER', '01900000-0000-7000-8100-000000001115', DATE '2020-01-01',
   '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001');

INSERT INTO fin.posting_event_type (code, owner_module, description, amount_keys) VALUES
  ('pay.UnverifiedPaymentVerified', 'pay', 'An unverified offline mobile money tender confirmed by the provider, moved to the wallet', ARRAY['verified']);

INSERT INTO fin.posting_rule (id, event_code, amount_key, side, account_id, determinant_type, determinant_role, subledger_from, valid_from, created_by, updated_by)
SELECT ('01900000-0000-7000-8300-' || lpad(r.n::text, 12, '0'))::uuid, r.event, r.amount, r.side,
       ('01900000-0000-7000-8100-00000000' || r.code)::uuid, NULL, NULL, r.subledger, DATE '2020-01-01',
       '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001'
  FROM (VALUES
    (284, 'pay.UnverifiedPaymentVerified', 'verified', 'D', '1110', 'bankAccountId'),
    (285, 'pay.UnverifiedPaymentVerified', 'verified', 'C', '1115', 'bankAccountId')
  ) AS r (n, event, amount, side, code, subledger);

CREATE UNIQUE INDEX uq_journal_entry_unverified_verified ON fin.journal_entry (event_subject_id) WHERE event_code = 'pay.UnverifiedPaymentVerified';

-- migrate:down
DROP INDEX fin.uq_journal_entry_unverified_verified;
DELETE FROM fin.posting_rule WHERE event_code = 'pay.UnverifiedPaymentVerified';
DELETE FROM fin.posting_event_type WHERE code = 'pay.UnverifiedPaymentVerified';
DELETE FROM fin.account_determination WHERE id = '01900000-0000-7000-8200-000000000281';
DELETE FROM fin.account WHERE id = '01900000-0000-7000-8100-000000001115';
