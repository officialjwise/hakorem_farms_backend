-- 0175_mdm_customer_has_phone
-- The owner, 2026-11-16 (FR-PAY-015, A-212 (b)): store credit is held only for a named customer with a phone number,
-- never the shared walk-in, where it would be a pot anyone could spend. MDM publishes whether a customer has a phone,
-- without the number, as a function PAY's database rule calls (ADR-0047, listed in tooling/architecture.json): PAY never reads
-- mdm.customer itself.
-- Data category: none (a function; it returns a yes or no, never the number).
-- Rollback: tested (`pnpm db:rollback`); 0176's trigger is dropped first.

-- migrate:up
CREATE FUNCTION mdm.customer_has_phone(p_customer_id uuid) RETURNS boolean
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
  SELECT EXISTS (SELECT 1 FROM mdm.customer c WHERE c.id = p_customer_id AND c.phone_e164 IS NOT NULL);
$$;
REVOKE ALL ON FUNCTION mdm.customer_has_phone(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mdm.customer_has_phone(uuid) TO hk_app, hk_worker;

-- migrate:down
DROP FUNCTION mdm.customer_has_phone(uuid);
