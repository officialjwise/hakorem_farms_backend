-- 0269_whl_automatic_hold_release
-- B10 continued 2b (the owner's decision 4 of 2026-11-18 on A-314, FR-WHL-008): paying off an overdue account releases
-- its hold automatically only if the system placed it for being overdue; a hold placed by a person stays until an Owner
-- or Manager who did not ask releases it.
--   whl.business_account.hold_automatic   boolean, true exactly while the account is on a hold the overdue job placed
--                                          (ck_business_account_hold_automatic: only on hold). Set only as the account
--                                          goes on hold and cleared only as it leaves it (whl.business_account_guard,
--                                          HK010 ck_business_account_hold_automatic). False for every hold placed before
--                                          this migration: those stay until released by two people (A-314 as amended).
--   whl.business_account_guard            an account leaves a hold the system placed without a release change; every
--                                          other hold still leaves only with an approved, unused RELEASE change
--                                          (ck_business_account_release_approved). Otherwise unchanged from 0259.
-- Additions to docs/data-model/whl.md: the column and the guard's new rule.
-- Data category: CONFIDENTIAL (DC-11).
-- Rollback: tested (`pnpm db:rollback`): the guard of 0259 again, and the column dropped.

-- migrate:up
ALTER TABLE whl.business_account ADD COLUMN hold_automatic boolean NOT NULL DEFAULT false;
ALTER TABLE whl.business_account ADD CONSTRAINT ck_business_account_hold_automatic CHECK (NOT hold_automatic OR status = 'ON_HOLD');

CREATE OR REPLACE FUNCTION whl.business_account_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  change record;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.credit_limit_pesewas <> 0 OR NEW.limit_change_id IS NOT NULL OR NEW.release_change_id IS NOT NULL THEN
      RAISE EXCEPTION 'whl.business_account %: an account opens with a nil credit limit', NEW.customer_id USING ERRCODE = 'HK010', CONSTRAINT = 'ck_business_account_limit_approved';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.customer_id <> OLD.customer_id OR NEW.branch_id <> OLD.branch_id THEN
    RAISE EXCEPTION 'whl.business_account %: the customer and branch of an account never change', OLD.customer_id USING ERRCODE = 'HK004', CONSTRAINT = 'ck_business_account_frozen';
  END IF;
  IF NEW.credit_limit_pesewas <> OLD.credit_limit_pesewas OR NEW.limit_change_id IS DISTINCT FROM OLD.limit_change_id THEN
    SELECT c.customer_id, c.kind, c.status, c.credit_limit_pesewas INTO change FROM whl.account_change c WHERE c.id = NEW.limit_change_id;
    IF NEW.limit_change_id IS NULL OR NEW.limit_change_id IS NOT DISTINCT FROM OLD.limit_change_id OR change.customer_id <> NEW.customer_id
       OR change.kind <> 'CREDIT_LIMIT' OR change.status <> 'APPLIED' OR change.credit_limit_pesewas <> NEW.credit_limit_pesewas THEN
      RAISE EXCEPTION 'whl.business_account %: a credit limit changes only by an approved change for that limit', OLD.customer_id USING ERRCODE = 'HK010', CONSTRAINT = 'ck_business_account_limit_approved';
    END IF;
  END IF;
  -- Whether a hold is the system's is set only as the account goes on hold, and cleared only as it leaves it.
  IF NEW.hold_automatic IS DISTINCT FROM OLD.hold_automatic
     AND NOT (OLD.status <> 'ON_HOLD' AND NEW.status = 'ON_HOLD') AND NOT (OLD.status = 'ON_HOLD' AND NEW.status <> 'ON_HOLD' AND NOT NEW.hold_automatic) THEN
    RAISE EXCEPTION 'whl.business_account %: whether a hold is automatic is set only when it is placed', OLD.customer_id USING ERRCODE = 'HK010', CONSTRAINT = 'ck_business_account_hold_automatic';
  END IF;
  -- A hold the system placed for being overdue leaves without a release change once paid (decision 4 on A-314);
  -- every other hold needs an approved release.
  IF OLD.status = 'ON_HOLD' AND NEW.status <> 'ON_HOLD' AND OLD.hold_automatic AND NEW.release_change_id IS NOT DISTINCT FROM OLD.release_change_id THEN
    RETURN NEW;
  END IF;
  IF (OLD.status = 'ON_HOLD' AND NEW.status <> 'ON_HOLD') OR NEW.release_change_id IS DISTINCT FROM OLD.release_change_id THEN
    SELECT c.customer_id, c.kind, c.status INTO change FROM whl.account_change c WHERE c.id = NEW.release_change_id;
    IF OLD.status <> 'ON_HOLD' OR NEW.status = 'ON_HOLD' OR NEW.release_change_id IS NULL OR NEW.release_change_id IS NOT DISTINCT FROM OLD.release_change_id
       OR change.customer_id <> NEW.customer_id OR change.kind <> 'RELEASE' OR change.status <> 'APPLIED' THEN
      RAISE EXCEPTION 'whl.business_account %: a hold is released only by an approved release', OLD.customer_id USING ERRCODE = 'HK010', CONSTRAINT = 'ck_business_account_release_approved';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

-- migrate:down
CREATE OR REPLACE FUNCTION whl.business_account_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  change record;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.credit_limit_pesewas <> 0 OR NEW.limit_change_id IS NOT NULL OR NEW.release_change_id IS NOT NULL THEN
      RAISE EXCEPTION 'whl.business_account %: an account opens with a nil credit limit', NEW.customer_id USING ERRCODE = 'HK010', CONSTRAINT = 'ck_business_account_limit_approved';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.customer_id <> OLD.customer_id OR NEW.branch_id <> OLD.branch_id THEN
    RAISE EXCEPTION 'whl.business_account %: the customer and branch of an account never change', OLD.customer_id USING ERRCODE = 'HK004', CONSTRAINT = 'ck_business_account_frozen';
  END IF;
  IF NEW.credit_limit_pesewas <> OLD.credit_limit_pesewas OR NEW.limit_change_id IS DISTINCT FROM OLD.limit_change_id THEN
    SELECT c.customer_id, c.kind, c.status, c.credit_limit_pesewas INTO change FROM whl.account_change c WHERE c.id = NEW.limit_change_id;
    IF NEW.limit_change_id IS NULL OR NEW.limit_change_id IS NOT DISTINCT FROM OLD.limit_change_id OR change.customer_id <> NEW.customer_id
       OR change.kind <> 'CREDIT_LIMIT' OR change.status <> 'APPLIED' OR change.credit_limit_pesewas <> NEW.credit_limit_pesewas THEN
      RAISE EXCEPTION 'whl.business_account %: a credit limit changes only by an approved change for that limit', OLD.customer_id USING ERRCODE = 'HK010', CONSTRAINT = 'ck_business_account_limit_approved';
    END IF;
  END IF;
  IF (OLD.status = 'ON_HOLD' AND NEW.status <> 'ON_HOLD') OR NEW.release_change_id IS DISTINCT FROM OLD.release_change_id THEN
    SELECT c.customer_id, c.kind, c.status INTO change FROM whl.account_change c WHERE c.id = NEW.release_change_id;
    IF OLD.status <> 'ON_HOLD' OR NEW.status = 'ON_HOLD' OR NEW.release_change_id IS NULL OR NEW.release_change_id IS NOT DISTINCT FROM OLD.release_change_id
       OR change.customer_id <> NEW.customer_id OR change.kind <> 'RELEASE' OR change.status <> 'APPLIED' THEN
      RAISE EXCEPTION 'whl.business_account %: a hold is released only by an approved release', OLD.customer_id USING ERRCODE = 'HK010', CONSTRAINT = 'ck_business_account_release_approved';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

ALTER TABLE whl.business_account DROP CONSTRAINT ck_business_account_hold_automatic;
ALTER TABLE whl.business_account DROP COLUMN hold_automatic;
