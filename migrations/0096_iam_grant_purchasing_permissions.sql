-- 0096_iam_grant_purchasing_permissions
-- Grants the B7 purchase-to-pay permissions (FR-PUR-005 to FR-PUR-012, A-164). Purchase orders: the Storekeeper and the
-- Manager draft and submit them (the requirement's makers), the Owner too; the Owner and the Manager approve, send,
-- close and cancel them; the Accountant reads them to match invoices. Supplier invoices: the Accountant enters,
-- matches and approves them, the Owner too; the Manager reads them. Supplier payments: the Accountant prepares and
-- marks them paid, the Owner too; the Owner and the Manager approve them, never their own (IAM refuses the maker as
-- checker). The Storekeeper sees no invoice or payment, and every other role holds none.
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
INSERT INTO iam.role_permission (role_id, permission_code, created_by, updated_by)
SELECT r.id, p.code, '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001'
  FROM iam.role r CROSS JOIN iam.permission p
 WHERE r.deleted_at IS NULL
   AND ((r.code IN ('OWNER', 'MANAGER', 'STOREKEEPER') AND p.code IN ('pur.purchase_order.read', 'pur.purchase_order.create'))
     OR (r.code IN ('OWNER', 'MANAGER') AND p.code IN ('pur.purchase_order.approve', 'pur.purchase_order.send', 'pur.purchase_order.close',
                                                       'pur.supplier_invoice.read', 'pur.supplier_payment.read', 'pur.supplier_payment.approve'))
     OR (r.code = 'ACCOUNTANT' AND p.code IN ('pur.purchase_order.read', 'pur.supplier_invoice.read', 'pur.supplier_payment.read'))
     OR (r.code IN ('OWNER', 'ACCOUNTANT') AND p.code IN ('pur.supplier_invoice.create', 'pur.supplier_invoice.match', 'pur.supplier_invoice.approve',
                                                          'pur.supplier_payment.create', 'pur.supplier_payment.pay')));

-- migrate:down
DELETE FROM iam.role_permission WHERE permission_code LIKE 'pur.%';
