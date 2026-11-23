-- 0318_del_routes
-- B11 continued 3 (docs/data-model/del.md; FR-DEL-005, FR-DEL-007, ADR-0092, A-337 and the owner's 2026-11-23 close
-- rule, A-345 (g), A-347): a driver's run for a day and its stops, and the hand-in recorded against the run.
--   del.route            DOCUMENT: one driver, one vehicle, one branch, one day (uq_route_driver_date), written PLANNED,
--                        moving PLANNED -> IN_PROGRESS -> COMPLETED (posted), its driver, vehicle, date and branch never
--                        changing, frozen once COMPLETED (ck_route_transition, HK004):
--     ck_route_started     a start time and actor exactly when it has started
--     ck_route_posted      a posted time and actor exactly when COMPLETED
--     ck_route_closed      (deferred, HK010) COMPLETED only when every stop's goods have left the van (DELIVERED or
--                          RETURNED) and no collection made on the run is still held by the driver
--   del.route_stop       DOCUMENT row of its route: the deliveries in the order of visit. A stop is written and renumbered
--                        only while its route is PLANNED, never moved to another route or delivery (ck_route_stop, HK010);
--                        its delivery is ASSIGNED, to the route's driver, on its vehicle, at its branch; one route per
--                        delivery (uq_route_stop_delivery). The stop numbers are unique per route at commit, so a reorder
--                        may swap them.
--   del.delivery         a delivery on a route that has not started is not taken on its way, delivered or failed, and
--                        keeps its driver and vehicle while on a live route (ck_delivery_route, HK004); on_the_way_at is
--                        added (FR-DEL-007: the time is recorded).
--   del.driver_cash_handed_in   route_id added: the run the collection was made on, set by the database from the stop
--                        (NULL for a delivery on no route), so a run's hand-ins are recorded against it (A-345 (g)).
-- `hk_app` has no DELETE on any of them.
-- Data category: INTERNAL (a driver's day and the order of the stops).
-- Rollback: tested (`pnpm db:rollback`), safe before the first route; afterwards forward fix only.

-- migrate:up
CREATE TABLE del.route (
  id                  uuid PRIMARY KEY,
  driver_id           uuid NOT NULL CONSTRAINT fk_route_driver REFERENCES iam.principal (id) ON DELETE RESTRICT,
  route_date          date NOT NULL,
  vehicle_location_id uuid NOT NULL CONSTRAINT fk_route_vehicle REFERENCES mdm.location (id) ON DELETE RESTRICT,
  status              text NOT NULL CONSTRAINT ck_route_status CHECK (status IN ('PLANNED', 'IN_PROGRESS', 'COMPLETED')),
  started_at          timestamptz NULL,
  started_by          uuid NULL CONSTRAINT fk_route_started_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  branch_id           uuid NOT NULL CONSTRAINT fk_route_branch REFERENCES mdm.branch (id) ON DELETE RESTRICT,
  version             integer NOT NULL DEFAULT 1,
  created_at          timestamptz NOT NULL,
  created_by          uuid NOT NULL CONSTRAINT fk_route_created_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  updated_at          timestamptz NOT NULL,
  updated_by          uuid NOT NULL CONSTRAINT fk_route_updated_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  posted_at           timestamptz NULL,
  posted_by           uuid NULL CONSTRAINT fk_route_posted_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  CONSTRAINT uq_route_driver_date UNIQUE (driver_id, route_date),
  CONSTRAINT ck_route_started CHECK ((started_at IS NULL) = (started_by IS NULL) AND (started_at IS NULL) = (status = 'PLANNED')),
  CONSTRAINT ck_route_posted CHECK ((posted_at IS NULL) = (posted_by IS NULL) AND (posted_at IS NULL) = (status <> 'COMPLETED'))
);
COMMENT ON TABLE del.route IS 'class=DOCUMENT';
CREATE INDEX ix_route_branch_date ON del.route (branch_id, route_date, id);
CREATE TRIGGER trg_route_version BEFORE UPDATE ON del.route
  FOR EACH ROW EXECUTE FUNCTION platform.touch_version();

CREATE FUNCTION del.route_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  fixed text[] := ARRAY['id', 'driver_id', 'route_date', 'vehicle_location_id', 'branch_id', 'created_at', 'created_by'];
  k text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'PLANNED' THEN
      RAISE EXCEPTION 'del.route %: a route is written PLANNED', NEW.id USING ERRCODE = 'HK004', CONSTRAINT = 'ck_route_transition';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status = 'COMPLETED' THEN
    RAISE EXCEPTION 'del.route % is COMPLETED and frozen', OLD.id USING ERRCODE = 'HK004', CONSTRAINT = 'ck_route_transition';
  END IF;
  FOREACH k IN ARRAY fixed LOOP
    IF to_jsonb(NEW) -> k IS DISTINCT FROM to_jsonb(OLD) -> k THEN
      RAISE EXCEPTION 'del.route %: % never changes', OLD.id, k USING ERRCODE = 'HK004', CONSTRAINT = 'ck_route_transition';
    END IF;
  END LOOP;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'PLANNED' AND NEW.status = 'IN_PROGRESS')
    OR (OLD.status = 'IN_PROGRESS' AND NEW.status = 'COMPLETED')) THEN
    RAISE EXCEPTION 'del.route %: % cannot move to %', OLD.id, OLD.status, NEW.status USING ERRCODE = 'HK004', CONSTRAINT = 'ck_route_transition';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION del.route_guard() FROM PUBLIC;
CREATE TRIGGER trg_route_guard BEFORE INSERT OR UPDATE ON del.route
  FOR EACH ROW EXECUTE FUNCTION del.route_guard();

CREATE TABLE del.route_stop (
  route_id    uuid NOT NULL CONSTRAINT fk_route_stop_route REFERENCES del.route (id) ON DELETE RESTRICT,
  stop_no     integer NOT NULL CONSTRAINT ck_route_stop_no CHECK (stop_no > 0),
  delivery_id uuid NOT NULL CONSTRAINT fk_route_stop_delivery REFERENCES del.delivery (id) ON DELETE RESTRICT,
  created_at  timestamptz NOT NULL,
  created_by  uuid NOT NULL CONSTRAINT fk_route_stop_created_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  updated_at  timestamptz NOT NULL,
  updated_by  uuid NOT NULL CONSTRAINT fk_route_stop_updated_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  CONSTRAINT pk_route_stop PRIMARY KEY (route_id, stop_no) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT uq_route_stop_delivery UNIQUE (delivery_id)
);
COMMENT ON TABLE del.route_stop IS 'class=DOCUMENT';

-- A stop is the route driver's loaded delivery, written and renumbered only while the route is planned.
CREATE FUNCTION del.route_stop_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  r del.route%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.route_id IS DISTINCT FROM OLD.route_id OR NEW.delivery_id IS DISTINCT FROM OLD.delivery_id) THEN
    RAISE EXCEPTION 'del.route_stop %: a stop never moves to another route or delivery', OLD.delivery_id USING ERRCODE = 'HK010', CONSTRAINT = 'ck_route_stop';
  END IF;
  SELECT * INTO r FROM del.route WHERE id = NEW.route_id;
  IF r.status IS DISTINCT FROM 'PLANNED' THEN
    RAISE EXCEPTION 'del.route_stop %: route % is %, its stops are fixed', NEW.delivery_id, NEW.route_id, r.status USING ERRCODE = 'HK010', CONSTRAINT = 'ck_route_stop';
  END IF;
  IF TG_OP = 'INSERT' AND NOT EXISTS (
    SELECT 1 FROM del.delivery d
     WHERE d.id = NEW.delivery_id AND d.status = 'ASSIGNED' AND d.driver_id = r.driver_id AND d.vehicle_location_id = r.vehicle_location_id
       AND d.branch_id = r.branch_id) THEN
    RAISE EXCEPTION 'del.route_stop %: not a delivery waiting on route %''s van for its driver', NEW.delivery_id, NEW.route_id USING ERRCODE = 'HK010', CONSTRAINT = 'ck_route_stop';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION del.route_stop_guard() FROM PUBLIC;
CREATE TRIGGER trg_route_stop_guard BEFORE INSERT OR UPDATE ON del.route_stop
  FOR EACH ROW EXECUTE FUNCTION del.route_stop_guard();

-- COMPLETED only with nothing left on the van and nothing still held, checked at commit.
CREATE FUNCTION del.route_check() RETURNS trigger
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
REVOKE ALL ON FUNCTION del.route_check() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER trg_route_check AFTER INSERT OR UPDATE ON del.route
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION del.route_check();

-- A delivery on a route: nothing happens on the doorstep before the run has started, and its driver and van stay put.
ALTER TABLE del.delivery ADD COLUMN on_the_way_at timestamptz NULL;

CREATE FUNCTION del.delivery_route_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  route_status text;
BEGIN
  SELECT r.status INTO route_status FROM del.route_stop s JOIN del.route r ON r.id = s.route_id WHERE s.delivery_id = NEW.id;
  IF route_status IS NULL THEN
    RETURN NEW;
  END IF;
  IF route_status = 'PLANNED' AND NEW.status IS DISTINCT FROM OLD.status AND NEW.status IN ('OUT_FOR_DELIVERY', 'DELIVERED', 'FAILED') THEN
    RAISE EXCEPTION 'del.delivery %: its route has not started', OLD.id USING ERRCODE = 'HK004', CONSTRAINT = 'ck_delivery_route';
  END IF;
  IF route_status <> 'COMPLETED' AND (NEW.driver_id IS DISTINCT FROM OLD.driver_id OR NEW.vehicle_location_id IS DISTINCT FROM OLD.vehicle_location_id) THEN
    RAISE EXCEPTION 'del.delivery %: on a live route, its driver and vehicle stay', OLD.id USING ERRCODE = 'HK004', CONSTRAINT = 'ck_delivery_route';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION del.delivery_route_guard() FROM PUBLIC;
CREATE TRIGGER trg_delivery_route_guard BEFORE UPDATE ON del.delivery
  FOR EACH ROW EXECUTE FUNCTION del.delivery_route_guard();

-- The run a collection was made on, from its stop: the database's, never the caller's.
ALTER TABLE del.driver_cash_handed_in ADD COLUMN route_id uuid NULL CONSTRAINT fk_driver_cash_handed_in_route REFERENCES del.route (id) ON DELETE RESTRICT;
CREATE INDEX ix_driver_cash_handed_in_route ON del.driver_cash_handed_in (route_id) WHERE route_id IS NOT NULL;

CREATE FUNCTION del.driver_cash_handed_in_route() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  NEW.route_id := (SELECT s.route_id FROM del.proof_of_delivery p JOIN del.route_stop s ON s.delivery_id = p.delivery_id WHERE p.id = NEW.proof_id);
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION del.driver_cash_handed_in_route() FROM PUBLIC;
CREATE TRIGGER trg_driver_cash_handed_in_route BEFORE INSERT ON del.driver_cash_handed_in
  FOR EACH ROW EXECUTE FUNCTION del.driver_cash_handed_in_route();

REVOKE ALL ON del.route, del.route_stop FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON del.route, del.route_stop TO hk_app, hk_worker;

-- migrate:down
DROP TRIGGER trg_driver_cash_handed_in_route ON del.driver_cash_handed_in;
DROP FUNCTION del.driver_cash_handed_in_route();
DROP INDEX del.ix_driver_cash_handed_in_route;
ALTER TABLE del.driver_cash_handed_in DROP COLUMN route_id;
DROP TRIGGER trg_delivery_route_guard ON del.delivery;
DROP FUNCTION del.delivery_route_guard();
ALTER TABLE del.delivery DROP COLUMN on_the_way_at;
DROP TABLE del.route_stop;
DROP FUNCTION del.route_stop_guard();
DROP TRIGGER trg_route_check ON del.route;
DROP FUNCTION del.route_check();
DROP TABLE del.route;
DROP FUNCTION del.route_guard();
