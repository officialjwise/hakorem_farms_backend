-- 0370_rpt_exception_report
-- B12 continued 3 (FR-RPT-007 to FR-RPT-009, ADR-0023, ADR-0026, ADR-0103, CR-059): the reporting schema's first tables,
-- the daily exception report's read model.
--   rpt.exception_item        PROJECTION: one row per thing a manager must look at, raised by an outbox event the
--                             projector reads or by a record the sweep reads; its id is fixed by its source key, so a
--                             rebuild gives every item the same id and its review still applies
--   rpt.exception_review      LEDGER: an item marked reviewed with a note, once, never by the item's own actor
--   rpt.projection_checkpoint WORK: where each projector has read up to and when, for the health endpoint's lag
--   rpt.approval_fact         PROJECTION: every approval decided (maker, checker, amount), for the approval pairs (R1)
--   rpt.checkout_fact         PROJECTION: every storefront checkout by the keyed hash of its address, for R18
--   rpt.payout_change_fact    PROJECTION: every payout detail change made, for a payment within 24 hours after it
-- Rules held here:
--   * an item's kind and severity are from the fixed lists; an amount is never negative (platform.pesewas);
--   * a review is written once per item (uq_exception_review_item) and never by the person the item names
--     (ck_exception_review_not_own); reviews are insert-only;
--   * the projections are written only through the SECURITY DEFINER functions below; the application roles read them.
-- Data category: CONFIDENTIAL (DC-09): staff, customers and suppliers appear as ids; payout details only masked, as
-- their modules publish them; no contact detail is ever copied into an item (the projector removes them).
-- Rollback: tested (`pnpm db:rollback`). The projections rebuild from the outbox and the swept records; a review
-- is lost only if rolled back, so roll back only before the first review, afterwards forward fix only.

-- migrate:up
CREATE SCHEMA rpt AUTHORIZATION hk_owner;
REVOKE ALL ON SCHEMA rpt FROM PUBLIC;
GRANT USAGE ON SCHEMA rpt TO hk_app, hk_worker, hk_report;

-- An item's id from its source key: md5 laid out as an RFC 9562 version 8 UUID, so a rebuild gives each item the same id.
CREATE FUNCTION rpt.exception_item_id(p_source_key text) RETURNS uuid
  LANGUAGE sql
  IMMUTABLE
  SET search_path = pg_catalog
AS $$
  SELECT (substr(h, 1, 12) || '8' || substr(h, 14, 3) || '8' || substr(h, 18, 15))::uuid FROM (SELECT md5(p_source_key) AS h) m
$$;

CREATE TABLE rpt.exception_item (
  id                   uuid PRIMARY KEY,
  source_key           text NOT NULL CONSTRAINT uq_exception_item_source UNIQUE
                         CONSTRAINT ck_exception_item_source_key CHECK (length(source_key) BETWEEN 3 AND 400),
  event_ref            uuid NULL,
  exception_date       date NOT NULL,
  branch_id            uuid NULL CONSTRAINT fk_exception_item_branch REFERENCES mdm.branch (id) ON DELETE RESTRICT,
  kind                 text NOT NULL CONSTRAINT ck_exception_item_kind CHECK (kind IN (
                    'SALE_VOID', 'PRICE_OVERRIDE', 'REFUND', 'MORTALITY', 'STOCK_ADJUSTMENT', 'STOCK_EXCEPTION', 'UNMATCHED_PAYMENT',
                    'WEBHOOK_REJECTED', 'DRIVER_VARIANCE', 'SHIFT_OVER_SHORT', 'DEVICE_COUNTER_GAP', 'AUTHORISATION_FAILURE',
                    'BULK_EXPORT', 'CREDIT_OVERRIDE', 'PAYOUT_DETAIL_CHANGE', 'PERMISSION_CHANGE', 'YIELD_VARIANCE', 'AUDIT_INTEGRITY',
                    'RECONCILIATION_BREAK', 'SYNC_REJECTED', 'LATE_POSTING', 'QUOTE_ACCEPTED_BY_STAFF', 'CASH_DROP',
                    'MORTALITY_PHOTO_REUSED', 'DELIVERY_PHOTO_REUSED', 'CASH_HANDED_IN_LATE', 'NEGATIVE_STOCK',
                    'GOODS_RECEIPT_UNMATCHED', 'ORDER_SPLITTING', 'SUPPLIER_VARIANCE', 'SUPPLIER_CREDIT_NOTE', 'PROCESSING_REVERSAL',
                    'ASSET_DISPOSAL', 'CREDIT_NOTE', 'PAYMENT_REVERSAL', 'RECEIPT_CLAIM', 'RECEIPT_TOKEN_REFUSED',
                    'OFFLINE_SALE_REVIEW', 'BAD_DEBT_WRITE_OFF', 'WRITTEN_OFF_CUSTOMER_PAID', 'CONSENT_RECORDED_BY_STAFF',
                    'DELIVERY_FAILURE', 'DELIVERY_WRITE_OFF', 'DELIVERY_RETURN', 'DELIVERY_REASSIGNED', 'PART_DELIVERY',
                    'DELIVERY_CANCELLED', 'BACKORDER_HELD', 'SALE_RETURN', 'MESSAGE_REPORT_REJECTED', 'MESSAGE_SUPPRESSED',
                    'MESSAGE_FAILED', 'DOCUMENT_SENT', 'QUOTE_HOLD', 'QUOTE_WITHDRAWN', 'ACCEPTED_QUOTE_LAPSED',
                    'PAYMENT_AFTER_PAYOUT_CHANGE', 'CAPITAL_WITHDRAWAL', 'DISTRIBUTION', 'BACKDATED_CONTRIBUTION', 'RETENTION_RATE',
                    'LOAN_OR_GRANT', 'ACCRUAL_BLOCKED', 'OVERHEAD_ALLOCATION', 'PROJECTION_DRIFT', 'CHECKOUT_HOLDING')),
  source_kind          text NULL CONSTRAINT ck_exception_item_source_kind CHECK (source_kind ~ '^[A-Za-z0-9_.]{1,80}$'),
  abuse_cases          integer[] NOT NULL,
  severity             text NOT NULL CONSTRAINT ck_exception_item_severity CHECK (severity IN ('INFO', 'REVIEW', 'URGENT')),
  actor_ref            uuid NULL,
  subject_document_ref uuid NULL,
  subject_doc_type     text NULL,
  amount_pesewas       platform.pesewas NULL,
  summary              text NOT NULL CONSTRAINT ck_exception_item_summary CHECK (length(summary) BETWEEN 1 AND 1000),
  details              jsonb NOT NULL,
  raised_at            timestamptz NOT NULL,
  restricted_to        text NULL,
  projected_at         timestamptz NOT NULL,
  CONSTRAINT ck_exception_item_id CHECK (id = rpt.exception_item_id(source_key)),
  CONSTRAINT ck_exception_item_subject CHECK ((subject_document_ref IS NULL) = (subject_doc_type IS NULL))
);
COMMENT ON TABLE rpt.exception_item IS 'class=PROJECTION';
CREATE INDEX ix_exception_item_day ON rpt.exception_item (exception_date, branch_id);
CREATE INDEX ix_exception_item_rates ON rpt.exception_item (kind, actor_ref, exception_date);

CREATE TABLE rpt.exception_review (
  id                uuid PRIMARY KEY,
  exception_item_id uuid NOT NULL CONSTRAINT uq_exception_review_item UNIQUE,
  branch_id         uuid NULL CONSTRAINT fk_exception_review_branch REFERENCES mdm.branch (id) ON DELETE RESTRICT,
  item_actor_ref    uuid NULL,
  note              text NOT NULL CONSTRAINT ck_exception_review_note CHECK (length(btrim(note)) BETWEEN 1 AND 500),
  recorded_at       timestamptz NOT NULL DEFAULT platform.app_now(),
  actor_id          uuid NOT NULL CONSTRAINT fk_exception_review_actor REFERENCES iam.principal (id) ON DELETE RESTRICT,
  CONSTRAINT ck_exception_review_not_own CHECK (item_actor_ref IS DISTINCT FROM actor_id)
);
COMMENT ON TABLE rpt.exception_review IS 'class=LEDGER';
CREATE TRIGGER trg_exception_review_immutable BEFORE UPDATE OR DELETE ON rpt.exception_review
  FOR EACH ROW EXECUTE FUNCTION platform.reject_change();
CREATE TRIGGER trg_exception_review_no_truncate BEFORE TRUNCATE ON rpt.exception_review
  FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_change();

CREATE TABLE rpt.projection_checkpoint (
  projector         text PRIMARY KEY CONSTRAINT ck_projection_checkpoint_name CHECK (projector ~ '^[a-z]{3,8}\.[a-z][a-z0-9-]+$'),
  last_message_id   uuid NULL,
  last_processed_at timestamptz NULL,
  last_recorded_at  timestamptz NULL,
  rebuilt_at        timestamptz NULL
);
COMMENT ON TABLE rpt.projection_checkpoint IS 'class=WORK';

CREATE TABLE rpt.approval_fact (
  event_ref      uuid PRIMARY KEY,
  decided_date   date NOT NULL,
  decided_at     timestamptz NOT NULL,
  branch_id      uuid NULL CONSTRAINT fk_approval_fact_branch REFERENCES mdm.branch (id) ON DELETE RESTRICT,
  approval_kind  text NOT NULL,
  decision       text NOT NULL CONSTRAINT ck_approval_fact_decision CHECK (decision IN ('APPROVED', 'REJECTED')),
  maker_ref      uuid NOT NULL,
  checker_ref    uuid NOT NULL,
  amount_pesewas platform.pesewas NULL
);
COMMENT ON TABLE rpt.approval_fact IS 'class=PROJECTION';
CREATE INDEX ix_approval_fact_day ON rpt.approval_fact (decided_date, branch_id);

CREATE TABLE rpt.checkout_fact (
  checkout_ref  uuid PRIMARY KEY,
  address_hash  text NULL CONSTRAINT ck_checkout_fact_hash CHECK (address_hash ~ '^[0-9a-f]{64}$'),
  started_date  date NOT NULL,
  started_at    timestamptz NOT NULL,
  outcome       text NOT NULL CONSTRAINT ck_checkout_fact_outcome CHECK (outcome IN ('STARTED', 'EXPIRED', 'CANCELLED', 'COMPLETED')),
  ended_at      timestamptz NULL
);
COMMENT ON TABLE rpt.checkout_fact IS 'class=PROJECTION';
CREATE INDEX ix_checkout_fact_address ON rpt.checkout_fact (address_hash, started_date);

CREATE TABLE rpt.payout_change_fact (
  event_ref    uuid PRIMARY KEY,
  party_kind   text NOT NULL CONSTRAINT ck_payout_change_fact_party CHECK (party_kind IN ('SUPPLIER', 'INVESTOR')),
  party_ref    uuid NOT NULL,
  change_ref   uuid NOT NULL,
  changed_at   timestamptz NOT NULL,
  requested_by uuid NULL,
  approved_by  uuid NULL
);
COMMENT ON TABLE rpt.payout_change_fact IS 'class=PROJECTION';
CREATE INDEX ix_payout_change_fact_party ON rpt.payout_change_fact (party_kind, party_ref, changed_at);

-- Items from JSON rows: insert each by its source key; with p_replace an existing item takes the new figures (an
-- event's item is richer than a swept record's), otherwise the first stays. Its id is fixed by its source key.
CREATE FUNCTION rpt.put_exception_items(p_rows jsonb, p_replace boolean) RETURNS integer
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
DECLARE
  written integer;
BEGIN
  INSERT INTO rpt.exception_item (id, source_key, event_ref, exception_date, branch_id, kind, source_kind, abuse_cases, severity,
                                  actor_ref, subject_document_ref, subject_doc_type, amount_pesewas, summary, details, raised_at,
                                  restricted_to, projected_at)
  SELECT rpt.exception_item_id(r ->> 'sourceKey'), r ->> 'sourceKey', (r ->> 'eventRef')::uuid, (r ->> 'exceptionDate')::date,
         (r ->> 'branchId')::uuid, r ->> 'kind', r ->> 'sourceKind',
         ARRAY(SELECT jsonb_array_elements_text(r -> 'abuseCases')::integer), r ->> 'severity', (r ->> 'actorId')::uuid,
         (r ->> 'subjectId')::uuid, r ->> 'subjectDocType', (r ->> 'amountPesewas')::bigint, r ->> 'summary', r -> 'details',
         (r ->> 'raisedAt')::timestamptz, r ->> 'restrictedTo', platform.app_now()
    FROM jsonb_array_elements(p_rows) r
  ON CONFLICT (source_key) DO UPDATE
     SET event_ref = EXCLUDED.event_ref, branch_id = EXCLUDED.branch_id, kind = EXCLUDED.kind, source_kind = EXCLUDED.source_kind,
         abuse_cases = EXCLUDED.abuse_cases, severity = EXCLUDED.severity, actor_ref = EXCLUDED.actor_ref,
         subject_document_ref = EXCLUDED.subject_document_ref, subject_doc_type = EXCLUDED.subject_doc_type,
         amount_pesewas = EXCLUDED.amount_pesewas, summary = EXCLUDED.summary, details = EXCLUDED.details,
         restricted_to = EXCLUDED.restricted_to, projected_at = EXCLUDED.projected_at
   WHERE p_replace;
  GET DIAGNOSTICS written = ROW_COUNT;
  RETURN written;
END
$$;

CREATE FUNCTION rpt.put_approval_fact(p_event uuid, p_at timestamptz, p_date date, p_branch uuid, p_kind text, p_decision text,
                                      p_maker uuid, p_checker uuid, p_amount bigint) RETURNS void
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
  INSERT INTO rpt.approval_fact (event_ref, decided_date, decided_at, branch_id, approval_kind, decision, maker_ref, checker_ref, amount_pesewas)
  VALUES (p_event, p_date, p_at, p_branch, p_kind, p_decision, p_maker, p_checker, p_amount)
  ON CONFLICT (event_ref) DO NOTHING
$$;

-- A checkout started is inserted with its address; its end only moves a STARTED row to its outcome.
CREATE FUNCTION rpt.put_checkout_fact(p_checkout uuid, p_hash text, p_at timestamptz, p_date date, p_outcome text) RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
BEGIN
  IF p_outcome = 'STARTED' THEN
    INSERT INTO rpt.checkout_fact (checkout_ref, address_hash, started_date, started_at, outcome)
    VALUES (p_checkout, p_hash, p_date, p_at, 'STARTED')
    ON CONFLICT (checkout_ref) DO NOTHING;
  ELSE
    UPDATE rpt.checkout_fact SET outcome = p_outcome, ended_at = p_at WHERE checkout_ref = p_checkout AND outcome = 'STARTED';
  END IF;
END
$$;

CREATE FUNCTION rpt.put_payout_change(p_event uuid, p_party_kind text, p_party uuid, p_change uuid, p_at timestamptz,
                                      p_requested_by uuid, p_approved_by uuid) RETURNS void
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
  INSERT INTO rpt.payout_change_fact (event_ref, party_kind, party_ref, change_ref, changed_at, requested_by, approved_by)
  VALUES (p_event, p_party_kind, p_party, p_change, p_at, p_requested_by, p_approved_by)
  ON CONFLICT (event_ref) DO NOTHING
$$;

-- A rebuild empties every projection of the exception report (its reviews are kept: they key on the fixed ids).
CREATE FUNCTION rpt.clear_exception_projections() RETURNS void
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
  DELETE FROM rpt.exception_item;
  DELETE FROM rpt.approval_fact;
  DELETE FROM rpt.checkout_fact;
  DELETE FROM rpt.payout_change_fact;
$$;

REVOKE ALL ON FUNCTION rpt.put_exception_items(jsonb, boolean), rpt.put_approval_fact(uuid, timestamptz, date, uuid, text, text, uuid, uuid, bigint),
  rpt.put_checkout_fact(uuid, text, timestamptz, date, text), rpt.put_payout_change(uuid, text, uuid, uuid, timestamptz, uuid, uuid),
  rpt.clear_exception_projections() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rpt.exception_item_id(text) TO hk_app, hk_worker, hk_report;
GRANT EXECUTE ON FUNCTION rpt.put_exception_items(jsonb, boolean), rpt.put_approval_fact(uuid, timestamptz, date, uuid, text, text, uuid, uuid, bigint),
  rpt.put_checkout_fact(uuid, text, timestamptz, date, text), rpt.put_payout_change(uuid, text, uuid, uuid, timestamptz, uuid, uuid),
  rpt.clear_exception_projections() TO hk_app, hk_worker;

REVOKE ALL ON ALL TABLES IN SCHEMA rpt FROM PUBLIC;
GRANT SELECT ON rpt.exception_item, rpt.approval_fact, rpt.checkout_fact, rpt.payout_change_fact TO hk_app, hk_worker, hk_report;
GRANT SELECT, INSERT ON rpt.exception_review TO hk_app, hk_worker;
GRANT SELECT ON rpt.exception_review TO hk_report;
GRANT SELECT, INSERT, UPDATE, DELETE ON rpt.projection_checkpoint TO hk_app, hk_worker;
GRANT SELECT ON rpt.projection_checkpoint TO hk_report;

-- migrate:down
DROP FUNCTION rpt.clear_exception_projections();
DROP FUNCTION rpt.put_payout_change(uuid, text, uuid, uuid, timestamptz, uuid, uuid);
DROP FUNCTION rpt.put_checkout_fact(uuid, text, timestamptz, date, text);
DROP FUNCTION rpt.put_approval_fact(uuid, timestamptz, date, uuid, text, text, uuid, uuid, bigint);
DROP FUNCTION rpt.put_exception_items(jsonb, boolean);
DROP TABLE rpt.payout_change_fact;
DROP TABLE rpt.checkout_fact;
DROP TABLE rpt.approval_fact;
DROP TABLE rpt.projection_checkpoint;
DROP TABLE rpt.exception_review;
DROP TABLE rpt.exception_item;
DROP FUNCTION rpt.exception_item_id(text);
DROP SCHEMA rpt;
