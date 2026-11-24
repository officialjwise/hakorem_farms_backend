-- 0351_quo_accepted_hold_lapses
-- B11u continued (the owner, 2026-11-24, verbatim: "An accepted quote's hold ends 7 days after acceptance."; A-310 (b)
-- amended, A-294): the quote-expiry job ends an accepted quote's hold 7 days after its acceptance when no order took it,
-- and the quote stands EXPIRED with its accepted version, so it can no longer be converted.
--   quo.quote_guard()   (replaced) the machine gains ACCEPTED to EXPIRED; every other edge as in 0253
--   ck_quote_accepted   (replaced) an accepted version stays named on an EXPIRED quote (lapsed after acceptance), as on
--                       an ACCEPTED, CONVERTED or CANCELLED one
-- Data category: CONFIDENTIAL (DC-22): commercial history.
-- Rollback: tested (`pnpm db:rollback`), safe while no quote lapsed after acceptance; afterwards forward fix only (the
-- lapsed quotes keep their accepted version, which the old check refuses: leave this migration in place).

-- migrate:up
CREATE OR REPLACE FUNCTION quo.quote_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  allowed text[];
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'DRAFT' OR NEW.accepted_version_id IS NOT NULL OR NEW.converted_order_id IS NOT NULL THEN
      RAISE EXCEPTION 'quo.quote %: a quote is written DRAFT', NEW.id USING ERRCODE = 'HK004', CONSTRAINT = 'ck_quote_transition';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status IN ('DECLINED', 'EXPIRED', 'CONVERTED', 'CANCELLED') AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
    RAISE EXCEPTION 'quo.quote % is % and frozen', OLD.id, OLD.status USING ERRCODE = 'HK004', CONSTRAINT = 'ck_quote_frozen';
  END IF;
  IF NEW.quote_no IS DISTINCT FROM OLD.quote_no OR NEW.salesperson_id IS DISTINCT FROM OLD.salesperson_id OR NEW.branch_id IS DISTINCT FROM OLD.branch_id
     OR NEW.rfq_id IS DISTINCT FROM OLD.rfq_id OR NEW.current_version_no < OLD.current_version_no
     OR (OLD.accepted_version_id IS NOT NULL AND NEW.accepted_version_id IS DISTINCT FROM OLD.accepted_version_id) THEN
    RAISE EXCEPTION 'quo.quote %: its number, salesperson, branch, request and accepted version never change', OLD.id USING ERRCODE = 'HK004', CONSTRAINT = 'ck_quote_frozen';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    allowed := CASE OLD.status
      WHEN 'DRAFT' THEN ARRAY['PENDING_APPROVAL', 'ISSUED', 'CANCELLED']
      WHEN 'PENDING_APPROVAL' THEN ARRAY['DRAFT', 'ISSUED', 'CANCELLED']
      WHEN 'ISSUED' THEN ARRAY['ACCEPTED', 'DECLINED', 'EXPIRED', 'CANCELLED']
      WHEN 'ACCEPTED' THEN ARRAY['CONVERTED', 'CANCELLED', 'EXPIRED']
      ELSE ARRAY[]::text[] END;
    IF NOT (NEW.status = ANY (allowed)) THEN
      RAISE EXCEPTION 'quo.quote %: % cannot move to %', OLD.id, OLD.status, NEW.status USING ERRCODE = 'HK004', CONSTRAINT = 'ck_quote_transition';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
ALTER TABLE quo.quote DROP CONSTRAINT ck_quote_accepted;
ALTER TABLE quo.quote ADD CONSTRAINT ck_quote_accepted CHECK ((status NOT IN ('ACCEPTED', 'CONVERTED') OR accepted_version_id IS NOT NULL)
                                      AND (accepted_version_id IS NULL OR status IN ('ACCEPTED', 'CONVERTED', 'CANCELLED', 'EXPIRED')));

-- migrate:down
ALTER TABLE quo.quote DROP CONSTRAINT ck_quote_accepted;
ALTER TABLE quo.quote ADD CONSTRAINT ck_quote_accepted CHECK ((status NOT IN ('ACCEPTED', 'CONVERTED') OR accepted_version_id IS NOT NULL)
                                      AND (accepted_version_id IS NULL OR status IN ('ACCEPTED', 'CONVERTED', 'CANCELLED')));
CREATE OR REPLACE FUNCTION quo.quote_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  allowed text[];
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'DRAFT' OR NEW.accepted_version_id IS NOT NULL OR NEW.converted_order_id IS NOT NULL THEN
      RAISE EXCEPTION 'quo.quote %: a quote is written DRAFT', NEW.id USING ERRCODE = 'HK004', CONSTRAINT = 'ck_quote_transition';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status IN ('DECLINED', 'EXPIRED', 'CONVERTED', 'CANCELLED') AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
    RAISE EXCEPTION 'quo.quote % is % and frozen', OLD.id, OLD.status USING ERRCODE = 'HK004', CONSTRAINT = 'ck_quote_frozen';
  END IF;
  IF NEW.quote_no IS DISTINCT FROM OLD.quote_no OR NEW.salesperson_id IS DISTINCT FROM OLD.salesperson_id OR NEW.branch_id IS DISTINCT FROM OLD.branch_id
     OR NEW.rfq_id IS DISTINCT FROM OLD.rfq_id OR NEW.current_version_no < OLD.current_version_no
     OR (OLD.accepted_version_id IS NOT NULL AND NEW.accepted_version_id IS DISTINCT FROM OLD.accepted_version_id) THEN
    RAISE EXCEPTION 'quo.quote %: its number, salesperson, branch, request and accepted version never change', OLD.id USING ERRCODE = 'HK004', CONSTRAINT = 'ck_quote_frozen';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    allowed := CASE OLD.status
      WHEN 'DRAFT' THEN ARRAY['PENDING_APPROVAL', 'ISSUED', 'CANCELLED']
      WHEN 'PENDING_APPROVAL' THEN ARRAY['DRAFT', 'ISSUED', 'CANCELLED']
      WHEN 'ISSUED' THEN ARRAY['ACCEPTED', 'DECLINED', 'EXPIRED', 'CANCELLED']
      WHEN 'ACCEPTED' THEN ARRAY['CONVERTED', 'CANCELLED']
      ELSE ARRAY[]::text[] END;
    IF NOT (NEW.status = ANY (allowed)) THEN
      RAISE EXCEPTION 'quo.quote %: % cannot move to %', OLD.id, OLD.status, NEW.status USING ERRCODE = 'HK004', CONSTRAINT = 'ck_quote_transition';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
