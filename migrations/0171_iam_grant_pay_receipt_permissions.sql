-- 0171_iam_grant_pay_receipt_permissions
-- Who records, clears and reverses money by hand (FR-PAY-001, FR-PAY-011, FR-PAY-014, FR-PAY-015, A-212): a cheque, a
-- bank transfer or a store credit tender is recorded by the Owner, Manager, Accountant, Cashier or Sales; a cheque is
-- cleared on the bank's confirmation by the Owner or the Accountant; a reversal is asked for by the Owner, Manager or
-- Accountant and approved by the Owner or Manager (never its maker, ADR-0017), so the smallest team, one Owner and one
-- Manager, can reverse and a single Owner cannot. Store credit is read by every selling and finance role; open items
-- by the Owner, Manager, Accountant and Sales.
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
INSERT INTO iam.role_permission (role_id, permission_code, created_by, updated_by)
SELECT r.id, p.code, '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001'
  FROM iam.role r JOIN (VALUES
    ('OWNER', 'pay.payment.create'), ('MANAGER', 'pay.payment.create'), ('ACCOUNTANT', 'pay.payment.create'), ('CASHIER', 'pay.payment.create'), ('SALES', 'pay.payment.create'),
    ('OWNER', 'pay.payment.clear_cheque'), ('ACCOUNTANT', 'pay.payment.clear_cheque'),
    ('OWNER', 'pay.payment.reverse'), ('MANAGER', 'pay.payment.reverse'), ('ACCOUNTANT', 'pay.payment.reverse'),
    ('OWNER', 'pay.reversal.approve'), ('MANAGER', 'pay.reversal.approve'),
    ('OWNER', 'pay.store_credit.read'), ('MANAGER', 'pay.store_credit.read'), ('ACCOUNTANT', 'pay.store_credit.read'), ('CASHIER', 'pay.store_credit.read'), ('SALES', 'pay.store_credit.read'),
    ('OWNER', 'pay.receivable.read'), ('MANAGER', 'pay.receivable.read'), ('ACCOUNTANT', 'pay.receivable.read'), ('SALES', 'pay.receivable.read')
  ) AS p (role, code) ON p.role = r.code
 WHERE r.deleted_at IS NULL
ON CONFLICT DO NOTHING;

-- migrate:down
DELETE FROM iam.role_permission WHERE permission_code IN ('pay.payment.create', 'pay.payment.clear_cheque', 'pay.payment.reverse', 'pay.reversal.approve', 'pay.store_credit.read', 'pay.receivable.read');
