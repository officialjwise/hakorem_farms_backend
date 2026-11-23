-- 0308_quo_quote_link_staff_match
-- The owner, 2026-11-23 (decision 5, B10 continued 6, A-325 as amended, A-343, abuse case 40): never widen the staff
-- session cookie's scope to see a staff member deciding a quote through the buyer's link. Staff cookies stay host-only
-- on the console and QUO reads none. A decision through a link keeps its address and browser (0282); IAM answers which
-- staff sessions were active from that address in the 24 hours before it (the application clock, ADR-0067), and each
-- match is recorded here, with whether its browser is the decision's. It flags a possible staff acceptance; it never
-- blocks the buyer's decision.
--   quo.quote_link_staff_match       LEDGER, insert-only: one row per staff session matched to one link decision
--                                    (uq_quote_link_staff_match_session), the staff member, the session's id (IAM's,
--                                    no foreign key: iam.session is not a published key), its last-seen time and
--                                    whether its user agent equals the decision's
--   ck_quote_link_decision_no_cookie quo.quote_link_decision no longer takes a staff session from a cookie: every new
--                                    row has none (NOT VALID: the rows B10 continued 4 recorded keep theirs)
-- Data category: CONFIDENTIAL (DC-27: who was signed in where).
-- Rollback: tested (`pnpm db:rollback`), safe before the first match; afterwards forward fix only (the table is a
-- ledger of evidence for the exception report).

-- migrate:up
CREATE TABLE quo.quote_link_staff_match (
  id                     uuid PRIMARY KEY,
  link_decision_id       uuid NOT NULL CONSTRAINT fk_quote_link_staff_match_decision REFERENCES quo.quote_link_decision (id) ON DELETE RESTRICT,
  staff_principal_id     uuid NOT NULL CONSTRAINT fk_quote_link_staff_match_staff REFERENCES iam.principal (id) ON DELETE RESTRICT,
  staff_session_id       uuid NOT NULL,
  same_browser           boolean NOT NULL,
  session_last_seen_at   timestamptz NOT NULL,
  window_hours           integer NOT NULL CONSTRAINT ck_quote_link_staff_match_window CHECK (window_hours = 24),
  recorded_at            timestamptz NOT NULL,
  actor_id               uuid NOT NULL CONSTRAINT fk_quote_link_staff_match_actor REFERENCES iam.principal (id) ON DELETE RESTRICT,
  CONSTRAINT uq_quote_link_staff_match_session UNIQUE (link_decision_id, staff_session_id)
);
COMMENT ON TABLE quo.quote_link_staff_match IS 'class=LEDGER';
CREATE INDEX ix_quote_link_staff_match_staff ON quo.quote_link_staff_match (staff_principal_id);
CREATE TRIGGER trg_quote_link_staff_match_immutable BEFORE UPDATE OR DELETE ON quo.quote_link_staff_match FOR EACH ROW EXECUTE FUNCTION platform.reject_change();
CREATE TRIGGER trg_quote_link_staff_match_no_truncate BEFORE TRUNCATE ON quo.quote_link_staff_match FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_change();
REVOKE ALL ON quo.quote_link_staff_match FROM PUBLIC;
GRANT SELECT, INSERT ON quo.quote_link_staff_match TO hk_app, hk_worker;

ALTER TABLE quo.quote_link_decision
  ADD CONSTRAINT ck_quote_link_decision_no_cookie CHECK (staff_principal_id IS NULL AND staff_session_id IS NULL) NOT VALID;
COMMENT ON COLUMN quo.quote_link_decision.staff_principal_id IS
  'Written only by B10 continued 4 from the staff cookie (A-325 (c), withdrawn 2026-11-23); null on every later row (ck_quote_link_decision_no_cookie). Matches are in quo.quote_link_staff_match.';

-- migrate:down
COMMENT ON COLUMN quo.quote_link_decision.staff_principal_id IS NULL;
ALTER TABLE quo.quote_link_decision DROP CONSTRAINT ck_quote_link_decision_no_cookie;
DROP TABLE quo.quote_link_staff_match;
