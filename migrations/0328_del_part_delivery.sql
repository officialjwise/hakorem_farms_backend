-- 0328_del_part_delivery
-- B11 continued 6 (CR-055, FR-DEL-008, FR-DEL-009, ADR-0093, A-364 (b)): a part delivery. The proof says what the
-- customer kept of each line; the rest came back with a DELIVERY_FAILURE reason, and the cash the driver may collect is
-- the cash due less the credit for what came back. The delivery's cash due is never changed (ADR-0092).
--   del.proof_of_delivery   returned_reason_code (FK mdm.reason_code, a DELIVERY_FAILURE reason) and
--                           returned_credit_pesewas (the credit for what came back, as BIL priced it at the door; 0 when
--                           everything was kept) and returned_note (where the reason asks for one): a reason exactly
--                           when something came back (ck_proof_returned).
--                           ck_proof_variance (HK010) now holds against the cash due at the door, greatest(due - credit,
--                           0): never more, less only with a COD_VARIANCE reason, a reason only when less.
--   del.proof_line          (LEDGER) what the customer kept of each line a part delivery names: the line, what was
--                           dispatched and what was kept, never more (ck_proof_line_qty); one row a line
--                           (uq_proof_line); a proof with a returned reason names a line kept short and a proof naming a
--                           line kept short has its reason, at commit (ck_proof_line_returned, HK010).
-- Data category: CONFIDENTIAL as del.proof_of_delivery (no new personal data).
-- Rollback: tested (`pnpm db:rollback`), safe before the first part delivery; afterwards forward fix only.

-- migrate:up
ALTER TABLE del.proof_of_delivery
  ADD COLUMN returned_reason_code text NULL CONSTRAINT fk_proof_returned_reason REFERENCES mdm.reason_code (code) ON DELETE RESTRICT,
  ADD COLUMN returned_credit_pesewas platform.pesewas NOT NULL DEFAULT 0,
  ADD COLUMN returned_note text NULL CONSTRAINT ck_proof_returned_note CHECK (length(btrim(returned_note)) BETWEEN 1 AND 500),
  ADD CONSTRAINT ck_proof_returned CHECK ((returned_reason_code IS NOT NULL OR returned_credit_pesewas = 0) AND (returned_note IS NULL OR returned_reason_code IS NOT NULL));

CREATE TABLE del.proof_line (
  proof_id        uuid NOT NULL CONSTRAINT fk_proof_line_proof REFERENCES del.proof_of_delivery (id) ON DELETE RESTRICT,
  order_line_id   uuid NOT NULL,
  dispatched_qty  platform.qty NOT NULL CONSTRAINT ck_proof_line_dispatched CHECK (dispatched_qty > 0),
  delivered_qty   platform.qty NOT NULL,
  recorded_at     timestamptz NOT NULL DEFAULT now(),
  actor_id        uuid NOT NULL CONSTRAINT fk_proof_line_actor REFERENCES iam.principal (id) ON DELETE RESTRICT,
  CONSTRAINT uq_proof_line PRIMARY KEY (proof_id, order_line_id),
  CONSTRAINT ck_proof_line_qty CHECK (delivered_qty >= 0 AND delivered_qty <= dispatched_qty)
);
COMMENT ON TABLE del.proof_line IS 'class=LEDGER';
CREATE TRIGGER trg_proof_line_immutable BEFORE UPDATE OR DELETE ON del.proof_line
  FOR EACH ROW EXECUTE FUNCTION platform.reject_change();
CREATE TRIGGER trg_proof_line_no_truncate BEFORE TRUNCATE ON del.proof_line
  FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_change();
REVOKE ALL ON del.proof_line FROM PUBLIC;
GRANT SELECT, INSERT ON del.proof_line TO hk_app, hk_worker;

-- A proof against the cash due at its door: the delivery's cash due less what came back, never below zero.
CREATE OR REPLACE FUNCTION del.proof_of_delivery_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  due bigint;
  reason_domain text;
BEGIN
  SELECT greatest(d.cod_due_pesewas - NEW.returned_credit_pesewas, 0) INTO due FROM del.delivery d WHERE d.id = NEW.delivery_id;
  reason_domain := mdm.reason_code_domain(NEW.cod_variance_reason_code);
  IF NEW.cod_collected_pesewas > due
     OR (NEW.cod_collected_pesewas < due) <> (NEW.cod_variance_reason_code IS NOT NULL)
     OR (NEW.cod_variance_reason_code IS NOT NULL AND reason_domain IS DISTINCT FROM 'COD_VARIANCE')
     OR (NEW.cod_variance_note IS NOT NULL AND NEW.cod_variance_reason_code IS NULL)
     OR (NEW.returned_reason_code IS NOT NULL AND mdm.reason_code_domain(NEW.returned_reason_code) IS DISTINCT FROM 'DELIVERY_FAILURE') THEN
    RAISE EXCEPTION 'del.proof_of_delivery %: % collected against % due at the door breaks the cash rule', NEW.id, NEW.cod_collected_pesewas, due
      USING ERRCODE = 'HK010', CONSTRAINT = 'ck_proof_variance';
  END IF;
  RETURN NEW;
END
$$;

-- At commit: a returned reason names a line kept short, and a line kept short has its proof's reason.
CREATE FUNCTION del.proof_returned_check() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  proof uuid := (to_jsonb(NEW) ->> CASE TG_TABLE_NAME WHEN 'proof_line' THEN 'proof_id' ELSE 'id' END)::uuid;
BEGIN
  IF (SELECT p.returned_reason_code IS NOT NULL FROM del.proof_of_delivery p WHERE p.id = proof)
     <> EXISTS (SELECT 1 FROM del.proof_line l WHERE l.proof_id = proof AND l.delivered_qty < l.dispatched_qty) THEN
    RAISE EXCEPTION 'del.proof_of_delivery %: a returned reason exactly when a line was kept short', proof
      USING ERRCODE = 'HK010', CONSTRAINT = 'ck_proof_line_returned';
  END IF;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION del.proof_returned_check() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER trg_proof_returned_check AFTER INSERT ON del.proof_of_delivery
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION del.proof_returned_check();
CREATE CONSTRAINT TRIGGER trg_proof_line_returned_check AFTER INSERT ON del.proof_line
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION del.proof_returned_check();

-- migrate:down
DROP TRIGGER trg_proof_line_returned_check ON del.proof_line;
DROP TRIGGER trg_proof_returned_check ON del.proof_of_delivery;
DROP FUNCTION del.proof_returned_check();
CREATE OR REPLACE FUNCTION del.proof_of_delivery_guard() RETURNS trigger
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
DROP TABLE del.proof_line;
ALTER TABLE del.proof_of_delivery DROP CONSTRAINT ck_proof_returned, DROP COLUMN returned_note, DROP COLUMN returned_credit_pesewas, DROP COLUMN returned_reason_code;
