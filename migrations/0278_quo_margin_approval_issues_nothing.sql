-- 0278_quo_margin_approval_issues_nothing
-- The owner, 2026-11-19 (from the frontend's F10m, B10 continued 3b, A-323): approving a quote version below the margin
-- floor only approves it. It neither issues the version nor makes a link: the salesperson then issues it and sees the
-- link once, as for any quote, so no live link exists that nobody has seen. LOUD on 2.12.0's approval, which issued.
--   ck_quote_version_status          gains APPROVED
--   ck_quote_version_approved_state  an APPROVED version carries its approval and approver
--   uq_quote_version_open            one open version per quote: DRAFT, PENDING_APPROVAL or APPROVED
--   quo.quote_version_guard          0253's, with PENDING_APPROVAL moving to DRAFT or APPROVED (never straight to
--                                    ISSUED), APPROVED only to ISSUED, and an APPROVED version issued exactly as approved
-- Data category: CONFIDENTIAL (DC-11).
-- Rollback: tested (`pnpm db:rollback`): restores 0253's guard, check and index; refuses once a version is APPROVED.

-- migrate:up
ALTER TABLE quo.quote_version DROP CONSTRAINT ck_quote_version_status;
ALTER TABLE quo.quote_version ADD CONSTRAINT ck_quote_version_status CHECK (status IN ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'ISSUED', 'SUPERSEDED', 'ACCEPTED'));
ALTER TABLE quo.quote_version ADD CONSTRAINT ck_quote_version_approved_state CHECK (status <> 'APPROVED' OR (approval_request_id IS NOT NULL AND approved_by IS NOT NULL AND approved_by <> created_by));
DROP INDEX quo.uq_quote_version_open;
CREATE UNIQUE INDEX uq_quote_version_open ON quo.quote_version (quote_id) WHERE status IN ('DRAFT', 'PENDING_APPROVAL', 'APPROVED');

CREATE OR REPLACE FUNCTION quo.quote_version_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  allowed text[];
  moving text[] := ARRAY['status', 'version', 'updated_at', 'updated_by'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'quo.quote_version % is never removed', OLD.id USING ERRCODE = 'HK004', CONSTRAINT = 'ck_quote_version_frozen';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'DRAFT' OR NEW.archived_document_id IS NOT NULL OR NEW.approved_by IS NOT NULL THEN
      RAISE EXCEPTION 'quo.quote_version %: a version is written DRAFT', NEW.id USING ERRCODE = 'HK004', CONSTRAINT = 'ck_quote_version_frozen';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.quote_id IS DISTINCT FROM OLD.quote_id OR NEW.version_no IS DISTINCT FROM OLD.version_no OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'quo.quote_version %: its quote, number and author never change', OLD.id USING ERRCODE = 'HK004', CONSTRAINT = 'ck_quote_version_frozen';
  END IF;
  IF OLD.status IN ('ISSUED', 'SUPERSEDED', 'ACCEPTED') THEN
    IF (to_jsonb(NEW) - (moving || ARRAY['archived_document_id'])) IS DISTINCT FROM (to_jsonb(OLD) - (moving || ARRAY['archived_document_id']))
       OR (OLD.archived_document_id IS NOT NULL AND NEW.archived_document_id IS DISTINCT FROM OLD.archived_document_id) THEN
      RAISE EXCEPTION 'quo.quote_version % is issued and frozen; a change is a new version', OLD.id USING ERRCODE = 'HK004', CONSTRAINT = 'ck_quote_version_frozen';
    END IF;
  ELSIF OLD.status IN ('PENDING_APPROVAL', 'APPROVED') AND NEW.status = OLD.status
     AND (to_jsonb(NEW) - moving) IS DISTINCT FROM (to_jsonb(OLD) - moving) THEN
    RAISE EXCEPTION 'quo.quote_version % waits for its approval, or is approved, and is not edited', OLD.id USING ERRCODE = 'HK004', CONSTRAINT = 'ck_quote_version_frozen';
  ELSIF OLD.status = 'APPROVED' AND (to_jsonb(NEW) - (moving || ARRAY['issued_at', 'issued_by'])) IS DISTINCT FROM (to_jsonb(OLD) - (moving || ARRAY['issued_at', 'issued_by'])) THEN
    RAISE EXCEPTION 'quo.quote_version % is issued as it was approved', OLD.id USING ERRCODE = 'HK004', CONSTRAINT = 'ck_quote_version_frozen';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    allowed := CASE OLD.status
      WHEN 'DRAFT' THEN ARRAY['PENDING_APPROVAL', 'ISSUED']
      WHEN 'PENDING_APPROVAL' THEN ARRAY['DRAFT', 'APPROVED']
      WHEN 'APPROVED' THEN ARRAY['ISSUED']
      WHEN 'ISSUED' THEN ARRAY['SUPERSEDED', 'ACCEPTED']
      ELSE ARRAY[]::text[] END;
    IF NOT (NEW.status = ANY (allowed)) THEN
      RAISE EXCEPTION 'quo.quote_version %: % cannot move to %', OLD.id, OLD.status, NEW.status USING ERRCODE = 'HK004', CONSTRAINT = 'ck_quote_version_frozen';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

-- migrate:down
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM quo.quote_version WHERE status = 'APPROVED') THEN
    RAISE EXCEPTION '0278 cannot be rolled back: versions are APPROVED and not yet issued (forward fix only)';
  END IF;
END
$$;
-- 0253's guard, word for word.
CREATE OR REPLACE FUNCTION quo.quote_version_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  allowed text[];
  moving text[] := ARRAY['status', 'version', 'updated_at', 'updated_by'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'quo.quote_version % is never removed', OLD.id USING ERRCODE = 'HK004', CONSTRAINT = 'ck_quote_version_frozen';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'DRAFT' OR NEW.archived_document_id IS NOT NULL OR NEW.approved_by IS NOT NULL THEN
      RAISE EXCEPTION 'quo.quote_version %: a version is written DRAFT', NEW.id USING ERRCODE = 'HK004', CONSTRAINT = 'ck_quote_version_frozen';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.quote_id IS DISTINCT FROM OLD.quote_id OR NEW.version_no IS DISTINCT FROM OLD.version_no OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'quo.quote_version %: its quote, number and author never change', OLD.id USING ERRCODE = 'HK004', CONSTRAINT = 'ck_quote_version_frozen';
  END IF;
  IF OLD.status IN ('ISSUED', 'SUPERSEDED', 'ACCEPTED') THEN
    IF (to_jsonb(NEW) - (moving || ARRAY['archived_document_id'])) IS DISTINCT FROM (to_jsonb(OLD) - (moving || ARRAY['archived_document_id']))
       OR (OLD.archived_document_id IS NOT NULL AND NEW.archived_document_id IS DISTINCT FROM OLD.archived_document_id) THEN
      RAISE EXCEPTION 'quo.quote_version % is issued and frozen; a change is a new version', OLD.id USING ERRCODE = 'HK004', CONSTRAINT = 'ck_quote_version_frozen';
    END IF;
  ELSIF OLD.status = 'PENDING_APPROVAL' AND NEW.status = 'PENDING_APPROVAL'
     AND (to_jsonb(NEW) - moving) IS DISTINCT FROM (to_jsonb(OLD) - moving) THEN
    RAISE EXCEPTION 'quo.quote_version % waits for its approval and is not edited', OLD.id USING ERRCODE = 'HK004', CONSTRAINT = 'ck_quote_version_frozen';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    allowed := CASE OLD.status
      WHEN 'DRAFT' THEN ARRAY['PENDING_APPROVAL', 'ISSUED']
      WHEN 'PENDING_APPROVAL' THEN ARRAY['DRAFT', 'ISSUED']
      WHEN 'ISSUED' THEN ARRAY['SUPERSEDED', 'ACCEPTED']
      ELSE ARRAY[]::text[] END;
    IF NOT (NEW.status = ANY (allowed)) THEN
      RAISE EXCEPTION 'quo.quote_version %: % cannot move to %', OLD.id, OLD.status, NEW.status USING ERRCODE = 'HK004', CONSTRAINT = 'ck_quote_version_frozen';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
DROP INDEX quo.uq_quote_version_open;
CREATE UNIQUE INDEX uq_quote_version_open ON quo.quote_version (quote_id) WHERE status IN ('DRAFT', 'PENDING_APPROVAL');
ALTER TABLE quo.quote_version DROP CONSTRAINT ck_quote_version_approved_state;
ALTER TABLE quo.quote_version DROP CONSTRAINT ck_quote_version_status;
ALTER TABLE quo.quote_version ADD CONSTRAINT ck_quote_version_status CHECK (status IN ('DRAFT', 'PENDING_APPROVAL', 'ISSUED', 'SUPERSEDED', 'ACCEPTED'));
