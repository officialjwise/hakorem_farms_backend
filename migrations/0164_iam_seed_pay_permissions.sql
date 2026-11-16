-- 0164_iam_seed_pay_permissions
-- B09a continued (FR-PAY-001, FR-PAY-003, FR-PAY-005, FR-PAY-009, FR-PAY-012, FR-PAY-013, ADR-0017, A-210): the
-- permissions of the PAY operations this session builds, as contract/openapi.yaml names them, and the REFUND approval:
-- every refund a person asks for waits for a holder of pay.refund.approve other than its maker, whatever its amount,
-- with a fresh step-up (the owner, 2026-11-16: "refunds are where till fraud lives"; the contract's REFUND policy has a
-- threshold of 0). Recording a manual refund payout also needs a fresh step-up. Granted to no role here; 0165 grants
-- them. The threshold is data: a lower-risk policy is a row change with no code change. The permissions of recording a payment by
-- hand, cheques, reversals, store credit, open items and reconciliation are seeded by B09a continued 1b, which builds them (A-211).
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
-- The principal a payment provider's webhook acts as (security architecture section 8): its rows, events and audit
-- name it. It holds no grant and signs in nowhere.
INSERT INTO iam.principal (id, kind, display_name, status, created_by, updated_by) VALUES
  ('01900000-0000-7000-8000-000000000007', 'SYSTEM', 'Payment provider webhook', 'ACTIVE', '01900000-0000-7000-8000-000000000007', '01900000-0000-7000-8000-000000000007');

INSERT INTO iam.permission (code, module, description, requires_step_up) VALUES
  ('pay.payment.read', 'pay', 'Read payments, their allocations and the unmatched payment queue, and look up a pending payment with the provider', false),
  ('pay.payment.initiate', 'pay', 'Ask a customer to approve a mobile money payment on their phone', false),
  ('pay.payment.allocate', 'pay', 'Allocate a cleared payment to billing documents, or take an allocation off with a reason', false),
  ('pay.refund.read', 'pay', 'Read refunds', false),
  ('pay.refund.create', 'pay', 'Ask for a refund against an original payment (it waits for a different approver), or retry a failed one', false),
  ('pay.refund.approve', 'pay', 'Approve a refund asked for by someone else', true),
  ('pay.refund.pay', 'pay', 'Record that an approved refund was paid outside the provider, with its reference', true);

INSERT INTO iam.approval_policy (id, kind, branch_id, threshold_pesewas, approver_permission, requires_evidence, requires_step_up, created_by, updated_by) VALUES
  ('01900000-0000-7000-8000-000000000421', 'REFUND', NULL, 0, 'pay.refund.approve', false, true,
   '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001');

-- migrate:down
DELETE FROM iam.approval_policy WHERE id = '01900000-0000-7000-8000-000000000421';
DELETE FROM iam.role_permission WHERE permission_code IN ('pay.payment.read', 'pay.payment.initiate', 'pay.payment.allocate', 'pay.refund.read', 'pay.refund.create', 'pay.refund.approve', 'pay.refund.pay');
DELETE FROM iam.permission WHERE code IN ('pay.payment.read', 'pay.payment.initiate', 'pay.payment.allocate', 'pay.refund.read', 'pay.refund.create', 'pay.refund.approve', 'pay.refund.pay');
DELETE FROM iam.principal WHERE id = '01900000-0000-7000-8000-000000000007';
