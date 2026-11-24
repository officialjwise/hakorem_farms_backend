-- 0341_shp_abandoned_cart_notice
-- Abandoned-cart recovery (FR-SHP-015, ADR-0026's assignment to B11; B11 continued 12, ADR-0084, A-378): the scheduler
-- finds a cart a customer holds, with lines, idle two hours and not checked out, whose customer has given marketing
-- consent (mdm.customer.marketing_consent_at), and requests one reminder for it, once ever. NTF sends it as a marketing
-- message through its one queue: never to a number that replied STOP, never in quiet hours, never to a customer without
-- consent (checked again when queued and when sent), and it names nothing that was in the cart.
--   shp.abandoned_cart_notice (LEDGER)  a reminder requested: at most one per cart (uq_abandoned_cart_notice,
--                                       ck_abandoned_cart_notice_sequence: the first and only), with the time the
--                                       cart was last changed, which the reminder was judged on.
--   shp.abandoned_cart_notice_guard (HK010)  only a cart a customer holds (ck_abandoned_cart_notice_customer).
-- The cart is not reserved and keeps its status: the customer can carry on with it.
-- The reminder's template and trigger (shp.CartAbandoned -> CART_REMINDER) are NTF's, seeded by 0339.
-- Every time is written by the application from its clock (ADR-0067); nothing here reads now().
-- Data category: none beyond the ids (DC-22 commercial history by reference).

-- migrate:up
CREATE TABLE shp.abandoned_cart_notice (
  id            uuid PRIMARY KEY,
  cart_id       uuid NOT NULL CONSTRAINT fk_abandoned_cart_notice_cart REFERENCES shp.cart (id) ON DELETE RESTRICT,
  sequence_no   integer NOT NULL CONSTRAINT ck_abandoned_cart_notice_sequence CHECK (sequence_no = 1),
  idle_since    timestamptz NOT NULL,
  recorded_at   timestamptz NOT NULL,
  actor_id      uuid NOT NULL CONSTRAINT fk_abandoned_cart_notice_actor REFERENCES iam.principal (id) ON DELETE RESTRICT,
  CONSTRAINT uq_abandoned_cart_notice UNIQUE (cart_id, sequence_no),
  CONSTRAINT ck_abandoned_cart_notice_idle CHECK (idle_since < recorded_at)
);
COMMENT ON TABLE shp.abandoned_cart_notice IS 'class=LEDGER';
CREATE TRIGGER trg_abandoned_cart_notice_immutable BEFORE UPDATE OR DELETE ON shp.abandoned_cart_notice
  FOR EACH ROW EXECUTE FUNCTION platform.reject_change();
CREATE TRIGGER trg_abandoned_cart_notice_no_truncate BEFORE TRUNCATE ON shp.abandoned_cart_notice
  FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_change();

CREATE FUNCTION shp.abandoned_cart_notice_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM shp.cart c WHERE c.id = NEW.cart_id AND c.customer_id IS NOT NULL) THEN
    RAISE EXCEPTION 'shp.abandoned_cart_notice %: cart % is held by no customer', NEW.id, NEW.cart_id
      USING ERRCODE = 'HK010', CONSTRAINT = 'ck_abandoned_cart_notice_customer';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION shp.abandoned_cart_notice_guard() FROM PUBLIC;
CREATE TRIGGER trg_abandoned_cart_notice_guard BEFORE INSERT ON shp.abandoned_cart_notice
  FOR EACH ROW EXECUTE FUNCTION shp.abandoned_cart_notice_guard();

REVOKE ALL ON shp.abandoned_cart_notice FROM PUBLIC;
GRANT SELECT, INSERT ON shp.abandoned_cart_notice TO hk_app, hk_worker;

-- migrate:down
DROP TABLE shp.abandoned_cart_notice;
DROP FUNCTION shp.abandoned_cart_notice_guard();
