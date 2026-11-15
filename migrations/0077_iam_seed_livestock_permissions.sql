-- 0077_iam_seed_livestock_permissions
-- The permissions of the LIV operations B06 continued builds (contract x-permission): reading the animal register;
-- reading and recording weights, health events and feed; reporting and approving mortality and culls; and managing
-- rations. Granted to no role here; 0078 grants them (A-158).
-- The approval policy (ADR-0017, FR-LIV-012, threat model abuse case 2): a death or cull valued at or above 50,000
-- pesewas (the SRS seed threshold) is written off only once a different person holding liv.mortality.approve, with a
-- fresh step-up, approves it, and only with a photograph as evidence. Its own kind, MORTALITY_WRITE_OFF, so the
-- livestock handler decides it and a stock adjustment's approver is not by that alone a mortality approver (A-158).
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
INSERT INTO iam.permission (code, module, description, requires_step_up) VALUES
  ('liv.animal.read', 'liv', 'Read the animal register, with each animal''s accumulated cost', false),
  ('liv.weight.read', 'liv', 'Read weight records', false),
  ('liv.weight.record', 'liv', 'Record the weights of animals and flocks', false),
  ('liv.health.read', 'liv', 'Read vaccinations, treatments and health checks, with their cost', false),
  ('liv.health.record', 'liv', 'Record a vaccination, treatment or health check, placing any withdrawal hold', false),
  ('liv.mortality.read', 'liv', 'Read death and cull records, with the value written off', false),
  ('liv.mortality.report', 'liv', 'Report and submit a death or cull for write-off', false),
  ('liv.mortality.approve', 'liv', 'Approve a death or cull at or above the value threshold', true),
  ('liv.feed.read', 'liv', 'Read rations and feed consumption, with its cost spread', false),
  ('liv.feed.record', 'liv', 'Record feed issued to a pen', false),
  ('liv.feed.manage', 'liv', 'Create and change rations', false);

INSERT INTO iam.approval_policy (id, kind, branch_id, threshold_pesewas, approver_permission, requires_evidence, requires_step_up, created_by, updated_by) VALUES
  ('01900000-0000-7000-8000-000000000406', 'MORTALITY_WRITE_OFF', NULL, 50000, 'liv.mortality.approve', true, true,
   '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001');

-- migrate:down
DELETE FROM iam.approval_policy WHERE id = '01900000-0000-7000-8000-000000000406';
DELETE FROM iam.permission WHERE code IN ('liv.animal.read', 'liv.weight.read', 'liv.weight.record', 'liv.health.read', 'liv.health.record',
  'liv.mortality.read', 'liv.mortality.report', 'liv.mortality.approve', 'liv.feed.read', 'liv.feed.record', 'liv.feed.manage');
