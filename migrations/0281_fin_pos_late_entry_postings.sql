-- 0281_fin_pos_late_entry_postings
-- B09b continued 3b (ADR-0003 Amendments, ADR-0077 Amendments, the owner on 2026-11-18): the post-close adjustment of
-- a late entry on a till shift. A late entry's own cash posts as any cash does (pay.PaymentCleared Dr 1000 against the
-- till, or the movement's pos.CashDropped, pos.CashPaidIn or pos.CashPaidOut); the close counted the drawer without it,
-- so the shift's over or short moves by exactly its amount:
--   pos.ShiftLateEntryPosted  short: Dr 6900 Cash over and short, Cr 1000 Cash on hand against the register (a sale's
--                             cash or a pay-in that never reached the count); over: Dr 1000 against the register,
--                             Cr 6900 (a drop or a pay-out the count already missed).
-- Each posts once per late entry (uq_journal_entry_pos_late_entry). New rows only; no existing rule or row changes.
-- The rule ids sit in lane A's block (280 to 283), so a parallel lane's next rows cannot collide.
-- Data category: CONFIDENTIAL (DC-09): the farm's books.
-- Rollback: tested (`pnpm db:rollback`) before the first late entry posts; afterwards forward fix only.

-- migrate:up
INSERT INTO fin.posting_event_type (code, owner_module, description, amount_keys) VALUES
  ('pos.ShiftLateEntryPosted', 'pos', 'A late entry on a closed till shift moved its over or short', ARRAY['short', 'over']);

INSERT INTO fin.posting_rule (id, event_code, amount_key, side, account_id, determinant_type, determinant_role, subledger_from, valid_from, created_by, updated_by)
SELECT ('01900000-0000-7000-8300-' || lpad(r.n::text, 12, '0'))::uuid, r.event, r.amount, r.side,
       ('01900000-0000-7000-8100-00000000' || r.code)::uuid, NULL, NULL, r.subledger, DATE '2020-01-01',
       '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001'
  FROM (VALUES
    (280, 'pos.ShiftLateEntryPosted', 'short', 'D', '6900', NULL),
    (281, 'pos.ShiftLateEntryPosted', 'short', 'C', '1000', 'register'),
    (282, 'pos.ShiftLateEntryPosted', 'over', 'D', '1000', 'register'),
    (283, 'pos.ShiftLateEntryPosted', 'over', 'C', '6900', NULL)
  ) AS r (n, event, amount, side, code, subledger);

CREATE UNIQUE INDEX uq_journal_entry_pos_late_entry ON fin.journal_entry (event_code, event_subject_id)
  WHERE event_code = 'pos.ShiftLateEntryPosted';

-- migrate:down
DROP INDEX fin.uq_journal_entry_pos_late_entry;
DELETE FROM fin.posting_rule WHERE event_code = 'pos.ShiftLateEntryPosted';
DELETE FROM fin.posting_event_type WHERE code = 'pos.ShiftLateEntryPosted';
