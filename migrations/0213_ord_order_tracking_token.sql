-- 0213_ord_order_tracking_token
-- B09q continued (owner's decision 5 of 2026-11-17, ADR-0074 superseding ADR-0070's tracking token): an online order's
-- tracking link carries its own random token, stored only as its hash. Held by the database:
--   ord.order_tracking_token        LEDGER: one row per token ever issued for an order (placement, and each replay of
--                                   the placement), never changed or removed; the token itself is never stored
--   ck_order_tracking_token_hash    the SHA-256 of the token's text, exactly 32 bytes
--   uq_order_tracking_token_hash    one row per token; also the point read trackOrder looks up by (ADR-0005)
--   ck_order_tracking_token_expiry  a link lives more than nothing and at most thirty days from when it was made
--                                   (A-256); expiry is judged by the application's clock (ADR-0067)
--   ck_order_tracking_token_online  only an ONLINE order has a tracking link (trigger, 23514)
-- The HMAC-signed tokens of 1.51.0 to 2.0.0 (never stored) stop reading anything: nothing is deployed (A-256).
-- Data category: CONFIDENTIAL (DC-22): a hash that opens an order's progress.
-- Rollback: tested (`pnpm db:rollback`), safe before deployment; once links have been sent, dropping the table makes
-- them read nothing, so after deployment only a forward fix is safe.

-- migrate:up
CREATE TABLE ord.order_tracking_token (
  id             uuid PRIMARY KEY,
  sales_order_id uuid NOT NULL CONSTRAINT fk_order_tracking_token_order REFERENCES ord.sales_order (id) ON DELETE RESTRICT,
  token_hash     bytea NOT NULL CONSTRAINT ck_order_tracking_token_hash CHECK (octet_length(token_hash) = 32),
  recorded_at    timestamptz NOT NULL,
  expires_at     timestamptz NOT NULL,
  actor_id       uuid NOT NULL CONSTRAINT fk_order_tracking_token_actor REFERENCES iam.principal (id) ON DELETE RESTRICT,
  CONSTRAINT uq_order_tracking_token_hash UNIQUE (token_hash),
  CONSTRAINT ck_order_tracking_token_expiry CHECK (expires_at > recorded_at AND expires_at <= recorded_at + interval '30 days')
);
COMMENT ON TABLE ord.order_tracking_token IS 'class=LEDGER';
CREATE INDEX ix_order_tracking_token_order ON ord.order_tracking_token (sales_order_id);

CREATE FUNCTION ord.order_tracking_token_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, ord
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM ord.sales_order o WHERE o.id = NEW.sales_order_id AND o.channel = 'ONLINE') THEN
    RAISE EXCEPTION 'ord.order_tracking_token: order % is not an online order', NEW.sales_order_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ck_order_tracking_token_online';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION ord.order_tracking_token_guard() FROM PUBLIC;
CREATE TRIGGER trg_order_tracking_token_guard BEFORE INSERT ON ord.order_tracking_token
  FOR EACH ROW EXECUTE FUNCTION ord.order_tracking_token_guard();
CREATE TRIGGER trg_order_tracking_token_immutable BEFORE UPDATE OR DELETE ON ord.order_tracking_token
  FOR EACH ROW EXECUTE FUNCTION platform.reject_change();
CREATE TRIGGER trg_order_tracking_token_no_truncate BEFORE TRUNCATE ON ord.order_tracking_token
  FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_change();

REVOKE ALL ON ord.order_tracking_token FROM PUBLIC;
GRANT SELECT, INSERT ON ord.order_tracking_token TO hk_app, hk_worker;

-- migrate:down
DROP TABLE ord.order_tracking_token;
DROP FUNCTION ord.order_tracking_token_guard();
