-- 0082_iam_grant_growth_breeding_permissions
-- Grants the B06 continued 2 livestock permissions (A-159). The Owner and the Manager hold all of them. The Storekeeper,
-- who already reads the register with its cost, edits and moves animals, reads and starts batches, and reads and
-- records breeding. The Accountant reads batches, growth and breeding and writes nothing. The Vet or Farm hand, the
-- actor of FR-LIV-002, FR-LIV-003, FR-LIV-006, FR-LIV-010 and FR-LIV-011, edits and moves animals, reads, starts and
-- closes batches, reads growth, and reads and records breeding and births: the owner decided on 2026-11-15 that the
-- Farm hand is not refused a read needed for animal work because it carries cost; B06 continued 3 gives the role
-- cost-free shapes (the batch's and the animal's accumulated cost here). Every other role holds none.
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
INSERT INTO iam.role_permission (role_id, permission_code, created_by, updated_by)
SELECT r.id, p.code, '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001'
  FROM iam.role r CROSS JOIN iam.permission p
 WHERE r.deleted_at IS NULL
   AND p.code IN ('liv.animal.update', 'liv.animal.move', 'liv.report.read', 'liv.batch.read', 'liv.batch.create', 'liv.batch.update',
                  'liv.breeding.read', 'liv.breeding.record')
   AND ((r.code IN ('OWNER', 'MANAGER'))
     OR (r.code = 'STOREKEEPER' AND p.code IN ('liv.animal.update', 'liv.animal.move', 'liv.batch.read', 'liv.batch.create', 'liv.breeding.read', 'liv.breeding.record'))
     OR (r.code = 'ACCOUNTANT' AND p.code IN ('liv.report.read', 'liv.batch.read', 'liv.breeding.read'))
     OR (r.code = 'FARM_HAND' AND p.code IN ('liv.animal.update', 'liv.animal.move', 'liv.report.read', 'liv.batch.read', 'liv.batch.create', 'liv.batch.update',
                                              'liv.breeding.read', 'liv.breeding.record')));

-- migrate:down
DELETE FROM iam.role_permission WHERE permission_code IN ('liv.animal.update', 'liv.animal.move', 'liv.report.read', 'liv.batch.read', 'liv.batch.create',
  'liv.batch.update', 'liv.breeding.read', 'liv.breeding.record');
