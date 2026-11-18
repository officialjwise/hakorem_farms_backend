-- 0245_pur_invoice_approver_differs
-- B09u, CR-043 (the owner, 2026-11-17): an invoice is approved for payment by someone other than the person who entered
-- it, as a credit note and a variance already are (0107):
--   ck_supplier_invoice_approver  an APPROVED or PAID invoice (kind INVOICE) was approved (`posted_by`) by someone other
--                                 than its maker (`created_by`)
-- A credit note keeps `ck_supplier_invoice_credit_approved`; a variance keeps `ck_supplier_invoice_variance`. Added
-- without NOT VALID: no real invoice exists yet, and the seed approves each invoice by someone other than its maker.
-- Data category: none (a constraint).
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
ALTER TABLE pur.supplier_invoice ADD CONSTRAINT ck_supplier_invoice_approver
  CHECK (kind = 'CREDIT_NOTE' OR status NOT IN ('APPROVED', 'PAID') OR posted_by IS DISTINCT FROM created_by);

-- migrate:down
ALTER TABLE pur.supplier_invoice DROP CONSTRAINT ck_supplier_invoice_approver;
