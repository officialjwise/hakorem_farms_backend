-- 0208_iam_seed_aud_business_profile_permission
-- B09x continued (FR-AUD-008, CR-028): reading the business profile in the console (getBusinessProfile), as
-- contract/openapi.yaml names it. Changing it is aud.setting.manage (0102), with a fresh step-up. The public shop
-- profile needs no permission: it shows only the trading name, the two numbers, the address, the directions and the
-- hours. Granted to no role here; 0209 grants it.
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
INSERT INTO iam.permission (code, module, description, requires_step_up) VALUES
  ('aud.setting.read', 'aud', 'Read the settings and the business profile, with its tax numbers', false);

-- migrate:down
DELETE FROM iam.role_permission WHERE permission_code = 'aud.setting.read';
DELETE FROM iam.permission WHERE code = 'aud.setting.read';
