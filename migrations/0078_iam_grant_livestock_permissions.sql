-- 0078_iam_grant_livestock_permissions
-- Grants the B06 continued livestock permissions (A-158). The Owner and the Manager hold all of them, the Manager as
-- the checker of a mortality at or above the threshold. The Storekeeper reads the register and records weights,
-- health, feed and mortality, but approves none. The Accountant reads everything and writes nothing. The Vet or
-- Farm hand, whom the requirements name as the maker of most livestock records, records weights, health events,
-- feed and mortality and reads weights, and is granted no read whose shape carries a cost they did not enter (the
-- register's accumulated cost, the feed spread, the value written off: DC-11), as A-153 decided for processing,
-- until the owner decides that they may see cost. Every other role holds none.
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
INSERT INTO iam.role_permission (role_id, permission_code, created_by, updated_by)
SELECT r.id, p.code, '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001'
  FROM iam.role r CROSS JOIN iam.permission p
 WHERE r.deleted_at IS NULL
   AND ((r.code IN ('OWNER', 'MANAGER') AND p.module = 'liv')
     OR (r.code = 'STOREKEEPER' AND p.code IN ('liv.animal.read', 'liv.weight.read', 'liv.weight.record', 'liv.health.read', 'liv.health.record',
                                                'liv.mortality.read', 'liv.mortality.report', 'liv.feed.read', 'liv.feed.record'))
     OR (r.code = 'ACCOUNTANT' AND p.code IN ('liv.animal.read', 'liv.weight.read', 'liv.health.read', 'liv.mortality.read', 'liv.feed.read'))
     OR (r.code = 'FARM_HAND' AND p.code IN ('liv.weight.read', 'liv.weight.record', 'liv.health.record', 'liv.mortality.report', 'liv.feed.record')));

-- migrate:down
DELETE FROM iam.role_permission WHERE permission_code IN ('liv.animal.read', 'liv.weight.read', 'liv.weight.record', 'liv.health.read', 'liv.health.record',
  'liv.mortality.read', 'liv.mortality.report', 'liv.mortality.approve', 'liv.feed.read', 'liv.feed.record', 'liv.feed.manage');
