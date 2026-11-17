-- 0233_iam_seed_pos_device_permissions
-- B09b continued (FR-POS-010, FR-POS-020, ADR-0016, ADR-0077, A-274): the permissions of device enrolment and of
-- recovering another cashier's till, as contract/openapi.yaml names them. Enrolling or revoking a device issues or ends a
-- credential, and recovering a till lets cash move on another cashier's shift, so both ask for a fresh step-up where they
-- are the operation's own permission. Granted to no role here; 0234 grants them.
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
INSERT INTO iam.permission (code, module, description, requires_step_up) VALUES
  ('pos.device.read', 'pos', 'Read the devices enrolled on a till', false),
  ('pos.device.enrol', 'pos', 'Enrol a device to run a till, or revoke it; its credential is shown once', true),
  ('pos.shift.force_close', 'pos', 'Recover a till: close another cashier''s abandoned shift, and record cash or a refund on another cashier''s open shift', true);

-- migrate:down
DELETE FROM iam.role_permission WHERE permission_code IN ('pos.device.read', 'pos.device.enrol', 'pos.shift.force_close');
DELETE FROM iam.permission WHERE code IN ('pos.device.read', 'pos.device.enrol', 'pos.shift.force_close');
