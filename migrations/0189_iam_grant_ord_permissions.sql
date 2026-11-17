-- 0189_iam_grant_ord_permissions
-- Who reads, enters and confirms orders (FR-ORD-001, FR-ORD-005, A-224), each the most conservative reading: every
-- selling and finance role reads orders (Owner, Manager, Accountant, Sales, Cashier: the till looks a sale up for a
-- return or a reprint); an order for a phone, WhatsApp or wholesale customer is entered and confirmed by the Owner, the
-- Manager or Sales. The Cashier sells at the counter through the till (B9b), never by entering an order here. The
-- Storekeeper, the Farm hand, the Driver, the Investor and the Customer hold none of them: picking and delivery read
-- their own documents (B11), and a customer reads their own orders through the shop.
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
INSERT INTO iam.role_permission (role_id, permission_code, created_by, updated_by)
SELECT r.id, p.code, '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001'
  FROM iam.role r JOIN (VALUES
    ('OWNER', 'ord.order.read'), ('MANAGER', 'ord.order.read'), ('ACCOUNTANT', 'ord.order.read'), ('SALES', 'ord.order.read'), ('CASHIER', 'ord.order.read'),
    ('OWNER', 'ord.order.create'), ('MANAGER', 'ord.order.create'), ('SALES', 'ord.order.create'),
    ('OWNER', 'ord.order.confirm'), ('MANAGER', 'ord.order.confirm'), ('SALES', 'ord.order.confirm')
  ) AS p (role, code) ON p.role = r.code
 WHERE r.deleted_at IS NULL
ON CONFLICT DO NOTHING;

-- migrate:down
DELETE FROM iam.role_permission WHERE permission_code IN ('ord.order.read', 'ord.order.create', 'ord.order.confirm');
