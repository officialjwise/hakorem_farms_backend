-- 0354_fin_capital_postings
-- B12 (FR-CAP-003, FR-CAP-004, FR-CAP-011, FR-CAP-012, ADR-0003, ADR-0028): CAP's ◆ events with ADR-0003's rows. The bank
-- or mobile money account is the one the money arrived in or left, by its kind (PAYMENT_METHOD_KIND, PAYOUT: BANK 1100,
-- MOBILE_MONEY 1110), never cash (A-212 (a)); each investor is a subledger party of 3000, 3300 and 2300.
--   cap.CapitalContributed   Dr 1100 or 1110 the amount; Cr 3000 Investor capital against the investor
--   cap.CapitalWithdrawn     Dr 3000 against the investor; Cr 1100 or 1110
--   cap.DistributionDeclared Dr 3300 Distributions declared, each investor's allocation against them; Cr 2300 Distributions
--                            payable, each investor's net payable against them; Cr 2310 the tax withheld
--   cap.DistributionPaid     Dr 2300 against the investor; Cr 1100 or 1110
-- One entry per capital transaction, run and payment, ever (uq_journal_entry_cap_*).
-- Data category: CONFIDENTIAL (DC-09): the farm's books.
-- Rollback: tested (`pnpm db:rollback`), safe before the first capital posting; afterwards forward fix only (a posted
-- entry is never removed).

-- migrate:up
INSERT INTO fin.posting_event_type (code, owner_module, description, amount_keys) VALUES
  ('cap.CapitalContributed', 'cap', 'Capital paid in by an investor to the farm''s bank or mobile money account, issuing units', ARRAY['amount']),
  ('cap.CapitalWithdrawn', 'cap', 'Capital paid back to an investor after a second person approved it, redeeming units', ARRAY['amount']),
  ('cap.DistributionDeclared', 'cap', 'A profit distribution posted after a second person approved it: each investor''s share payable', ARRAY['allocated', 'netPayable', 'withheld']),
  ('cap.DistributionPaid', 'cap', 'A distribution paid to an investor from the farm''s bank or mobile money account', ARRAY['amount']);

INSERT INTO fin.posting_rule (id, event_code, amount_key, side, account_id, determinant_type, determinant_role, subledger_from, valid_from, created_by, updated_by)
SELECT ('01900000-0000-7000-8300-' || lpad(r.n::text, 12, '0'))::uuid, r.event, r.amount, r.side,
       CASE WHEN r.code IS NULL THEN NULL ELSE ('01900000-0000-7000-8100-00000000' || r.code)::uuid END, r.det_type, r.det_role, r.subledger, DATE '2020-01-01',
       '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001'
  FROM (VALUES
    (310, 'cap.CapitalContributed', 'amount', 'D', NULL, 'PAYMENT_METHOD_KIND', 'PAYOUT', 'bankAccountId'),
    (311, 'cap.CapitalContributed', 'amount', 'C', '3000', NULL, NULL, 'investorId'),
    (312, 'cap.CapitalWithdrawn', 'amount', 'D', '3000', NULL, NULL, 'investorId'),
    (313, 'cap.CapitalWithdrawn', 'amount', 'C', NULL, 'PAYMENT_METHOD_KIND', 'PAYOUT', 'bankAccountId'),
    (314, 'cap.DistributionDeclared', 'allocated', 'D', '3300', NULL, NULL, 'lines.investorId'),
    (315, 'cap.DistributionDeclared', 'netPayable', 'C', '2300', NULL, NULL, 'lines.investorId'),
    (316, 'cap.DistributionDeclared', 'withheld', 'C', '2310', NULL, NULL, NULL),
    (317, 'cap.DistributionPaid', 'amount', 'D', '2300', NULL, NULL, 'investorId'),
    (318, 'cap.DistributionPaid', 'amount', 'C', NULL, 'PAYMENT_METHOD_KIND', 'PAYOUT', 'bankAccountId')
  ) AS r (n, event, amount, side, code, det_type, det_role, subledger);

CREATE UNIQUE INDEX uq_journal_entry_cap_capital ON fin.journal_entry (event_subject_id) WHERE event_code IN ('cap.CapitalContributed', 'cap.CapitalWithdrawn');
CREATE UNIQUE INDEX uq_journal_entry_cap_distribution ON fin.journal_entry (event_subject_id) WHERE event_code = 'cap.DistributionDeclared';
CREATE UNIQUE INDEX uq_journal_entry_cap_distribution_payment ON fin.journal_entry (event_subject_id) WHERE event_code = 'cap.DistributionPaid';

-- migrate:down
DROP INDEX fin.uq_journal_entry_cap_distribution_payment;
DROP INDEX fin.uq_journal_entry_cap_distribution;
DROP INDEX fin.uq_journal_entry_cap_capital;
DELETE FROM fin.posting_rule WHERE event_code IN ('cap.CapitalContributed', 'cap.CapitalWithdrawn', 'cap.DistributionDeclared', 'cap.DistributionPaid');
DELETE FROM fin.posting_event_type WHERE code IN ('cap.CapitalContributed', 'cap.CapitalWithdrawn', 'cap.DistributionDeclared', 'cap.DistributionPaid');
