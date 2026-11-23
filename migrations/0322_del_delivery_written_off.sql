-- 0322_del_delivery_written_off
-- B11 continued 4 (FR-DEL-011, the owner's van rule of 2026-11-23, A-360): the third way off the van. A failed
-- delivery's goods are delivered, returned to stock (RETURNED) or written off with a reason (WRITTEN_OFF, new): INV's
-- adjustment at the vehicle posted their loss, so they are no longer on the van.
--   del.delivery            status gains WRITTEN_OFF, a posted status (ck_delivery_status, ck_delivery_delivered); the
--                           guard (ck_delivery_transition, HK004) gains the edge FAILED to WRITTEN_OFF and freezes it.
--                           written_off_reason_code (FK mdm.reason_code), written_off_value_pesewas (the adjustment's
--                           value at cost), written_off_at and write_off_document_id (FK platform.business_document, the
--                           posted STOCK_ADJUSTMENT), all set exactly when WRITTEN_OFF (ck_delivery_written_off). The
--                           driver variance report reads the UNACCOUNTED_ON_VAN ones.
--   ck_route_closed         (deferred, HK010) a run closes when every stop is DELIVERED, RETURNED or WRITTEN_OFF.
-- Data category: CONFIDENTIAL as del.delivery (no new personal data).
-- Rollback: tested (`pnpm db:rollback`), safe before the first write-off; afterwards forward fix only.

-- migrate:up
ALTER TABLE del.delivery
  ADD COLUMN written_off_reason_code text NULL CONSTRAINT fk_delivery_written_off_reason REFERENCES mdm.reason_code (code) ON DELETE RESTRICT,
  ADD COLUMN written_off_value_pesewas platform.pesewas NULL,
  ADD COLUMN written_off_at timestamptz NULL,
  ADD COLUMN write_off_document_id uuid NULL CONSTRAINT fk_delivery_write_off_document REFERENCES platform.business_document (id) ON DELETE RESTRICT;
ALTER TABLE del.delivery DROP CONSTRAINT ck_delivery_status;
ALTER TABLE del.delivery ADD CONSTRAINT ck_delivery_status CHECK (status IN ('SCHEDULED', 'ASSIGNED', 'OUT_FOR_DELIVERY', 'DELIVERED', 'FAILED', 'RETURNED', 'WRITTEN_OFF', 'CANCELLED'));
ALTER TABLE del.delivery DROP CONSTRAINT ck_delivery_delivered;
ALTER TABLE del.delivery ADD CONSTRAINT ck_delivery_delivered CHECK ((delivered_at IS NULL) = (status <> 'DELIVERED')
                                          AND (posted_at IS NULL) = (posted_by IS NULL)
                                          AND (posted_at IS NULL) = (status NOT IN ('DELIVERED', 'RETURNED', 'WRITTEN_OFF', 'CANCELLED')));
ALTER TABLE del.delivery ADD CONSTRAINT ck_delivery_written_off CHECK (
  (status = 'WRITTEN_OFF') = (written_off_reason_code IS NOT NULL)
  AND (status = 'WRITTEN_OFF') = (written_off_value_pesewas IS NOT NULL)
  AND (status = 'WRITTEN_OFF') = (written_off_at IS NOT NULL)
  AND (status = 'WRITTEN_OFF') = (write_off_document_id IS NOT NULL));
CREATE INDEX ix_delivery_written_off ON del.delivery (branch_id, written_off_at, id) WHERE status = 'WRITTEN_OFF';

CREATE OR REPLACE FUNCTION del.delivery_guard() RETURNS trigger
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
  IF OLD.status IN ('DELIVERED', 'RETURNED', 'WRITTEN_OFF', 'CANCELLED') THEN
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
    OR (OLD.status = 'FAILED' AND NEW.status IN ('ASSIGNED', 'RETURNED', 'WRITTEN_OFF'))) THEN
    RAISE EXCEPTION 'del.delivery %: % cannot move to %', OLD.id, OLD.status, NEW.status USING ERRCODE = 'HK004', CONSTRAINT = 'ck_delivery_transition';
  END IF;
  RETURN NEW;
END
$$;
CREATE OR REPLACE FUNCTION del.route_check() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM del.route r WHERE r.id = NEW.id AND r.status = 'COMPLETED')
     AND (EXISTS (SELECT 1 FROM del.route_stop s JOIN del.delivery d ON d.id = s.delivery_id
                   WHERE s.route_id = NEW.id AND d.status NOT IN ('DELIVERED', 'RETURNED', 'WRITTEN_OFF'))
          OR EXISTS (SELECT 1 FROM del.route_stop s JOIN del.proof_of_delivery p ON p.delivery_id = s.delivery_id
                      WHERE s.route_id = NEW.id AND p.payment_id IS NOT NULL
                        AND NOT EXISTS (SELECT 1 FROM del.driver_cash_handed_in h WHERE h.proof_id = p.id))) THEN
    RAISE EXCEPTION 'del.route %: closed with goods on the van or cash still held', NEW.id USING ERRCODE = 'HK010', CONSTRAINT = 'ck_route_closed';
  END IF;
  RETURN NULL;
END
$$;

-- migrate:down
CREATE OR REPLACE FUNCTION del.delivery_guard() RETURNS trigger
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
CREATE OR REPLACE FUNCTION del.route_check() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM del.route r WHERE r.id = NEW.id AND r.status = 'COMPLETED')
     AND (EXISTS (SELECT 1 FROM del.route_stop s JOIN del.delivery d ON d.id = s.delivery_id
                   WHERE s.route_id = NEW.id AND d.status NOT IN ('DELIVERED', 'RETURNED'))
          OR EXISTS (SELECT 1 FROM del.route_stop s JOIN del.proof_of_delivery p ON p.delivery_id = s.delivery_id
                      WHERE s.route_id = NEW.id AND p.payment_id IS NOT NULL
                        AND NOT EXISTS (SELECT 1 FROM del.driver_cash_handed_in h WHERE h.proof_id = p.id))) THEN
    RAISE EXCEPTION 'del.route %: closed with goods on the van or cash still held', NEW.id USING ERRCODE = 'HK010', CONSTRAINT = 'ck_route_closed';
  END IF;
  RETURN NULL;
END
$$;
DROP INDEX del.ix_delivery_written_off;
ALTER TABLE del.delivery DROP CONSTRAINT ck_delivery_written_off;
ALTER TABLE del.delivery DROP CONSTRAINT ck_delivery_delivered;
ALTER TABLE del.delivery ADD CONSTRAINT ck_delivery_delivered CHECK ((delivered_at IS NULL) = (status <> 'DELIVERED')
                                          AND (posted_at IS NULL) = (posted_by IS NULL)
                                          AND (posted_at IS NULL) = (status NOT IN ('DELIVERED', 'RETURNED', 'CANCELLED')));
ALTER TABLE del.delivery DROP CONSTRAINT ck_delivery_status;
ALTER TABLE del.delivery ADD CONSTRAINT ck_delivery_status CHECK (status IN ('SCHEDULED', 'ASSIGNED', 'OUT_FOR_DELIVERY', 'DELIVERED', 'FAILED', 'RETURNED', 'CANCELLED'));
ALTER TABLE del.delivery DROP COLUMN write_off_document_id, DROP COLUMN written_off_at, DROP COLUMN written_off_value_pesewas, DROP COLUMN written_off_reason_code;
