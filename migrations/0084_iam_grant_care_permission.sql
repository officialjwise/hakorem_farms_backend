-- 0084_iam_grant_care_permission
-- The owner's Farm hand decision (2026-11-15, replacing A-158's Farm hand line; A-160, ADR-0052): the Vet or Farm hand
-- reads what animal work and food safety need, the register, the rations, the batches and the health events with their
-- withdrawal holds, and never a cost. The Owner and the Manager hold every LIV permission and so this one too. The Farm
-- hand gives up `liv.batch.read` (0082), whose answers carry the batch's accumulated cost: it reads batches through
-- `liv.care.read` instead. Its write permissions stay; a write whose full answer carries cost also needs that answer's
-- read permission, so the role writes through the care operations, which answer without cost. Every other role is
-- unchanged.
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
INSERT INTO iam.role_permission (role_id, permission_code, created_by, updated_by)
SELECT r.id, 'liv.care.read', '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001'
  FROM iam.role r
 WHERE r.deleted_at IS NULL AND r.code IN ('OWNER', 'MANAGER', 'FARM_HAND');

DELETE FROM iam.role_permission rp USING iam.role r
 WHERE rp.role_id = r.id AND r.code = 'FARM_HAND' AND rp.permission_code = 'liv.batch.read';

-- migrate:down
INSERT INTO iam.role_permission (role_id, permission_code, created_by, updated_by)
SELECT r.id, 'liv.batch.read', '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001'
  FROM iam.role r
 WHERE r.deleted_at IS NULL AND r.code = 'FARM_HAND';
DELETE FROM iam.role_permission WHERE permission_code = 'liv.care.read';
