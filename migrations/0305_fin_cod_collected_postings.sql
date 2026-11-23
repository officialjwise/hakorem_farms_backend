-- 0305_fin_cod_collected_postings
-- B11 continued (FR-DEL-009, ADR-0003's matrix row `del.CodCollected`, A-339): cash collected on delivery is held by the
-- driver who took it until it is handed in at a till shift (B11 continued 2):
--   del.CodCollected   Dr 1020 Cash held by drivers, against the driver (DRIVER); Cr 1200, against the customer (the
--                      walk-in party if none), for the amount collected, which PAY allocates to the delivery's invoice.
--                      Once per proof of delivery (uq_journal_entry_cod_collected).
-- New rows only; no existing rule, account or determination changes.
-- Data category: CONFIDENTIAL (DC-09): the farm's books.
-- Rollback: tested (`pnpm db:rollback`) before the first collection posts; afterwards forward fix only.

-- migrate:up
INSERT INTO fin.posting_event_type (code, owner_module, description, amount_keys) VALUES
  ('del.CodCollected', 'del', 'Cash collected on delivery, held by the driver and taken off the customer''s receivable', ARRAY['collected']);

INSERT INTO fin.posting_rule (id, event_code, amount_key, side, account_id, determinant_type, determinant_role, subledger_from, valid_from, created_by, updated_by)
SELECT ('01900000-0000-7000-8300-' || lpad(r.n::text, 12, '0'))::uuid, r.event, r.amount, r.side,
       ('01900000-0000-7000-8100-00000000' || r.code)::uuid, NULL, NULL, r.subledger, DATE '2020-01-01',
       '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001'
  FROM (VALUES
    (292, 'del.CodCollected', 'collected', 'D', '1020', 'driverId'),
    (293, 'del.CodCollected', 'collected', 'C', '1200', 'customerId')
  ) AS r (n, event, amount, side, code, subledger);

CREATE UNIQUE INDEX uq_journal_entry_cod_collected ON fin.journal_entry (event_subject_id) WHERE event_code = 'del.CodCollected';

-- migrate:down
DROP INDEX fin.uq_journal_entry_cod_collected;
DELETE FROM fin.posting_rule WHERE event_code = 'del.CodCollected';
DELETE FROM fin.posting_event_type WHERE code = 'del.CodCollected';
