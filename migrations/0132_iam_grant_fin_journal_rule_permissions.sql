-- 0132_iam_grant_fin_journal_rule_permissions
-- Who reads the journal and who makes and checks manual journals and rule changes (FR-FIN-005, FR-FIN-008, DC-15,
-- A-190, A-191): the Owner and the Accountant, each both maker and checker, so the smallest team that keeps the books
-- (one Owner, one Accountant) can post a manual journal or change a rule only by the one approving the other's. Nobody
-- approves their own: the domain refuses it and so does iam.approval_request (ADR-0017). A farm with one Owner and no
-- Accountant or second Owner cannot post a manual journal or change a rule at all, as ADR-0017's consequences say.
-- No other role is granted anything of FIN here.
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
INSERT INTO iam.role_permission (role_id, permission_code, created_by, updated_by)
SELECT r.id, p.code, '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001'
  FROM iam.role r
  CROSS JOIN (VALUES ('fin.journal.read'), ('fin.journal.create'), ('fin.journal.approve'),
                     ('fin.posting_rule.read'), ('fin.posting_rule.manage'), ('fin.posting_rule.approve')) AS p (code)
 WHERE r.code IN ('OWNER', 'ACCOUNTANT') AND r.deleted_at IS NULL
ON CONFLICT DO NOTHING;

-- migrate:down
DELETE FROM iam.role_permission rp USING iam.role r
 WHERE rp.role_id = r.id AND r.code IN ('OWNER', 'ACCOUNTANT')
   AND rp.permission_code IN ('fin.journal.read', 'fin.journal.create', 'fin.journal.approve', 'fin.posting_rule.read', 'fin.posting_rule.manage', 'fin.posting_rule.approve');
