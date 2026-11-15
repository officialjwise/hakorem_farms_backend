-- 0057_inv_stock_hold_notes
-- Holds placed and released by a person (FR-INV-022, FR-INV-008, A-142): the contract's StockHoldCreate and
-- StockHoldRelease each carry a note, which the table had no column for; and the release is a second person's act.
-- Expand only: two nullable columns and two checks on a table no service has written yet (the hold service arrives
-- with this migration), so nothing existing is affected.
--
--   note, release_note        why the hold was placed, and what the release found; a release always has its note
--   ck_stock_hold_releaser    the person who releases a hold is not the one who placed it (maker and checker)
--   inv.stock_hold_guard      replaced to let release_note be written with the release, once, and nothing else
-- Data category: INTERNAL (DC-13): free text about stock condition; no personal data is asked for.
-- Rollback: tested (`pnpm db:rollback`): restores the B5 guard and drops the columns, which loses the notes; safe
-- before the first hold, afterwards a forward fix only.

-- migrate:up
ALTER TABLE inv.stock_hold
  ADD COLUMN note text NULL CONSTRAINT ck_stock_hold_note CHECK (length(btrim(note)) BETWEEN 1 AND 1000),
  ADD COLUMN release_note text NULL CONSTRAINT ck_stock_hold_release_note CHECK (length(btrim(release_note)) BETWEEN 1 AND 1000);
ALTER TABLE inv.stock_hold
  ADD CONSTRAINT ck_stock_hold_release_noted CHECK (released_at IS NULL OR release_note IS NOT NULL),
  ADD CONSTRAINT ck_stock_hold_releaser CHECK (released_by IS NULL OR released_by <> created_by);

-- Holds: placing one locks the unit row, as a sale does, so the rule holds at any isolation level. A hold is released
-- once, by a named user with a reason and a note, and only that; a WITHDRAWAL hold is never released early: it ends
-- by time.
CREATE OR REPLACE FUNCTION inv.stock_hold_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  locked uuid;
  release text[] := ARRAY['released_at', 'released_by', 'release_reason_code', 'release_note'];
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT u.id INTO locked FROM inv.stock_unit u WHERE u.id = NEW.stock_unit_id FOR UPDATE;
    IF NEW.released_at IS NOT NULL OR NEW.release_note IS NOT NULL THEN
      PERFORM inv.refuse('ck_stock_hold_change', format('hold %s is placed unreleased', NEW.id));
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.released_at IS NOT NULL OR NEW.released_at IS NULL OR OLD.kind = 'WITHDRAWAL'
     OR (to_jsonb(NEW) - release) IS DISTINCT FROM (to_jsonb(OLD) - release) THEN
    PERFORM inv.refuse('ck_stock_hold_change', format('hold %s (%s) is released once with a reason, and a withdrawal hold only ends by time', OLD.id, OLD.kind));
  END IF;
  RETURN NEW;
END
$$;

-- migrate:down
CREATE OR REPLACE FUNCTION inv.stock_hold_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  locked uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT u.id INTO locked FROM inv.stock_unit u WHERE u.id = NEW.stock_unit_id FOR UPDATE;
    IF NEW.released_at IS NOT NULL THEN
      PERFORM inv.refuse('ck_stock_hold_change', format('hold %s is placed unreleased', NEW.id));
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.released_at IS NOT NULL OR NEW.released_at IS NULL OR OLD.kind = 'WITHDRAWAL'
     OR (to_jsonb(NEW) - ARRAY['released_at', 'released_by', 'release_reason_code'])
        IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['released_at', 'released_by', 'release_reason_code']) THEN
    PERFORM inv.refuse('ck_stock_hold_change', format('hold %s (%s) is released once with a reason, and a withdrawal hold only ends by time', OLD.id, OLD.kind));
  END IF;
  RETURN NEW;
END
$$;
ALTER TABLE inv.stock_hold DROP CONSTRAINT ck_stock_hold_releaser, DROP CONSTRAINT ck_stock_hold_release_noted;
ALTER TABLE inv.stock_hold DROP COLUMN release_note, DROP COLUMN note;
