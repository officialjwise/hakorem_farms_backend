-- 0273_fin_bad_debt_postings
-- B10 continued 3 (FR-WHL-012, ADR-0003, ADR-0090): WHL's ◆ event with ADR-0003's row:
--   whl.BadDebtWrittenOff   Dr 6940 Bad debts the amount written off; Cr 1200 Trade receivables against the customer
--   uq_journal_entry_bad_debt   one entry per write-off, ever
-- Data category: CONFIDENTIAL (DC-09): the farm's books.
-- Rollback: tested (`pnpm db:rollback`), safe before the first write-off; afterwards forward fix only (a posted entry
-- is never removed).

-- migrate:up
INSERT INTO fin.posting_event_type (code, owner_module, description, amount_keys) VALUES
  ('whl.BadDebtWrittenOff', 'whl', 'An open item written off as bad debt after a second person approved it: the amount to bad debts, off receivables', ARRAY['amount']);

INSERT INTO fin.posting_rule (id, event_code, amount_key, side, account_id, determinant_type, determinant_role, subledger_from, valid_from, created_by, updated_by)
SELECT ('01900000-0000-7000-8300-' || lpad(r.n::text, 12, '0'))::uuid, r.event, r.amount, r.side,
       ('01900000-0000-7000-8100-00000000' || r.code)::uuid, NULL, NULL, r.subledger, DATE '2020-01-01',
       '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001'
  FROM (VALUES
    (150, 'whl.BadDebtWrittenOff', 'amount', 'D', '6940', NULL),
    (151, 'whl.BadDebtWrittenOff', 'amount', 'C', '1200', 'customerId')
  ) AS r (n, event, amount, side, code, subledger);

CREATE UNIQUE INDEX uq_journal_entry_bad_debt ON fin.journal_entry (event_subject_id) WHERE event_code = 'whl.BadDebtWrittenOff';

-- migrate:down
DROP INDEX fin.uq_journal_entry_bad_debt;
DELETE FROM fin.posting_rule WHERE event_code = 'whl.BadDebtWrittenOff';
DELETE FROM fin.posting_event_type WHERE code = 'whl.BadDebtWrittenOff';
