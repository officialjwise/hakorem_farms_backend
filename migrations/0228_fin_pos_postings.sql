-- 0228_fin_pos_postings
-- B9b (FR-POS-015, FR-POS-016, FR-POS-019, ADR-0003, A-273 (e)): the till's ◆ events. Cash only moves between the safe
-- and a till, or out of a till as a pay-out; a sale's cash is PAY's `pay.PaymentCleared` against the till.
--   pos.ShiftOpened   the opening float from the safe: Dr 1000 Cash on hand, tills against the register, Cr 1010 Cash, safe
--   pos.CashDropped   a drop to the safe: Dr 1010, Cr 1000 against the register
--   pos.CashPaidIn    the float topped up from the safe: Dr 1000 against the register, Cr 1010
--   pos.CashPaidOut   a pay-out from the till: Dr the expense its reason determines (EXPENSE_CATEGORY, 6800 by default),
--                     Cr 1000 against the register
--   pos.ShiftClosed   the signed-off count: Cr 1000 what the till should hold (expected) against the register, Dr 1010
--                     what was counted and returned to the safe, Dr 6900 Cash over and short when short, Cr 6900 when
--                     over (FR-POS-019's 1010 Dr 63,500, 6900 Dr 500, 1000 Cr 64,000)
-- Each posts once per subject (uq_journal_entry_pos_subject): a shift opened or closed, or a cash movement.
-- Data category: CONFIDENTIAL (DC-09): the farm's books.
-- Rollback: tested (`pnpm db:rollback`), safe before the first shift; afterwards forward fix only.

-- migrate:up
INSERT INTO fin.posting_event_type (code, owner_module, description, amount_keys) VALUES
  ('pos.ShiftOpened', 'pos', 'A till shift opened with its float from the safe', ARRAY['float']),
  ('pos.CashDropped', 'pos', 'Cash dropped from a till to the safe', ARRAY['drop']),
  ('pos.CashPaidIn', 'pos', 'A till''s float topped up from the safe', ARRAY['payIn']),
  ('pos.CashPaidOut', 'pos', 'Cash paid out of a till for an expense', ARRAY['payOut']),
  ('pos.ShiftClosed', 'pos', 'Shift closed with over or short', ARRAY['expected', 'returnedToSafe', 'over', 'short']);

INSERT INTO fin.posting_rule (id, event_code, amount_key, side, account_id, determinant_type, determinant_role, subledger_from, valid_from, created_by, updated_by)
SELECT ('01900000-0000-7000-8300-' || lpad(r.n::text, 12, '0'))::uuid, r.event, r.amount, r.side,
       CASE WHEN r.code IS NULL THEN NULL ELSE ('01900000-0000-7000-8100-00000000' || r.code)::uuid END,
       r.det_type, r.det_role, r.subledger, DATE '2020-01-01',
       '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001'
  FROM (VALUES
    (103, 'pos.ShiftOpened', 'float', 'D', '1000', NULL, NULL, 'register'),
    (104, 'pos.ShiftOpened', 'float', 'C', '1010', NULL, NULL, NULL),
    (105, 'pos.CashDropped', 'drop', 'D', '1010', NULL, NULL, NULL),
    (106, 'pos.CashDropped', 'drop', 'C', '1000', NULL, NULL, 'register'),
    (107, 'pos.CashPaidIn', 'payIn', 'D', '1000', NULL, NULL, 'register'),
    (108, 'pos.CashPaidIn', 'payIn', 'C', '1010', NULL, NULL, NULL),
    (109, 'pos.CashPaidOut', 'payOut', 'D', NULL, 'EXPENSE_CATEGORY', 'EXPENSE', NULL),
    (110, 'pos.CashPaidOut', 'payOut', 'C', '1000', NULL, NULL, 'register'),
    (111, 'pos.ShiftClosed', 'expected', 'C', '1000', NULL, NULL, 'register'),
    (112, 'pos.ShiftClosed', 'returnedToSafe', 'D', '1010', NULL, NULL, NULL),
    (113, 'pos.ShiftClosed', 'short', 'D', '6900', NULL, NULL, NULL),
    (114, 'pos.ShiftClosed', 'over', 'C', '6900', NULL, NULL, NULL)
  ) AS r (n, event, amount, side, code, det_type, det_role, subledger);

CREATE UNIQUE INDEX uq_journal_entry_pos_subject ON fin.journal_entry (event_code, event_subject_id)
  WHERE event_code IN ('pos.ShiftOpened', 'pos.CashDropped', 'pos.CashPaidIn', 'pos.CashPaidOut', 'pos.ShiftClosed');

-- migrate:down
DROP INDEX fin.uq_journal_entry_pos_subject;
DELETE FROM fin.posting_rule WHERE event_code IN ('pos.ShiftOpened', 'pos.CashDropped', 'pos.CashPaidIn', 'pos.CashPaidOut', 'pos.ShiftClosed');
DELETE FROM fin.posting_event_type WHERE code IN ('pos.ShiftOpened', 'pos.CashDropped', 'pos.CashPaidIn', 'pos.CashPaidOut', 'pos.ShiftClosed');
