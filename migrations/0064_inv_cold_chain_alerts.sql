-- 0064_inv_cold_chain_alerts
-- The cold chain log, reorder rules and stock alerts (FR-INV-007, FR-INV-008, FR-INV-015, FR-INV-016,
-- docs/data-model/inv.md), and the refusal to sell an expired lot (A-134 (j)).
--
--   inv.reorder_rule          minimum, reorder point and maximum per product and branch, or one location of it, with
--                             the expiry alert lead time (MASTER). One live rule per product, branch and location.
--   inv.stock_alert           a low-stock, below-minimum, expiring or expired alert, OPEN until the condition ends and
--                             then CLEARED once (DOCUMENT). At most one OPEN alert of a kind per rule, and per lot and
--                             location, so an alert is raised once per crossing, not per movement (FR-INV-015).
--   inv.temperature_reading   the cold chain log (LEDGER, insert only). The location's permitted range is MDM's: it
--                             is copied onto the reading when it is recorded (read through MDM's interface, never from
--                             an inv trigger, so ADR-0047 is not widened), and the database checks the reading's
--                             excursion flag against the range it was judged by (ck_temperature_reading_excursion). An
--                             excursion names its TEMPERATURE_EXCURSION document, the source of its holds.
--   blocked_when_expired      a movement type column: sale and offline sale of a lot after its expiry date (in Africa/
--                             Accra) are refused by inv.protect_expired (HK010 ck_stock_expired)
--   inv.pub_reorder_level     published view: each live rule with available stock (on hand less reserved less held,
--                             over the branch's physical stock locations or the rule's one location, in-transit and
--                             sites left out) and whether it is at or below its reorder point or below its minimum.
--                             RPT's low stock tile reads it (B05x, ADR-0011).
-- The view and the new trigger read only inv tables and MDM's published location_stock_facts (ADR-0047, unchanged).
-- Data category: INTERNAL (DC-13): quantities, temperatures, locations; no personal data.
-- Rollback: tested (`pnpm db:rollback`), safe before the first reading or rule; afterwards forward fix only, since a
-- reading is a ledger row and holds and exceptions name its excursion.

-- migrate:up
CREATE TABLE inv.reorder_rule (
  id                 uuid PRIMARY KEY,
  product_id         uuid NOT NULL CONSTRAINT fk_reorder_rule_product REFERENCES mdm.product (id) ON DELETE RESTRICT,
  branch_id          uuid NOT NULL CONSTRAINT fk_reorder_rule_branch REFERENCES mdm.branch (id) ON DELETE RESTRICT,
  location_id        uuid NULL CONSTRAINT fk_reorder_rule_location REFERENCES mdm.location (id) ON DELETE RESTRICT,
  min_qty            platform.qty NOT NULL CONSTRAINT ck_reorder_rule_min CHECK (min_qty >= 0),
  reorder_point_qty  platform.qty NOT NULL,
  max_qty            platform.qty NOT NULL,
  expiry_alert_days  integer NULL CONSTRAINT ck_reorder_rule_expiry_days CHECK (expiry_alert_days BETWEEN 1 AND 365),
  version            integer NOT NULL DEFAULT 1,
  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid NOT NULL CONSTRAINT fk_reorder_rule_created_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  updated_by         uuid NOT NULL CONSTRAINT fk_reorder_rule_updated_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  deleted_at         timestamptz NULL,
  deleted_by         uuid NULL CONSTRAINT fk_reorder_rule_deleted_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  delete_reason      text NULL,
  CONSTRAINT ck_reorder_rule_levels CHECK (reorder_point_qty >= min_qty AND max_qty >= reorder_point_qty AND max_qty > 0),
  CONSTRAINT ck_reorder_rule_soft_delete CHECK ((deleted_at IS NULL) = (deleted_by IS NULL) AND (deleted_at IS NULL) = (delete_reason IS NULL))
);
COMMENT ON TABLE inv.reorder_rule IS 'class=MASTER';
CREATE UNIQUE INDEX uq_reorder_rule ON inv.reorder_rule (product_id, branch_id, location_id) NULLS NOT DISTINCT WHERE deleted_at IS NULL;
CREATE INDEX ix_reorder_rule_branch ON inv.reorder_rule (branch_id) WHERE deleted_at IS NULL;
CREATE TRIGGER trg_reorder_rule_version BEFORE UPDATE ON inv.reorder_rule
  FOR EACH ROW EXECUTE FUNCTION platform.touch_version();

-- What a rule is about never changes; only its levels and lead time do.
CREATE FUNCTION inv.reorder_rule_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.product_id <> OLD.product_id OR NEW.branch_id <> OLD.branch_id OR NEW.location_id IS DISTINCT FROM OLD.location_id
     OR NEW.created_at <> OLD.created_at OR NEW.created_by <> OLD.created_by THEN
    PERFORM inv.refuse('ck_reorder_rule_change', format('reorder rule %s: its product, branch and location never change', OLD.id));
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION inv.reorder_rule_guard() FROM PUBLIC;
CREATE TRIGGER trg_reorder_rule_guard BEFORE UPDATE ON inv.reorder_rule
  FOR EACH ROW EXECUTE FUNCTION inv.reorder_rule_guard();

CREATE TABLE inv.stock_alert (
  id                uuid PRIMARY KEY,
  kind              text NOT NULL CONSTRAINT ck_stock_alert_kind CHECK (kind IN ('LOW_STOCK', 'BELOW_MINIMUM', 'EXPIRING', 'EXPIRED')),
  branch_id         uuid NOT NULL CONSTRAINT fk_stock_alert_branch REFERENCES mdm.branch (id) ON DELETE RESTRICT,
  product_id        uuid NOT NULL CONSTRAINT fk_stock_alert_product REFERENCES mdm.product (id) ON DELETE RESTRICT,
  location_id       uuid NULL CONSTRAINT fk_stock_alert_location REFERENCES mdm.location (id) ON DELETE RESTRICT,
  stock_unit_id     uuid NULL CONSTRAINT fk_stock_alert_unit REFERENCES inv.stock_unit (id) ON DELETE RESTRICT,
  reorder_rule_id   uuid NULL CONSTRAINT fk_stock_alert_rule REFERENCES inv.reorder_rule (id) ON DELETE RESTRICT,
  qty               numeric(14,3) NOT NULL,
  threshold_qty     platform.qty NULL,
  suggested_qty     platform.qty NULL,
  expires_on        date NULL,
  status            text NOT NULL CONSTRAINT ck_stock_alert_status CHECK (status IN ('OPEN', 'CLEARED')),
  raised_at         timestamptz NOT NULL,
  cleared_at        timestamptz NULL,
  version           integer NOT NULL DEFAULT 1,
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid NOT NULL CONSTRAINT fk_stock_alert_created_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  updated_by        uuid NOT NULL CONSTRAINT fk_stock_alert_updated_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  -- A level alert belongs to its rule and carries the level it crossed; an expiry alert to a lot where it stands.
  CONSTRAINT ck_stock_alert_shape CHECK (
    CASE WHEN kind IN ('LOW_STOCK', 'BELOW_MINIMUM')
         THEN reorder_rule_id IS NOT NULL AND threshold_qty IS NOT NULL AND stock_unit_id IS NULL AND expires_on IS NULL
         ELSE reorder_rule_id IS NULL AND threshold_qty IS NULL AND suggested_qty IS NULL
              AND stock_unit_id IS NOT NULL AND location_id IS NOT NULL AND expires_on IS NOT NULL END),
  CONSTRAINT ck_stock_alert_cleared CHECK ((status = 'CLEARED') = (cleared_at IS NOT NULL) AND (cleared_at IS NULL OR cleared_at >= raised_at))
);
COMMENT ON TABLE inv.stock_alert IS 'class=DOCUMENT';
-- Raised once per crossing: one open alert of a kind per rule, and per lot and location.
CREATE UNIQUE INDEX uq_stock_alert_open_rule ON inv.stock_alert (reorder_rule_id, kind) WHERE status = 'OPEN' AND reorder_rule_id IS NOT NULL;
CREATE UNIQUE INDEX uq_stock_alert_open_lot ON inv.stock_alert (stock_unit_id, location_id, kind) WHERE status = 'OPEN' AND stock_unit_id IS NOT NULL;
CREATE INDEX ix_stock_alert_open ON inv.stock_alert (branch_id, raised_at) WHERE status = 'OPEN';
CREATE INDEX ix_stock_alert_product ON inv.stock_alert (product_id) WHERE status = 'OPEN';
CREATE TRIGGER trg_stock_alert_version BEFORE UPDATE ON inv.stock_alert
  FOR EACH ROW EXECUTE FUNCTION platform.touch_version();

-- An alert is raised OPEN and cleared once; nothing else about it ever changes.
CREATE FUNCTION inv.stock_alert_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  mutable text[] := ARRAY['status', 'cleared_at', 'version', 'updated_at', 'updated_by'];
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'OPEN' THEN
      PERFORM inv.refuse('ck_stock_alert_change', format('stock alert %s is raised OPEN', NEW.id));
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status <> 'OPEN' OR NEW.status <> 'CLEARED' OR (to_jsonb(NEW) - mutable) IS DISTINCT FROM (to_jsonb(OLD) - mutable) THEN
    PERFORM inv.refuse('ck_stock_alert_change', format('stock alert %s is cleared once, and only its clearing is written', OLD.id));
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION inv.stock_alert_guard() FROM PUBLIC;
CREATE TRIGGER trg_stock_alert_guard BEFORE INSERT OR UPDATE ON inv.stock_alert
  FOR EACH ROW EXECUTE FUNCTION inv.stock_alert_guard();

CREATE TABLE inv.temperature_reading (
  id                    uuid PRIMARY KEY,
  location_id           uuid NOT NULL CONSTRAINT fk_temperature_reading_location REFERENCES mdm.location (id) ON DELETE RESTRICT,
  branch_id             uuid NOT NULL CONSTRAINT fk_temperature_reading_branch REFERENCES mdm.branch (id) ON DELETE RESTRICT,
  reading_c             numeric(4,1) NOT NULL,
  range_min_c           numeric(4,1) NOT NULL,
  range_max_c           numeric(4,1) NOT NULL,
  measured_at           timestamptz NOT NULL,
  source                text NOT NULL CONSTRAINT ck_temperature_reading_source CHECK (source IN ('MANUAL', 'SENSOR')),
  is_excursion          boolean NOT NULL,
  excursion_document_id uuid NULL CONSTRAINT fk_temperature_reading_excursion REFERENCES platform.business_document (id) ON DELETE RESTRICT,
  exception_id          uuid NULL CONSTRAINT fk_temperature_reading_exception REFERENCES inv.stock_exception (id) ON DELETE RESTRICT,
  recorded_at           timestamptz NOT NULL DEFAULT now(),
  actor_id              uuid NOT NULL CONSTRAINT fk_temperature_reading_actor REFERENCES iam.principal (id) ON DELETE RESTRICT,
  CONSTRAINT ck_temperature_reading_range CHECK (range_min_c < range_max_c),
  -- FR-INV-007: an excursion is a reading outside the range it was judged against, the bounds themselves in range.
  CONSTRAINT ck_temperature_reading_excursion CHECK (is_excursion = (reading_c < range_min_c OR reading_c > range_max_c)),
  CONSTRAINT ck_temperature_reading_document CHECK (is_excursion = (excursion_document_id IS NOT NULL) AND (exception_id IS NULL OR is_excursion))
);
COMMENT ON TABLE inv.temperature_reading IS 'class=LEDGER';
CREATE INDEX ix_temperature_reading_location ON inv.temperature_reading (location_id, measured_at);
CREATE INDEX ix_temperature_reading_excursion ON inv.temperature_reading (branch_id, measured_at) WHERE is_excursion;
CREATE TRIGGER trg_temperature_reading_immutable BEFORE UPDATE OR DELETE ON inv.temperature_reading
  FOR EACH ROW EXECUTE FUNCTION platform.reject_change();
CREATE TRIGGER trg_temperature_reading_no_truncate BEFORE TRUNCATE ON inv.temperature_reading
  FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_change();

-- FR-INV-016: a lot past its expiry date is never sold. The date is Africa/Accra's on the day the sale happened.
ALTER TABLE inv.movement_type ADD COLUMN blocked_when_expired boolean NOT NULL DEFAULT false;
UPDATE inv.movement_type SET blocked_when_expired = true WHERE code IN ('SALE_ISSUE', 'SALE_ISSUE_OFFLINE');

CREATE FUNCTION inv.protect_expired() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
DECLARE
  blocked boolean;
  expires date;
  identifier text;
BEGIN
  IF NEW.stock_unit_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT t.blocked_when_expired INTO blocked FROM inv.movement_type t WHERE t.code = NEW.movement_type;
  IF NOT blocked THEN
    RETURN NEW;
  END IF;
  SELECT u.expires_on, u.identifier INTO expires, identifier FROM inv.stock_unit u WHERE u.id = NEW.stock_unit_id;
  IF expires IS NOT NULL AND expires < (NEW.occurred_at AT TIME ZONE 'Africa/Accra')::date THEN
    PERFORM inv.refuse('ck_stock_expired', format('%s expired on %s and cannot be sold by %s', identifier, expires, NEW.movement_type));
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION inv.protect_expired() FROM PUBLIC;
CREATE TRIGGER trg_stock_movement_expired BEFORE INSERT ON inv.stock_movement
  FOR EACH ROW EXECUTE FUNCTION inv.protect_expired();

-- Each live rule against what is available now. A unit under a hold in force counts its positive on hand as held.
CREATE VIEW inv.pub_reorder_level AS
SELECT r.id AS reorder_rule_id, r.product_id, r.branch_id, r.location_id, r.min_qty, r.reorder_point_qty, r.max_qty,
       COALESCE(s.on_hand, 0)::numeric(14,3) AS on_hand_qty,
       COALESCE(s.reserved, 0)::numeric(14,3) AS reserved_qty,
       COALESCE(s.held, 0)::numeric(14,3) AS held_qty,
       (COALESCE(s.on_hand, 0) - COALESCE(s.reserved, 0) - COALESCE(s.held, 0))::numeric(14,3) AS available_qty,
       (COALESCE(s.on_hand, 0) - COALESCE(s.reserved, 0) - COALESCE(s.held, 0)) <= r.reorder_point_qty AS at_or_below_reorder_point,
       (COALESCE(s.on_hand, 0) - COALESCE(s.reserved, 0) - COALESCE(s.held, 0)) < r.min_qty AS below_minimum
  FROM inv.reorder_rule r
  LEFT JOIN LATERAL (
    SELECT sum(b.on_hand_qty) AS on_hand, sum(b.reserved_qty) AS reserved,
           sum(CASE WHEN b.stock_unit_id IS NOT NULL AND b.on_hand_qty > 0 AND EXISTS (
                      SELECT 1 FROM inv.stock_hold h
                       WHERE h.stock_unit_id = b.stock_unit_id AND h.released_at IS NULL AND h.starts_at <= now() AND (h.ends_at IS NULL OR h.ends_at > now()))
                    THEN b.on_hand_qty ELSE 0 END) AS held
      FROM inv.stock_balance b
      CROSS JOIN LATERAL mdm.location_stock_facts(b.location_id) f
     WHERE b.product_id = r.product_id AND b.branch_id = r.branch_id AND (r.location_id IS NULL OR b.location_id = r.location_id)
       AND NOT f.is_virtual AND f.kind NOT IN ('IN_TRANSIT', 'SITE')
  ) s ON true
 WHERE r.deleted_at IS NULL;

GRANT SELECT, INSERT, UPDATE ON inv.reorder_rule, inv.stock_alert TO hk_app, hk_worker;
GRANT SELECT, INSERT ON inv.temperature_reading TO hk_app, hk_worker;
GRANT SELECT ON inv.pub_reorder_level TO hk_app, hk_worker, hk_report;

-- migrate:down
DROP VIEW inv.pub_reorder_level;
DROP TRIGGER trg_stock_movement_expired ON inv.stock_movement;
DROP FUNCTION inv.protect_expired();
ALTER TABLE inv.movement_type DROP COLUMN blocked_when_expired;
DROP TABLE inv.temperature_reading;
DROP TRIGGER trg_stock_alert_guard ON inv.stock_alert;
DROP FUNCTION inv.stock_alert_guard();
DROP TABLE inv.stock_alert;
DROP TRIGGER trg_reorder_rule_guard ON inv.reorder_rule;
DROP FUNCTION inv.reorder_rule_guard();
DROP TABLE inv.reorder_rule;
