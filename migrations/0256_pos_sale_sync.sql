-- 0256_pos_sale_sync
-- B09b continued 2b (FR-POS-011 to FR-POS-014, ADR-0027, OFFLINE_SYNC 4, 7 and 9, A-278): every offline sale a till
-- syncs, logged once per submission, including duplicates and the ones refused for integrity.
--   pos.sale_sync   LEDGER (insert only): the device, the shift, the client's sale id (the order's id), its device
--                   counter, the provisional reference as printed, the till's time, the hash it sent (32 bytes), the
--                   outcome and, for a sale recorded, its order and receipt numbers, the gross the server recorded and
--                   the exceptions it raised (a JSON array of {kind, summary}, exception_count its length); for a sale
--                   refused, the rule that refused it. Its flags: posted late (PERIOD_LOCKED, SHIFT_CLOSED,
--                   AFTER_FORCE_CLOSE) with the posting date, a till clock outside the tolerance (AHEAD_OF_SERVER,
--                   BEFORE_SHIFT_OPENED) and a sale older than sync.max_sale_age_hours. "Posted late" lives here, not on
--                   ord.sales_order (A-278 (b), the parent session for lane A).
--   uq_sale_sync_applied      a sale is applied exactly once (APPLIED or APPLIED_WITH_EXCEPTION) by its client id.
--   uq_sale_sync_counter      a device counter of a shift belongs to one applied sale.
--   pos.sale_sync_guard (HK010): the shift is of the device's till (ck_sale_sync_device_shift); an applied row names
--                   its own sale as its order (ck_sale_sync_order); a DUPLICATE answers an applied row of the same sale
--                   with the same hash (ck_sale_sync_duplicate).
-- Every time is written by the application from its clock (ADR-0067); nothing here reads now().
-- Additions to docs/data-model/pos.md: the table above, as built.
-- Data category: INTERNAL (DC-04: till ids, counters and totals; no customer detail, the phone stays on the order).
-- Rollback: tested (`pnpm db:rollback`) before the first sync; once a sale has synced the log is evidence and only a
-- forward fix is safe.

-- migrate:up
CREATE TABLE pos.sale_sync (
  id                   uuid PRIMARY KEY,
  device_id            uuid NOT NULL CONSTRAINT fk_sale_sync_device REFERENCES pos.device_enrolment (id) ON DELETE RESTRICT,
  shift_id             uuid NOT NULL CONSTRAINT fk_sale_sync_shift REFERENCES pos.shift (id) ON DELETE RESTRICT,
  branch_id            uuid NOT NULL CONSTRAINT fk_sale_sync_branch REFERENCES mdm.branch (id) ON DELETE RESTRICT,
  client_sale_id       uuid NOT NULL,
  device_counter       integer NOT NULL CONSTRAINT ck_sale_sync_counter CHECK (device_counter > 0),
  provisional_ref      text NOT NULL CONSTRAINT ck_sale_sync_provisional_ref CHECK (length(provisional_ref) BETWEEN 1 AND 40),
  client_occurred_at   timestamptz NOT NULL,
  payload_hash         bytea NOT NULL CONSTRAINT ck_sale_sync_hash CHECK (octet_length(payload_hash) = 32),
  outcome              text NOT NULL CONSTRAINT ck_sale_sync_outcome CHECK (outcome IN ('APPLIED', 'APPLIED_WITH_EXCEPTION', 'DUPLICATE', 'REJECTED_INTEGRITY')),
  order_document_id    uuid NULL CONSTRAINT fk_sale_sync_order REFERENCES platform.business_document (id) ON DELETE RESTRICT,
  order_no             text NULL,
  receipt_no           text NULL,
  gross_pesewas        platform.pesewas NULL,
  exceptions           jsonb NOT NULL CONSTRAINT ck_sale_sync_exceptions CHECK (jsonb_typeof(exceptions) = 'array'),
  exception_count      integer NOT NULL,
  rejection_rule       text NULL CONSTRAINT ck_sale_sync_rejection CHECK (length(rejection_rule) BETWEEN 1 AND 80),
  posted_late_reason   text NULL CONSTRAINT ck_sale_sync_late CHECK (posted_late_reason IN ('PERIOD_LOCKED', 'SHIFT_CLOSED', 'AFTER_FORCE_CLOSE')),
  posting_date         date NULL,
  clock_verdict        text NULL CONSTRAINT ck_sale_sync_clock CHECK (clock_verdict IN ('AHEAD_OF_SERVER', 'BEFORE_SHIFT_OPENED')),
  too_old              boolean NOT NULL,
  received_at          timestamptz NOT NULL,
  recorded_at          timestamptz NOT NULL,
  actor_id             uuid NOT NULL CONSTRAINT fk_sale_sync_actor REFERENCES iam.principal (id) ON DELETE RESTRICT,
  CONSTRAINT ck_sale_sync_exception_count CHECK (exception_count = jsonb_array_length(exceptions)),
  CONSTRAINT ck_sale_sync_fields CHECK (
    (outcome = 'REJECTED_INTEGRITY' AND rejection_rule IS NOT NULL AND order_document_id IS NULL AND order_no IS NULL AND receipt_no IS NULL
       AND gross_pesewas IS NULL AND posted_late_reason IS NULL AND posting_date IS NULL)
    OR (outcome <> 'REJECTED_INTEGRITY' AND rejection_rule IS NULL AND order_document_id IS NOT NULL AND order_no IS NOT NULL AND receipt_no IS NOT NULL
       AND gross_pesewas IS NOT NULL AND posting_date IS NOT NULL)),
  CONSTRAINT ck_sale_sync_applied CHECK (outcome NOT IN ('APPLIED', 'APPLIED_WITH_EXCEPTION') OR (outcome = 'APPLIED') = (exception_count = 0))
);
COMMENT ON TABLE pos.sale_sync IS 'class=LEDGER';
CREATE UNIQUE INDEX uq_sale_sync_applied ON pos.sale_sync (client_sale_id) WHERE outcome IN ('APPLIED', 'APPLIED_WITH_EXCEPTION');
CREATE UNIQUE INDEX uq_sale_sync_counter ON pos.sale_sync (shift_id, device_counter) WHERE outcome IN ('APPLIED', 'APPLIED_WITH_EXCEPTION');
CREATE INDEX ix_sale_sync_shift ON pos.sale_sync (shift_id, device_counter);
CREATE INDEX ix_sale_sync_client ON pos.sale_sync (client_sale_id);
CREATE TRIGGER trg_sale_sync_immutable BEFORE UPDATE OR DELETE ON pos.sale_sync
  FOR EACH ROW EXECUTE FUNCTION platform.reject_change();
CREATE TRIGGER trg_sale_sync_no_truncate BEFORE TRUNCATE ON pos.sale_sync
  FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_change();

CREATE FUNCTION pos.sale_sync_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pos.shift s JOIN pos.device_enrolment d ON d.register_id = s.register_id
                  WHERE s.id = NEW.shift_id AND d.id = NEW.device_id AND s.branch_id = NEW.branch_id) THEN
    RAISE EXCEPTION 'pos.sale_sync %: shift % is not of the till device % is enrolled on', NEW.id, NEW.shift_id, NEW.device_id
      USING ERRCODE = 'HK010', CONSTRAINT = 'ck_sale_sync_device_shift';
  END IF;
  IF NEW.outcome IN ('APPLIED', 'APPLIED_WITH_EXCEPTION') AND NEW.order_document_id IS DISTINCT FROM NEW.client_sale_id THEN
    RAISE EXCEPTION 'pos.sale_sync %: an applied sale is its own order', NEW.id USING ERRCODE = 'HK010', CONSTRAINT = 'ck_sale_sync_order';
  END IF;
  IF NEW.outcome = 'DUPLICATE' AND NOT EXISTS (
       SELECT 1 FROM pos.sale_sync a
        WHERE a.client_sale_id = NEW.client_sale_id AND a.outcome IN ('APPLIED', 'APPLIED_WITH_EXCEPTION')
          AND a.payload_hash = NEW.payload_hash AND a.order_document_id = NEW.order_document_id) THEN
    RAISE EXCEPTION 'pos.sale_sync %: a duplicate answers the applied sale with the same content', NEW.id
      USING ERRCODE = 'HK010', CONSTRAINT = 'ck_sale_sync_duplicate';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION pos.sale_sync_guard() FROM PUBLIC;
CREATE TRIGGER trg_sale_sync_guard BEFORE INSERT ON pos.sale_sync
  FOR EACH ROW EXECUTE FUNCTION pos.sale_sync_guard();

REVOKE ALL ON pos.sale_sync FROM PUBLIC;
GRANT SELECT, INSERT ON pos.sale_sync TO hk_app, hk_worker;

-- migrate:down
DROP TABLE pos.sale_sync;
DROP FUNCTION pos.sale_sync_guard();
