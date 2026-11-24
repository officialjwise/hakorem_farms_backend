-- 0340_pos_receipt_message_link
-- B11 continued 12 (CR-033 point 3, ADR-0074 and its Amendments, ADR-0083, ADR-0084, A-349; the parent session's leave in
-- POS of 2026-11-24): the receipt SMS carries a link of its own, made by NTF's sending worker through POS just before
-- the provider call, never the till's token (which the server never holds) and never one stored in the outbox.
--   pos.receipt_message_link (LEDGER)   a link sent by message for a sale's receipt: the SHA-256 of a fresh `rcp_` token
--                                       (unique, uq_receipt_message_link_token), always of a sale's till link
--                                       (receipt_link_id), so it answers exactly that receipt; it expires with it
--                                       (ck_receipt_message_link_expiry, the till link's twelve months from the sale's
--                                       time) and reads nothing once the till link is revoked (no row of its own to
--                                       revoke: revoking the till link revokes every message link of it at once). One
--                                       per send; a message sent again gets another.
--   pos.receipt_message_link_guard (HK010)  the till link is the sale's (ck_receipt_message_link_sale), its expiry is the
--                                       till link's (ck_receipt_message_link_expiry), and the hash is no till link's
--                                       (ck_receipt_message_link_distinct).
-- A sale with no till link (its till token was refused, or the till sent none) has no message link: the receipt shows
-- the till's tenders and change, which only the till link keeps (the parent session, 2026-11-24; BL-118).
-- Every time is written by the application from its clock (ADR-0067); nothing here reads now().
-- Data category: the token hash is DC-43 (Restricted, an authentication verifier); never the token.
-- Rollback: tested before the first message link; afterwards the rows are evidence and only a forward fix applies.

-- migrate:up
CREATE TABLE pos.receipt_message_link (
  id                  uuid PRIMARY KEY,
  receipt_link_id     uuid NOT NULL CONSTRAINT fk_receipt_message_link_link REFERENCES pos.receipt_link (id) ON DELETE RESTRICT,
  order_document_id   uuid NOT NULL CONSTRAINT fk_receipt_message_link_order REFERENCES platform.business_document (id) ON DELETE RESTRICT,
  token_hash          bytea NOT NULL CONSTRAINT ck_receipt_message_link_hash CHECK (octet_length(token_hash) = 32),
  expires_at          timestamptz NOT NULL,
  recorded_at         timestamptz NOT NULL,
  actor_id            uuid NOT NULL CONSTRAINT fk_receipt_message_link_actor REFERENCES iam.principal (id) ON DELETE RESTRICT
);
COMMENT ON TABLE pos.receipt_message_link IS 'class=LEDGER';
CREATE UNIQUE INDEX uq_receipt_message_link_token ON pos.receipt_message_link (token_hash);
CREATE INDEX ix_receipt_message_link_link ON pos.receipt_message_link (receipt_link_id);
CREATE TRIGGER trg_receipt_message_link_immutable BEFORE UPDATE OR DELETE ON pos.receipt_message_link
  FOR EACH ROW EXECUTE FUNCTION platform.reject_change();
CREATE TRIGGER trg_receipt_message_link_no_truncate BEFORE TRUNCATE ON pos.receipt_message_link
  FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_change();

CREATE FUNCTION pos.receipt_message_link_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  till pos.receipt_link%ROWTYPE;
BEGIN
  SELECT * INTO till FROM pos.receipt_link l WHERE l.id = NEW.receipt_link_id;
  IF till.order_document_id IS DISTINCT FROM NEW.order_document_id OR till.source <> 'TILL' THEN
    RAISE EXCEPTION 'pos.receipt_message_link %: link % is not the till link of sale %', NEW.id, NEW.receipt_link_id, NEW.order_document_id
      USING ERRCODE = 'HK010', CONSTRAINT = 'ck_receipt_message_link_sale';
  END IF;
  IF NEW.expires_at IS DISTINCT FROM till.expires_at THEN
    RAISE EXCEPTION 'pos.receipt_message_link %: a message link expires with its till link', NEW.id
      USING ERRCODE = 'HK010', CONSTRAINT = 'ck_receipt_message_link_expiry';
  END IF;
  IF EXISTS (SELECT 1 FROM pos.receipt_link l WHERE l.token_hash = NEW.token_hash) THEN
    RAISE EXCEPTION 'pos.receipt_message_link %: the hash is a till link''s', NEW.id
      USING ERRCODE = 'HK010', CONSTRAINT = 'ck_receipt_message_link_distinct';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION pos.receipt_message_link_guard() FROM PUBLIC;
CREATE TRIGGER trg_receipt_message_link_guard BEFORE INSERT ON pos.receipt_message_link
  FOR EACH ROW EXECUTE FUNCTION pos.receipt_message_link_guard();

REVOKE ALL ON pos.receipt_message_link FROM PUBLIC;
GRANT SELECT, INSERT ON pos.receipt_message_link TO hk_app, hk_worker;

-- migrate:down
DROP TABLE pos.receipt_message_link;
DROP FUNCTION pos.receipt_message_link_guard();
