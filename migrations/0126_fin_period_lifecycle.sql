-- 0126_fin_period_lifecycle
-- B08 continued (FR-FIN-009, FR-FIN-010, A-188): accounting periods lock, close and reopen, and a reopen is asked for
-- and approved by a different person (PERIOD_REOPEN, ADR-0017).
--
-- The database holds the lifecycle itself, whoever writes (HK012, the rule as its constraint name):
--   ck_period_change            (0123, kept) a period's dates never change and a CLOSED period never changes at all
--   ck_period_transition        a status moves only FUTURE -> OPEN, OPEN -> LOCKED, LOCKED -> OPEN or LOCKED -> CLOSED;
--                               a LOCKED period names who locked it and when, and an OPEN one names nobody
--   ck_period_close_order       a period becomes CLOSED only once every earlier period is CLOSED, so the closed
--                               periods always run unbroken from the first
-- fin.period_reopen (DOCUMENT): one request to reopen one locked period, with its reason, frozen once decided:
--   ck_period_reopen_status     PENDING_APPROVAL, POSTED (reopened) or REJECTED
--   ck_period_reopen_decided    decided_at and decided_by are set exactly when the request is no longer pending
--   uq_period_reopen_pending    one pending request per period
-- Additions to docs/data-model/fin.md: `fin.period_reopen`; the transition and close-order rules on
-- `fin.accounting_period`.
-- Data category: CONFIDENTIAL (DC-15).
-- Rollback: tested (`pnpm db:rollback`): restores 0123's guard and drops the table. Safe before the first reopen
-- request; afterwards forward fix only.

-- migrate:up
CREATE OR REPLACE FUNCTION fin.accounting_period_guard() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
BEGIN
  IF OLD.status = 'CLOSED' THEN
    PERFORM fin.refuse('ck_period_change', format('accounting period %s-%s is CLOSED and never changes', OLD.fiscal_year, OLD.period_no));
  END IF;
  IF (NEW.fiscal_year, NEW.period_no, NEW.start_date, NEW.end_date) IS DISTINCT FROM (OLD.fiscal_year, OLD.period_no, OLD.start_date, OLD.end_date) THEN
    PERFORM fin.refuse('ck_period_change', format('accounting period %s-%s keeps its dates', OLD.fiscal_year, OLD.period_no));
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status
     AND (OLD.status, NEW.status) NOT IN (('FUTURE', 'OPEN'), ('OPEN', 'LOCKED'), ('LOCKED', 'OPEN'), ('LOCKED', 'CLOSED')) THEN
    PERFORM fin.refuse('ck_period_transition', format('accounting period %s-%s cannot move from %s to %s', OLD.fiscal_year, OLD.period_no, OLD.status, NEW.status));
  END IF;
  IF (NEW.status IN ('LOCKED', 'CLOSED') AND (NEW.locked_at IS NULL OR NEW.locked_by IS NULL))
     OR (NEW.status IN ('FUTURE', 'OPEN') AND (NEW.locked_at IS NOT NULL OR NEW.locked_by IS NOT NULL)) THEN
    PERFORM fin.refuse('ck_period_transition', format('accounting period %s-%s: a locked period names who locked it, an open one nobody', OLD.fiscal_year, OLD.period_no));
  END IF;
  IF NEW.status = 'CLOSED'
     AND EXISTS (SELECT 1 FROM fin.accounting_period p WHERE p.start_date < NEW.start_date AND p.status <> 'CLOSED') THEN
    PERFORM fin.refuse('ck_period_close_order', format('accounting period %s-%s closes only once every earlier period is closed', OLD.fiscal_year, OLD.period_no));
  END IF;
  RETURN NEW;
END
$$;

CREATE TABLE fin.period_reopen (
  id                  uuid PRIMARY KEY CONSTRAINT fk_period_reopen_document REFERENCES platform.business_document (id) ON DELETE RESTRICT,
  period_id           uuid NOT NULL CONSTRAINT fk_period_reopen_period REFERENCES fin.accounting_period (id) ON DELETE RESTRICT,
  branch_id           uuid NOT NULL CONSTRAINT fk_period_reopen_branch REFERENCES mdm.branch (id) ON DELETE RESTRICT,
  reason              text NOT NULL CONSTRAINT ck_period_reopen_reason CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
  status              text NOT NULL CONSTRAINT ck_period_reopen_status CHECK (status IN ('PENDING_APPROVAL', 'POSTED', 'REJECTED')),
  approval_request_id uuid NOT NULL CONSTRAINT fk_period_reopen_approval REFERENCES iam.approval_request (id) ON DELETE RESTRICT,
  decided_at          timestamptz NULL,
  decided_by          uuid NULL CONSTRAINT fk_period_reopen_decided_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  version             integer NOT NULL DEFAULT 1,
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid NOT NULL CONSTRAINT fk_period_reopen_created_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  updated_by          uuid NOT NULL CONSTRAINT fk_period_reopen_updated_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  CONSTRAINT ck_period_reopen_decided CHECK ((status = 'PENDING_APPROVAL') = (decided_at IS NULL) AND (decided_at IS NULL) = (decided_by IS NULL))
);
COMMENT ON TABLE fin.period_reopen IS 'class=DOCUMENT';
CREATE UNIQUE INDEX uq_period_reopen_pending ON fin.period_reopen (period_id) WHERE status = 'PENDING_APPROVAL';
CREATE TRIGGER trg_period_reopen_version BEFORE UPDATE ON fin.period_reopen
  FOR EACH ROW EXECUTE FUNCTION platform.touch_version();
CREATE TRIGGER trg_period_reopen_freeze BEFORE UPDATE ON fin.period_reopen
  FOR EACH ROW EXECUTE FUNCTION platform.freeze_posted('POSTED,REJECTED');

REVOKE ALL ON fin.period_reopen FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON fin.period_reopen TO hk_app, hk_worker;

-- migrate:down
DROP TABLE fin.period_reopen;
CREATE OR REPLACE FUNCTION fin.accounting_period_guard() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
BEGIN
  IF OLD.status = 'CLOSED' THEN
    PERFORM fin.refuse('ck_period_change', format('accounting period %s-%s is CLOSED and never changes', OLD.fiscal_year, OLD.period_no));
  END IF;
  IF (NEW.fiscal_year, NEW.period_no, NEW.start_date, NEW.end_date) IS DISTINCT FROM (OLD.fiscal_year, OLD.period_no, OLD.start_date, OLD.end_date) THEN
    PERFORM fin.refuse('ck_period_change', format('accounting period %s-%s keeps its dates', OLD.fiscal_year, OLD.period_no));
  END IF;
  RETURN NEW;
END
$$;
