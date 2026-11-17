-- 0199_inv_sale_return_of_issue
-- B09a continued 2d (FR-ORD-015, FR-INV-001, ADR-0002, ADR-0018, A-228): a customer return names the sale issue it takes
-- back, and the database holds both what may come back and what it is worth.
--   returns_movement_id     the SALE_ISSUE (or SALE_ISSUE_OFFLINE) a SALE_RETURN takes back part or all of; every
--                           SALE_RETURN that is not itself a reversal names one (ck_stock_sale_return)
--   ck_stock_sale_return    the return comes from where the issue went, of the same product, stock unit and branch, from
--                           an issue that is neither a reversal nor reversed; and what the returns of an issue take back
--                           (less any of them reversed) never exceeds what it issued. The issue's row is locked first,
--                           so two returns of one issue are decided one after the other.
--   value                   set here, never by the caller: the returns of an issue of quantity Q valued V carry
--                           half_up(V x c / Q) - half_up(V x p / Q), where p is what was returned before and c = p + q, so
--                           the parts always sum to V exactly and the last one takes what is left; the cost element is the
--                           issue's. A return therefore credits cost of sales with exactly what the sale charged it.
-- Additions to docs/data-model/inv.md: `returns_movement_id`.
-- Data category: CONFIDENTIAL (DC-22): stock and cost.
-- Rollback: tested (`pnpm db:rollback`), safe before the first return; afterwards forward fix only (a movement is never
-- removed).

-- migrate:up
ALTER TABLE inv.stock_movement
  ADD COLUMN returns_movement_id uuid NULL CONSTRAINT fk_stock_movement_returns REFERENCES inv.stock_movement (id) ON DELETE RESTRICT;
CREATE INDEX ix_stock_movement_returns ON inv.stock_movement (returns_movement_id) WHERE returns_movement_id IS NOT NULL;

CREATE FUNCTION inv.check_sale_return() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
DECLARE
  issue inv.stock_movement;
  before_qty numeric;
  q bigint;
  p bigint;
  big_q bigint;
BEGIN
  IF NEW.returns_movement_id IS NULL THEN
    IF NEW.movement_type = 'SALE_RETURN' AND NEW.reverses_movement_id IS NULL THEN
      PERFORM inv.refuse('ck_stock_sale_return', format('return %s names no sale issue it takes back', NEW.id));
    END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO issue FROM inv.stock_movement m WHERE m.id = NEW.returns_movement_id FOR UPDATE;
  IF NEW.movement_type <> 'SALE_RETURN' OR NEW.reverses_movement_id IS NOT NULL
     OR issue.movement_type NOT IN ('SALE_ISSUE', 'SALE_ISSUE_OFFLINE') OR issue.reverses_movement_id IS NOT NULL
     OR EXISTS (SELECT 1 FROM inv.stock_movement r WHERE r.reverses_movement_id = issue.id)
     OR issue.product_id <> NEW.product_id OR issue.stock_unit_id IS DISTINCT FROM NEW.stock_unit_id
     OR issue.branch_id <> NEW.branch_id OR issue.to_location_id <> NEW.from_location_id THEN
    PERFORM inv.refuse('ck_stock_sale_return', format('movement %s is not a return of sale issue %s', NEW.id, NEW.returns_movement_id));
  END IF;
  SELECT COALESCE(sum(r.qty_base), 0) INTO before_qty
    FROM inv.stock_movement r
   WHERE r.returns_movement_id = issue.id
     AND NOT EXISTS (SELECT 1 FROM inv.stock_movement x WHERE x.reverses_movement_id = r.id);
  IF before_qty + NEW.qty_base > issue.qty_base THEN
    PERFORM inv.refuse('ck_stock_sale_return', format('sale issue %s issued %s and %s is back already; %s more is too much', issue.id, issue.qty_base, before_qty, NEW.qty_base));
  END IF;
  q := ((before_qty + NEW.qty_base) * 1000)::bigint;
  p := (before_qty * 1000)::bigint;
  big_q := (issue.qty_base * 1000)::bigint;
  NEW.value_pesewas := div(2 * issue.value_pesewas::numeric * q + big_q, 2 * big_q::numeric)::bigint
                     - div(2 * issue.value_pesewas::numeric * p + big_q, 2 * big_q::numeric)::bigint;
  NEW.cost_element := issue.cost_element;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION inv.check_sale_return() FROM PUBLIC;
-- Named to run after trg_stock_movement_check and trg_stock_movement_expired (BEFORE triggers fire by name).
CREATE TRIGGER trg_stock_movement_sale_return BEFORE INSERT ON inv.stock_movement
  FOR EACH ROW EXECUTE FUNCTION inv.check_sale_return();

-- migrate:down
DROP TRIGGER trg_stock_movement_sale_return ON inv.stock_movement;
DROP FUNCTION inv.check_sale_return();
DROP INDEX inv.ix_stock_movement_returns;
ALTER TABLE inv.stock_movement DROP COLUMN returns_movement_id;
