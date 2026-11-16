-- 0111_iam_seed_b06r_permissions
-- B06r (owner, 2026-11-15; ADR-0053, A-175, A-176): the Farm hand's death reports under a second person, and the
-- processing reversal under ADR-0048's pattern.
--   platform.file.upload.evidence  upload an EVIDENCE file and nothing else (the Farm hand's death photograph); the
--                                  file store refuses any other use to a holder of this alone (deny by default)
--   liv.mortality.post             write off a death or cull below the value threshold without a second person
--   liv.mortality.confirm          confirm a death or cull below the threshold reported by someone who may not post one
-- Approval policies (ADR-0017):
--   MORTALITY_CONFIRMATION  every submission by a reporter without liv.mortality.post below the MORTALITY_WRITE_OFF
--                           threshold waits for a holder of liv.mortality.confirm other than its reporter; no step-up
--   PROCESSING_REVERSAL     a reversal valued at or above the STOCK_WRITE_OFF threshold (judged there and copied onto
--                           the reversal) waits for a holder of prc.order.reverse other than its maker, with step-up
-- The new permissions are granted to no role here; 0112 grants them.
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
INSERT INTO iam.permission (code, module, description, requires_step_up) VALUES
  ('platform.file.upload.evidence', 'platform', 'Upload an EVIDENCE file (a death photograph) and no other kind of file', false),
  ('liv.mortality.post', 'liv', 'Write off a death or cull below the value threshold without a second person', false),
  ('liv.mortality.confirm', 'liv', 'Confirm a death or cull below the value threshold reported by someone who may not write it off alone', false);

INSERT INTO iam.approval_policy (id, kind, branch_id, threshold_pesewas, approver_permission, requires_evidence, requires_step_up, created_by, updated_by) VALUES
  ('01900000-0000-7000-8000-000000000412', 'MORTALITY_CONFIRMATION', NULL, NULL, 'liv.mortality.confirm', false, false,
   '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001'),
  ('01900000-0000-7000-8000-000000000413', 'PROCESSING_REVERSAL', NULL, NULL, 'prc.order.reverse', false, true,
   '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001');

-- migrate:down
DELETE FROM iam.approval_policy WHERE id IN ('01900000-0000-7000-8000-000000000412', '01900000-0000-7000-8000-000000000413');
DELETE FROM iam.role_permission WHERE permission_code IN ('platform.file.upload.evidence', 'liv.mortality.post', 'liv.mortality.confirm');
DELETE FROM iam.permission WHERE code IN ('platform.file.upload.evidence', 'liv.mortality.post', 'liv.mortality.confirm');
