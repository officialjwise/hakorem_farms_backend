-- 0191_iam_grant_ord_reversal_permissions
-- Who cancels an order and who voids a sale (FR-ORD-014, FR-ORD-002, abuse case 1, A-226), each the most conservative
-- reading: an order is cancelled by those who enter it (the Owner, the Manager, Sales); a void is asked for by anyone
-- who sells (the Owner, the Manager, Sales, the Cashier) and approved only by a supervisor (the Owner, the Manager), who
-- may be neither the person asking nor the cashier who made the sale (held by IAM and by the database). The Accountant
-- corrects money through credit notes and reversals, never by voiding a sale. Nobody else holds any of them.
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
INSERT INTO iam.role_permission (role_id, permission_code, created_by, updated_by)
SELECT r.id, p.code, '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001'
  FROM iam.role r JOIN (VALUES
    ('OWNER', 'ord.order.cancel'), ('MANAGER', 'ord.order.cancel'), ('SALES', 'ord.order.cancel'),
    ('OWNER', 'ord.order.void'), ('MANAGER', 'ord.order.void'), ('SALES', 'ord.order.void'), ('CASHIER', 'ord.order.void'),
    ('OWNER', 'ord.void.approve'), ('MANAGER', 'ord.void.approve')
  ) AS p (role, code) ON p.role = r.code
 WHERE r.deleted_at IS NULL
ON CONFLICT DO NOTHING;

-- migrate:down
DELETE FROM iam.role_permission WHERE permission_code IN ('ord.order.cancel', 'ord.order.void', 'ord.void.approve');
