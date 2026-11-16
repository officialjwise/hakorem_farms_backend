-- 0173_fin_pay_receipt_postings
-- B09a continued 1b (FR-PAY-001, FR-PAY-011, FR-PAY-014, FR-PAY-015, ADR-0003, ADR-0056, ADR-0064, A-212): the tender
-- accounts of a cheque and of store credit, and PAY's two further ◆ events with ADR-0003's rows:
--   pay.PaymentCleared   a cheque debits 1130 Cheques awaiting clearance (no party) when it is received; store credit
--                        redeemed debits 2210 Store credit against the customer
--   pay.ChequeCleared    Dr 1100 against the bank account the cheque was paid into, Cr 1130, once per cheque
--   pay.PaymentReversed  "Reverse of the original": the mirror of an earlier entry, its lines copied with every side
--                        swapped (ADR-0056). It carries no amount keys and has no rules: an event type with an empty
--                        key list posts only as a REVERSAL of the entry its subject names, and the ledger refuses it
--                        otherwise (ck_posting_event_type_keys now admits the empty list)
--   pay.RefundPaid       a refund to store credit credits 2210 against the customer: its tender is STORE_CREDIT
-- Bank transfer (1100), suspense (2290), provider fees (6910) and the refund against a credit note (Dr 1200) are
-- seeded by B09a continued 1c, which builds them (A-213).
--   uq_journal_entry_cheque_cleared   one clearing entry per cheque, ever
-- Data category: CONFIDENTIAL (DC-09): the farm's books.
-- Rollback: tested (`pnpm db:rollback`), safe before the first cheque, reversal or store credit; afterwards forward fix only.

-- migrate:up
ALTER TABLE fin.posting_event_type DROP CONSTRAINT ck_posting_event_type_keys;
ALTER TABLE fin.posting_event_type ADD CONSTRAINT ck_posting_event_type_keys CHECK (array_position(amount_keys, NULL) IS NULL AND (cardinality(amount_keys) > 0 OR code = 'pay.PaymentReversed'));

INSERT INTO fin.posting_event_type (code, owner_module, description, amount_keys) VALUES
  ('pay.ChequeCleared', 'pay', 'A cheque awaiting clearance cleared at the bank', ARRAY['cheque']),
  ('pay.PaymentReversed', 'pay', 'A payment reversed: the mirror of the entry it reverses', ARRAY[]::text[]);

INSERT INTO fin.account_determination (id, determinant_type, determinant_key, role, account_id, valid_from, created_by, updated_by) VALUES
  ('01900000-0000-7000-8200-000000000039', 'PAYMENT_METHOD_KIND', 'CHEQUE', 'TENDER', '01900000-0000-7000-8100-000000001130', DATE '2020-01-01',
   '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001'),
  ('01900000-0000-7000-8200-000000000040', 'PAYMENT_METHOD_KIND', 'STORE_CREDIT', 'TENDER', '01900000-0000-7000-8100-000000002210', DATE '2020-01-01',
   '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001');

INSERT INTO fin.posting_rule (id, event_code, amount_key, side, account_id, determinant_type, determinant_role, subledger_from, valid_from, created_by, updated_by)
SELECT ('01900000-0000-7000-8300-' || lpad(r.n::text, 12, '0'))::uuid, r.event, r.amount, r.side,
       ('01900000-0000-7000-8100-00000000' || r.code)::uuid, NULL, NULL, r.subledger, DATE '2020-01-01',
       '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001'
  FROM (VALUES
    (93, 'pay.ChequeCleared', 'cheque', 'D', '1100', 'bankAccountId'),
    (94, 'pay.ChequeCleared', 'cheque', 'C', '1130', NULL)
  ) AS r (n, event, amount, side, code, subledger);

CREATE UNIQUE INDEX uq_journal_entry_cheque_cleared ON fin.journal_entry (source_document_id) WHERE event_code = 'pay.ChequeCleared';

-- migrate:down
DROP INDEX fin.uq_journal_entry_cheque_cleared;
DELETE FROM fin.posting_rule WHERE event_code = 'pay.ChequeCleared';
DELETE FROM fin.account_determination WHERE id IN ('01900000-0000-7000-8200-000000000039', '01900000-0000-7000-8200-000000000040');
DELETE FROM fin.posting_event_type WHERE code IN ('pay.ChequeCleared', 'pay.PaymentReversed');
ALTER TABLE fin.posting_event_type DROP CONSTRAINT ck_posting_event_type_keys;
ALTER TABLE fin.posting_event_type ADD CONSTRAINT ck_posting_event_type_keys CHECK (cardinality(amount_keys) > 0);
