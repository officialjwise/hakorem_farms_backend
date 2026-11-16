-- 0148_fin_billing_postings
-- B08 continued 2 (FR-BIL-004, FR-BIL-007, ADR-0003, ADR-0020, ADR-0056, A-200): billing's three ◆ events join the
-- posting catalogue with ADR-0003's rows:
--   bil.InvoiceIssued    Dr 1200 the agreed gross against the customer; Dr 4210 where agreed is below resolved; Dr 4220
--                        promotions; Cr 40xx the resolved amount by the line's GL group; Cr 4100 a delivery fee; Cr 2100
--                        each levy against its levy; Cr 4210 where agreed is above resolved. A RECEIPT posts as an invoice.
--   bil.CreditNoteIssued Dr 4200 the net; Dr 2100 each levy; Cr 1200 the gross against the customer
--   bil.DebitNoteIssued  Dr 1200 the gross against the customer; Cr 40xx by GL group; Cr 4100 a delivery fee; Cr 2100
--                        each levy
-- The levy lines go through the TAX_LEVY / OUTPUT determination, so a fourth levy needs no rule of its own.
--   uq_journal_entry_billing   one entry per billing document, ever
-- Published: `fin.pub_receivable_balance`, the balance of trade receivables (1200) per branch, for RPT (A-149).
-- Data category: CONFIDENTIAL (DC-09): the farm's books.
-- Rollback: tested (`pnpm db:rollback`), safe before the first billing document; afterwards forward fix only (a posted
-- entry is never removed).

-- migrate:up
INSERT INTO fin.posting_event_type (code, owner_module, description, amount_keys) VALUES
  ('bil.InvoiceIssued', 'bil', 'An invoice or receipt issued: the agreed gross owed, sales at the resolved amount, each levy, the price variance and promotions',
   ARRAY['gross', 'sales', 'deliveryFee', 'levy', 'priceVarianceBelow', 'priceVarianceAbove', 'promotion']),
  ('bil.CreditNoteIssued', 'bil', 'A credit note issued against an invoice or receipt: the net to returns and allowances, each levy back, the gross off receivables',
   ARRAY['gross', 'net', 'levy']),
  ('bil.DebitNoteIssued', 'bil', 'A debit note issued against an invoice or receipt: the gross owed, the charge by GL group, each levy',
   ARRAY['gross', 'sales', 'deliveryFee', 'levy']);

INSERT INTO fin.posting_rule (id, event_code, amount_key, side, account_id, determinant_type, determinant_role, subledger_from, valid_from, created_by, updated_by)
SELECT ('01900000-0000-7000-8300-' || lpad(r.n::text, 12, '0'))::uuid, r.event, r.amount, r.side,
       CASE WHEN r.code IS NULL THEN NULL ELSE ('01900000-0000-7000-8100-00000000' || r.code)::uuid END,
       r.det_type, r.det_role, r.subledger, DATE '2020-01-01', '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001'
  FROM (VALUES
    (70, 'bil.InvoiceIssued', 'gross', 'D', '1200', NULL, NULL, 'customerId'),
    (71, 'bil.InvoiceIssued', 'sales', 'C', NULL, 'GL_GROUP', 'SALES', NULL),
    (72, 'bil.InvoiceIssued', 'deliveryFee', 'C', '4100', NULL, NULL, NULL),
    (73, 'bil.InvoiceIssued', 'levy', 'C', NULL, 'TAX_LEVY', 'OUTPUT', 'levies.levyId'),
    (74, 'bil.InvoiceIssued', 'priceVarianceBelow', 'D', '4210', NULL, NULL, NULL),
    (75, 'bil.InvoiceIssued', 'priceVarianceAbove', 'C', '4210', NULL, NULL, NULL),
    (76, 'bil.InvoiceIssued', 'promotion', 'D', '4220', NULL, NULL, NULL),
    (77, 'bil.CreditNoteIssued', 'net', 'D', '4200', NULL, NULL, NULL),
    (78, 'bil.CreditNoteIssued', 'levy', 'D', NULL, 'TAX_LEVY', 'OUTPUT', 'levies.levyId'),
    (79, 'bil.CreditNoteIssued', 'gross', 'C', '1200', NULL, NULL, 'customerId'),
    (80, 'bil.DebitNoteIssued', 'gross', 'D', '1200', NULL, NULL, 'customerId'),
    (81, 'bil.DebitNoteIssued', 'sales', 'C', NULL, 'GL_GROUP', 'SALES', NULL),
    (82, 'bil.DebitNoteIssued', 'deliveryFee', 'C', '4100', NULL, NULL, NULL),
    (83, 'bil.DebitNoteIssued', 'levy', 'C', NULL, 'TAX_LEVY', 'OUTPUT', 'levies.levyId')
  ) AS r (n, event, amount, side, code, det_type, det_role, subledger);

CREATE UNIQUE INDEX uq_journal_entry_billing ON fin.journal_entry (source_document_id)
  WHERE event_code IN ('bil.InvoiceIssued', 'bil.CreditNoteIssued', 'bil.DebitNoteIssued');

CREATE VIEW fin.pub_receivable_balance AS
SELECT l.branch_id, sum(CASE l.side WHEN 'D' THEN l.amount_pesewas ELSE -l.amount_pesewas END)::bigint AS balance_pesewas
  FROM fin.journal_line l JOIN fin.account a ON a.id = l.account_id
 WHERE a.code = '1200'
 GROUP BY l.branch_id;
REVOKE ALL ON fin.pub_receivable_balance FROM PUBLIC;
GRANT SELECT ON fin.pub_receivable_balance TO hk_app, hk_worker, hk_report;

-- migrate:down
DROP VIEW fin.pub_receivable_balance;
DROP INDEX fin.uq_journal_entry_billing;
DELETE FROM fin.posting_rule WHERE event_code IN ('bil.InvoiceIssued', 'bil.CreditNoteIssued', 'bil.DebitNoteIssued');
DELETE FROM fin.posting_event_type WHERE code IN ('bil.InvoiceIssued', 'bil.CreditNoteIssued', 'bil.DebitNoteIssued');
