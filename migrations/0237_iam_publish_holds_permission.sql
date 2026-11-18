-- 0237_iam_publish_holds_permission
-- B09b continued (ADR-0077 Amendments, ADR-0047): a read-only fact a higher module's constraint may ask IAM, by key,
-- without reading IAM's tables: whether an active principal holds a permission now (the application clock's instant,
-- platform.app_now, ADR-0067) through a live grant at a branch, a grant to one location of it included. First asked by
-- PAY's till cash constraints and POS's cash movement guard: may this person recover another cashier's till
-- (`pos.shift.force_close`).
-- Data category: internal.
-- Rollback: tested (`pnpm db:rollback`), after 0238 and 0239 are rolled back.

-- migrate:up
CREATE FUNCTION iam.holds_permission_at(p_principal_id uuid, p_permission text, p_branch_id uuid) RETURNS boolean
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM iam.role_grant g JOIN iam.role r ON r.id = g.role_id
      JOIN iam.role_permission rp ON rp.role_id = r.id AND rp.deleted_at IS NULL
      JOIN iam.principal p ON p.id = g.principal_id
     WHERE g.principal_id = p_principal_id AND g.branch_id = p_branch_id AND rp.permission_code = p_permission
       AND g.deleted_at IS NULL AND r.deleted_at IS NULL AND p.status = 'ACTIVE' AND p.deleted_at IS NULL
       AND g.valid_from <= platform.app_now() AND (g.valid_to IS NULL OR g.valid_to > platform.app_now()))
$$;
REVOKE ALL ON FUNCTION iam.holds_permission_at(uuid, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION iam.holds_permission_at(uuid, text, uuid) TO hk_app, hk_worker, hk_report;

-- migrate:down
DROP FUNCTION iam.holds_permission_at(uuid, text, uuid);
