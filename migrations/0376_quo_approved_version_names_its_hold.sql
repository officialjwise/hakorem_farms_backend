-- 0376_quo_approved_version_names_its_hold
-- B12f (the owner, 2026-11-24, from the frontend's F10o): a version approved below the margin floor is issued by
-- someone other than its approver ("Issue and send"), and its issue holds what it quotes (B11u: a line of animals holds
-- its count at issue) and names a single hold on its line, as a draft's issue does. 0253's guard let a line name its
-- reservation once only while its version was DRAFT or PENDING_APPROVAL: 0278 added APPROVED and left the guard as it
-- was, so issuing an approved version whose line is held by one reservation (one goat, one lot of eggs) was refused by
-- the database and answered 500. This replaces the guard with APPROVED beside them; every other rule is 0253's:
-- the reservation named once, from null, nothing else on the line changed, and the lines of an issued, superseded or
-- accepted version frozen.
--   quo.quote_line_guard  0253's, a line naming its reservation once also while its version is APPROVED
-- Data category: CONFIDENTIAL (DC-11).
-- Rollback: tested (`pnpm db:rollback`): restores 0253's guard.

-- migrate:up
CREATE OR REPLACE FUNCTION quo.quote_line_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  version_status text;
BEGIN
  SELECT v.status INTO version_status FROM quo.quote_version v
   WHERE v.id = CASE WHEN TG_OP = 'DELETE' THEN OLD.quote_version_id ELSE NEW.quote_version_id END;
  IF TG_OP = 'UPDATE' AND version_status IN ('DRAFT', 'PENDING_APPROVAL', 'APPROVED') AND OLD.reservation_id IS NULL AND NEW.reservation_id IS NOT NULL
     AND (to_jsonb(NEW) - 'reservation_id') = (to_jsonb(OLD) - 'reservation_id') THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'quo.quote_line % is never deleted; a draft''s line is set aside', OLD.id USING ERRCODE = 'HK004', CONSTRAINT = 'ck_quote_line_frozen';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.removed THEN
    RAISE EXCEPTION 'quo.quote_line % was set aside and never changes', OLD.id USING ERRCODE = 'HK004', CONSTRAINT = 'ck_quote_line_frozen';
  END IF;
  IF version_status IS DISTINCT FROM 'DRAFT' OR (TG_OP = 'UPDATE' AND NEW.quote_version_id IS DISTINCT FROM OLD.quote_version_id) THEN
    RAISE EXCEPTION 'quo.quote_line: the lines of a version that is % are frozen', version_status USING ERRCODE = 'HK004', CONSTRAINT = 'ck_quote_line_frozen';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;

-- migrate:down
CREATE OR REPLACE FUNCTION quo.quote_line_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  version_status text;
BEGIN
  SELECT v.status INTO version_status FROM quo.quote_version v
   WHERE v.id = CASE WHEN TG_OP = 'DELETE' THEN OLD.quote_version_id ELSE NEW.quote_version_id END;
  IF TG_OP = 'UPDATE' AND version_status IN ('DRAFT', 'PENDING_APPROVAL') AND OLD.reservation_id IS NULL AND NEW.reservation_id IS NOT NULL
     AND (to_jsonb(NEW) - 'reservation_id') = (to_jsonb(OLD) - 'reservation_id') THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'quo.quote_line % is never deleted; a draft''s line is set aside', OLD.id USING ERRCODE = 'HK004', CONSTRAINT = 'ck_quote_line_frozen';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.removed THEN
    RAISE EXCEPTION 'quo.quote_line % was set aside and never changes', OLD.id USING ERRCODE = 'HK004', CONSTRAINT = 'ck_quote_line_frozen';
  END IF;
  IF version_status IS DISTINCT FROM 'DRAFT' OR (TG_OP = 'UPDATE' AND NEW.quote_version_id IS DISTINCT FROM OLD.quote_version_id) THEN
    RAISE EXCEPTION 'quo.quote_line: the lines of a version that is % are frozen', version_status USING ERRCODE = 'HK004', CONSTRAINT = 'ck_quote_line_frozen';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;
