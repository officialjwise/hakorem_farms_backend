-- 0315_fin_driver_cash_remitted_postings
-- B11 continued 2 (FR-DEL-010, ADR-0003's matrix, ADR-0092, CR-057): a driver's cash on delivery handed in at a till
-- shift moves from what the driver holds into the till that counted it; a count short of it, or over, is the driver's
-- variance on 6900, as a till's own over and short are:
--   del.DriverCashRemitted  received: Dr 1000 Cash on hand against the till (REGISTER) that counted it
--                           expected: Cr 1020 Cash held by drivers against the driver (DRIVER), every collection handed in
--                           short:    Dr 6900 Cash over and short
--                           over:     Cr 6900 Cash over and short
--                           Balanced by construction (received + short = expected + over). Once per reconciliation
--                           (uq_journal_entry_driver_cash_remitted).
-- New rows only; no existing rule, account or determination changes.
-- Data category: CONFIDENTIAL (DC-09): the farm's books.
-- Rollback: tested (`pnpm db:rollback`) before the first hand-in posts; afterwards forward fix only.

-- migrate:up
INSERT INTO fin.posting_event_type (code, owner_module, description, amount_keys) VALUES
  ('del.DriverCashRemitted', 'del', 'A driver''s cash on delivery handed in at a till shift, with the driver''s variance', ARRAY['received', 'expected', 'short', 'over']);

INSERT INTO fin.posting_rule (id, event_code, amount_key, side, account_id, determinant_type, determinant_role, subledger_from, valid_from, created_by, updated_by)
SELECT ('01900000-0000-7000-8300-' || lpad(r.n::text, 12, '0'))::uuid, r.event, r.amount, r.side,
       ('01900000-0000-7000-8100-00000000' || r.code)::uuid, NULL, NULL, r.subledger, DATE '2020-01-01',
       '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001'
  FROM (VALUES
    (294, 'del.DriverCashRemitted', 'received', 'D', '1000', 'register'),
    (295, 'del.DriverCashRemitted', 'expected', 'C', '1020', 'driverId'),
    (296, 'del.DriverCashRemitted', 'short', 'D', '6900', NULL),
    (297, 'del.DriverCashRemitted', 'over', 'C', '6900', NULL)
  ) AS r (n, event, amount, side, code, subledger);

CREATE UNIQUE INDEX uq_journal_entry_driver_cash_remitted ON fin.journal_entry (event_subject_id) WHERE event_code = 'del.DriverCashRemitted';

-- migrate:down
DROP INDEX fin.uq_journal_entry_driver_cash_remitted;
DELETE FROM fin.posting_rule WHERE event_code = 'del.DriverCashRemitted';
DELETE FROM fin.posting_event_type WHERE code = 'del.DriverCashRemitted';
