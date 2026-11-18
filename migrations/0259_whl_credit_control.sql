-- 0259_whl_credit_control
-- B10 continued (FR-WHL-001, FR-WHL-006 to FR-WHL-008, CR-046, CR-048, ADR-0017, abuse case 14): business accounts and
-- credit control. Exposure is not stored: it is read in the confirming transaction from the owning modules (A-313).
--   whl.account_change          DOCUMENT, registered as an ACCOUNT_CHANGE business document: a new credit limit or the
--                               release of a hold, asked by one person and decided once by another (IAM's approval,
--                               CREDIT_LIMIT_CHANGE or ACCOUNT_RELEASE). ck_account_change_checker: an APPLIED change
--                               was decided (posted_by) by someone other than the person who asked (created_by), as
--                               CR-043's supplier invoice approval is held. Content frozen; decided once (HK004).
--   whl.business_account        MASTER: a customer's credit terms. A credit limit other than nil, and a release from
--                               hold, are written only with an APPLIED change of this account that says so
--                               (whl.business_account_guard, HK010 ck_business_account_limit_approved and
--                               ck_business_account_release_approved); an account opens with a nil limit.
--   whl.credit_override_request LEDGER: an override asked for an order, with its written reason and the figures then.
--   whl.credit_override         LEDGER: an approved override; ck_credit_override_checker: never approved by the person
--                               who asked; the amount over is the exposure with the order less the limit.
-- Differences from docs/data-model/whl.md, recorded there: business_account adds branch_id (the home branch its
-- approvals and reads are scoped to), held_by, hold_document_id, limit_change_id, release_change_id and drops
-- exposure_pesewas; credit_override adds the request, the order's amount, the amount over, the reasons and who asked.
-- Data category: CONFIDENTIAL (DC-11: a customer's credit terms and standing).
-- Rollback: tested (`pnpm db:rollback`), safe before the first account; afterwards forward fix only (an override is a
-- financial control record and is never removed).

-- migrate:up
CREATE TABLE whl.account_change (
  id                     uuid PRIMARY KEY CONSTRAINT fk_account_change_document REFERENCES platform.business_document (id) ON DELETE RESTRICT,
  customer_id            uuid NOT NULL CONSTRAINT fk_account_change_customer REFERENCES mdm.customer (id) ON DELETE RESTRICT,
  kind                   text NOT NULL CONSTRAINT ck_account_change_kind CHECK (kind IN ('CREDIT_LIMIT', 'RELEASE')),
  credit_limit_pesewas   platform.pesewas NULL,
  previous_limit_pesewas platform.pesewas NULL,
  reason                 text NOT NULL CONSTRAINT ck_account_change_reason CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
  approval_request_id    uuid NOT NULL CONSTRAINT fk_account_change_approval REFERENCES iam.approval_request (id) ON DELETE RESTRICT
                         CONSTRAINT uq_account_change_approval UNIQUE,
  decision_reason        text NULL CONSTRAINT ck_account_change_decision_reason CHECK (length(decision_reason) <= 500),
  status                 text NOT NULL CONSTRAINT ck_account_change_status CHECK (status IN ('PENDING_APPROVAL', 'APPLIED', 'REJECTED', 'CANCELLED')),
  branch_id              uuid NOT NULL CONSTRAINT fk_account_change_branch REFERENCES mdm.branch (id) ON DELETE RESTRICT,
  version                integer NOT NULL DEFAULT 1,
  created_at             timestamptz NOT NULL,
  created_by             uuid NOT NULL CONSTRAINT fk_account_change_created_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  updated_at             timestamptz NOT NULL,
  updated_by             uuid NOT NULL CONSTRAINT fk_account_change_updated_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  posted_at              timestamptz NULL,
  posted_by              uuid NULL CONSTRAINT fk_account_change_posted_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  CONSTRAINT ck_account_change_limit CHECK ((kind = 'CREDIT_LIMIT') = (credit_limit_pesewas IS NOT NULL AND previous_limit_pesewas IS NOT NULL)),
  CONSTRAINT ck_account_change_decided CHECK ((status IN ('APPLIED', 'REJECTED')) = (posted_at IS NOT NULL AND posted_by IS NOT NULL)),
  CONSTRAINT ck_account_change_checker CHECK (status <> 'APPLIED' OR posted_by IS DISTINCT FROM created_by)
);
COMMENT ON TABLE whl.account_change IS 'class=DOCUMENT';
CREATE UNIQUE INDEX uq_account_change_pending ON whl.account_change (customer_id, kind) WHERE status = 'PENDING_APPROVAL';
CREATE INDEX ix_account_change_customer ON whl.account_change (customer_id, id);
CREATE TRIGGER trg_account_change_version BEFORE UPDATE ON whl.account_change FOR EACH ROW EXECUTE FUNCTION platform.touch_version();

-- Asked once and decided once: a change is written PENDING_APPROVAL and moves once to its decision; nothing else of it
-- changes.
CREATE FUNCTION whl.account_change_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'PENDING_APPROVAL' THEN
      RAISE EXCEPTION 'whl.account_change %: a change is asked for before it is decided', NEW.id USING ERRCODE = 'HK004', CONSTRAINT = 'ck_account_change_frozen';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status <> 'PENDING_APPROVAL' OR NEW.status = 'PENDING_APPROVAL'
     OR (to_jsonb(NEW) - ARRAY['status', 'decision_reason', 'posted_at', 'posted_by', 'version', 'updated_at', 'updated_by'])
        IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'decision_reason', 'posted_at', 'posted_by', 'version', 'updated_at', 'updated_by']) THEN
    RAISE EXCEPTION 'whl.account_change % is decided once and never changed', OLD.id USING ERRCODE = 'HK004', CONSTRAINT = 'ck_account_change_frozen';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION whl.account_change_guard() FROM PUBLIC;
CREATE TRIGGER trg_account_change_guard BEFORE INSERT OR UPDATE ON whl.account_change
  FOR EACH ROW EXECUTE FUNCTION whl.account_change_guard();

CREATE TABLE whl.business_account (
  customer_id          uuid PRIMARY KEY CONSTRAINT fk_business_account_customer REFERENCES mdm.customer (id) ON DELETE RESTRICT,
  branch_id            uuid NOT NULL CONSTRAINT fk_business_account_branch REFERENCES mdm.branch (id) ON DELETE RESTRICT,
  credit_limit_pesewas platform.pesewas NOT NULL DEFAULT 0,
  payment_terms_days   integer NOT NULL DEFAULT 0 CONSTRAINT ck_business_account_terms CHECK (payment_terms_days BETWEEN 0 AND 365),
  account_manager_id   uuid NULL CONSTRAINT fk_business_account_manager REFERENCES iam.principal (id) ON DELETE RESTRICT,
  overdue_hold_days    integer NOT NULL DEFAULT 30 CONSTRAINT ck_business_account_hold_days CHECK (overdue_hold_days BETWEEN 1 AND 365),
  status               text NOT NULL CONSTRAINT ck_business_account_status CHECK (status IN ('ACTIVE', 'ON_HOLD', 'CLOSED')),
  hold_reason          text NULL CONSTRAINT ck_business_account_hold_reason CHECK (length(btrim(hold_reason)) BETWEEN 1 AND 500),
  held_at              timestamptz NULL,
  held_by              uuid NULL CONSTRAINT fk_business_account_held_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  hold_document_id     uuid NULL CONSTRAINT fk_business_account_hold_document REFERENCES platform.business_document (id) ON DELETE RESTRICT,
  limit_change_id      uuid NULL CONSTRAINT fk_business_account_limit_change REFERENCES whl.account_change (id) ON DELETE RESTRICT,
  release_change_id    uuid NULL CONSTRAINT fk_business_account_release_change REFERENCES whl.account_change (id) ON DELETE RESTRICT,
  version              integer NOT NULL DEFAULT 1,
  created_at           timestamptz NOT NULL,
  created_by           uuid NOT NULL CONSTRAINT fk_business_account_created_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  updated_at           timestamptz NOT NULL,
  updated_by           uuid NOT NULL CONSTRAINT fk_business_account_updated_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  deleted_at           timestamptz NULL,
  deleted_by           uuid NULL CONSTRAINT fk_business_account_deleted_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  delete_reason        text NULL,
  CONSTRAINT ck_business_account_hold CHECK ((status = 'ON_HOLD') = (hold_reason IS NOT NULL AND held_at IS NOT NULL AND held_by IS NOT NULL)
                                            AND (hold_document_id IS NULL OR status = 'ON_HOLD')),
  CONSTRAINT ck_business_account_deleted CHECK ((deleted_at IS NULL) = (deleted_by IS NULL) AND (deleted_at IS NULL) = (delete_reason IS NULL))
);
COMMENT ON TABLE whl.business_account IS 'class=MASTER';
CREATE INDEX ix_business_account_branch ON whl.business_account (branch_id, customer_id);
CREATE INDEX ix_business_account_manager ON whl.business_account (account_manager_id) WHERE account_manager_id IS NOT NULL;
CREATE TRIGGER trg_business_account_version BEFORE UPDATE ON whl.business_account FOR EACH ROW EXECUTE FUNCTION platform.touch_version();

-- The second person is held here as well as in the application (ADR-0017, CR-048): an account opens with a nil limit;
-- its limit changes only with an APPLIED CREDIT_LIMIT change of this account for exactly that limit, and it leaves a
-- hold only with an APPLIED RELEASE change of this account not used before. Its customer and branch never change.
CREATE FUNCTION whl.business_account_guard() RETURNS trigger
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
REVOKE ALL ON FUNCTION whl.business_account_guard() FROM PUBLIC;
CREATE TRIGGER trg_business_account_guard BEFORE INSERT OR UPDATE ON whl.business_account
  FOR EACH ROW EXECUTE FUNCTION whl.business_account_guard();

CREATE TABLE whl.credit_override_request (
  id                  uuid PRIMARY KEY,
  order_id            uuid NOT NULL CONSTRAINT fk_credit_override_request_order REFERENCES ord.sales_order (id) ON DELETE RESTRICT,
  customer_id         uuid NOT NULL CONSTRAINT fk_credit_override_request_customer REFERENCES mdm.customer (id) ON DELETE RESTRICT,
  branch_id           uuid NOT NULL CONSTRAINT fk_credit_override_request_branch REFERENCES mdm.branch (id) ON DELETE RESTRICT,
  approval_request_id uuid NOT NULL CONSTRAINT fk_credit_override_request_approval REFERENCES iam.approval_request (id) ON DELETE RESTRICT
                      CONSTRAINT uq_credit_override_request_approval UNIQUE,
  reason              text NOT NULL CONSTRAINT ck_credit_override_request_reason CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
  reasons             text[] NOT NULL CONSTRAINT ck_credit_override_request_reasons
                      CHECK (cardinality(reasons) BETWEEN 1 AND 3 AND reasons <@ ARRAY['OVER_LIMIT', 'PAST_TERMS', 'ON_HOLD']::text[]),
  limit_pesewas       platform.pesewas NOT NULL,
  exposure_pesewas    platform.pesewas NOT NULL,
  order_pesewas       platform.pesewas NOT NULL,
  over_limit_pesewas  platform.pesewas NOT NULL,
  requested_by        uuid NOT NULL CONSTRAINT fk_credit_override_request_requested_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  recorded_at         timestamptz NOT NULL,
  actor_id            uuid NOT NULL CONSTRAINT fk_credit_override_request_actor REFERENCES iam.principal (id) ON DELETE RESTRICT,
  CONSTRAINT ck_credit_override_request_over CHECK (over_limit_pesewas::numeric = greatest(exposure_pesewas::numeric + order_pesewas - limit_pesewas, 0))
);
COMMENT ON TABLE whl.credit_override_request IS 'class=LEDGER';
CREATE INDEX ix_credit_override_request_order ON whl.credit_override_request (order_id);
CREATE TRIGGER trg_credit_override_request_immutable BEFORE UPDATE OR DELETE ON whl.credit_override_request FOR EACH ROW EXECUTE FUNCTION platform.reject_change();
CREATE TRIGGER trg_credit_override_request_no_truncate BEFORE TRUNCATE ON whl.credit_override_request FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_change();

CREATE TABLE whl.credit_override (
  id                  uuid PRIMARY KEY,
  request_id          uuid NOT NULL CONSTRAINT fk_credit_override_request REFERENCES whl.credit_override_request (id) ON DELETE RESTRICT
                      CONSTRAINT uq_credit_override_request UNIQUE,
  customer_id         uuid NOT NULL CONSTRAINT fk_credit_override_customer REFERENCES mdm.customer (id) ON DELETE RESTRICT,
  order_id            uuid NOT NULL CONSTRAINT fk_credit_override_order REFERENCES ord.sales_order (id) ON DELETE RESTRICT,
  branch_id           uuid NOT NULL CONSTRAINT fk_credit_override_branch REFERENCES mdm.branch (id) ON DELETE RESTRICT,
  approval_request_id uuid NOT NULL CONSTRAINT fk_credit_override_approval REFERENCES iam.approval_request (id) ON DELETE RESTRICT
                      CONSTRAINT uq_credit_override_approval UNIQUE,
  reason              text NOT NULL CONSTRAINT ck_credit_override_reason CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
  reasons             text[] NOT NULL CONSTRAINT ck_credit_override_reasons
                      CHECK (cardinality(reasons) BETWEEN 1 AND 3 AND reasons <@ ARRAY['OVER_LIMIT', 'PAST_TERMS', 'ON_HOLD']::text[]),
  limit_pesewas       platform.pesewas NOT NULL,
  exposure_pesewas    platform.pesewas NOT NULL,
  order_pesewas       platform.pesewas NOT NULL,
  over_limit_pesewas  platform.pesewas NOT NULL,
  requested_by        uuid NOT NULL CONSTRAINT fk_credit_override_requested_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  approved_by         uuid NOT NULL CONSTRAINT fk_credit_override_approved_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  recorded_at         timestamptz NOT NULL,
  actor_id            uuid NOT NULL CONSTRAINT fk_credit_override_actor REFERENCES iam.principal (id) ON DELETE RESTRICT,
  CONSTRAINT ck_credit_override_checker CHECK (approved_by <> requested_by),
  CONSTRAINT ck_credit_override_over CHECK (over_limit_pesewas::numeric = greatest(exposure_pesewas::numeric - limit_pesewas, 0)
                                            AND exposure_pesewas >= order_pesewas)
);
COMMENT ON TABLE whl.credit_override IS 'class=LEDGER';
CREATE INDEX ix_credit_override_order ON whl.credit_override (order_id);
CREATE INDEX ix_credit_override_customer ON whl.credit_override (customer_id, id);
CREATE INDEX ix_credit_override_branch ON whl.credit_override (branch_id, id);
CREATE TRIGGER trg_credit_override_immutable BEFORE UPDATE OR DELETE ON whl.credit_override FOR EACH ROW EXECUTE FUNCTION platform.reject_change();
CREATE TRIGGER trg_credit_override_no_truncate BEFORE TRUNCATE ON whl.credit_override FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_change();

REVOKE ALL ON whl.account_change, whl.business_account, whl.credit_override_request, whl.credit_override FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON whl.account_change, whl.business_account TO hk_app, hk_worker;
GRANT SELECT, INSERT ON whl.credit_override_request, whl.credit_override TO hk_app, hk_worker;

-- migrate:down
DROP TABLE whl.credit_override;
DROP TABLE whl.credit_override_request;
DROP TABLE whl.business_account;
DROP FUNCTION whl.business_account_guard();
DROP TABLE whl.account_change;
DROP FUNCTION whl.account_change_guard();
