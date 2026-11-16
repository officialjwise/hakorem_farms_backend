-- 0167_fin_pay_provider_postings
-- B09a continued (FR-PAY-003, FR-PAY-009, FR-PAY-010, FR-PAY-012, ADR-0003, ADR-0056, A-210): the tender account of a
-- provider payment, and PAY's two further ◆ events with ADR-0003's rows:
--   pay.PaymentCleared   mobile money and card debit 1120 Payment provider clearing, against the provider that took
--                        them (settled to the bank by pay.ProviderSettled, B09a continued 1b)
--   pay.DepositAllocated applied: Dr 2200 Cr 1200, both against the customer (a deposit allocated to a billing
--                        document); unapplied: Dr 1200 Cr 2200 (an allocation taken off, the money back on deposit)
--   pay.RefundPaid       Dr 2200 the refunded deposit, against the customer; Cr the original payment's tender account by
--                        its method's kind, against its till or provider
-- A refund against a credit note (Dr 1200) and to store credit (Cr 2210), bank transfer (1100), cheques (1130), suspense
-- (2290) and provider fees (6910) are seeded by B09a continued 1b, which builds them (A-211).
--   uq_journal_entry_refund   one payout entry per refund, ever
-- Data category: CONFIDENTIAL (DC-09): the farm's books.
-- Rollback: tested (`pnpm db:rollback`), safe before the first provider payment; afterwards forward fix only.

-- migrate:up
INSERT INTO fin.posting_event_type (code, owner_module, description, amount_keys) VALUES
  ('pay.DepositAllocated', 'pay', 'A cleared payment applied to a billing document from deposit, or an allocation taken off back to deposit', ARRAY['applied', 'unapplied']),
  ('pay.RefundPaid', 'pay', 'A refund paid out of a customer deposit to the original payment''s method', ARRAY['refund']);

INSERT INTO fin.account_determination (id, determinant_type, determinant_key, role, account_id, valid_from, created_by, updated_by) VALUES
  ('01900000-0000-7000-8200-000000000037', 'PAYMENT_METHOD_KIND', 'MOBILE_MONEY', 'TENDER', '01900000-0000-7000-8100-000000001120', DATE '2020-01-01',
   '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001'),
  ('01900000-0000-7000-8200-000000000038', 'PAYMENT_METHOD_KIND', 'CARD', 'TENDER', '01900000-0000-7000-8100-000000001120', DATE '2020-01-01',
   '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001');

INSERT INTO fin.posting_rule (id, event_code, amount_key, side, account_id, determinant_type, determinant_role, subledger_from, valid_from, created_by, updated_by)
SELECT ('01900000-0000-7000-8300-' || lpad(r.n::text, 12, '0'))::uuid, r.event, r.amount, r.side,
       CASE WHEN r.code IS NULL THEN NULL ELSE ('01900000-0000-7000-8100-00000000' || r.code)::uuid END,
       r.det_type, r.det_role, r.subledger, DATE '2020-01-01', '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001'
  FROM (VALUES
    (87, 'pay.DepositAllocated', 'applied', 'D', '2200', NULL, NULL, 'customerId'),
    (88, 'pay.DepositAllocated', 'applied', 'C', '1200', NULL, NULL, 'customerId'),
    (89, 'pay.DepositAllocated', 'unapplied', 'D', '1200', NULL, NULL, 'customerId'),
    (90, 'pay.DepositAllocated', 'unapplied', 'C', '2200', NULL, NULL, 'customerId'),
    (91, 'pay.RefundPaid', 'refund', 'D', '2200', NULL, NULL, 'customerId'),
    (92, 'pay.RefundPaid', 'refund', 'C', NULL, 'PAYMENT_METHOD_KIND', 'TENDER', 'register or provider')
  ) AS r (n, event, amount, side, code, det_type, det_role, subledger);

CREATE UNIQUE INDEX uq_journal_entry_refund ON fin.journal_entry (source_document_id) WHERE event_code = 'pay.RefundPaid';

-- migrate:down
DROP INDEX fin.uq_journal_entry_refund;
DELETE FROM fin.posting_rule WHERE event_code IN ('pay.DepositAllocated', 'pay.RefundPaid');
DELETE FROM fin.account_determination WHERE id IN ('01900000-0000-7000-8200-000000000037', '01900000-0000-7000-8200-000000000038');
DELETE FROM fin.posting_event_type WHERE code IN ('pay.DepositAllocated', 'pay.RefundPaid');
