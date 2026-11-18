-- 0271_iam_seed_pos_pin_permission
-- B09b continued 3 (CR-032, ADR-0080, ADR-0035): the permission to set one's own till PIN (setTillPin), as the contract
-- names it, granted to the roles that run or supervise a till: the Owner, the Manager and the Cashier. One's own PIN
-- only: the operation sets the caller's, and the database holds it (ck_till_pin_own). No step-up: the cashier has no
-- second factor, and the PIN authenticates nothing on the server.
-- Data category: none (lookup rows and grants).
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
INSERT INTO iam.permission (code, module, description, requires_step_up) VALUES
  ('pos.pin.set', 'pos', 'Set one''s own till PIN, sent only as the verifier the till derives from it', false);
INSERT INTO iam.role_permission (role_id, permission_code, created_by, updated_by)
SELECT r.id, p.code, '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001'
  FROM iam.role r JOIN (VALUES ('OWNER', 'pos.pin.set'), ('MANAGER', 'pos.pin.set'), ('CASHIER', 'pos.pin.set')) AS p (role, code) ON p.role = r.code
 WHERE r.deleted_at IS NULL
ON CONFLICT DO NOTHING;

-- migrate:down
DELETE FROM iam.role_permission WHERE permission_code = 'pos.pin.set';
DELETE FROM iam.permission WHERE code = 'pos.pin.set';
