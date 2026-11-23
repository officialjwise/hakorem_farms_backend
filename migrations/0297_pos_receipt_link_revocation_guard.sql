-- 0297_pos_receipt_link_revocation_guard
-- B09b continued 4b (ADR-0074 Amendments, ADR-0083, A-284 (f), A-285): a receipt link is revoked only by a supervisor
-- of the sale's branch. 0292 built pos.receipt_link_revocation; this adds who may write it.
--   pos.receipt_link_revocation_guard (HK010)  the actor holds pos.shift.close.approve at the link's branch, at the
--                                              application clock's instant (iam.holds_permission_at, ADR-0077
--                                              Amendments) (ck_receipt_link_revocation_supervisor).
-- No table or column changes; the table stays insert-only (0292).
-- Every time is written by the application from its clock (ADR-0067); nothing here reads now().
-- Additions to docs/data-model/pos.md: the guard, as built.
-- Data category: none new (DC-22 for the reason, as 0292).
-- Rollback: tested (`pnpm db:rollback`): the guard is dropped and the table is as 0292 left it.

-- migrate:up
CREATE FUNCTION pos.receipt_link_revocation_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  v_branch uuid;
BEGIN
  SELECT l.branch_id INTO v_branch FROM pos.receipt_link l WHERE l.id = NEW.receipt_link_id;
  IF v_branch IS NULL OR NOT iam.holds_permission_at(NEW.actor_id, 'pos.shift.close.approve', v_branch) THEN
    RAISE EXCEPTION 'pos.receipt_link_revocation: % may not revoke receipt link % at its branch', NEW.actor_id, NEW.receipt_link_id
      USING ERRCODE = 'HK010', CONSTRAINT = 'ck_receipt_link_revocation_supervisor';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION pos.receipt_link_revocation_guard() FROM PUBLIC;
CREATE TRIGGER trg_receipt_link_revocation_guard BEFORE INSERT ON pos.receipt_link_revocation
  FOR EACH ROW EXECUTE FUNCTION pos.receipt_link_revocation_guard();

-- migrate:down
DROP TRIGGER trg_receipt_link_revocation_guard ON pos.receipt_link_revocation;
DROP FUNCTION pos.receipt_link_revocation_guard();
