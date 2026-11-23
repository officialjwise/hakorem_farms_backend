-- 0288_quo_quote_line_stock
-- B10 continued 5 (the owner's item 3 of 2026-11-18, A-309 (f) as amended, ADR-0019, ADR-0081, A-328): a quote for
-- stock not on hand is no longer refused; it is issued subject to stock, holding only what is on hand, never more.
--   quo.quote_line_stock  LEDGER, insert-only: for each product line of a version, recorded once while it is issued
--                         (uq_quote_line_stock_line), what was on hand to promise (available_qty, a balance below zero
--                         counted as nothing) and what the quote reserved (held_qty). held_qty is never more than what
--                         was there (ck_quote_line_stock_held) nor more than the line's base quantity; a line is subject
--                         to stock when available_qty is below its base quantity. quo.quote_line_stock_check refuses a
--                         row for a line of another version, a free-text line, a held quantity above the line's, or a
--                         version already issued (HK004). Both quantities are in the product's base unit.
-- Data category: CONFIDENTIAL (DC-22, `quo.quote*`: stock levels at a branch behind a quote; the buyer sees only the flags).
-- Rollback: tested (`pnpm db:rollback`), safe before the first issue after it; afterwards forward fix only (a record of
-- what each issued version held).

-- migrate:up
CREATE TABLE quo.quote_line_stock (
  id                uuid PRIMARY KEY,
  quote_line_id     uuid NOT NULL CONSTRAINT fk_quote_line_stock_line REFERENCES quo.quote_line (id) ON DELETE RESTRICT,
  quote_version_id  uuid NOT NULL CONSTRAINT fk_quote_line_stock_version REFERENCES quo.quote_version (id) ON DELETE RESTRICT,
  available_qty     platform.qty NOT NULL,
  held_qty          platform.qty NOT NULL,
  recorded_at       timestamptz NOT NULL,
  actor_id          uuid NOT NULL CONSTRAINT fk_quote_line_stock_actor REFERENCES iam.principal (id) ON DELETE RESTRICT,
  CONSTRAINT uq_quote_line_stock_line UNIQUE (quote_line_id),
  CONSTRAINT ck_quote_line_stock_held CHECK (held_qty <= available_qty)
);
COMMENT ON TABLE quo.quote_line_stock IS 'class=LEDGER';
CREATE INDEX ix_quote_line_stock_version ON quo.quote_line_stock (quote_version_id);
CREATE TRIGGER trg_quote_line_stock_immutable BEFORE UPDATE OR DELETE ON quo.quote_line_stock FOR EACH ROW EXECUTE FUNCTION platform.reject_change();
CREATE TRIGGER trg_quote_line_stock_no_truncate BEFORE TRUNCATE ON quo.quote_line_stock FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_change();

-- A product line of this version, written while the version is issued and before it is ISSUED, never holding more
-- than the line asks for.
CREATE FUNCTION quo.quote_line_stock_check() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF NOT EXISTS (
       SELECT 1 FROM quo.quote_line l JOIN quo.quote_version v ON v.id = l.quote_version_id
        WHERE l.id = NEW.quote_line_id AND l.quote_version_id = NEW.quote_version_id AND l.base_qty IS NOT NULL
          AND NEW.held_qty <= l.base_qty AND v.status IN ('DRAFT', 'APPROVED')) THEN
    RAISE EXCEPTION 'quo.quote_line_stock: a product line of its own version, recorded before it is issued, holding no more than it asks for'
      USING ERRCODE = 'HK004', CONSTRAINT = 'ck_quote_line_stock_line';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION quo.quote_line_stock_check() FROM PUBLIC;
CREATE TRIGGER trg_quote_line_stock_check BEFORE INSERT ON quo.quote_line_stock FOR EACH ROW EXECUTE FUNCTION quo.quote_line_stock_check();

REVOKE ALL ON quo.quote_line_stock FROM PUBLIC;
GRANT SELECT, INSERT ON quo.quote_line_stock TO hk_app, hk_worker;

-- migrate:down
DROP TABLE quo.quote_line_stock;
DROP FUNCTION quo.quote_line_stock_check();
