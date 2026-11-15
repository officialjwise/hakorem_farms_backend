-- 0089_iam_grant_processing_reverse_permission
-- The Owner and the Manager reverse a completed processing order (FR-PRC-011's actor; A-162). The Storekeeper, who
-- plans and cancels an order that has not completed, does not; nor does any other role. The Vet or Farm hand holds no
-- PRC permission (A-153 as decided in A-160): every order answers its costs.
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
INSERT INTO iam.role_permission (role_id, permission_code, created_by, updated_by)
SELECT r.id, 'prc.order.reverse', '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001'
  FROM iam.role r
 WHERE r.deleted_at IS NULL AND r.code IN ('OWNER', 'MANAGER');

-- migrate:down
DELETE FROM iam.role_permission WHERE permission_code = 'prc.order.reverse';
