-- 0369_iam_cst_permissions
-- B12 continued 2 (FR-CST-001 to FR-CST-007, ADR-0017, ADR-0102, A-387): the costing permissions and their grants.
--   cst.cost.read          the accumulated cost of an animal, pen, batch or processing order by element
--   cst.margin.read        margins by dimension, break-even and contribution, and losses as their own figure
--   cst.allocation.read    labour and overhead allocation runs and their lines
--   cst.allocation.manage  create an allocation run (a draft, nothing posted)
--   cst.allocation.post    post a run someone else created as value-only movements, step-up (the checker)
-- Grants (FR-CST-002: the Accountant makes, the Owner or the Manager checks): the Accountant reads everything and
-- creates runs; the Manager reads everything and posts; the Owner holds all of it (a granter holds every permission
-- of a role they grant). Whoever created a run never posts it: the application and the database refuse it.
-- Data category: none (lookup rows and grants).
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
INSERT INTO iam.permission (code, module, description, requires_step_up) VALUES
  ('cst.cost.read', 'cst', 'Read the accumulated cost of an animal, pen, batch or processing order by element', false),
  ('cst.margin.read', 'cst', 'Read margins, break-even and contribution, and losses as their own figure', false),
  ('cst.allocation.read', 'cst', 'Read labour and overhead allocation runs', false),
  ('cst.allocation.manage', 'cst', 'Create a labour or overhead allocation run as a draft', false),
  ('cst.allocation.post', 'cst', 'Post an allocation run someone else created as value-only stock movements', true);

INSERT INTO iam.role_permission (role_id, permission_code, created_by, updated_by)
SELECT r.id, p.code, '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001'
  FROM iam.role r JOIN (VALUES
    ('OWNER', 'cst.cost.read'), ('OWNER', 'cst.margin.read'), ('OWNER', 'cst.allocation.read'), ('OWNER', 'cst.allocation.manage'), ('OWNER', 'cst.allocation.post'),
    ('MANAGER', 'cst.cost.read'), ('MANAGER', 'cst.margin.read'), ('MANAGER', 'cst.allocation.read'), ('MANAGER', 'cst.allocation.post'),
    ('ACCOUNTANT', 'cst.cost.read'), ('ACCOUNTANT', 'cst.margin.read'), ('ACCOUNTANT', 'cst.allocation.read'), ('ACCOUNTANT', 'cst.allocation.manage')
  ) AS p (role, code) ON p.role = r.code
 WHERE r.deleted_at IS NULL
ON CONFLICT DO NOTHING;

-- migrate:down
DELETE FROM iam.role_permission WHERE permission_code IN ('cst.cost.read', 'cst.margin.read', 'cst.allocation.read', 'cst.allocation.manage', 'cst.allocation.post');
DELETE FROM iam.permission WHERE code IN ('cst.cost.read', 'cst.margin.read', 'cst.allocation.read', 'cst.allocation.manage', 'cst.allocation.post');
