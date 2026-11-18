-- 0255_iam_grant_quo_permissions
-- Who handles requests for quote and quotes (the owner's item 5 of 2026-11-17, FR-QUO-002 to FR-QUO-011, A-309 (a)):
-- Sales builds, sends and converts quotes and works the requests that lead to them; the Owner and the Manager hold
-- every permission of the role they grant (FR-IAM-022) and alone approve a version below the margin floor (FR-QUO-005's
-- checker), never one they drafted or asked to issue. The Accountant, the Storekeeper, the Cashier, the Farm hand, the
-- Driver, the Investor and the Customer hold none of them: the most conservative reading.
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
INSERT INTO iam.role_permission (role_id, permission_code, created_by, updated_by)
SELECT r.id, p.code, '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001'
  FROM iam.role r
  JOIN (VALUES ('OWNER'), ('MANAGER'), ('SALES')) AS who (role) ON who.role = r.code
  CROSS JOIN (VALUES ('quo.rfq.read'), ('quo.rfq.create'), ('quo.rfq.update'), ('quo.quote.read'), ('quo.quote.create'), ('quo.quote.issue'), ('quo.quote.convert')) AS p (code)
 WHERE r.deleted_at IS NULL
ON CONFLICT DO NOTHING;

INSERT INTO iam.role_permission (role_id, permission_code, created_by, updated_by)
SELECT r.id, 'quo.quote_margin.approve', '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001'
  FROM iam.role r
 WHERE r.code IN ('OWNER', 'MANAGER') AND r.deleted_at IS NULL
ON CONFLICT DO NOTHING;

-- migrate:down
DELETE FROM iam.role_permission WHERE permission_code LIKE 'quo.%';
