-- 0282_quo_quote_links_revoked_and_decided
-- B10 continued 4 (the owner's decisions of 2026-11-18 for QUO, items 2 and 4; ADR-0074, ADR-0087, A-324, A-325):
-- several live links per issued version, each revoked on its own, and the device and session behind every decision
-- made through a link.
--   quo.quote_link_revocation  LEDGER, insert-only: a link revoked once (uq_quote_link_revocation_link), with its reason
--                              and who revoked it. A revoked link opens nothing; the version's other links keep working.
--   quo.quote_link_decision    LEDGER, insert-only: the acceptance or decline made through a link, once per version
--                              across all its links (uq_quote_link_decision_version), with the address and user agent
--                              of the call and, when the browser also held a signed-in staff session, whose
--                              (ck_quote_link_decision_staff: both or neither). quo.quote_link_decision_check refuses a
--                              decision through a link of another version or through a revoked link.
-- Data category: CONFIDENTIAL (DC-22 for the decision; DC-27 for the address, user agent and staff session).
-- Rollback: tested (`pnpm db:rollback`), safe before the first revocation or decision; afterwards forward fix only (both
-- are records of what was done through a link sent to a customer).

-- migrate:up
CREATE TABLE quo.quote_link_revocation (
  id             uuid PRIMARY KEY,
  link_token_id  uuid NOT NULL CONSTRAINT fk_quote_link_revocation_link REFERENCES quo.quote_link_token (id) ON DELETE RESTRICT,
  reason         text NOT NULL CONSTRAINT ck_quote_link_revocation_reason CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
  recorded_at    timestamptz NOT NULL,
  actor_id       uuid NOT NULL CONSTRAINT fk_quote_link_revocation_actor REFERENCES iam.principal (id) ON DELETE RESTRICT,
  CONSTRAINT uq_quote_link_revocation_link UNIQUE (link_token_id)
);
COMMENT ON TABLE quo.quote_link_revocation IS 'class=LEDGER';
CREATE TRIGGER trg_quote_link_revocation_immutable BEFORE UPDATE OR DELETE ON quo.quote_link_revocation FOR EACH ROW EXECUTE FUNCTION platform.reject_change();
CREATE TRIGGER trg_quote_link_revocation_no_truncate BEFORE TRUNCATE ON quo.quote_link_revocation FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_change();

CREATE TABLE quo.quote_link_decision (
  id                  uuid PRIMARY KEY,
  link_token_id       uuid NOT NULL CONSTRAINT fk_quote_link_decision_link REFERENCES quo.quote_link_token (id) ON DELETE RESTRICT,
  quote_version_id    uuid NOT NULL CONSTRAINT fk_quote_link_decision_version REFERENCES quo.quote_version (id) ON DELETE RESTRICT,
  decision            text NOT NULL CONSTRAINT ck_quote_link_decision_decision CHECK (decision IN ('ACCEPTED', 'DECLINED')),
  ip                  inet NULL,
  user_agent          text NULL CONSTRAINT ck_quote_link_decision_user_agent CHECK (length(user_agent) <= 500),
  staff_principal_id  uuid NULL CONSTRAINT fk_quote_link_decision_staff REFERENCES iam.principal (id) ON DELETE RESTRICT,
  staff_session_id    uuid NULL,
  decided_at          timestamptz NOT NULL,
  recorded_at         timestamptz NOT NULL,
  actor_id            uuid NOT NULL CONSTRAINT fk_quote_link_decision_actor REFERENCES iam.principal (id) ON DELETE RESTRICT,
  CONSTRAINT uq_quote_link_decision_version UNIQUE (quote_version_id),
  CONSTRAINT ck_quote_link_decision_staff CHECK ((staff_principal_id IS NULL) = (staff_session_id IS NULL))
);
COMMENT ON TABLE quo.quote_link_decision IS 'class=LEDGER';
CREATE INDEX ix_quote_link_decision_link ON quo.quote_link_decision (link_token_id);
CREATE INDEX ix_quote_link_decision_staff ON quo.quote_link_decision (staff_principal_id) WHERE staff_principal_id IS NOT NULL;
CREATE TRIGGER trg_quote_link_decision_immutable BEFORE UPDATE OR DELETE ON quo.quote_link_decision FOR EACH ROW EXECUTE FUNCTION platform.reject_change();
CREATE TRIGGER trg_quote_link_decision_no_truncate BEFORE TRUNCATE ON quo.quote_link_decision FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_change();

-- A decision is made through a link of its own version that nobody has revoked.
CREATE FUNCTION quo.quote_link_decision_check() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM quo.quote_link_token t WHERE t.id = NEW.link_token_id AND t.quote_version_id = NEW.quote_version_id)
     OR EXISTS (SELECT 1 FROM quo.quote_link_revocation r WHERE r.link_token_id = NEW.link_token_id) THEN
    RAISE EXCEPTION 'quo.quote_link_decision: a decision is made through a live link of its own version' USING ERRCODE = 'HK004', CONSTRAINT = 'ck_quote_link_decision_link';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION quo.quote_link_decision_check() FROM PUBLIC;
CREATE TRIGGER trg_quote_link_decision_check BEFORE INSERT ON quo.quote_link_decision FOR EACH ROW EXECUTE FUNCTION quo.quote_link_decision_check();

REVOKE ALL ON quo.quote_link_revocation, quo.quote_link_decision FROM PUBLIC;
GRANT SELECT, INSERT ON quo.quote_link_revocation, quo.quote_link_decision TO hk_app, hk_worker;

-- migrate:down
DROP TABLE quo.quote_link_decision;
DROP TABLE quo.quote_link_revocation;
DROP FUNCTION quo.quote_link_decision_check();
