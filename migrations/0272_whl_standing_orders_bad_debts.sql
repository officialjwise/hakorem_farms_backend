-- 0272_whl_standing_orders_bad_debts
-- B10 continued 3 (FR-WHL-004, FR-WHL-012, CR-043's pattern, ADR-0017, ADR-0090, A-320, A-321).
--   whl.standing_order          DOCUMENT, registered as a STANDING_ORDER business document: a customer's recurring
--                               order at one branch, weekly or fortnightly on named days, monthly on a day of the
--                               month or every n days (ck_standing_order_schedule: each frequency with only its own
--                               fields), from a start to an optional end. ENDED and CANCELLED are final.
--   whl.standing_order_line     DOCUMENT: its products and quantities, priced by the engine on each run date.
--   whl.standing_order_run      LEDGER: each run date once (PK standing order and date, however often the job runs),
--                               with the order it made (CREATED, or HELD_FOR_CREDIT when the credit check refused it and
--                               it waits for an override) or the reason none was (SKIPPED_ON_HOLD, SKIPPED_NO_PRICE,
--                               MISSED, FAILED): ck_standing_order_run_outcome.
--   whl.bad_debt_write_off_request  DOCUMENT, registered as a BAD_DEBT_WRITE_OFF business document: asked by one
--                               person (the Accountant), decided once by another (IAM's BAD_DEBT_WRITE_OFF approval).
--                               ck_bad_debt_write_off_request_checker: an APPLIED request was decided by someone other
--                               than its maker; one waiting per document; content frozen (HK004).
--   whl.bad_debt_write_off      LEDGER, insert-only: the write-off applied, with the journal that posted it.
--                               ck_bad_debt_write_off_checker (approved_by <> requested_by) and
--                               whl.bad_debt_write_off_check (HK010 ck_bad_debt_write_off_approved): written only for
--                               an APPLIED request of the same customer, document and amount, its maker and checker.
--                               A correction is a reversing row (BL-092); none is updated or deleted.
-- Differences from docs/data-model/whl.md, recorded there: standing_order adds branch_id, salesperson_id, weekdays
-- (named days, where the dictionary had one weekday), interval_days and EVERY_N_DAYS; the run adds reason, actor_id,
-- HELD_FOR_CREDIT and MISSED; the two write-off tables are new.
-- Data category: CONFIDENTIAL (DC-11: a customer's standing and its debts written off); the standing order DC-13.
-- Rollback: tested (`pnpm db:rollback`), safe before the first standing order or write-off; afterwards forward fix
-- only (a write-off and a run are records that are never removed).

-- migrate:up
CREATE TABLE whl.standing_order (
  id              uuid PRIMARY KEY CONSTRAINT fk_standing_order_document REFERENCES platform.business_document (id) ON DELETE RESTRICT,
  customer_id     uuid NOT NULL CONSTRAINT fk_standing_order_customer REFERENCES mdm.customer (id) ON DELETE RESTRICT,
  frequency       text NOT NULL CONSTRAINT ck_standing_order_frequency CHECK (frequency IN ('WEEKLY', 'FORTNIGHTLY', 'MONTHLY', 'EVERY_N_DAYS')),
  weekdays        integer[] NOT NULL DEFAULT '{}',
  day_of_month    integer NULL CONSTRAINT ck_standing_order_day_of_month CHECK (day_of_month BETWEEN 1 AND 28),
  interval_days   integer NULL CONSTRAINT ck_standing_order_interval CHECK (interval_days BETWEEN 1 AND 365),
  starts_on       date NOT NULL,
  ends_on         date NULL,
  next_run_on     date NULL,
  salesperson_id  uuid NOT NULL CONSTRAINT fk_standing_order_salesperson REFERENCES iam.principal (id) ON DELETE RESTRICT,
  status          text NOT NULL CONSTRAINT ck_standing_order_status CHECK (status IN ('ACTIVE', 'PAUSED', 'ENDED', 'CANCELLED')),
  branch_id       uuid NOT NULL CONSTRAINT fk_standing_order_branch REFERENCES mdm.branch (id) ON DELETE RESTRICT,
  version         integer NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL,
  created_by      uuid NOT NULL CONSTRAINT fk_standing_order_created_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  updated_at      timestamptz NOT NULL,
  updated_by      uuid NOT NULL CONSTRAINT fk_standing_order_updated_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  posted_at       timestamptz NULL,
  posted_by       uuid NULL CONSTRAINT fk_standing_order_posted_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  CONSTRAINT ck_standing_order_schedule CHECK (
    CASE frequency
      WHEN 'MONTHLY' THEN cardinality(weekdays) = 0 AND day_of_month IS NOT NULL AND interval_days IS NULL
      WHEN 'EVERY_N_DAYS' THEN cardinality(weekdays) = 0 AND day_of_month IS NULL AND interval_days IS NOT NULL
      ELSE cardinality(weekdays) BETWEEN 1 AND 7 AND weekdays <@ ARRAY[1, 2, 3, 4, 5, 6, 7] AND day_of_month IS NULL AND interval_days IS NULL
    END),
  CONSTRAINT ck_standing_order_ends CHECK (ends_on IS NULL OR ends_on >= starts_on),
  CONSTRAINT ck_standing_order_next CHECK (next_run_on IS NULL OR (next_run_on >= starts_on AND (ends_on IS NULL OR next_run_on <= ends_on))),
  CONSTRAINT ck_standing_order_posted CHECK ((status IN ('ENDED', 'CANCELLED')) = (posted_at IS NOT NULL AND posted_by IS NOT NULL) AND (status = 'ACTIVE' OR next_run_on IS NULL))
);
COMMENT ON TABLE whl.standing_order IS 'class=DOCUMENT';
CREATE INDEX ix_standing_order_due ON whl.standing_order (next_run_on, id) WHERE status = 'ACTIVE';
CREATE INDEX ix_standing_order_branch ON whl.standing_order (branch_id, id);
CREATE INDEX ix_standing_order_customer ON whl.standing_order (customer_id, id);
CREATE TRIGGER trg_standing_order_version BEFORE UPDATE ON whl.standing_order FOR EACH ROW EXECUTE FUNCTION platform.touch_version();

-- An ended or cancelled standing order never changes again; its customer and branch never change.
CREATE FUNCTION whl.standing_order_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF OLD.status IN ('ENDED', 'CANCELLED') OR NEW.customer_id <> OLD.customer_id OR NEW.branch_id <> OLD.branch_id OR NEW.created_by <> OLD.created_by THEN
    RAISE EXCEPTION 'whl.standing_order %: an ended order, and any order''s customer and branch, never change', OLD.id USING ERRCODE = 'HK004', CONSTRAINT = 'ck_standing_order_frozen';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION whl.standing_order_guard() FROM PUBLIC;
CREATE TRIGGER trg_standing_order_guard BEFORE UPDATE ON whl.standing_order FOR EACH ROW EXECUTE FUNCTION whl.standing_order_guard();

CREATE TABLE whl.standing_order_line (
  id                uuid PRIMARY KEY,
  standing_order_id uuid NOT NULL CONSTRAINT fk_standing_order_line_order REFERENCES whl.standing_order (id) ON DELETE RESTRICT,
  line_no           integer NOT NULL CONSTRAINT ck_standing_order_line_no CHECK (line_no BETWEEN 1 AND 50),
  product_id        uuid NOT NULL CONSTRAINT fk_standing_order_line_product REFERENCES mdm.product (id) ON DELETE RESTRICT,
  qty               platform.qty NOT NULL CONSTRAINT ck_standing_order_line_qty CHECK (qty > 0),
  uom               text NOT NULL CONSTRAINT ck_standing_order_line_uom CHECK (length(uom) BETWEEN 1 AND 20),
  retired_at        timestamptz NULL,
  retired_by        uuid NULL CONSTRAINT fk_standing_order_line_retired_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  created_at        timestamptz NOT NULL,
  created_by        uuid NOT NULL CONSTRAINT fk_standing_order_line_created_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  CONSTRAINT ck_standing_order_line_retired CHECK ((retired_at IS NULL) = (retired_by IS NULL))
);
COMMENT ON TABLE whl.standing_order_line IS 'class=DOCUMENT';
-- The lines in force: replaced lines are retired, never deleted.
CREATE UNIQUE INDEX uq_standing_order_line_no ON whl.standing_order_line (standing_order_id, line_no) WHERE retired_at IS NULL;
CREATE UNIQUE INDEX uq_standing_order_line_product ON whl.standing_order_line (standing_order_id, product_id, uom) WHERE retired_at IS NULL;

-- A line is only ever retired, once; nothing else of it changes.
CREATE FUNCTION whl.standing_order_line_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF OLD.retired_at IS NOT NULL OR NEW.retired_at IS NULL
     OR (to_jsonb(NEW) - ARRAY['retired_at', 'retired_by']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['retired_at', 'retired_by']) THEN
    RAISE EXCEPTION 'whl.standing_order_line % is only retired, once', OLD.id USING ERRCODE = 'HK004', CONSTRAINT = 'ck_standing_order_line_frozen';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION whl.standing_order_line_guard() FROM PUBLIC;
CREATE TRIGGER trg_standing_order_line_guard BEFORE UPDATE ON whl.standing_order_line FOR EACH ROW EXECUTE FUNCTION whl.standing_order_line_guard();

CREATE TABLE whl.standing_order_run (
  standing_order_id uuid NOT NULL CONSTRAINT fk_standing_order_run_order REFERENCES whl.standing_order (id) ON DELETE RESTRICT,
  run_date          date NOT NULL,
  outcome           text NOT NULL CONSTRAINT ck_standing_order_run_outcome_kind CHECK (outcome IN ('CREATED', 'HELD_FOR_CREDIT', 'SKIPPED_ON_HOLD', 'SKIPPED_NO_PRICE', 'MISSED', 'FAILED')),
  order_id          uuid NULL CONSTRAINT fk_standing_order_run_sales_order REFERENCES ord.sales_order (id) ON DELETE RESTRICT
                    CONSTRAINT uq_standing_order_run_sales_order UNIQUE,
  reason            text NULL CONSTRAINT ck_standing_order_run_reason CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
  recorded_at       timestamptz NOT NULL,
  actor_id          uuid NOT NULL CONSTRAINT fk_standing_order_run_actor REFERENCES iam.principal (id) ON DELETE RESTRICT,
  CONSTRAINT pk_standing_order_run PRIMARY KEY (standing_order_id, run_date),
  CONSTRAINT ck_standing_order_run_outcome CHECK ((outcome IN ('CREATED', 'HELD_FOR_CREDIT')) = (order_id IS NOT NULL) AND (outcome = 'CREATED') = (reason IS NULL))
);
COMMENT ON TABLE whl.standing_order_run IS 'class=LEDGER';
CREATE TRIGGER trg_standing_order_run_immutable BEFORE UPDATE OR DELETE ON whl.standing_order_run FOR EACH ROW EXECUTE FUNCTION platform.reject_change();
CREATE TRIGGER trg_standing_order_run_no_truncate BEFORE TRUNCATE ON whl.standing_order_run FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_change();

CREATE TABLE whl.bad_debt_write_off_request (
  id                  uuid PRIMARY KEY CONSTRAINT fk_bad_debt_write_off_request_document REFERENCES platform.business_document (id) ON DELETE RESTRICT,
  customer_id         uuid NOT NULL CONSTRAINT fk_bad_debt_write_off_request_customer REFERENCES mdm.customer (id) ON DELETE RESTRICT,
  billing_document_id uuid NOT NULL CONSTRAINT fk_bad_debt_write_off_request_billing REFERENCES platform.business_document (id) ON DELETE RESTRICT,
  amount_pesewas      platform.pesewas NOT NULL CONSTRAINT ck_bad_debt_write_off_request_amount CHECK (amount_pesewas > 0),
  reason              text NOT NULL CONSTRAINT ck_bad_debt_write_off_request_reason CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
  approval_request_id uuid NOT NULL CONSTRAINT fk_bad_debt_write_off_request_approval REFERENCES iam.approval_request (id) ON DELETE RESTRICT
                      CONSTRAINT uq_bad_debt_write_off_request_approval UNIQUE,
  status              text NOT NULL CONSTRAINT ck_bad_debt_write_off_request_status CHECK (status IN ('PENDING_APPROVAL', 'APPLIED', 'REJECTED', 'CANCELLED')),
  branch_id           uuid NOT NULL CONSTRAINT fk_bad_debt_write_off_request_branch REFERENCES mdm.branch (id) ON DELETE RESTRICT,
  version             integer NOT NULL DEFAULT 1,
  created_at          timestamptz NOT NULL,
  created_by          uuid NOT NULL CONSTRAINT fk_bad_debt_write_off_request_created_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  updated_at          timestamptz NOT NULL,
  updated_by          uuid NOT NULL CONSTRAINT fk_bad_debt_write_off_request_updated_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  posted_at           timestamptz NULL,
  posted_by           uuid NULL CONSTRAINT fk_bad_debt_write_off_request_posted_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  CONSTRAINT ck_bad_debt_write_off_request_decided CHECK ((status IN ('APPLIED', 'REJECTED')) = (posted_at IS NOT NULL AND posted_by IS NOT NULL)),
  CONSTRAINT ck_bad_debt_write_off_request_checker CHECK (status <> 'APPLIED' OR posted_by IS DISTINCT FROM created_by)
);
COMMENT ON TABLE whl.bad_debt_write_off_request IS 'class=DOCUMENT';
CREATE UNIQUE INDEX uq_bad_debt_write_off_request_pending ON whl.bad_debt_write_off_request (billing_document_id) WHERE status = 'PENDING_APPROVAL';
CREATE INDEX ix_bad_debt_write_off_request_customer ON whl.bad_debt_write_off_request (customer_id, id);
CREATE TRIGGER trg_bad_debt_write_off_request_version BEFORE UPDATE ON whl.bad_debt_write_off_request FOR EACH ROW EXECUTE FUNCTION platform.touch_version();

-- Asked once and decided once: written PENDING_APPROVAL, moved once to its decision, nothing else of it changes.
CREATE FUNCTION whl.bad_debt_write_off_request_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'PENDING_APPROVAL' THEN
      RAISE EXCEPTION 'whl.bad_debt_write_off_request %: a write-off is asked for before it is decided', NEW.id USING ERRCODE = 'HK004', CONSTRAINT = 'ck_bad_debt_write_off_request_frozen';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status <> 'PENDING_APPROVAL' OR NEW.status = 'PENDING_APPROVAL'
     OR (to_jsonb(NEW) - ARRAY['status', 'posted_at', 'posted_by', 'version', 'updated_at', 'updated_by'])
        IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'posted_at', 'posted_by', 'version', 'updated_at', 'updated_by']) THEN
    RAISE EXCEPTION 'whl.bad_debt_write_off_request % is decided once and never changed', OLD.id USING ERRCODE = 'HK004', CONSTRAINT = 'ck_bad_debt_write_off_request_frozen';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION whl.bad_debt_write_off_request_guard() FROM PUBLIC;
CREATE TRIGGER trg_bad_debt_write_off_request_guard BEFORE INSERT OR UPDATE ON whl.bad_debt_write_off_request
  FOR EACH ROW EXECUTE FUNCTION whl.bad_debt_write_off_request_guard();

CREATE TABLE whl.bad_debt_write_off (
  id                  uuid PRIMARY KEY CONSTRAINT fk_bad_debt_write_off_request REFERENCES whl.bad_debt_write_off_request (id) ON DELETE RESTRICT,
  customer_id         uuid NOT NULL CONSTRAINT fk_bad_debt_write_off_customer REFERENCES mdm.customer (id) ON DELETE RESTRICT,
  billing_document_id uuid NOT NULL CONSTRAINT fk_bad_debt_write_off_billing REFERENCES platform.business_document (id) ON DELETE RESTRICT,
  branch_id           uuid NOT NULL CONSTRAINT fk_bad_debt_write_off_branch REFERENCES mdm.branch (id) ON DELETE RESTRICT,
  amount_pesewas      platform.pesewas NOT NULL CONSTRAINT ck_bad_debt_write_off_amount CHECK (amount_pesewas > 0),
  written_off_on      date NOT NULL,
  journal_entry_id    uuid NOT NULL CONSTRAINT fk_bad_debt_write_off_journal REFERENCES platform.business_document (id) ON DELETE RESTRICT
                      CONSTRAINT uq_bad_debt_write_off_journal UNIQUE,
  requested_by        uuid NOT NULL CONSTRAINT fk_bad_debt_write_off_requested_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  approved_by         uuid NOT NULL CONSTRAINT fk_bad_debt_write_off_approved_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  recorded_at         timestamptz NOT NULL,
  actor_id            uuid NOT NULL CONSTRAINT fk_bad_debt_write_off_actor REFERENCES iam.principal (id) ON DELETE RESTRICT,
  CONSTRAINT ck_bad_debt_write_off_checker CHECK (approved_by <> requested_by)
);
COMMENT ON TABLE whl.bad_debt_write_off IS 'class=LEDGER';
CREATE INDEX ix_bad_debt_write_off_document ON whl.bad_debt_write_off (billing_document_id, written_off_on);
CREATE INDEX ix_bad_debt_write_off_customer ON whl.bad_debt_write_off (customer_id, id);
CREATE TRIGGER trg_bad_debt_write_off_immutable BEFORE UPDATE OR DELETE ON whl.bad_debt_write_off FOR EACH ROW EXECUTE FUNCTION platform.reject_change();
CREATE TRIGGER trg_bad_debt_write_off_no_truncate BEFORE TRUNCATE ON whl.bad_debt_write_off FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_change();

-- A write-off is written only for its request, approved by someone other than its maker, as asked.
CREATE FUNCTION whl.bad_debt_write_off_check() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  r record;
BEGIN
  SELECT q.status, q.customer_id, q.billing_document_id, q.amount_pesewas, q.created_by, q.posted_by INTO r FROM whl.bad_debt_write_off_request q WHERE q.id = NEW.id;
  IF r.status IS DISTINCT FROM 'APPLIED' OR r.customer_id <> NEW.customer_id OR r.billing_document_id <> NEW.billing_document_id
     OR r.amount_pesewas <> NEW.amount_pesewas OR r.created_by <> NEW.requested_by OR r.posted_by IS DISTINCT FROM NEW.approved_by THEN
    RAISE EXCEPTION 'whl.bad_debt_write_off %: written only for its approved request, as asked, by its maker and its checker', NEW.id
      USING ERRCODE = 'HK010', CONSTRAINT = 'ck_bad_debt_write_off_approved';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION whl.bad_debt_write_off_check() FROM PUBLIC;
CREATE TRIGGER trg_bad_debt_write_off_check BEFORE INSERT ON whl.bad_debt_write_off FOR EACH ROW EXECUTE FUNCTION whl.bad_debt_write_off_check();

REVOKE ALL ON whl.standing_order, whl.standing_order_line, whl.standing_order_run, whl.bad_debt_write_off_request, whl.bad_debt_write_off FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON whl.standing_order, whl.standing_order_line, whl.bad_debt_write_off_request TO hk_app, hk_worker;
GRANT SELECT, INSERT ON whl.standing_order_run, whl.bad_debt_write_off TO hk_app, hk_worker;

-- migrate:down
DROP TABLE whl.bad_debt_write_off;
DROP FUNCTION whl.bad_debt_write_off_check();
DROP TABLE whl.bad_debt_write_off_request;
DROP FUNCTION whl.bad_debt_write_off_request_guard();
DROP TABLE whl.standing_order_run;
DROP TABLE whl.standing_order_line;
DROP FUNCTION whl.standing_order_line_guard();
DROP TABLE whl.standing_order;
DROP FUNCTION whl.standing_order_guard();
