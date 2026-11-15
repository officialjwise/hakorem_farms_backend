-- 0081_iam_seed_growth_breeding_permissions
-- The permissions of the LIV operations B06 continued 2 builds (contract x-permission): editing and moving an animal,
-- reading growth, managing batches, and reading and recording breeding and births. Granted to no role here; 0082
-- grants them (A-159).
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
INSERT INTO iam.permission (code, module, description, requires_step_up) VALUES
  ('liv.animal.update', 'liv', 'Change an animal''s breed, sex, purpose or grade', false),
  ('liv.animal.move', 'liv', 'Move an animal between pens of its branch', false),
  ('liv.report.read', 'liv', 'Read growth, feed conversion and mortality by pen and batch', false),
  ('liv.batch.read', 'liv', 'Read batches and flocks, with their accumulated cost', false),
  ('liv.batch.create', 'liv', 'Start a batch, hatching its flock at nil cost', false),
  ('liv.batch.update', 'liv', 'Change a batch''s purpose, or close a batch with no head left', false),
  ('liv.breeding.read', 'liv', 'Read breeding records and births', false),
  ('liv.breeding.record', 'liv', 'Record a mating, its confirmation, its failure or the birth it gave', false);

-- migrate:down
DELETE FROM iam.permission WHERE code IN ('liv.animal.update', 'liv.animal.move', 'liv.report.read', 'liv.batch.read', 'liv.batch.create',
  'liv.batch.update', 'liv.breeding.read', 'liv.breeding.record');
