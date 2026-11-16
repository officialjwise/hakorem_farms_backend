-- 0162_fin_payment_postings
-- B9a (FR-PAY-001, FR-PAY-010, ADR-0003, ADR-0056, A-208): PAY's first ◆ event joins the posting catalogue with
-- ADR-0003's row:
--   pay.PaymentCleared   Dr the tender account by the method's kind (cash: 1000 against the till that took it); Cr 1200
--                        the part allocated to a billing document, against its customer (the walk-in party if none); Cr
--                        2200 the part left unallocated, against the customer.
-- Only the cash tender's determination is seeded: a method kind with no row fails its posting and rolls the payment
-- back, so mobile money, card, bank transfer, cheque and store credit post only once the session that clears them
-- seeds their accounts (1120, 1100, 1130, 2210) and an unknown payer's 2290 (A-209).
--   uq_journal_entry_payment   one clearing entry per payment, ever
-- Data category: CONFIDENTIAL (DC-09): the farm's books.
-- Rollback: tested (`pnpm db:rollback`), safe before the first payment; afterwards forward fix only.

-- migrate:up
INSERT INTO fin.posting_event_type (code, owner_module, description, amount_keys) VALUES
  ('pay.PaymentCleared', 'pay', 'A payment cleared: the tender received, the part allocated off receivables, the rest held as a customer deposit',
   ARRAY['tender', 'allocated', 'unallocated']);

INSERT INTO fin.account_determination (id, determinant_type, determinant_key, role, account_id, valid_from, created_by, updated_by) VALUES
  ('01900000-0000-7000-8200-000000000036', 'PAYMENT_METHOD_KIND', 'CASH', 'TENDER', '01900000-0000-7000-8100-000000001000', DATE '2020-01-01',
   '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001');

INSERT INTO fin.posting_rule (id, event_code, amount_key, side, account_id, determinant_type, determinant_role, subledger_from, valid_from, created_by, updated_by)
SELECT ('01900000-0000-7000-8300-' || lpad(r.n::text, 12, '0'))::uuid, r.event, r.amount, r.side,
       CASE WHEN r.code IS NULL THEN NULL ELSE ('01900000-0000-7000-8100-00000000' || r.code)::uuid END,
       r.det_type, r.det_role, r.subledger, DATE '2020-01-01', '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001'
  FROM (VALUES
    (84, 'pay.PaymentCleared', 'tender', 'D', NULL, 'PAYMENT_METHOD_KIND', 'TENDER', 'register'),
    (85, 'pay.PaymentCleared', 'allocated', 'C', '1200', NULL, NULL, 'customerId'),
    (86, 'pay.PaymentCleared', 'unallocated', 'C', '2200', NULL, NULL, 'customerId')
  ) AS r (n, event, amount, side, code, det_type, det_role, subledger);

CREATE UNIQUE INDEX uq_journal_entry_payment ON fin.journal_entry (source_document_id) WHERE event_code = 'pay.PaymentCleared';

-- migrate:down
DROP INDEX fin.uq_journal_entry_payment;
DELETE FROM fin.posting_rule WHERE event_code = 'pay.PaymentCleared';
DELETE FROM fin.account_determination WHERE id = '01900000-0000-7000-8200-000000000036';
DELETE FROM fin.posting_event_type WHERE code = 'pay.PaymentCleared';
