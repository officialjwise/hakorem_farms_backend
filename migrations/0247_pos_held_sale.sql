-- 0247_pos_held_sale
-- B09b continued 1c (FR-POS-007, A-276): a sale parked on a till's open shift by its cashier and recalled once, on that
-- shift, by that cashier; re-priced when it is recalled. It reserves nothing. It lapses when its shift closes (the
-- cashier's declaration or a force close) or twelve hours after it was held, whichever is first.
--   pos.held_sale        WORK: the lines as entered (payload), the total they came to when held, held_at and
--                        expires_at, and the step it is at: HELD, RECALLED (once, by whom and when) or LAPSED (when
--                        and why). pos.held_sale_guard (HK010, HK004): held only on an OPEN shift of its till by that
--                        shift's cashier (ck_held_sale_open_shift); what was held never changes; HELD becomes RECALLED,
--                        on its shift while OPEN, by its cashier, before it expires (ck_held_sale_recall), or LAPSED;
--                        a recalled or lapsed hold never changes again.
--   pos.shift            trg_shift_held_sales_lapsed (HK010, ck_shift_held_sales_lapsed): a shift leaves OPEN only once
--                        none of its sales is still held, so a close or a force close always lapses them.
-- Every time is written by the application from its clock (ADR-0067); nothing here reads now().
-- Additions to docs/data-model/pos.md: the table above, as built.
-- Data category: INTERNAL (DC-04: the lines a cashier entered; a label may name the customer by first name).
-- Rollback: tested (`pnpm db:rollback`); a held sale is work that lapses with its shift, so nothing of money is lost.

-- migrate:up
CREATE TABLE pos.held_sale (
  id                  uuid PRIMARY KEY,
  register_id         uuid NOT NULL CONSTRAINT fk_held_sale_register REFERENCES pos.register (id) ON DELETE RESTRICT,
  shift_id            uuid NOT NULL CONSTRAINT fk_held_sale_shift REFERENCES pos.shift (id) ON DELETE RESTRICT,
  branch_id           uuid NOT NULL CONSTRAINT fk_held_sale_branch REFERENCES mdm.branch (id) ON DELETE RESTRICT,
  held_by             uuid NOT NULL CONSTRAINT fk_held_sale_held_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  label               text NULL CONSTRAINT ck_held_sale_label CHECK (length(btrim(label)) BETWEEN 1 AND 120),
  payload             jsonb NOT NULL CONSTRAINT ck_held_sale_payload CHECK (jsonb_typeof(payload) = 'object' AND jsonb_typeof(payload -> 'lines') = 'array' AND octet_length(payload::text) <= 32768),
  held_gross_pesewas  platform.pesewas NOT NULL,
  held_at             timestamptz NOT NULL,
  expires_at          timestamptz NOT NULL,
  status              text NOT NULL CONSTRAINT ck_held_sale_status CHECK (status IN ('HELD', 'RECALLED', 'LAPSED')),
  recalled_at         timestamptz NULL,
  recalled_by         uuid NULL CONSTRAINT fk_held_sale_recalled_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  lapsed_at           timestamptz NULL,
  lapse_reason        text NULL CONSTRAINT ck_held_sale_lapse_reason CHECK (lapse_reason IN ('SHIFT_CLOSED', 'SHIFT_FORCE_CLOSED')),
  CONSTRAINT ck_held_sale_expiry CHECK (expires_at > held_at),
  CONSTRAINT ck_held_sale_steps CHECK (
    (status = 'HELD' AND recalled_at IS NULL AND recalled_by IS NULL AND lapsed_at IS NULL AND lapse_reason IS NULL)
    OR (status = 'RECALLED' AND recalled_at IS NOT NULL AND recalled_by IS NOT NULL AND recalled_at >= held_at AND recalled_at < expires_at AND lapsed_at IS NULL AND lapse_reason IS NULL)
    OR (status = 'LAPSED' AND lapsed_at IS NOT NULL AND lapse_reason IS NOT NULL AND lapsed_at >= held_at AND recalled_at IS NULL AND recalled_by IS NULL))
);
COMMENT ON TABLE pos.held_sale IS 'class=WORK';
CREATE INDEX ix_held_sale_register ON pos.held_sale (register_id, status);
CREATE INDEX ix_held_sale_shift ON pos.held_sale (shift_id) WHERE status = 'HELD';

CREATE FUNCTION pos.held_sale_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  s record;
BEGIN
  SELECT x.status, x.register_id, x.cashier_id, x.branch_id INTO s FROM pos.shift x WHERE x.id = NEW.shift_id;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'HELD' OR s.status IS DISTINCT FROM 'OPEN' OR s.register_id <> NEW.register_id OR s.cashier_id <> NEW.held_by OR s.branch_id <> NEW.branch_id THEN
      RAISE EXCEPTION 'pos.held_sale %: a sale is held only on an open shift of its till, by that shift''s cashier', NEW.id USING ERRCODE = 'HK010', CONSTRAINT = 'ck_held_sale_open_shift';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW.register_id, NEW.shift_id, NEW.branch_id, NEW.held_by, NEW.label, NEW.payload, NEW.held_gross_pesewas, NEW.held_at, NEW.expires_at)
     IS DISTINCT FROM (OLD.id, OLD.register_id, OLD.shift_id, OLD.branch_id, OLD.held_by, OLD.label, OLD.payload, OLD.held_gross_pesewas, OLD.held_at, OLD.expires_at) THEN
    RAISE EXCEPTION 'pos.held_sale %: what was held never changes', OLD.id USING ERRCODE = 'HK004';
  END IF;
  IF OLD.status <> 'HELD' THEN
    RAISE EXCEPTION 'pos.held_sale %: a % hold never changes again', OLD.id, OLD.status USING ERRCODE = 'HK004';
  END IF;
  IF NEW.status = 'RECALLED' AND (s.status IS DISTINCT FROM 'OPEN' OR NEW.recalled_by <> s.cashier_id) THEN
    RAISE EXCEPTION 'pos.held_sale %: a hold is recalled only on its shift while open, by that shift''s cashier', OLD.id USING ERRCODE = 'HK010', CONSTRAINT = 'ck_held_sale_recall';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION pos.held_sale_guard() FROM PUBLIC;
CREATE TRIGGER trg_held_sale_guard BEFORE INSERT OR UPDATE ON pos.held_sale
  FOR EACH ROW EXECUTE FUNCTION pos.held_sale_guard();

-- A shift leaves OPEN (declared, or force-closed) only once none of its sales is still held.
CREATE FUNCTION pos.shift_held_sales_lapsed() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF OLD.status = 'OPEN' AND NEW.status <> 'OPEN' AND EXISTS (SELECT 1 FROM pos.held_sale h WHERE h.shift_id = OLD.id AND h.status = 'HELD') THEN
    RAISE EXCEPTION 'pos.shift %: its held sales lapse before it closes', OLD.id USING ERRCODE = 'HK010', CONSTRAINT = 'ck_shift_held_sales_lapsed';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION pos.shift_held_sales_lapsed() FROM PUBLIC;
CREATE TRIGGER trg_shift_held_sales_lapsed BEFORE UPDATE ON pos.shift
  FOR EACH ROW EXECUTE FUNCTION pos.shift_held_sales_lapsed();

REVOKE ALL ON pos.held_sale FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON pos.held_sale TO hk_app, hk_worker;

-- migrate:down
DROP TRIGGER trg_shift_held_sales_lapsed ON pos.shift;
DROP FUNCTION pos.shift_held_sales_lapsed();
DROP TABLE pos.held_sale;
DROP FUNCTION pos.held_sale_guard();
