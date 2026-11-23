-- 0314_del_driver_cash_reconciliation
-- B11 continued 2 (docs/data-model/del.md; FR-DEL-010, CR-057, ADR-0077, ADR-0092, abuse cases 6, 43 and 47): a
-- driver's cash on delivery handed in at a till shift, counted by the receiving cashier, never the driver:
--   del.driver_cash_reconciliation  DOCUMENT (0312), written POSTED and frozen at once (the cash is in the drawer):
--     ck_driver_cash_receiver         the person receiving is never the driver
--     ck_driver_cash_variance         the variance and its direction are exactly the difference between what was
--                                     expected and what was counted
--     ck_driver_cash_till_payment     the till payment exactly when cash was counted
--     ck_driver_cash_expected         (deferred, HK010) what was expected is exactly the sum of its collections
--   del.driver_cash_handed_in       LEDGER, insert-only: each collection (a proof of delivery with its cash) handed in
--     uq_driver_cash_handed_in_proof  exactly once, ever
--     ck_driver_cash_handed_in        (HK010) the collection is the driver's own, at the reconciliation's branch, for
--                                     exactly the cash its proof collected
-- No UNIQUE (driver_id, reconciliation_date) as the dictionary first had: a driver may hand in twice in a day (two
-- runs); each collection is still handed in only once (A-345 (c)).
-- Data category: CONFIDENTIAL (DC-09): the farm's money and who handled it.
-- Rollback: tested (`pnpm db:rollback`), safe before the first hand-in; afterwards forward fix only.

-- migrate:up
CREATE TABLE del.driver_cash_reconciliation (
  id                   uuid PRIMARY KEY CONSTRAINT fk_driver_cash_document REFERENCES platform.business_document (id) ON DELETE RESTRICT,
  driver_id            uuid NOT NULL CONSTRAINT fk_driver_cash_driver REFERENCES iam.principal (id) ON DELETE RESTRICT,
  reconciliation_date  date NOT NULL,
  shift_document_id    uuid NOT NULL CONSTRAINT fk_driver_cash_shift REFERENCES platform.business_document (id) ON DELETE RESTRICT,
  till_payment_id      uuid NULL CONSTRAINT fk_driver_cash_till_payment REFERENCES pay.payment (id) ON DELETE RESTRICT
                         CONSTRAINT uq_driver_cash_till_payment UNIQUE,
  expected_pesewas     platform.pesewas NOT NULL,
  declared_pesewas     platform.pesewas NOT NULL,
  variance_pesewas     platform.pesewas NOT NULL,
  variance_direction   text NOT NULL CONSTRAINT ck_driver_cash_direction CHECK (variance_direction IN ('OVER', 'SHORT', 'EXACT')),
  received_by          uuid NOT NULL CONSTRAINT fk_driver_cash_received_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  note                 text NULL CONSTRAINT ck_driver_cash_note CHECK (length(btrim(note)) BETWEEN 1 AND 500),
  currency             char(3) NOT NULL DEFAULT 'GHS' CONSTRAINT ck_driver_cash_currency CHECK (currency = 'GHS'),
  status               text NOT NULL CONSTRAINT ck_driver_cash_status CHECK (status = 'POSTED'),
  branch_id            uuid NOT NULL CONSTRAINT fk_driver_cash_branch REFERENCES mdm.branch (id) ON DELETE RESTRICT,
  version              integer NOT NULL DEFAULT 1,
  created_at           timestamptz NOT NULL DEFAULT now(),
  created_by           uuid NOT NULL CONSTRAINT fk_driver_cash_created_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  updated_by           uuid NOT NULL CONSTRAINT fk_driver_cash_updated_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  posted_at            timestamptz NOT NULL,
  posted_by            uuid NOT NULL CONSTRAINT fk_driver_cash_posted_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  CONSTRAINT ck_driver_cash_receiver CHECK (received_by <> driver_id AND created_by = received_by),
  CONSTRAINT ck_driver_cash_variance CHECK (
    (variance_direction = 'EXACT' AND variance_pesewas = 0 AND declared_pesewas = expected_pesewas)
    OR (variance_direction = 'SHORT' AND variance_pesewas > 0 AND declared_pesewas + variance_pesewas = expected_pesewas)
    OR (variance_direction = 'OVER' AND variance_pesewas > 0 AND expected_pesewas + variance_pesewas = declared_pesewas)),
  CONSTRAINT ck_driver_cash_till_payment CHECK ((till_payment_id IS NULL) = (declared_pesewas = 0)),
  CONSTRAINT ck_driver_cash_expected_positive CHECK (expected_pesewas > 0)
);
COMMENT ON TABLE del.driver_cash_reconciliation IS 'class=DOCUMENT';
CREATE INDEX ix_driver_cash_driver ON del.driver_cash_reconciliation (driver_id, reconciliation_date);
CREATE INDEX ix_driver_cash_branch ON del.driver_cash_reconciliation (branch_id, id);
CREATE TRIGGER trg_driver_cash_version BEFORE UPDATE ON del.driver_cash_reconciliation
  FOR EACH ROW EXECUTE FUNCTION platform.touch_version();
CREATE TRIGGER trg_driver_cash_frozen BEFORE UPDATE ON del.driver_cash_reconciliation
  FOR EACH ROW EXECUTE FUNCTION platform.freeze_posted('POSTED');

CREATE TABLE del.driver_cash_handed_in (
  reconciliation_id  uuid NOT NULL CONSTRAINT fk_driver_cash_handed_in_reconciliation REFERENCES del.driver_cash_reconciliation (id) ON DELETE RESTRICT,
  proof_id           uuid NOT NULL CONSTRAINT fk_driver_cash_handed_in_proof REFERENCES del.proof_of_delivery (id) ON DELETE RESTRICT
                       CONSTRAINT uq_driver_cash_handed_in_proof UNIQUE,
  amount_pesewas     platform.pesewas NOT NULL CONSTRAINT ck_driver_cash_handed_in_amount CHECK (amount_pesewas > 0),
  recorded_at        timestamptz NOT NULL DEFAULT now(),
  actor_id           uuid NOT NULL CONSTRAINT fk_driver_cash_handed_in_actor REFERENCES iam.principal (id) ON DELETE RESTRICT,
  PRIMARY KEY (reconciliation_id, proof_id)
);
COMMENT ON TABLE del.driver_cash_handed_in IS 'class=LEDGER';
CREATE TRIGGER trg_driver_cash_handed_in_immutable BEFORE UPDATE OR DELETE ON del.driver_cash_handed_in
  FOR EACH ROW EXECUTE FUNCTION platform.reject_change();
CREATE TRIGGER trg_driver_cash_handed_in_no_truncate BEFORE TRUNCATE ON del.driver_cash_handed_in
  FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_change();

-- A collection handed in is the driver's own, at the reconciliation's branch, for exactly what its proof collected.
CREATE FUNCTION del.driver_cash_handed_in_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM del.proof_of_delivery p
      JOIN del.delivery d ON d.id = p.delivery_id
      JOIN del.driver_cash_reconciliation r ON r.id = NEW.reconciliation_id
     WHERE p.id = NEW.proof_id AND p.payment_id IS NOT NULL AND p.cod_collected_pesewas = NEW.amount_pesewas
       AND d.driver_id = r.driver_id AND d.branch_id = r.branch_id) THEN
    RAISE EXCEPTION 'del.driver_cash_handed_in %: proof % is not this driver''s collection of %', NEW.reconciliation_id, NEW.proof_id, NEW.amount_pesewas
      USING ERRCODE = 'HK010', CONSTRAINT = 'ck_driver_cash_handed_in';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION del.driver_cash_handed_in_guard() FROM PUBLIC;
CREATE TRIGGER trg_driver_cash_handed_in_guard BEFORE INSERT ON del.driver_cash_handed_in
  FOR EACH ROW EXECUTE FUNCTION del.driver_cash_handed_in_guard();

-- What was expected is exactly the collections handed in, checked at commit so the rows may be written in any order.
CREATE FUNCTION del.driver_cash_check() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  rec_id uuid := (to_jsonb(NEW) ->> (CASE WHEN TG_TABLE_NAME = 'driver_cash_reconciliation' THEN 'id' ELSE 'reconciliation_id' END))::uuid;
  expected bigint;
  counted bigint;
BEGIN
  SELECT r.expected_pesewas INTO expected FROM del.driver_cash_reconciliation r WHERE r.id = rec_id;
  SELECT COALESCE(sum(h.amount_pesewas), 0) INTO counted FROM del.driver_cash_handed_in h WHERE h.reconciliation_id = rec_id;
  IF expected IS DISTINCT FROM counted THEN
    RAISE EXCEPTION 'del.driver_cash_reconciliation %: % expected but its collections hold %', rec_id, expected, counted
      USING ERRCODE = 'HK010', CONSTRAINT = 'ck_driver_cash_expected';
  END IF;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION del.driver_cash_check() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER trg_driver_cash_check AFTER INSERT ON del.driver_cash_reconciliation
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION del.driver_cash_check();
CREATE CONSTRAINT TRIGGER trg_driver_cash_handed_in_check AFTER INSERT ON del.driver_cash_handed_in
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION del.driver_cash_check();

REVOKE ALL ON del.driver_cash_reconciliation, del.driver_cash_handed_in FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON del.driver_cash_reconciliation TO hk_app, hk_worker;
GRANT SELECT, INSERT ON del.driver_cash_handed_in TO hk_app, hk_worker;

-- migrate:down
DROP TABLE del.driver_cash_handed_in;
DROP TABLE del.driver_cash_reconciliation;
DROP FUNCTION del.driver_cash_check();
DROP FUNCTION del.driver_cash_handed_in_guard();
