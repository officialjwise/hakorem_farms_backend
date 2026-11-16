-- 0182_platform_app_clock
-- B09t (owner, 2026-11-16; ADR-0066, A-216): the application's clock inside a rule that lives in a view or a trigger.
-- `platform.app_now()` is the instant the unit of work wrote into the transaction-local setting `hk.app_now` from the
-- application's `Clock` at BEGIN, and `now()` when nothing wrote it (a migration, a psql session, a read outside a unit
-- of work). Rules whose "now" decides something (a hold window, an as-of time) read it instead of `now()`, so a test's
-- `ManualClock` controls them; audit columns (`created_at`, `updated_at`, `recorded_at`, ...) keep the database's
-- `now()`. A rule a caller can pass its instant to takes it as an argument instead (ADR-0066).
-- Data category: none (no table).
-- Rollback: tested (`pnpm db:rollback`), safe once 0183 and 0184 are rolled back.

-- migrate:up
CREATE FUNCTION platform.app_now() RETURNS timestamptz
  LANGUAGE sql
  STABLE
  SET search_path = pg_catalog
AS $$
  SELECT COALESCE(NULLIF(current_setting('hk.app_now', true), '')::timestamptz, now())
$$;
COMMENT ON FUNCTION platform.app_now() IS 'The application clock''s instant written by the unit of work for this transaction (hk.app_now), or now() (ADR-0066)';
REVOKE ALL ON FUNCTION platform.app_now() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.app_now() TO hk_app, hk_worker, hk_report;

-- migrate:down
DROP FUNCTION platform.app_now();
