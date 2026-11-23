-- 0324_iam_seed_van_way_out_permissions
-- B11 continued 4 (FR-DEL-011, the owner's van rule of 2026-11-23, A-360): the van's two other ways out, as
-- contract/openapi.yaml names them:
--   del.delivery.return     return a failed delivery's goods from the van to the branch returns hold, the document credited
--   del.delivery.write_off  write a failed delivery's goods off the van with a reason, through the stock write-off approval
-- Granted to no role here; 0325 grants them.
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
INSERT INTO iam.permission (code, module, description, requires_step_up) VALUES
  ('del.delivery.return', 'del', 'Return a failed delivery''s goods from the van to the returns hold, its document credited', false),
  ('del.delivery.write_off', 'del', 'Write a failed delivery''s goods off the van with a reason, through the stock write-off approval', false);

-- migrate:down
DELETE FROM iam.role_permission WHERE permission_code IN ('del.delivery.return', 'del.delivery.write_off');
DELETE FROM iam.permission WHERE code IN ('del.delivery.return', 'del.delivery.write_off');
