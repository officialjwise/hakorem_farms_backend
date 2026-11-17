-- 0202_iam_grant_ord_price_override_permissions
-- Who approves a price override and who issues a proforma (FR-ORD-003, ADR-0017, abuse case 3, A-201, A-230), each the
-- most conservative reading: an override is approved only by a supervisor (the Owner, the Manager) who neither asked for
-- it nor sold (held by IAM, by ORD and by the database); a proforma is issued by those who enter orders (the Owner, the
-- Manager, Sales). The Cashier sells at the till (B9b) and the Accountant corrects money through credit notes; neither
-- holds either. Nobody else holds any of them.
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
INSERT INTO iam.role_permission (role_id, permission_code, created_by, updated_by)
SELECT r.id, p.code, '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001'
  FROM iam.role r JOIN (VALUES
    ('OWNER', 'ord.price_override.approve'), ('MANAGER', 'ord.price_override.approve'),
    ('OWNER', 'bil.proforma.create'), ('MANAGER', 'bil.proforma.create'), ('SALES', 'bil.proforma.create')
  ) AS p (role, code) ON p.role = r.code
 WHERE r.deleted_at IS NULL
ON CONFLICT DO NOTHING;

-- migrate:down
DELETE FROM iam.role_permission WHERE permission_code IN ('ord.price_override.approve', 'bil.proforma.create');
