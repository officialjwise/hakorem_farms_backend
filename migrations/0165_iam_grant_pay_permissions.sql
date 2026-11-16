-- 0165_iam_grant_pay_permissions
-- Who takes and returns money (FR-PAY-001, FR-PAY-009, FR-PAY-012, A-210): every selling and finance role reads
-- payments and refunds (Owner, Manager, Accountant, Sales, Cashier); the Owner, Manager, Cashier and Sales initiate mobile money (the driver's collection arrives with delivery,
-- B11); the Owner and the Accountant allocate and unallocate. A refund is asked for by the Owner, Manager, Cashier or
-- Sales, approved by the Owner, Manager or Accountant (never its maker, ADR-0017), and a manual payout is recorded by
-- the Owner, Manager or Accountant (never the refund's maker). The smallest team, one Owner and one Manager, can
-- therefore refund: one asks, the other approves.
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
INSERT INTO iam.role_permission (role_id, permission_code, created_by, updated_by)
SELECT r.id, p.code, '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001'
  FROM iam.role r JOIN (VALUES
    ('OWNER', 'pay.payment.read'), ('MANAGER', 'pay.payment.read'), ('ACCOUNTANT', 'pay.payment.read'), ('SALES', 'pay.payment.read'), ('CASHIER', 'pay.payment.read'),
    ('OWNER', 'pay.payment.initiate'), ('MANAGER', 'pay.payment.initiate'), ('CASHIER', 'pay.payment.initiate'), ('SALES', 'pay.payment.initiate'),
    ('OWNER', 'pay.payment.allocate'), ('ACCOUNTANT', 'pay.payment.allocate'),
    ('OWNER', 'pay.refund.read'), ('MANAGER', 'pay.refund.read'), ('ACCOUNTANT', 'pay.refund.read'), ('SALES', 'pay.refund.read'), ('CASHIER', 'pay.refund.read'),
    ('OWNER', 'pay.refund.create'), ('MANAGER', 'pay.refund.create'), ('CASHIER', 'pay.refund.create'), ('SALES', 'pay.refund.create'),
    ('OWNER', 'pay.refund.approve'), ('MANAGER', 'pay.refund.approve'), ('ACCOUNTANT', 'pay.refund.approve'),
    ('OWNER', 'pay.refund.pay'), ('MANAGER', 'pay.refund.pay'), ('ACCOUNTANT', 'pay.refund.pay')
  ) AS p (role, code) ON p.role = r.code
 WHERE r.deleted_at IS NULL
ON CONFLICT DO NOTHING;

-- migrate:down
DELETE FROM iam.role_permission WHERE permission_code IN ('pay.payment.read', 'pay.payment.initiate', 'pay.payment.allocate', 'pay.refund.read', 'pay.refund.create', 'pay.refund.approve', 'pay.refund.pay');
