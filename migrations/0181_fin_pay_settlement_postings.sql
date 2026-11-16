-- 0181_fin_pay_settlement_postings
-- B09a continued 1c (FR-PAY-005, FR-PAY-010, FR-PAY-016, FR-PAY-017, ADR-0003, ADR-0056, ADR-0065, A-214): the bank
-- transfer's tender account and PAY's two further ◆ events:
--   pay.PaymentCleared            a bank transfer, cleared by the statement line matched to it, debits 1100 Bank accounts
--                                 against the bank account it landed in (its tender determination, ADR-0003)
--   pay.ProviderSettled           ADR-0003's row: Dr 1100 the net against the bank account the provider paid into, Dr
--                                 6910 Payment provider fees the fee, Cr 1120 the gross against the provider; once per
--                                 settlement report (uq_journal_entry_provider_settled)
--   pay.UnidentifiedReceiptHeld   a break resolved, on a second person's approval, as money from a payer nobody can name:
--                                 Dr 1100 what reached the bank against its account, Dr 6910 any provider fee, Cr 2290
--                                 Suspense, unidentified receipts the whole (ADR-0003's "2290 if the payer is unknown");
--                                 once per settlement or statement line (uq_journal_entry_unidentified_receipt)
-- Data category: CONFIDENTIAL (DC-09): the farm's books.
-- Rollback: tested (`pnpm db:rollback`), safe before the first settlement or transfer cleared; afterwards forward fix only.

-- migrate:up
INSERT INTO fin.posting_event_type (code, owner_module, description, amount_keys) VALUES
  ('pay.ProviderSettled', 'pay', 'A payment provider paid out the payments a settlement report matched, less its fee', ARRAY['net', 'fee', 'gross']),
  ('pay.UnidentifiedReceiptHeld', 'pay', 'Money from a payer nobody can name held in suspense on an approved break resolution', ARRAY['banked', 'fee', 'held']);

INSERT INTO fin.account_determination (id, determinant_type, determinant_key, role, account_id, valid_from, created_by, updated_by) VALUES
  ('01900000-0000-7000-8200-000000000041', 'PAYMENT_METHOD_KIND', 'BANK_TRANSFER', 'TENDER', '01900000-0000-7000-8100-000000001100', DATE '2020-01-01',
   '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001');

INSERT INTO fin.posting_rule (id, event_code, amount_key, side, account_id, determinant_type, determinant_role, subledger_from, valid_from, created_by, updated_by)
SELECT ('01900000-0000-7000-8300-' || lpad(r.n::text, 12, '0'))::uuid, r.event, r.amount, r.side,
       ('01900000-0000-7000-8100-00000000' || r.code)::uuid, NULL, NULL, r.subledger, DATE '2020-01-01',
       '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001'
  FROM (VALUES
    (95, 'pay.ProviderSettled', 'net', 'D', '1100', 'bankAccountId'),
    (96, 'pay.ProviderSettled', 'fee', 'D', '6910', NULL),
    (97, 'pay.ProviderSettled', 'gross', 'C', '1120', 'provider'),
    (98, 'pay.UnidentifiedReceiptHeld', 'banked', 'D', '1100', 'bankAccountId'),
    (99, 'pay.UnidentifiedReceiptHeld', 'fee', 'D', '6910', NULL),
    (100, 'pay.UnidentifiedReceiptHeld', 'held', 'C', '2290', NULL)
  ) AS r (n, event, amount, side, code, subledger);

CREATE UNIQUE INDEX uq_journal_entry_provider_settled ON fin.journal_entry (source_document_id) WHERE event_code = 'pay.ProviderSettled';
CREATE UNIQUE INDEX uq_journal_entry_unidentified_receipt ON fin.journal_entry (event_subject_id) WHERE event_code = 'pay.UnidentifiedReceiptHeld';

-- migrate:down
DROP INDEX fin.uq_journal_entry_unidentified_receipt;
DROP INDEX fin.uq_journal_entry_provider_settled;
DELETE FROM fin.posting_rule WHERE event_code IN ('pay.ProviderSettled', 'pay.UnidentifiedReceiptHeld');
DELETE FROM fin.account_determination WHERE id = '01900000-0000-7000-8200-000000000041';
DELETE FROM fin.posting_event_type WHERE code IN ('pay.ProviderSettled', 'pay.UnidentifiedReceiptHeld');
