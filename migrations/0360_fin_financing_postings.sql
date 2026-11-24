-- 0360_fin_financing_postings
-- B12 continued (FR-CAP-015, ADR-0003, ADR-0101): CAP's loan and grant events with ADR-0003's rows, and the grant's
-- recognition ADR-0101 adds. The bank or mobile money account is the one the money arrived in or left, by its kind
-- (PAYMENT_METHOD_KIND, PAYOUT: BANK 1100, MOBILE_MONEY 1110), never cash (A-212 (a)). The lender is an INVESTOR
-- subledger party of 2400: the registered investor when they are one, else the financing itself (ADR-0101).
--   cap.LoanDrawn        Dr 1100 or 1110 the principal; Cr 2400 Loans payable against the lender
--   cap.GrantReceived    Dr 1100 or 1110 the grant; Cr 2450 Deferred grant income
--   cap.InterestAccrued  Dr 6930 Interest expense; Cr 2410 Accrued interest (a month's interest, on its last day)
--   cap.GrantRecognised  Dr 2450 Deferred grant income; Cr 4910 Grant income (a month's part, on its last day)
--   cap.LoanRepaid       Dr 2400 the principal against the lender; Dr 2410 the interest; Cr 1100 or 1110 the total
-- One entry per financing, accrual and repayment, ever (uq_journal_entry_cap_financing*).
-- Data category: CONFIDENTIAL (DC-09): the farm's books.
-- Rollback: tested (`pnpm db:rollback`), safe before the first financing posting; afterwards forward fix only.

-- migrate:up
INSERT INTO fin.posting_event_type (code, owner_module, description, amount_keys) VALUES
  ('cap.LoanDrawn', 'cap', 'A loan drawn into the farm''s bank or mobile money account after a second person approved it', ARRAY['amount']),
  ('cap.GrantReceived', 'cap', 'A grant received into the farm''s bank or mobile money account after a second person approved it, deferred', ARRAY['amount']),
  ('cap.InterestAccrued', 'cap', 'A month''s simple interest on a loan, accrued on the month''s last day', ARRAY['amount']),
  ('cap.GrantRecognised', 'cap', 'A month''s part of a grant recognised as income on the month''s last day', ARRAY['amount']),
  ('cap.LoanRepaid', 'cap', 'A repayment of a loan from the farm''s bank or mobile money account, interest first', ARRAY['principal', 'interest', 'amount']);

INSERT INTO fin.posting_rule (id, event_code, amount_key, side, account_id, determinant_type, determinant_role, subledger_from, valid_from, created_by, updated_by)
SELECT ('01900000-0000-7000-8300-' || lpad(r.n::text, 12, '0'))::uuid, r.event, r.amount, r.side,
       CASE WHEN r.code IS NULL THEN NULL ELSE ('01900000-0000-7000-8100-00000000' || r.code)::uuid END, r.det_type, r.det_role, r.subledger, DATE '2020-01-01',
       '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001'
  FROM (VALUES
    (319, 'cap.LoanDrawn', 'amount', 'D', NULL, 'PAYMENT_METHOD_KIND', 'PAYOUT', 'bankAccountId'),
    (320, 'cap.LoanDrawn', 'amount', 'C', '2400', NULL, NULL, 'lenderPartyId'),
    (321, 'cap.GrantReceived', 'amount', 'D', NULL, 'PAYMENT_METHOD_KIND', 'PAYOUT', 'bankAccountId'),
    (322, 'cap.GrantReceived', 'amount', 'C', '2450', NULL, NULL, NULL),
    (323, 'cap.InterestAccrued', 'amount', 'D', '6930', NULL, NULL, NULL),
    (324, 'cap.InterestAccrued', 'amount', 'C', '2410', NULL, NULL, NULL),
    (325, 'cap.GrantRecognised', 'amount', 'D', '2450', NULL, NULL, NULL),
    (326, 'cap.GrantRecognised', 'amount', 'C', '4910', NULL, NULL, NULL),
    (327, 'cap.LoanRepaid', 'principal', 'D', '2400', NULL, NULL, 'lenderPartyId'),
    (328, 'cap.LoanRepaid', 'interest', 'D', '2410', NULL, NULL, NULL),
    (329, 'cap.LoanRepaid', 'amount', 'C', NULL, 'PAYMENT_METHOD_KIND', 'PAYOUT', 'bankAccountId')
  ) AS r (n, event, amount, side, code, det_type, det_role, subledger);

CREATE UNIQUE INDEX uq_journal_entry_cap_financing ON fin.journal_entry (event_subject_id) WHERE event_code IN ('cap.LoanDrawn', 'cap.GrantReceived');
CREATE UNIQUE INDEX uq_journal_entry_cap_financing_accrual ON fin.journal_entry (event_subject_id) WHERE event_code IN ('cap.InterestAccrued', 'cap.GrantRecognised');
CREATE UNIQUE INDEX uq_journal_entry_cap_financing_repayment ON fin.journal_entry (event_subject_id) WHERE event_code = 'cap.LoanRepaid';

-- migrate:down
DROP INDEX fin.uq_journal_entry_cap_financing_repayment;
DROP INDEX fin.uq_journal_entry_cap_financing_accrual;
DROP INDEX fin.uq_journal_entry_cap_financing;
DELETE FROM fin.posting_rule WHERE event_code IN ('cap.LoanDrawn', 'cap.GrantReceived', 'cap.InterestAccrued', 'cap.GrantRecognised', 'cap.LoanRepaid');
DELETE FROM fin.posting_event_type WHERE code IN ('cap.LoanDrawn', 'cap.GrantReceived', 'cap.InterestAccrued', 'cap.GrantRecognised', 'cap.LoanRepaid');
