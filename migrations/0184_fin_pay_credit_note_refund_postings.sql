-- 0184_fin_pay_credit_note_refund_postings
-- B09a continued 1d (FR-PAY-012, ADR-0003, ADR-0056, ADR-0066, A-216): ADR-0003's `pay.RefundPaid` row reads "Dr 1200 or
-- 2200, Cr the tender account". A refund out of a deposit keeps its amount key `refund` (Dr 2200). A refund against a
-- credit note is paid out of receivables, the money the credit note left owed to the customer:
--   pay.RefundPaid creditRefund   Dr 1200 against the customer (or the walk-in party); Cr the original payment's tender
--                                 account by its method's kind, against its till or provider, or 2210 to store credit,
--                                 or 1100 against the bank account for a cheque's bank payout (tender BANK_TRANSFER)
-- One payout entry per refund, ever, as before (uq_journal_entry_refund).
-- Data category: CONFIDENTIAL (DC-09): the farm's books.
-- Rollback: tested (`pnpm db:rollback`), safe before the first refund against a credit note; afterwards forward fix only.

-- migrate:up
UPDATE fin.posting_event_type
   SET amount_keys = ARRAY['refund', 'creditRefund'],
       description = 'A refund paid out of a customer deposit, or of receivables against a credit note, to the original payment''s method'
 WHERE code = 'pay.RefundPaid';

INSERT INTO fin.posting_rule (id, event_code, amount_key, side, account_id, determinant_type, determinant_role, subledger_from, valid_from, created_by, updated_by)
SELECT ('01900000-0000-7000-8300-' || lpad(r.n::text, 12, '0'))::uuid, r.event, r.amount, r.side,
       CASE WHEN r.code IS NULL THEN NULL ELSE ('01900000-0000-7000-8100-00000000' || r.code)::uuid END,
       r.det_type, r.det_role, r.subledger, DATE '2020-01-01', '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001'
  FROM (VALUES
    (101, 'pay.RefundPaid', 'creditRefund', 'D', '1200', NULL, NULL, 'customerId'),
    (102, 'pay.RefundPaid', 'creditRefund', 'C', NULL, 'PAYMENT_METHOD_KIND', 'TENDER', 'register, provider, customer or bank account')
  ) AS r (n, event, amount, side, code, det_type, det_role, subledger);

-- migrate:down
DELETE FROM fin.posting_rule WHERE id IN ('01900000-0000-7000-8300-000000000101', '01900000-0000-7000-8300-000000000102');
UPDATE fin.posting_event_type
   SET amount_keys = ARRAY['refund'],
       description = 'A refund paid out of a customer deposit to the original payment''s method'
 WHERE code = 'pay.RefundPaid';
