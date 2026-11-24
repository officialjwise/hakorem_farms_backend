-- 0344_iam_seed_bil_send_permission
-- B11 continued 13 (ADR-0062, ADR-0099, A-288): sending an issued billing document to its own customer by SMS, WhatsApp
-- or email (`sendBillingDocument`), as contract/openapi.yaml names it. Granted to no role here; 0345 grants it.
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
INSERT INTO iam.permission (code, module, description, requires_step_up) VALUES
  ('bil.document.send', 'bil', 'Send an issued billing document to its own customer by message, logged as a copy with its channel', false);

-- migrate:down
DELETE FROM iam.role_permission WHERE permission_code = 'bil.document.send';
DELETE FROM iam.permission WHERE code = 'bil.document.send';
