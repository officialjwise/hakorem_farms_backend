-- 0303_del_deliveries
-- B11 continued (docs/data-model/del.md; FR-DEL-003, FR-DEL-004, FR-DEL-008, FR-DEL-009, ADR-0021, A-337 to A-341): a
-- delivery, made at dispatch from the snapshot ORD gives (DEL does not know orders), its attempts and its proof.
--   del.delivery            DOCUMENT, numbered DLV (0299). The order, the invoice it settles, the recipient, address and
--                           contents as dispatched, the driver and the vehicle, and the cash due on delivery, fixed by the
--                           server at dispatch from the invoice on the weighed quantity:
--     ck_delivery_assigned    a SCHEDULED delivery names no driver; one assigned, on its way or delivered names its driver
--                             and vehicle
--     ck_delivery_cod         the cash collected is never above the cash due, and is recorded exactly when delivered
--     ck_delivery_delivered   a delivered time exactly when DELIVERED; a posted time and actor exactly when finished
--     ck_delivery_transition  (HK004) it moves only along its listed edges; its order, invoice, number, branch and cash
--                             due never change ("the driver cannot change the amount due", FR-DEL-009); a delivered,
--                             returned or cancelled delivery is frozen
--     ck_delivery_proof       (deferred, HK010) DELIVERED has its proof of delivery
--     uq_delivery_order       one live delivery per order
--   del.delivery_attempt    LEDGER, insert-only: each attempt, numbered per delivery (uq_delivery_attempt_no).
--   del.proof_of_delivery   LEDGER, insert-only, its id the driver's device's, so a retried upload collides:
--     ck_proof_evidence       a signature or a photograph (FR-DEL-008: a name alone is refused)
--     ck_proof_variance       (HK010, from the delivery) never more than due; less than due only with a COD_VARIANCE
--                             reason; a reason only when less was collected
--     ck_proof_payment        the collection's payment exactly when cash was collected
-- `hk_app` has no DELETE on any of them; the LEDGER tables refuse UPDATE, DELETE and TRUNCATE for every role.
-- Data category: CONFIDENTIAL (DC-13 and DC-22): a recipient's name, phone and address, a photograph and a position.
-- Rollback: tested (`pnpm db:rollback`), safe before the first dispatch; afterwards forward fix only.

-- migrate:up
CREATE TABLE del.delivery (
  id                        uuid PRIMARY KEY CONSTRAINT fk_delivery_document REFERENCES platform.business_document (id) ON DELETE RESTRICT,
  delivery_no               text NOT NULL CONSTRAINT uq_delivery_no UNIQUE,
  order_document_id         uuid NOT NULL CONSTRAINT fk_delivery_order REFERENCES platform.business_document (id) ON DELETE RESTRICT,
  billing_document_id       uuid NOT NULL CONSTRAINT fk_delivery_billing_document REFERENCES bil.billing_document (id) ON DELETE RESTRICT,
  customer_id               uuid NULL CONSTRAINT fk_delivery_customer REFERENCES mdm.customer (id) ON DELETE RESTRICT,
  slot_id                   uuid NULL CONSTRAINT fk_delivery_slot REFERENCES del.delivery_slot (id) ON DELETE RESTRICT,
  delivery_zone_id          uuid NOT NULL CONSTRAINT fk_delivery_zone REFERENCES mdm.delivery_zone (id) ON DELETE RESTRICT,
  recipient_name            text NOT NULL CONSTRAINT ck_delivery_recipient_name CHECK (length(btrim(recipient_name)) BETWEEN 1 AND 160),
  recipient_phone_e164      text NOT NULL CONSTRAINT ck_delivery_recipient_phone CHECK (recipient_phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  address_snapshot          jsonb NOT NULL,
  contents_summary          jsonb NOT NULL CONSTRAINT ck_delivery_contents CHECK (jsonb_typeof(contents_summary) = 'array' AND jsonb_array_length(contents_summary) > 0),
  driver_id                 uuid NULL CONSTRAINT fk_delivery_driver REFERENCES iam.principal (id) ON DELETE RESTRICT,
  vehicle_location_id       uuid NULL CONSTRAINT fk_delivery_vehicle REFERENCES mdm.location (id) ON DELETE RESTRICT,
  cod_due_pesewas           platform.pesewas NOT NULL DEFAULT 0,
  cod_collected_pesewas     platform.pesewas NULL,
  attempt_count             integer NOT NULL DEFAULT 0 CONSTRAINT ck_delivery_attempt_count CHECK (attempt_count >= 0),
  dispatched_at             timestamptz NOT NULL,
  delivered_at              timestamptz NULL,
  delivery_note_document_id uuid NULL CONSTRAINT fk_delivery_note REFERENCES doc.archived_document (id) ON DELETE RESTRICT,
  currency                  char(3) NOT NULL DEFAULT 'GHS' CONSTRAINT ck_delivery_currency CHECK (currency = 'GHS'),
  status                    text NOT NULL CONSTRAINT ck_delivery_status CHECK (status IN ('SCHEDULED', 'ASSIGNED', 'OUT_FOR_DELIVERY', 'DELIVERED', 'FAILED', 'RETURNED', 'CANCELLED')),
  branch_id                 uuid NOT NULL CONSTRAINT fk_delivery_branch REFERENCES mdm.branch (id) ON DELETE RESTRICT,
  version                   integer NOT NULL DEFAULT 1,
  created_at                timestamptz NOT NULL DEFAULT now(),
  created_by                uuid NOT NULL CONSTRAINT fk_delivery_created_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  updated_at                timestamptz NOT NULL DEFAULT now(),
  updated_by                uuid NOT NULL CONSTRAINT fk_delivery_updated_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  posted_at                 timestamptz NULL,
  posted_by                 uuid NULL CONSTRAINT fk_delivery_posted_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  CONSTRAINT ck_delivery_assigned CHECK ((status <> 'SCHEDULED' OR driver_id IS NULL)
                                         AND (status NOT IN ('ASSIGNED', 'OUT_FOR_DELIVERY', 'DELIVERED') OR (driver_id IS NOT NULL AND vehicle_location_id IS NOT NULL))
                                         AND (driver_id IS NULL) = (vehicle_location_id IS NULL)),
  CONSTRAINT ck_delivery_cod CHECK ((cod_collected_pesewas IS NULL) = (status <> 'DELIVERED') AND (cod_collected_pesewas IS NULL OR cod_collected_pesewas <= cod_due_pesewas)),
  CONSTRAINT ck_delivery_delivered CHECK ((delivered_at IS NULL) = (status <> 'DELIVERED')
                                          AND (posted_at IS NULL) = (posted_by IS NULL)
                                          AND (posted_at IS NULL) = (status NOT IN ('DELIVERED', 'RETURNED', 'CANCELLED')))
);
COMMENT ON TABLE del.delivery IS 'class=DOCUMENT';
CREATE UNIQUE INDEX uq_delivery_order ON del.delivery (order_document_id) WHERE status <> 'CANCELLED';
CREATE INDEX ix_delivery_driver ON del.delivery (driver_id, status) WHERE driver_id IS NOT NULL;
CREATE INDEX ix_delivery_branch ON del.delivery (branch_id, status);
CREATE TRIGGER trg_delivery_version BEFORE UPDATE ON del.delivery
  FOR EACH ROW EXECUTE FUNCTION platform.touch_version();

-- The machine, held by the database: written SCHEDULED or ASSIGNED, moving only along its edges, what it delivers and the
-- cash due never changing, and a finished delivery frozen.
CREATE FUNCTION del.delivery_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  fixed text[] := ARRAY['id', 'delivery_no', 'order_document_id', 'billing_document_id', 'customer_id', 'delivery_zone_id', 'cod_due_pesewas', 'branch_id',
                        'dispatched_at', 'created_at', 'created_by', 'currency'];
  k text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status NOT IN ('SCHEDULED', 'ASSIGNED') THEN
      RAISE EXCEPTION 'del.delivery %: a delivery is written SCHEDULED or ASSIGNED', NEW.id USING ERRCODE = 'HK004', CONSTRAINT = 'ck_delivery_transition';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status IN ('DELIVERED', 'RETURNED', 'CANCELLED') THEN
    RAISE EXCEPTION 'del.delivery % is % and frozen', OLD.id, OLD.status USING ERRCODE = 'HK004', CONSTRAINT = 'ck_delivery_transition';
  END IF;
  FOREACH k IN ARRAY fixed LOOP
    IF to_jsonb(NEW) -> k IS DISTINCT FROM to_jsonb(OLD) -> k THEN
      RAISE EXCEPTION 'del.delivery %: % never changes', OLD.id, k USING ERRCODE = 'HK004', CONSTRAINT = 'ck_delivery_transition';
    END IF;
  END LOOP;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'SCHEDULED' AND NEW.status IN ('ASSIGNED', 'CANCELLED'))
    OR (OLD.status = 'ASSIGNED' AND NEW.status IN ('OUT_FOR_DELIVERY', 'DELIVERED', 'FAILED', 'CANCELLED'))
    OR (OLD.status = 'OUT_FOR_DELIVERY' AND NEW.status IN ('DELIVERED', 'FAILED'))
    OR (OLD.status = 'FAILED' AND NEW.status IN ('ASSIGNED', 'RETURNED'))) THEN
    RAISE EXCEPTION 'del.delivery %: % cannot move to %', OLD.id, OLD.status, NEW.status USING ERRCODE = 'HK004', CONSTRAINT = 'ck_delivery_transition';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION del.delivery_guard() FROM PUBLIC;
CREATE TRIGGER trg_delivery_guard BEFORE INSERT OR UPDATE ON del.delivery
  FOR EACH ROW EXECUTE FUNCTION del.delivery_guard();

CREATE TABLE del.delivery_attempt (
  id                  uuid PRIMARY KEY,
  delivery_id         uuid NOT NULL CONSTRAINT fk_delivery_attempt_delivery REFERENCES del.delivery (id) ON DELETE RESTRICT,
  attempt_no          integer NOT NULL CONSTRAINT ck_delivery_attempt_no CHECK (attempt_no > 0),
  outcome             text NOT NULL CONSTRAINT ck_delivery_attempt_outcome CHECK (outcome IN ('DELIVERED', 'FAILED')),
  failure_reason_code text NULL CONSTRAINT fk_delivery_attempt_reason REFERENCES mdm.reason_code (code) ON DELETE RESTRICT,
  next_action         text NULL CONSTRAINT ck_delivery_attempt_next_action CHECK (next_action IN ('REATTEMPT', 'RETURN_TO_STOCK')),
  latitude            numeric(9,6) NULL CONSTRAINT ck_delivery_attempt_latitude CHECK (latitude BETWEEN -90 AND 90),
  longitude           numeric(9,6) NULL CONSTRAINT ck_delivery_attempt_longitude CHECK (longitude BETWEEN -180 AND 180),
  occurred_at         timestamptz NOT NULL,
  recorded_at         timestamptz NOT NULL DEFAULT now(),
  created_by          uuid NOT NULL CONSTRAINT fk_delivery_attempt_created_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  CONSTRAINT uq_delivery_attempt_no UNIQUE (delivery_id, attempt_no),
  CONSTRAINT ck_delivery_attempt_failure CHECK ((outcome = 'FAILED') = (failure_reason_code IS NOT NULL) AND (outcome = 'FAILED') = (next_action IS NOT NULL))
);
COMMENT ON TABLE del.delivery_attempt IS 'class=LEDGER';
CREATE TRIGGER trg_delivery_attempt_immutable BEFORE UPDATE OR DELETE ON del.delivery_attempt
  FOR EACH ROW EXECUTE FUNCTION platform.reject_change();
CREATE TRIGGER trg_delivery_attempt_no_truncate BEFORE TRUNCATE ON del.delivery_attempt
  FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_change();

CREATE TABLE del.proof_of_delivery (
  id                       uuid PRIMARY KEY,
  delivery_id              uuid NOT NULL CONSTRAINT fk_proof_delivery REFERENCES del.delivery (id) ON DELETE RESTRICT
                             CONSTRAINT uq_proof_delivery UNIQUE,
  recipient_name           text NOT NULL CONSTRAINT ck_proof_recipient_name CHECK (length(btrim(recipient_name)) BETWEEN 1 AND 160),
  signature_file_id        uuid NULL CONSTRAINT fk_proof_signature REFERENCES platform.stored_file (id) ON DELETE RESTRICT,
  photo_file_id            uuid NULL CONSTRAINT fk_proof_photo REFERENCES platform.stored_file (id) ON DELETE RESTRICT,
  latitude                 numeric(9,6) NULL CONSTRAINT ck_proof_latitude CHECK (latitude BETWEEN -90 AND 90),
  longitude                numeric(9,6) NULL CONSTRAINT ck_proof_longitude CHECK (longitude BETWEEN -180 AND 180),
  position_accuracy_m      integer NULL CONSTRAINT ck_proof_accuracy CHECK (position_accuracy_m >= 0),
  cod_collected_pesewas    platform.pesewas NOT NULL DEFAULT 0,
  cod_variance_reason_code text NULL CONSTRAINT fk_proof_variance_reason REFERENCES mdm.reason_code (code) ON DELETE RESTRICT,
  cod_variance_note        text NULL CONSTRAINT ck_proof_variance_note CHECK (length(btrim(cod_variance_note)) BETWEEN 1 AND 500),
  payment_id               uuid NULL CONSTRAINT fk_proof_payment REFERENCES pay.payment (id) ON DELETE RESTRICT CONSTRAINT uq_proof_payment UNIQUE,
  captured_at              timestamptz NOT NULL,
  recorded_at              timestamptz NOT NULL DEFAULT now(),
  created_by               uuid NOT NULL CONSTRAINT fk_proof_created_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  CONSTRAINT ck_proof_evidence CHECK (signature_file_id IS NOT NULL OR photo_file_id IS NOT NULL),
  CONSTRAINT ck_proof_payment CHECK ((payment_id IS NULL) = (cod_collected_pesewas = 0)),
  CONSTRAINT ck_proof_position CHECK ((latitude IS NULL) = (longitude IS NULL))
);
COMMENT ON TABLE del.proof_of_delivery IS 'class=LEDGER';
CREATE TRIGGER trg_proof_of_delivery_immutable BEFORE UPDATE OR DELETE ON del.proof_of_delivery
  FOR EACH ROW EXECUTE FUNCTION platform.reject_change();
CREATE TRIGGER trg_proof_of_delivery_no_truncate BEFORE TRUNCATE ON del.proof_of_delivery
  FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_change();

-- A proof against its delivery's cash due: never more, less only with a COD_VARIANCE reason, a reason only when less.
CREATE FUNCTION del.proof_of_delivery_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  due bigint;
  reason_domain text;
BEGIN
  SELECT d.cod_due_pesewas INTO due FROM del.delivery d WHERE d.id = NEW.delivery_id;
  reason_domain := mdm.reason_code_domain(NEW.cod_variance_reason_code);
  IF NEW.cod_collected_pesewas > due
     OR (NEW.cod_collected_pesewas < due) <> (NEW.cod_variance_reason_code IS NOT NULL)
     OR (NEW.cod_variance_reason_code IS NOT NULL AND reason_domain IS DISTINCT FROM 'COD_VARIANCE')
     OR (NEW.cod_variance_note IS NOT NULL AND NEW.cod_variance_reason_code IS NULL) THEN
    RAISE EXCEPTION 'del.proof_of_delivery %: % collected against % due breaks the cash rule', NEW.id, NEW.cod_collected_pesewas, due
      USING ERRCODE = 'HK010', CONSTRAINT = 'ck_proof_variance';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION del.proof_of_delivery_guard() FROM PUBLIC;
CREATE TRIGGER trg_proof_of_delivery_guard BEFORE INSERT ON del.proof_of_delivery
  FOR EACH ROW EXECUTE FUNCTION del.proof_of_delivery_guard();

-- DELIVERED only with its proof, checked at commit so the proof and the status may be written in either order.
CREATE FUNCTION del.delivery_check() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM del.delivery d WHERE d.id = NEW.id AND d.status = 'DELIVERED')
     AND NOT EXISTS (SELECT 1 FROM del.proof_of_delivery p WHERE p.delivery_id = NEW.id) THEN
    RAISE EXCEPTION 'del.delivery %: delivered without a proof of delivery', NEW.id USING ERRCODE = 'HK010', CONSTRAINT = 'ck_delivery_proof';
  END IF;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION del.delivery_check() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER trg_delivery_check AFTER INSERT OR UPDATE ON del.delivery
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION del.delivery_check();

REVOKE ALL ON del.delivery, del.delivery_attempt, del.proof_of_delivery FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON del.delivery TO hk_app, hk_worker;
GRANT SELECT, INSERT ON del.delivery_attempt, del.proof_of_delivery TO hk_app, hk_worker;

-- migrate:down
DROP TABLE del.proof_of_delivery;
DROP FUNCTION del.proof_of_delivery_guard();
DROP TABLE del.delivery_attempt;
DROP TRIGGER trg_delivery_check ON del.delivery;
DROP FUNCTION del.delivery_check();
DROP TABLE del.delivery;
DROP FUNCTION del.delivery_guard();
