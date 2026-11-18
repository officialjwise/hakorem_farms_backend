-- 0254_iam_seed_quo_permissions
-- B10 (FR-QUO-001 to FR-QUO-012, ADR-0017, ADR-0035, the owner's item 5 of 2026-11-17): the permissions of the
-- request-for-quote and quote operations, as contract/openapi.yaml names them, and the QUOTE_BELOW_MARGIN approval: a
-- version below the margin floor, or with a line below the engine's floor, is issued only once a holder of
-- quo.quote_margin.approve who is neither its author nor the person who asked to issue it approves it, whatever its
-- amount, with a fresh step-up (FR-QUO-005). Granted to no role here; 0255 grants them. The threshold is data.
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
INSERT INTO iam.permission (code, module, description, requires_step_up) VALUES
  ('quo.rfq.read', 'quo', 'Read the requests for quote of a branch', false),
  ('quo.rfq.create', 'quo', 'Log a request for quote taken by phone, WhatsApp or at the counter', false),
  ('quo.rfq.update', 'quo', 'Assign a request for quote, link it to a customer, close it or mark it as spam', false),
  ('quo.quote.read', 'quo', 'Read the quotes of a branch with every version, margin and acceptance', false),
  ('quo.quote.create', 'quo', 'Draft a quote, start a new version and edit a draft version', false),
  ('quo.quote.issue', 'quo', 'Issue a quote version with its acceptance link; record an acceptance or a decline; withdraw a quote', false),
  ('quo.quote.convert', 'quo', 'Convert an accepted quote into its one sales order', false),
  ('quo.quote_margin.approve', 'quo', 'Approve a quote version below the margin floor that someone else drafted or asked to issue', true);

INSERT INTO iam.approval_policy (id, kind, branch_id, threshold_pesewas, approver_permission, requires_evidence, requires_step_up, created_by, updated_by) VALUES
  ('01900000-0000-7000-8000-000000000640', 'QUOTE_BELOW_MARGIN', NULL, 0, 'quo.quote_margin.approve', false, true,
   '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001');

-- migrate:down
DELETE FROM iam.approval_policy WHERE id = '01900000-0000-7000-8000-000000000640';
DELETE FROM iam.role_permission WHERE permission_code LIKE 'quo.%';
DELETE FROM iam.permission WHERE module = 'quo';
