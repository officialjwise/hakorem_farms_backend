-- 0201_iam_seed_ord_price_override_permissions
-- B09a continued 2e (FR-ORD-003, ADR-0017, ADR-0035, abuse case 3, A-230): the approval of a price override and the
-- proforma of an order, as contract/openapi.yaml names them. PRICE_OVERRIDE: a price outside the band, or below list
-- beyond the seller's per-line limit, waits for a holder of ord.price_override.approve who is neither the person who
-- asked, the order's salesperson nor the poster (SECURITY_ARCHITECTURE "Separation of duties": the seller makes, a
-- manager checks), whatever its amount, with a fresh step-up. bil.proforma.create issues an order's proforma
-- (issueProforma, A-201). Granted to no role here; 0202 grants them. The threshold is data.
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
INSERT INTO iam.permission (code, module, description, requires_step_up) VALUES
  ('ord.price_override.approve', 'ord', 'Approve a price outside the band, or below list beyond the seller''s limit, that someone else asked for', true),
  ('bil.proforma.create', 'bil', 'Issue the proforma invoice of an order', false);

INSERT INTO iam.approval_policy (id, kind, branch_id, threshold_pesewas, approver_permission, requires_evidence, requires_step_up, created_by, updated_by) VALUES
  ('01900000-0000-7000-8000-000000000426', 'PRICE_OVERRIDE', NULL, 0, 'ord.price_override.approve', false, true,
   '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001');

-- migrate:down
DELETE FROM iam.approval_policy WHERE id = '01900000-0000-7000-8000-000000000426';
DELETE FROM iam.role_permission WHERE permission_code IN ('ord.price_override.approve', 'bil.proforma.create');
DELETE FROM iam.permission WHERE code IN ('ord.price_override.approve', 'bil.proforma.create');
