-- 0102_iam_seed_owner_procurement_permissions
-- The permissions the owner's procurement decisions of 2026-11-15 need (A-168, A-169):
--   pur.supplier.payout_change  asking for a change of a supplier's payout details, split out of pur.supplier.update so
--                               it can be kept apart from every supplier payment permission (A-169)
--   aud.setting.manage          changing a setting through AUD's updateSetting (FR-AUD-007), the purchase order
--                               approval limit first; every change needs a fresh step-up and is audited (A-168)
-- Granted to no role here; 0103 grants them.
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
INSERT INTO iam.permission (code, module, description, requires_step_up) VALUES
  ('pur.supplier.payout_change', 'pur', 'Ask for a change of a supplier''s payout details, which a different person approves', false),
  ('aud.setting.manage', 'aud', 'Change a setting, effective-dated and audited with before and after values', true);

-- migrate:down
DELETE FROM iam.role_permission WHERE permission_code IN ('pur.supplier.payout_change', 'aud.setting.manage');
DELETE FROM iam.permission WHERE code IN ('pur.supplier.payout_change', 'aud.setting.manage');
