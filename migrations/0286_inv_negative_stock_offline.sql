-- 0286_inv_negative_stock_offline
-- B09b continued 3c (the owner's decision 2 of 2026-11-18, ADR-0081, ADR-0018 Amendments, A-283): an offline sale may
-- take a location's stock below zero, since the goods were physically sold. The stock-sign rule stays in the database,
-- narrowed to this one exception; every other movement type keeps today's rule. Leave from the parent session
-- (2026-11-23) to replace inv.apply_movement for this condition only; inv.check_movement is not changed.
--   inv.movement_type.negative_anywhere    true for SALE_ISSUE_OFFLINE only: it may go below zero at any physical
--                                          location, not only one that allows_negative (a SERIAL unit never)
--   inv.apply_movement                     its two "allowed negative" conditions read
--                                          (from_location.allows_negative OR mt.negative_anywhere); the rest byte for
--                                          byte as migration 0044 wrote it
--   inv.negative_stock_cost                LEDGER: the quantity an offline sale issued beyond what the branch's cost
--                                          pool held, valued at the last known cost (the pool's own average when it
--                                          covered part, else the last valued movement of the pool), half-up once;
--                                          written by trg_stock_movement_negative_cost, never by the application.
--                                          With no known cost at all: value 0, cost_known false (raised URGENT)
--   NEGATIVE_TRUE_UP_IN, NEGATIVE_TRUE_UP  the true-up on arrival: the open uncovered quantity lifted in at nil value
--                                          from ADJUSTMENT before the arrival and issued back out after it, valued by
--                                          the pool (check_movement's own rule): exact, insert-only, nets to zero
--   inv.negative_stock_settlement          LEDGER: what each true-up settled of each uncovered row, oldest first; one
--                                          row per (cost row, true-up); never more than is still uncovered
--                                          (ck_negative_stock_settled); written by inv.settle_negative_stock only
--   trg_stock_movement_true_up_named       deferred: a true-up movement is named by its settlement rows at commit, the
--                                          lift and the issue equal, the settled values summing to the issue's value
--                                          (ck_negative_true_up)
--   inv.count_task                         WORK: a count of that product at that location, one open at a time, raised
--                                          with the NEGATIVE_STOCK exception of an offline sale
-- Data category: CONFIDENTIAL (DC-09): stock and its cost.
-- Rollback: tested (`pnpm db:rollback`) before the first offline sale below zero; afterwards forward fix only.

-- migrate:up
ALTER TABLE inv.movement_type ADD COLUMN negative_anywhere boolean NOT NULL DEFAULT false;
UPDATE inv.movement_type SET negative_anywhere = true WHERE code = 'SALE_ISSUE_OFFLINE';
ALTER TABLE inv.movement_type ADD CONSTRAINT ck_movement_type_negative_anywhere CHECK (NOT negative_anywhere OR allows_negative);

INSERT INTO inv.movement_type (code, name, is_value_only, allows_negative, blocked_by_hold, requires_reason, requires_stock_unit, posting_event, negative_anywhere) VALUES
  ('NEGATIVE_TRUE_UP_IN', 'Stock sold ahead of receipt, lifted at nil value for its true-up', false, false, false, false, false, NULL, false),
  ('NEGATIVE_TRUE_UP', 'Stock sold ahead of receipt, its cost taken out on arrival', false, true, false, false, false, NULL, true);

CREATE OR REPLACE FUNCTION inv.apply_movement() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
DECLARE
  mt inv.movement_type;
  unit inv.stock_unit;
  reservation inv.stock_reservation;
  source_balance inv.stock_balance;
  from_location record;
  to_location record;
  weight numeric := COALESCE(NEW.weight_kg, 0);
  packs integer := COALESCE(NEW.pack_count, 0);
  physical_on_hand numeric;
  source_pool_branch uuid;
  target_pool_branch uuid;
  next_status text;
BEGIN
  SELECT * INTO mt FROM inv.movement_type t WHERE t.code = NEW.movement_type;
  SELECT * INTO from_location FROM mdm.location_stock_facts(NEW.from_location_id);
  SELECT * INTO to_location FROM mdm.location_stock_facts(NEW.to_location_id);
  IF NEW.stock_unit_id IS NOT NULL THEN
    SELECT * INTO unit FROM inv.stock_unit u WHERE u.id = NEW.stock_unit_id;
  END IF;

  IF NEW.reservation_id IS NOT NULL THEN
    SELECT * INTO reservation FROM inv.stock_reservation r WHERE r.id = NEW.reservation_id FOR UPDATE;
    IF reservation.status <> 'ACTIVE' OR reservation.product_id <> NEW.product_id
       OR reservation.stock_unit_id IS DISTINCT FROM NEW.stock_unit_id OR reservation.location_id <> NEW.from_location_id THEN
      PERFORM inv.refuse('ck_stock_reservation_use', format('movement %s names reservation %s, which is not an active reservation of this stock here', NEW.id, NEW.reservation_id));
    END IF;
    UPDATE inv.stock_reservation SET status = 'CONSUMED', version = version + 1, updated_by = NEW.actor_id WHERE id = NEW.reservation_id;
  END IF;

  IF NEW.qty_base > 0 THEN
    source_balance := inv.add_to_balance(NEW.product_id, NEW.stock_unit_id, NEW.from_location_id, from_location.branch_id, -NEW.qty_base, -weight, -packs);
    PERFORM inv.add_to_balance(NEW.product_id, NEW.stock_unit_id, NEW.to_location_id, to_location.branch_id, NEW.qty_base, weight, packs);

    IF NOT from_location.is_virtual THEN
      IF source_balance.on_hand_qty < 0 THEN
        IF mt.allows_negative AND (from_location.allows_negative OR mt.negative_anywhere) AND unit.tracking IS DISTINCT FROM 'SERIAL' THEN
          INSERT INTO inv.stock_exception (kind, branch_id, product_id, stock_unit_id, location_id, movement_id, source_document_id, qty, details)
          VALUES ('NEGATIVE_STOCK', from_location.branch_id, NEW.product_id, NEW.stock_unit_id, NEW.from_location_id, NEW.id, NEW.source_document_id,
                  -source_balance.on_hand_qty,
                  jsonb_build_object('movementType', NEW.movement_type, 'qtyMoved', NEW.qty_base, 'onHandAfter', source_balance.on_hand_qty,
                                     'note', 'the uncovered quantity carried no cost: cost of sales is understated until this is resolved'));
        ELSE
          PERFORM inv.refuse('ck_stock_negative', format('product %s at location %s would go to %s, short by %s', NEW.product_id, from_location.code,
                                                        source_balance.on_hand_qty, -source_balance.on_hand_qty));
        END IF;
      END IF;
      IF source_balance.on_hand_qty < source_balance.reserved_qty THEN
        IF mt.allows_negative AND (from_location.allows_negative OR mt.negative_anywhere) AND unit.tracking IS DISTINCT FROM 'SERIAL' THEN
          INSERT INTO inv.stock_exception (kind, branch_id, product_id, stock_unit_id, location_id, movement_id, source_document_id, qty, details)
          VALUES ('RESERVATION_CONFLICT', from_location.branch_id, NEW.product_id, NEW.stock_unit_id, NEW.from_location_id, NEW.id, NEW.source_document_id,
                  source_balance.reserved_qty - source_balance.on_hand_qty,
                  jsonb_build_object('movementType', NEW.movement_type, 'onHandAfter', source_balance.on_hand_qty, 'reserved', source_balance.reserved_qty));
        ELSE
          PERFORM inv.refuse('ck_stock_reserved', format('product %s at location %s: %s would remain against %s reserved', NEW.product_id, from_location.code,
                                                        source_balance.on_hand_qty, source_balance.reserved_qty));
        END IF;
      END IF;
    END IF;

    IF unit.tracking = 'SERIAL' THEN
      next_status := CASE WHEN NOT to_location.is_virtual THEN 'ACTIVE'
                          WHEN to_location.kind = 'CUSTOMER' THEN 'SOLD'
                          WHEN to_location.kind = 'PROCESSING' THEN 'CONSUMED'
                          WHEN to_location.kind = 'LOSS' THEN 'WRITTEN_OFF'
                          ELSE 'DEPLETED' END;
      UPDATE inv.stock_unit SET current_location_id = NEW.to_location_id, status = next_status, version = version + 1, updated_by = NEW.actor_id
       WHERE id = unit.id;
    ELSIF unit.tracking = 'LOT' THEN
      SELECT COALESCE(sum(b.on_hand_qty), 0) INTO physical_on_hand
        FROM inv.stock_balance b
       WHERE b.stock_unit_id = unit.id AND NOT (SELECT f.is_virtual FROM mdm.location_stock_facts(b.location_id) f);
      next_status := CASE WHEN physical_on_hand > 0 THEN 'ACTIVE' ELSE 'DEPLETED' END;
      IF next_status <> unit.status THEN
        UPDATE inv.stock_unit SET status = next_status, version = version + 1, updated_by = NEW.actor_id WHERE id = unit.id;
      END IF;
    END IF;
  END IF;

  -- Cost pools: a tracked unit has one pool at its branch; an untracked product one per branch.
  source_pool_branch := COALESCE(unit.branch_id, from_location.branch_id);
  target_pool_branch := COALESCE(unit.branch_id, to_location.branch_id);
  IF from_location.is_virtual THEN
    PERFORM inv.add_to_pool(NEW.product_id, NEW.stock_unit_id, target_pool_branch, NEW.qty_base, NEW.value_pesewas, NEW.id);
  ELSIF to_location.is_virtual THEN
    PERFORM inv.add_to_pool(NEW.product_id, NEW.stock_unit_id, source_pool_branch, -NEW.qty_base, -NEW.value_pesewas, NEW.id);
  ELSIF source_pool_branch <> target_pool_branch THEN
    PERFORM inv.add_to_pool(NEW.product_id, NEW.stock_unit_id, source_pool_branch, -NEW.qty_base, -NEW.value_pesewas, NEW.id);
    PERFORM inv.add_to_pool(NEW.product_id, NEW.stock_unit_id, target_pool_branch, NEW.qty_base, NEW.value_pesewas, NEW.id);
  END IF;
  RETURN NULL;
END
$$;

CREATE TABLE inv.negative_stock_cost (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  movement_id         uuid NOT NULL CONSTRAINT fk_negative_stock_cost_movement REFERENCES inv.stock_movement (id) ON DELETE RESTRICT
                        CONSTRAINT uq_negative_stock_cost_movement UNIQUE,
  product_id          uuid NOT NULL CONSTRAINT fk_negative_stock_cost_product REFERENCES mdm.product (id) ON DELETE RESTRICT,
  stock_unit_id       uuid NULL CONSTRAINT fk_negative_stock_cost_unit REFERENCES inv.stock_unit (id) ON DELETE RESTRICT,
  branch_id           uuid NOT NULL CONSTRAINT fk_negative_stock_cost_branch REFERENCES mdm.branch (id) ON DELETE RESTRICT,
  location_id         uuid NOT NULL CONSTRAINT fk_negative_stock_cost_location REFERENCES mdm.location (id) ON DELETE RESTRICT,
  uncovered_qty       platform.qty NOT NULL CONSTRAINT ck_negative_stock_cost_qty CHECK (uncovered_qty > 0),
  cost_known          boolean NOT NULL,
  basis_movement_id   uuid NULL CONSTRAINT fk_negative_stock_cost_basis REFERENCES inv.stock_movement (id) ON DELETE RESTRICT,
  basis_qty           numeric(14,3) NULL CONSTRAINT ck_negative_stock_cost_basis_qty CHECK (basis_qty > 0),
  basis_value_pesewas bigint NULL CONSTRAINT ck_negative_stock_cost_basis_value CHECK (basis_value_pesewas >= 0),
  value_pesewas       platform.pesewas NOT NULL,
  recorded_at         timestamptz NOT NULL,
  actor_id            uuid NOT NULL CONSTRAINT fk_negative_stock_cost_actor REFERENCES iam.principal (id) ON DELETE RESTRICT,
  CONSTRAINT ck_negative_stock_cost_basis CHECK (cost_known = (basis_qty IS NOT NULL) AND (basis_qty IS NULL) = (basis_value_pesewas IS NULL) AND (basis_qty IS NULL) = (basis_movement_id IS NULL)),
  CONSTRAINT ck_negative_stock_cost_value CHECK (value_pesewas = CASE WHEN cost_known
    THEN div(2 * basis_value_pesewas::numeric * (uncovered_qty * 1000) + (basis_qty * 1000), 2 * (basis_qty * 1000))::bigint ELSE 0 END)
);
COMMENT ON TABLE inv.negative_stock_cost IS 'class=LEDGER';
CREATE INDEX ix_negative_stock_cost_pool ON inv.negative_stock_cost (product_id, branch_id, stock_unit_id, recorded_at, id);
CREATE TRIGGER trg_negative_stock_cost_immutable BEFORE UPDATE OR DELETE ON inv.negative_stock_cost
  FOR EACH ROW EXECUTE FUNCTION platform.reject_change();
CREATE TRIGGER trg_negative_stock_cost_no_truncate BEFORE TRUNCATE ON inv.negative_stock_cost
  FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_change();
-- Written only by trg_stock_movement_negative_cost, inside the movement's own insert: never by hand (ck_negative_stock_cost).
CREATE FUNCTION inv.negative_stock_cost_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF pg_trigger_depth() < 2 OR NOT EXISTS (
       SELECT 1 FROM inv.stock_movement m WHERE m.id = NEW.movement_id AND m.movement_type = 'SALE_ISSUE_OFFLINE'
          AND m.product_id = NEW.product_id AND m.stock_unit_id IS NOT DISTINCT FROM NEW.stock_unit_id AND NEW.uncovered_qty <= m.qty_base) THEN
    RAISE EXCEPTION 'inv.negative_stock_cost: written only for an offline sale''s issue, by its own movement trigger' USING ERRCODE = 'HK010', CONSTRAINT = 'ck_negative_stock_cost';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION inv.negative_stock_cost_guard() FROM PUBLIC;
CREATE TRIGGER trg_negative_stock_cost_guard BEFORE INSERT ON inv.negative_stock_cost
  FOR EACH ROW EXECUTE FUNCTION inv.negative_stock_cost_guard();
REVOKE ALL ON inv.negative_stock_cost FROM PUBLIC;
GRANT SELECT, INSERT ON inv.negative_stock_cost TO hk_app, hk_worker;

-- AFTER INSERT of an offline sale's issue, after trg_stock_movement_apply has moved the pool (AFTER triggers fire by
-- name): what the branch's pool did not cover, valued at the last known cost.
CREATE FUNCTION inv.cost_negative_issue() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
DECLARE
  pool_branch uuid;
  pool_qty numeric;
  covered numeric;
  uncovered numeric;
  basis record;
BEGIN
  IF NEW.reverses_movement_id IS NOT NULL THEN RETURN NULL; END IF;
  SELECT COALESCE(u.branch_id, NEW.branch_id) INTO pool_branch FROM (SELECT 1) one LEFT JOIN inv.stock_unit u ON u.id = NEW.stock_unit_id;
  SELECT c.qty INTO pool_qty FROM inv.cost_pool c
   WHERE c.product_id = NEW.product_id AND c.stock_unit_id IS NOT DISTINCT FROM NEW.stock_unit_id AND c.branch_id = pool_branch;
  covered := LEAST(NEW.qty_base, GREATEST(COALESCE(pool_qty, 0) + NEW.qty_base, 0));
  uncovered := NEW.qty_base - covered;
  IF uncovered <= 0 THEN RETURN NULL; END IF;
  IF covered > 0 THEN
    SELECT NEW.id::uuid AS id, covered::numeric AS qty, NEW.value_pesewas::bigint AS value INTO basis;
  ELSE
    -- The last known cost: the latest of an earlier uncovered row's own basis and a valued movement of this pool that
    -- was not itself short (a short issue's value is only what the pool held; a true-up is not a cost).
    SELECT b.id::uuid AS id, b.qty::numeric AS qty, b.value::bigint AS value INTO basis FROM (
      SELECT c.basis_movement_id AS id, c.basis_qty AS qty, c.basis_value_pesewas AS value, c.recorded_at AS rec_at, c.movement_id AS tie
        FROM inv.negative_stock_cost c
       WHERE c.product_id = NEW.product_id AND c.stock_unit_id IS NOT DISTINCT FROM NEW.stock_unit_id AND c.branch_id = pool_branch AND c.cost_known
      UNION ALL
      SELECT m.id, m.qty_base, m.value_pesewas, m.recorded_at, m.id
        FROM inv.stock_movement m
       WHERE m.product_id = NEW.product_id AND m.stock_unit_id IS NOT DISTINCT FROM NEW.stock_unit_id AND m.branch_id = pool_branch
         AND m.id <> NEW.id AND m.qty_base > 0 AND m.value_pesewas > 0 AND m.movement_type NOT IN ('NEGATIVE_TRUE_UP_IN', 'NEGATIVE_TRUE_UP')
         AND NOT EXISTS (SELECT 1 FROM inv.negative_stock_cost x WHERE x.movement_id = m.id)
    ) b
    ORDER BY b.rec_at DESC, b.tie DESC LIMIT 1;
  END IF;
  INSERT INTO inv.negative_stock_cost (movement_id, product_id, stock_unit_id, branch_id, location_id, uncovered_qty, cost_known, basis_movement_id, basis_qty,
                                       basis_value_pesewas, value_pesewas, recorded_at, actor_id)
  VALUES (NEW.id, NEW.product_id, NEW.stock_unit_id, pool_branch, NEW.from_location_id, uncovered, basis.id IS NOT NULL, basis.id, basis.qty, basis.value,
          CASE WHEN basis.id IS NULL THEN 0 ELSE inv.half_up_div(basis.value::numeric * (uncovered * 1000), basis.qty * 1000) END, NEW.recorded_at, NEW.actor_id);
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION inv.cost_negative_issue() FROM PUBLIC;
CREATE TRIGGER trg_stock_movement_negative_cost AFTER INSERT ON inv.stock_movement
  FOR EACH ROW WHEN (NEW.movement_type = 'SALE_ISSUE_OFFLINE') EXECUTE FUNCTION inv.cost_negative_issue();

CREATE TABLE inv.negative_stock_settlement (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cost_id                uuid NOT NULL CONSTRAINT fk_negative_stock_settlement_cost REFERENCES inv.negative_stock_cost (id) ON DELETE RESTRICT,
  lift_movement_id       uuid NOT NULL CONSTRAINT fk_negative_stock_settlement_lift REFERENCES inv.stock_movement (id) ON DELETE RESTRICT,
  arrival_movement_id    uuid NOT NULL CONSTRAINT fk_negative_stock_settlement_arrival REFERENCES inv.stock_movement (id) ON DELETE RESTRICT,
  true_up_movement_id    uuid NOT NULL CONSTRAINT fk_negative_stock_settlement_true_up REFERENCES inv.stock_movement (id) ON DELETE RESTRICT,
  qty                    platform.qty NOT NULL CONSTRAINT ck_negative_stock_settlement_qty CHECK (qty > 0),
  cleared_value_pesewas  platform.pesewas NOT NULL,
  true_up_value_pesewas  platform.pesewas NOT NULL,
  recorded_at            timestamptz NOT NULL,
  actor_id               uuid NOT NULL CONSTRAINT fk_negative_stock_settlement_actor REFERENCES iam.principal (id) ON DELETE RESTRICT,
  CONSTRAINT uq_negative_stock_settlement UNIQUE (cost_id, true_up_movement_id)
);
COMMENT ON TABLE inv.negative_stock_settlement IS 'class=LEDGER';
CREATE INDEX ix_negative_stock_settlement_true_up ON inv.negative_stock_settlement (true_up_movement_id);
CREATE INDEX ix_negative_stock_settlement_lift ON inv.negative_stock_settlement (lift_movement_id);
CREATE TRIGGER trg_negative_stock_settlement_immutable BEFORE UPDATE OR DELETE ON inv.negative_stock_settlement
  FOR EACH ROW EXECUTE FUNCTION platform.reject_change();
CREATE TRIGGER trg_negative_stock_settlement_no_truncate BEFORE TRUNCATE ON inv.negative_stock_settlement
  FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_change();

-- BEFORE INSERT of a settlement: the cost row is locked; never more than is still uncovered; the three movements are
-- the lift, an arrival and the issue of the same pool; the cleared part of the last known value is cumulative half-up.
CREATE FUNCTION inv.negative_stock_settlement_guard() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
DECLARE
  c inv.negative_stock_cost;
  lift inv.stock_movement;
  issue inv.stock_movement;
  settled numeric;
BEGIN
  SELECT * INTO c FROM inv.negative_stock_cost WHERE id = NEW.cost_id FOR UPDATE;
  SELECT COALESCE(sum(s.qty), 0) INTO settled FROM inv.negative_stock_settlement s WHERE s.cost_id = NEW.cost_id;
  IF settled + NEW.qty > c.uncovered_qty THEN
    RAISE EXCEPTION 'inv.negative_stock_settlement: % would settle % of the % still uncovered on %', NEW.id, NEW.qty, c.uncovered_qty - settled, NEW.cost_id
      USING ERRCODE = 'HK010', CONSTRAINT = 'ck_negative_stock_settled';
  END IF;
  SELECT * INTO lift FROM inv.stock_movement WHERE id = NEW.lift_movement_id;
  SELECT * INTO issue FROM inv.stock_movement WHERE id = NEW.true_up_movement_id;
  IF lift.movement_type <> 'NEGATIVE_TRUE_UP_IN' OR issue.movement_type <> 'NEGATIVE_TRUE_UP'
     OR lift.product_id <> c.product_id OR issue.product_id <> c.product_id
     OR lift.stock_unit_id IS DISTINCT FROM c.stock_unit_id OR issue.stock_unit_id IS DISTINCT FROM c.stock_unit_id
     OR NOT EXISTS (SELECT 1 FROM inv.stock_movement a WHERE a.id = NEW.arrival_movement_id AND a.product_id = c.product_id
                     AND a.movement_type NOT IN ('NEGATIVE_TRUE_UP_IN', 'NEGATIVE_TRUE_UP', 'SALE_ISSUE_OFFLINE'))
     OR NEW.cleared_value_pesewas <> inv.half_up_div(c.value_pesewas::numeric * ((settled + NEW.qty) * 1000), c.uncovered_qty * 1000)
                                     - inv.half_up_div(c.value_pesewas::numeric * (settled * 1000), c.uncovered_qty * 1000) THEN
    RAISE EXCEPTION 'inv.negative_stock_settlement: % does not settle cost row % by its own lift, arrival and true-up', NEW.id, NEW.cost_id
      USING ERRCODE = 'HK010', CONSTRAINT = 'ck_negative_true_up';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION inv.negative_stock_settlement_guard() FROM PUBLIC;
CREATE TRIGGER trg_negative_stock_settlement_guard BEFORE INSERT ON inv.negative_stock_settlement
  FOR EACH ROW EXECUTE FUNCTION inv.negative_stock_settlement_guard();
REVOKE ALL ON inv.negative_stock_settlement FROM PUBLIC;
GRANT SELECT, INSERT ON inv.negative_stock_settlement TO hk_app, hk_worker;

-- The true-up's settlement, oldest uncovered row first (A-283 (c)): the arrived quantity settles up to what is still
-- uncovered; the issue's value is split over the rows by cumulative half-up on quantity, so it sums exactly; each row's
-- last known value is cleared by cumulative half-up on its own uncovered quantity, so a row fully settled clears it all.
CREATE FUNCTION inv.settle_negative_stock(p_lift uuid, p_arrival uuid, p_true_up uuid, p_actor uuid)
  RETURNS TABLE (settled_qty numeric, cleared_pesewas bigint, true_up_pesewas bigint)
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
DECLARE
  issue inv.stock_movement;
  arrival inv.stock_movement;
  pool_branch uuid;
  to_settle numeric;
  done numeric := 0;
  cleared_total bigint := 0;
  r record;
  take numeric;
  part_cleared bigint;
  part_value bigint;
  given bigint := 0;
BEGIN
  SELECT * INTO issue FROM inv.stock_movement WHERE id = p_true_up AND movement_type = 'NEGATIVE_TRUE_UP';
  SELECT * INTO arrival FROM inv.stock_movement WHERE id = p_arrival;
  IF issue.id IS NULL OR arrival.id IS NULL THEN
    RAISE EXCEPTION 'inv.settle_negative_stock: % is not a true-up of arrival %', p_true_up, p_arrival USING ERRCODE = 'HK010', CONSTRAINT = 'ck_negative_true_up';
  END IF;
  SELECT COALESCE(u.branch_id, issue.branch_id) INTO pool_branch FROM (SELECT 1) one LEFT JOIN inv.stock_unit u ON u.id = issue.stock_unit_id;
  to_settle := LEAST(issue.qty_base, arrival.qty_base);
  FOR r IN
    SELECT c.id, c.uncovered_qty - COALESCE((SELECT sum(s.qty) FROM inv.negative_stock_settlement s WHERE s.cost_id = c.id), 0) AS remaining
      FROM inv.negative_stock_cost c
     WHERE c.product_id = issue.product_id AND c.stock_unit_id IS NOT DISTINCT FROM issue.stock_unit_id AND c.branch_id = pool_branch
     ORDER BY c.recorded_at, c.id
     FOR UPDATE OF c
  LOOP
    EXIT WHEN done >= to_settle;
    CONTINUE WHEN r.remaining <= 0;
    take := LEAST(r.remaining, to_settle - done);
    part_value := inv.half_up_div(issue.value_pesewas::numeric * ((done + take) * 1000), to_settle * 1000) - given;
    SELECT inv.half_up_div(c.value_pesewas::numeric * ((c.uncovered_qty - r.remaining + take) * 1000), c.uncovered_qty * 1000)
           - inv.half_up_div(c.value_pesewas::numeric * ((c.uncovered_qty - r.remaining) * 1000), c.uncovered_qty * 1000)
      INTO part_cleared FROM inv.negative_stock_cost c WHERE c.id = r.id;
    INSERT INTO inv.negative_stock_settlement (cost_id, lift_movement_id, arrival_movement_id, true_up_movement_id, qty, cleared_value_pesewas, true_up_value_pesewas, recorded_at, actor_id)
    VALUES (r.id, p_lift, p_arrival, p_true_up, take, part_cleared, part_value, issue.recorded_at, p_actor);
    done := done + take;
    given := given + part_value;
    cleared_total := cleared_total + part_cleared;
  END LOOP;
  RETURN QUERY SELECT done, cleared_total, given;
END
$$;
REVOKE ALL ON FUNCTION inv.settle_negative_stock(uuid, uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION inv.settle_negative_stock(uuid, uuid, uuid, uuid) TO hk_app, hk_worker;

-- At commit: a true-up movement is named by its settlement rows, its lift and its issue are equal, and what the rows
-- took out sums to the issue's value exactly (ck_negative_true_up). A true-up written by hand never commits.
CREATE FUNCTION inv.true_up_named() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  n integer;
  lift_qty numeric;
  issue_qty numeric;
  issue_value bigint;
  given bigint;
  expected bigint;
BEGIN
  IF NEW.movement_type = 'NEGATIVE_TRUE_UP_IN' THEN
    SELECT count(*), min(i.qty_base), min(i.value_pesewas), min(NEW.qty_base) INTO n, issue_qty, issue_value, lift_qty
      FROM inv.negative_stock_settlement s JOIN inv.stock_movement i ON i.id = s.true_up_movement_id WHERE s.lift_movement_id = NEW.id;
  ELSE
    SELECT count(*), min(l.qty_base), min(NEW.qty_base), min(NEW.value_pesewas) INTO n, lift_qty, issue_qty, issue_value
      FROM inv.negative_stock_settlement s JOIN inv.stock_movement l ON l.id = s.lift_movement_id WHERE s.true_up_movement_id = NEW.id;
    SELECT COALESCE(sum(s.true_up_value_pesewas), 0) INTO given FROM inv.negative_stock_settlement s WHERE s.true_up_movement_id = NEW.id;
    IF given <> NEW.value_pesewas THEN n := 0; END IF;
  END IF;
  expected := CASE WHEN NEW.movement_type = 'NEGATIVE_TRUE_UP_IN' THEN 0 ELSE issue_value END;
  IF n = 0 OR lift_qty IS DISTINCT FROM issue_qty OR NEW.value_pesewas IS DISTINCT FROM expected THEN
    RAISE EXCEPTION 'inv.stock_movement %: a % is made only by the true-up on arrival, named by its settlement', NEW.id, NEW.movement_type
      USING ERRCODE = 'HK010', CONSTRAINT = 'ck_negative_true_up';
  END IF;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION inv.true_up_named() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER trg_stock_movement_true_up_named AFTER INSERT ON inv.stock_movement
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.movement_type IN ('NEGATIVE_TRUE_UP_IN', 'NEGATIVE_TRUE_UP')) EXECUTE FUNCTION inv.true_up_named();

CREATE TABLE inv.count_task (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id          uuid NOT NULL CONSTRAINT fk_count_task_branch REFERENCES mdm.branch (id) ON DELETE RESTRICT,
  location_id        uuid NOT NULL CONSTRAINT fk_count_task_location REFERENCES mdm.location (id) ON DELETE RESTRICT,
  product_id         uuid NOT NULL CONSTRAINT fk_count_task_product REFERENCES mdm.product (id) ON DELETE RESTRICT,
  stock_unit_id      uuid NULL CONSTRAINT fk_count_task_unit REFERENCES inv.stock_unit (id) ON DELETE RESTRICT,
  stock_exception_id uuid NOT NULL CONSTRAINT fk_count_task_exception REFERENCES inv.stock_exception (id) ON DELETE RESTRICT,
  status             text NOT NULL DEFAULT 'OPEN' CONSTRAINT ck_count_task_status CHECK (status IN ('OPEN', 'DONE')),
  raised_at          timestamptz NOT NULL,
  done_at            timestamptz NULL,
  done_by            uuid NULL CONSTRAINT fk_count_task_done_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  CONSTRAINT ck_count_task_done CHECK ((status = 'DONE') = (done_at IS NOT NULL) AND (done_at IS NULL) = (done_by IS NULL))
);
COMMENT ON TABLE inv.count_task IS 'class=WORK';
CREATE UNIQUE INDEX uq_count_task_open ON inv.count_task (location_id, product_id, stock_unit_id) NULLS NOT DISTINCT WHERE status = 'OPEN';
CREATE INDEX ix_count_task_exception ON inv.count_task (stock_exception_id);
REVOKE ALL ON inv.count_task FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON inv.count_task TO hk_app, hk_worker;

-- AFTER INSERT of a NEGATIVE_STOCK exception of an offline sale (its movement a SALE_ISSUE_OFFLINE, or none when the
-- stock could not be moved at all): a count of that product at that location, unless one is already open.
CREATE FUNCTION inv.raise_count_task() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.location_id IS NULL OR (NEW.movement_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM inv.stock_movement m WHERE m.id = NEW.movement_id AND m.movement_type = 'SALE_ISSUE_OFFLINE')) THEN
    RETURN NULL;
  END IF;
  INSERT INTO inv.count_task (branch_id, location_id, product_id, stock_unit_id, stock_exception_id, raised_at)
  VALUES (NEW.branch_id, NEW.location_id, NEW.product_id, NEW.stock_unit_id, NEW.id, NEW.raised_at)
  ON CONFLICT (location_id, product_id, stock_unit_id) WHERE status = 'OPEN' DO NOTHING;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION inv.raise_count_task() FROM PUBLIC;
CREATE TRIGGER trg_stock_exception_count_task AFTER INSERT ON inv.stock_exception
  FOR EACH ROW WHEN (NEW.kind = 'NEGATIVE_STOCK') EXECUTE FUNCTION inv.raise_count_task();

-- migrate:down
DROP TRIGGER trg_stock_exception_count_task ON inv.stock_exception;
DROP FUNCTION inv.raise_count_task();
DROP TABLE inv.count_task;
DROP TRIGGER trg_stock_movement_true_up_named ON inv.stock_movement;
DROP FUNCTION inv.true_up_named();
DROP FUNCTION inv.settle_negative_stock(uuid, uuid, uuid, uuid);
DROP TABLE inv.negative_stock_settlement;
DROP FUNCTION inv.negative_stock_settlement_guard();
DROP TRIGGER trg_stock_movement_negative_cost ON inv.stock_movement;
DROP FUNCTION inv.cost_negative_issue();
DROP TABLE inv.negative_stock_cost;
DROP FUNCTION inv.negative_stock_cost_guard();
CREATE OR REPLACE FUNCTION inv.apply_movement() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
DECLARE
  mt inv.movement_type;
  unit inv.stock_unit;
  reservation inv.stock_reservation;
  source_balance inv.stock_balance;
  from_location record;
  to_location record;
  weight numeric := COALESCE(NEW.weight_kg, 0);
  packs integer := COALESCE(NEW.pack_count, 0);
  physical_on_hand numeric;
  source_pool_branch uuid;
  target_pool_branch uuid;
  next_status text;
BEGIN
  SELECT * INTO mt FROM inv.movement_type t WHERE t.code = NEW.movement_type;
  SELECT * INTO from_location FROM mdm.location_stock_facts(NEW.from_location_id);
  SELECT * INTO to_location FROM mdm.location_stock_facts(NEW.to_location_id);
  IF NEW.stock_unit_id IS NOT NULL THEN
    SELECT * INTO unit FROM inv.stock_unit u WHERE u.id = NEW.stock_unit_id;
  END IF;

  IF NEW.reservation_id IS NOT NULL THEN
    SELECT * INTO reservation FROM inv.stock_reservation r WHERE r.id = NEW.reservation_id FOR UPDATE;
    IF reservation.status <> 'ACTIVE' OR reservation.product_id <> NEW.product_id
       OR reservation.stock_unit_id IS DISTINCT FROM NEW.stock_unit_id OR reservation.location_id <> NEW.from_location_id THEN
      PERFORM inv.refuse('ck_stock_reservation_use', format('movement %s names reservation %s, which is not an active reservation of this stock here', NEW.id, NEW.reservation_id));
    END IF;
    UPDATE inv.stock_reservation SET status = 'CONSUMED', version = version + 1, updated_by = NEW.actor_id WHERE id = NEW.reservation_id;
  END IF;

  IF NEW.qty_base > 0 THEN
    source_balance := inv.add_to_balance(NEW.product_id, NEW.stock_unit_id, NEW.from_location_id, from_location.branch_id, -NEW.qty_base, -weight, -packs);
    PERFORM inv.add_to_balance(NEW.product_id, NEW.stock_unit_id, NEW.to_location_id, to_location.branch_id, NEW.qty_base, weight, packs);

    IF NOT from_location.is_virtual THEN
      IF source_balance.on_hand_qty < 0 THEN
        IF mt.allows_negative AND from_location.allows_negative AND unit.tracking IS DISTINCT FROM 'SERIAL' THEN
          INSERT INTO inv.stock_exception (kind, branch_id, product_id, stock_unit_id, location_id, movement_id, source_document_id, qty, details)
          VALUES ('NEGATIVE_STOCK', from_location.branch_id, NEW.product_id, NEW.stock_unit_id, NEW.from_location_id, NEW.id, NEW.source_document_id,
                  -source_balance.on_hand_qty,
                  jsonb_build_object('movementType', NEW.movement_type, 'qtyMoved', NEW.qty_base, 'onHandAfter', source_balance.on_hand_qty,
                                     'note', 'the uncovered quantity carried no cost: cost of sales is understated until this is resolved'));
        ELSE
          PERFORM inv.refuse('ck_stock_negative', format('product %s at location %s would go to %s, short by %s', NEW.product_id, from_location.code,
                                                        source_balance.on_hand_qty, -source_balance.on_hand_qty));
        END IF;
      END IF;
      IF source_balance.on_hand_qty < source_balance.reserved_qty THEN
        IF mt.allows_negative AND from_location.allows_negative AND unit.tracking IS DISTINCT FROM 'SERIAL' THEN
          INSERT INTO inv.stock_exception (kind, branch_id, product_id, stock_unit_id, location_id, movement_id, source_document_id, qty, details)
          VALUES ('RESERVATION_CONFLICT', from_location.branch_id, NEW.product_id, NEW.stock_unit_id, NEW.from_location_id, NEW.id, NEW.source_document_id,
                  source_balance.reserved_qty - source_balance.on_hand_qty,
                  jsonb_build_object('movementType', NEW.movement_type, 'onHandAfter', source_balance.on_hand_qty, 'reserved', source_balance.reserved_qty));
        ELSE
          PERFORM inv.refuse('ck_stock_reserved', format('product %s at location %s: %s would remain against %s reserved', NEW.product_id, from_location.code,
                                                        source_balance.on_hand_qty, source_balance.reserved_qty));
        END IF;
      END IF;
    END IF;

    IF unit.tracking = 'SERIAL' THEN
      next_status := CASE WHEN NOT to_location.is_virtual THEN 'ACTIVE'
                          WHEN to_location.kind = 'CUSTOMER' THEN 'SOLD'
                          WHEN to_location.kind = 'PROCESSING' THEN 'CONSUMED'
                          WHEN to_location.kind = 'LOSS' THEN 'WRITTEN_OFF'
                          ELSE 'DEPLETED' END;
      UPDATE inv.stock_unit SET current_location_id = NEW.to_location_id, status = next_status, version = version + 1, updated_by = NEW.actor_id
       WHERE id = unit.id;
    ELSIF unit.tracking = 'LOT' THEN
      SELECT COALESCE(sum(b.on_hand_qty), 0) INTO physical_on_hand
        FROM inv.stock_balance b
       WHERE b.stock_unit_id = unit.id AND NOT (SELECT f.is_virtual FROM mdm.location_stock_facts(b.location_id) f);
      next_status := CASE WHEN physical_on_hand > 0 THEN 'ACTIVE' ELSE 'DEPLETED' END;
      IF next_status <> unit.status THEN
        UPDATE inv.stock_unit SET status = next_status, version = version + 1, updated_by = NEW.actor_id WHERE id = unit.id;
      END IF;
    END IF;
  END IF;

  -- Cost pools: a tracked unit has one pool at its branch; an untracked product one per branch.
  source_pool_branch := COALESCE(unit.branch_id, from_location.branch_id);
  target_pool_branch := COALESCE(unit.branch_id, to_location.branch_id);
  IF from_location.is_virtual THEN
    PERFORM inv.add_to_pool(NEW.product_id, NEW.stock_unit_id, target_pool_branch, NEW.qty_base, NEW.value_pesewas, NEW.id);
  ELSIF to_location.is_virtual THEN
    PERFORM inv.add_to_pool(NEW.product_id, NEW.stock_unit_id, source_pool_branch, -NEW.qty_base, -NEW.value_pesewas, NEW.id);
  ELSIF source_pool_branch <> target_pool_branch THEN
    PERFORM inv.add_to_pool(NEW.product_id, NEW.stock_unit_id, source_pool_branch, -NEW.qty_base, -NEW.value_pesewas, NEW.id);
    PERFORM inv.add_to_pool(NEW.product_id, NEW.stock_unit_id, target_pool_branch, NEW.qty_base, NEW.value_pesewas, NEW.id);
  END IF;
  RETURN NULL;
END
$$;
DELETE FROM inv.movement_type WHERE code IN ('NEGATIVE_TRUE_UP_IN', 'NEGATIVE_TRUE_UP');
ALTER TABLE inv.movement_type DROP CONSTRAINT ck_movement_type_negative_anywhere;
ALTER TABLE inv.movement_type DROP COLUMN negative_anywhere;
