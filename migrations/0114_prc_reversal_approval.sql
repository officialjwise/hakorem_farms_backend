-- 0114_prc_reversal_approval
-- B06r (owner, 2026-11-15, replacing A-162; ADR-0048's pattern; A-176; threat model abuse case 29): a processing
-- reversal moves stock value back, so it follows the write-off rule. Valued at or above the adjustment threshold
-- (STOCK_WRITE_OFF, judged when asked and copied onto the reversal, never read live) it waits as PENDING_APPROVAL for
-- a different approver with step-up; below it the maker's reason posts it. A reversal is refused outright once any
-- pack its order produced has been picked, sold or written off, because putting the carcass back would hide the meat
-- that left. A lot that has left the cold room is refused by INV's own stock check when its PROCESS_OUTPUT movement is
-- reversed (no negative stock at a physical location, ADR-0002).
--
-- The database holds these rules itself, whoever writes:
--   ck_processing_reversal_status    PENDING_APPROVAL, POSTED or REJECTED
--   ck_processing_reversal_posted    posted_at and posted_by are set exactly when POSTED
--   ck_processing_reversal_judged    value and threshold are both set or both null (null only on reversals posted
--                                    before this migration, which the guard admits no more)
--   ck_processing_reversal_waiting   a reversal that waited or was rejected names its approval request
--   ck_processing_reversal_approved  a POSTED reversal at or above its threshold has an approval and was posted by
--                                    someone other than its maker
--   uq_processing_reversal_order     one live reversal per order: a rejected one frees the order to be asked again
--   prc.processing_reversal_guard    a new reversal names a COMPLETED order of its branch, with its value and threshold;
--                                    PENDING_APPROVAL -> POSTED or REJECTED only; the order, branch, value, threshold,
--                                    approval and maker never change (HK004); and becoming POSTED is refused while any
--                                    pack of the order is PICKED, SOLD or WRITTEN_OFF (23514, ck_processing_reversal_unsold)
-- Additions to docs/data-model/prc.md: `value_pesewas`, `threshold_pesewas`, `approval_request_id`, statuses
-- PENDING_APPROVAL and REJECTED.
-- Data category: INTERNAL (DC-13; DC-11 for the value).
-- Rollback: tested (`pnpm db:rollback`), safe before the first reversal waits or is rejected; afterwards forward fix
-- only, since the previous checks cannot hold such a row.

-- migrate:up
ALTER TABLE prc.processing_reversal
  DROP CONSTRAINT ck_processing_reversal_status,
  DROP CONSTRAINT uq_processing_reversal_order,
  ALTER COLUMN posted_at DROP NOT NULL,
  ALTER COLUMN posted_by DROP NOT NULL,
  ADD COLUMN value_pesewas platform.pesewas NULL,
  ADD COLUMN threshold_pesewas platform.pesewas NULL,
  ADD COLUMN approval_request_id uuid NULL CONSTRAINT fk_processing_reversal_approval REFERENCES iam.approval_request (id) ON DELETE RESTRICT;
ALTER TABLE prc.processing_reversal
  ADD CONSTRAINT ck_processing_reversal_status CHECK (status IN ('PENDING_APPROVAL', 'POSTED', 'REJECTED')),
  ADD CONSTRAINT ck_processing_reversal_posted CHECK ((status = 'POSTED') = (posted_at IS NOT NULL) AND (posted_at IS NULL) = (posted_by IS NULL)),
  ADD CONSTRAINT ck_processing_reversal_judged CHECK ((value_pesewas IS NULL) = (threshold_pesewas IS NULL)),
  ADD CONSTRAINT ck_processing_reversal_waiting CHECK (status = 'POSTED' OR approval_request_id IS NOT NULL),
  ADD CONSTRAINT ck_processing_reversal_approved CHECK (status <> 'POSTED' OR threshold_pesewas IS NULL OR value_pesewas < threshold_pesewas
                                                        OR (approval_request_id IS NOT NULL AND posted_by <> created_by));
CREATE UNIQUE INDEX uq_processing_reversal_order ON prc.processing_reversal (processing_order_id) WHERE status <> 'REJECTED';

DROP TRIGGER trg_processing_reversal_freeze ON prc.processing_reversal;
CREATE TRIGGER trg_processing_reversal_freeze BEFORE UPDATE ON prc.processing_reversal
  FOR EACH ROW EXECUTE FUNCTION platform.freeze_posted('POSTED,REJECTED');

DROP TRIGGER trg_processing_reversal_guard ON prc.processing_reversal;
CREATE OR REPLACE FUNCTION prc.processing_reversal_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  order_row prc.processing_order;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO order_row FROM prc.processing_order o WHERE o.id = NEW.processing_order_id FOR SHARE;
    IF order_row.status IS DISTINCT FROM 'COMPLETED' OR order_row.branch_id <> NEW.branch_id THEN
      RAISE EXCEPTION 'prc.processing_reversal %: only a completed order of the branch is reversed', NEW.id USING ERRCODE = 'HK004';
    END IF;
    IF NEW.status NOT IN ('PENDING_APPROVAL', 'POSTED') OR NEW.value_pesewas IS NULL THEN
      RAISE EXCEPTION 'prc.processing_reversal %: a reversal starts waiting or posted, with its value and threshold', NEW.id USING ERRCODE = 'HK004';
    END IF;
  ELSE
    IF NEW.status IS DISTINCT FROM OLD.status AND NOT (OLD.status = 'PENDING_APPROVAL' AND NEW.status IN ('POSTED', 'REJECTED')) THEN
      RAISE EXCEPTION 'prc.processing_reversal %: % cannot become %', OLD.id, OLD.status, NEW.status USING ERRCODE = 'HK004';
    END IF;
    IF NEW.processing_order_id <> OLD.processing_order_id OR NEW.branch_id <> OLD.branch_id OR NEW.created_by <> OLD.created_by
       OR NEW.value_pesewas IS DISTINCT FROM OLD.value_pesewas OR NEW.threshold_pesewas IS DISTINCT FROM OLD.threshold_pesewas
       OR NEW.approval_request_id IS DISTINCT FROM OLD.approval_request_id THEN
      RAISE EXCEPTION 'prc.processing_reversal %: the order, value, threshold, approval and maker never change', OLD.id USING ERRCODE = 'HK004';
    END IF;
  END IF;
  IF NEW.status = 'POSTED' AND EXISTS (
       SELECT 1 FROM prc.pack p JOIN prc.processing_output po ON po.id = p.processing_output_id
        WHERE po.processing_order_id = NEW.processing_order_id AND p.status IN ('PICKED', 'SOLD', 'WRITTEN_OFF')) THEN
    RAISE EXCEPTION 'prc.processing_reversal %: a pack of the order has been picked, sold or written off', NEW.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ck_processing_reversal_unsold';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER trg_processing_reversal_guard BEFORE INSERT OR UPDATE ON prc.processing_reversal
  FOR EACH ROW EXECUTE FUNCTION prc.processing_reversal_guard();

-- migrate:down
DROP TRIGGER trg_processing_reversal_guard ON prc.processing_reversal;
CREATE OR REPLACE FUNCTION prc.processing_reversal_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  order_row prc.processing_order;
BEGIN
  SELECT * INTO order_row FROM prc.processing_order o WHERE o.id = NEW.processing_order_id FOR SHARE;
  IF order_row.status IS DISTINCT FROM 'COMPLETED' OR order_row.branch_id <> NEW.branch_id THEN
    RAISE EXCEPTION 'prc.processing_reversal %: only a completed order of the branch is reversed', NEW.id USING ERRCODE = 'HK004';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER trg_processing_reversal_guard BEFORE INSERT ON prc.processing_reversal
  FOR EACH ROW EXECUTE FUNCTION prc.processing_reversal_guard();
DROP TRIGGER trg_processing_reversal_freeze ON prc.processing_reversal;
CREATE TRIGGER trg_processing_reversal_freeze BEFORE UPDATE ON prc.processing_reversal
  FOR EACH ROW EXECUTE FUNCTION platform.freeze_posted('POSTED');
DROP INDEX prc.uq_processing_reversal_order;
ALTER TABLE prc.processing_reversal
  DROP CONSTRAINT ck_processing_reversal_approved,
  DROP CONSTRAINT ck_processing_reversal_waiting,
  DROP CONSTRAINT ck_processing_reversal_judged,
  DROP CONSTRAINT ck_processing_reversal_posted,
  DROP CONSTRAINT ck_processing_reversal_status,
  DROP COLUMN approval_request_id,
  DROP COLUMN threshold_pesewas,
  DROP COLUMN value_pesewas,
  ALTER COLUMN posted_by SET NOT NULL,
  ALTER COLUMN posted_at SET NOT NULL,
  ADD CONSTRAINT ck_processing_reversal_status CHECK (status = 'POSTED'),
  ADD CONSTRAINT uq_processing_reversal_order UNIQUE (processing_order_id);
