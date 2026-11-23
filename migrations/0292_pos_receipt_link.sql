-- 0292_pos_receipt_link
-- B09b continued 4 (CR-033 points 1 and 2, ADR-0074 and its Amendments, ADR-0083, A-284): every offline sale's digital
-- receipt is a public link the till makes itself, offline, with its own long random token. The server keeps only the
-- token's hash.
--   pos.receipt_link (LEDGER)            the link a till made for a synced sale: the SHA-256 of the till's token, unique
--                                        (uq_receipt_link_token), one per sale (uq_receipt_link_sale), valid for twelve
--                                        months from the sale's time (ck_receipt_link_expiry), with the till's tenders as
--                                        it took them and the change it gave, for the receipt to show.
--   pos.receipt_link_revocation (LEDGER) a link revoked: once (PK), with a reason; a revoked link reads nothing.
--   pos.receipt_token_refusal (LEDGER)   a sale whose token was refused at sync, once per refused sale (PK): a token
--                                        already bound to another sale (TOKEN_ALREADY_BOUND, naming that sale), or shaped
--                                        like an identifier (TOKEN_IS_AN_IDENTIFIER). The sale is recorded; only its link
--                                        is refused, and it is marked as needing a fresh server-made link (B11's SMS).
--   pos.receipt_link_guard (HK010)        the shift is of the till the device is enrolled on, at the branch
--                                        (ck_receipt_link_device_shift), and the sale is applied on that shift
--                                        (ck_receipt_link_synced).
--   pos.receipt_token_refusal_guard (HK010) the same shift and sale rules (ck_receipt_token_refusal_device_shift,
--                                        ck_receipt_token_refusal_synced); a sale bound to the token holds a link of that
--                                        hash (ck_receipt_token_refusal_bound); the refused sale holds no link
--                                        (ck_receipt_token_refusal_unlinked).
-- Every time is written by the application from its clock (ADR-0067); nothing here reads now().
-- Additions to docs/data-model/pos.md: the tables above, as built.
-- Data category: the token hashes are DC-43 (Restricted, authentication verifiers); the tenders and change are DC-22
-- (Confidential, commercial history). No customer detail; never the token.
-- Rollback: tested (`pnpm db:rollback`) before the first receipt link; afterwards the rows are evidence and only a
-- forward fix is safe.

-- migrate:up
CREATE TABLE pos.receipt_link (
  id                  uuid PRIMARY KEY,
  order_document_id   uuid NOT NULL CONSTRAINT fk_receipt_link_order REFERENCES platform.business_document (id) ON DELETE RESTRICT,
  branch_id           uuid NOT NULL CONSTRAINT fk_receipt_link_branch REFERENCES mdm.branch (id) ON DELETE RESTRICT,
  shift_id            uuid NOT NULL CONSTRAINT fk_receipt_link_shift REFERENCES pos.shift (id) ON DELETE RESTRICT,
  device_id           uuid NOT NULL CONSTRAINT fk_receipt_link_device REFERENCES pos.device_enrolment (id) ON DELETE RESTRICT,
  source              text NOT NULL CONSTRAINT ck_receipt_link_source CHECK (source = 'TILL'),
  token_hash          bytea NOT NULL CONSTRAINT ck_receipt_link_hash CHECK (octet_length(token_hash) = 32),
  issued_at           timestamptz NOT NULL,
  expires_at          timestamptz NOT NULL,
  tenders             jsonb NOT NULL CONSTRAINT ck_receipt_link_tenders CHECK (jsonb_typeof(tenders) = 'array' AND jsonb_array_length(tenders) BETWEEN 1 AND 10),
  change_pesewas      platform.pesewas NOT NULL,
  recorded_at         timestamptz NOT NULL,
  actor_id            uuid NOT NULL CONSTRAINT fk_receipt_link_actor REFERENCES iam.principal (id) ON DELETE RESTRICT,
  CONSTRAINT ck_receipt_link_expiry CHECK (expires_at = ((issued_at AT TIME ZONE 'UTC') + interval '12 months') AT TIME ZONE 'UTC'),
  CONSTRAINT ck_receipt_link_change CHECK (change_pesewas >= 0)
);
COMMENT ON TABLE pos.receipt_link IS 'class=LEDGER';
CREATE UNIQUE INDEX uq_receipt_link_token ON pos.receipt_link (token_hash);
CREATE UNIQUE INDEX uq_receipt_link_sale ON pos.receipt_link (order_document_id) WHERE source = 'TILL';
CREATE INDEX ix_receipt_link_shift ON pos.receipt_link (shift_id);
CREATE TRIGGER trg_receipt_link_immutable BEFORE UPDATE OR DELETE ON pos.receipt_link
  FOR EACH ROW EXECUTE FUNCTION platform.reject_change();
CREATE TRIGGER trg_receipt_link_no_truncate BEFORE TRUNCATE ON pos.receipt_link
  FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_change();

CREATE FUNCTION pos.receipt_link_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pos.shift s JOIN pos.device_enrolment d ON d.register_id = s.register_id
                  WHERE s.id = NEW.shift_id AND d.id = NEW.device_id AND s.branch_id = NEW.branch_id) THEN
    RAISE EXCEPTION 'pos.receipt_link %: shift % is not of the till device % is enrolled on', NEW.id, NEW.shift_id, NEW.device_id
      USING ERRCODE = 'HK010', CONSTRAINT = 'ck_receipt_link_device_shift';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pos.sale_sync y
                  WHERE y.order_document_id = NEW.order_document_id AND y.shift_id = NEW.shift_id
                    AND y.outcome IN ('APPLIED', 'APPLIED_WITH_EXCEPTION')) THEN
    RAISE EXCEPTION 'pos.receipt_link %: sale % is not applied on shift %', NEW.id, NEW.order_document_id, NEW.shift_id
      USING ERRCODE = 'HK010', CONSTRAINT = 'ck_receipt_link_synced';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION pos.receipt_link_guard() FROM PUBLIC;
CREATE TRIGGER trg_receipt_link_guard BEFORE INSERT ON pos.receipt_link
  FOR EACH ROW EXECUTE FUNCTION pos.receipt_link_guard();

REVOKE ALL ON pos.receipt_link FROM PUBLIC;
GRANT SELECT, INSERT ON pos.receipt_link TO hk_app, hk_worker;

CREATE TABLE pos.receipt_link_revocation (
  receipt_link_id     uuid PRIMARY KEY CONSTRAINT fk_receipt_link_revocation_link REFERENCES pos.receipt_link (id) ON DELETE RESTRICT,
  reason              text NOT NULL CONSTRAINT ck_receipt_link_revocation_reason CHECK (char_length(btrim(reason)) BETWEEN 1 AND 500),
  revoked_at          timestamptz NOT NULL,
  recorded_at         timestamptz NOT NULL,
  actor_id            uuid NOT NULL CONSTRAINT fk_receipt_link_revocation_actor REFERENCES iam.principal (id) ON DELETE RESTRICT
);
COMMENT ON TABLE pos.receipt_link_revocation IS 'class=LEDGER';
CREATE TRIGGER trg_receipt_link_revocation_immutable BEFORE UPDATE OR DELETE ON pos.receipt_link_revocation
  FOR EACH ROW EXECUTE FUNCTION platform.reject_change();
CREATE TRIGGER trg_receipt_link_revocation_no_truncate BEFORE TRUNCATE ON pos.receipt_link_revocation
  FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_change();
REVOKE ALL ON pos.receipt_link_revocation FROM PUBLIC;
GRANT SELECT, INSERT ON pos.receipt_link_revocation TO hk_app, hk_worker;

CREATE TABLE pos.receipt_token_refusal (
  order_document_id        uuid PRIMARY KEY CONSTRAINT fk_receipt_token_refusal_order REFERENCES platform.business_document (id) ON DELETE RESTRICT,
  token_hash               bytea NOT NULL CONSTRAINT ck_receipt_token_refusal_hash CHECK (octet_length(token_hash) = 32),
  reason                   text NOT NULL CONSTRAINT ck_receipt_token_refusal_reason CHECK (reason IN ('TOKEN_ALREADY_BOUND', 'TOKEN_IS_AN_IDENTIFIER')),
  bound_order_document_id  uuid NULL CONSTRAINT fk_receipt_token_refusal_bound REFERENCES platform.business_document (id) ON DELETE RESTRICT,
  branch_id                uuid NOT NULL CONSTRAINT fk_receipt_token_refusal_branch REFERENCES mdm.branch (id) ON DELETE RESTRICT,
  shift_id                 uuid NOT NULL CONSTRAINT fk_receipt_token_refusal_shift REFERENCES pos.shift (id) ON DELETE RESTRICT,
  device_id                uuid NOT NULL CONSTRAINT fk_receipt_token_refusal_device REFERENCES pos.device_enrolment (id) ON DELETE RESTRICT,
  cashier_id               uuid NOT NULL CONSTRAINT fk_receipt_token_refusal_cashier REFERENCES iam.principal (id) ON DELETE RESTRICT,
  needs_server_link        boolean NOT NULL CONSTRAINT ck_receipt_token_refusal_needs_link CHECK (needs_server_link),
  recorded_at              timestamptz NOT NULL,
  actor_id                 uuid NOT NULL CONSTRAINT fk_receipt_token_refusal_actor REFERENCES iam.principal (id) ON DELETE RESTRICT,
  CONSTRAINT ck_receipt_token_refusal_fields CHECK (
    (reason = 'TOKEN_ALREADY_BOUND' AND bound_order_document_id IS NOT NULL AND bound_order_document_id <> order_document_id)
    OR (reason = 'TOKEN_IS_AN_IDENTIFIER' AND bound_order_document_id IS NULL))
);
COMMENT ON TABLE pos.receipt_token_refusal IS 'class=LEDGER';
CREATE INDEX ix_receipt_token_refusal_shift ON pos.receipt_token_refusal (shift_id);
CREATE TRIGGER trg_receipt_token_refusal_immutable BEFORE UPDATE OR DELETE ON pos.receipt_token_refusal
  FOR EACH ROW EXECUTE FUNCTION platform.reject_change();
CREATE TRIGGER trg_receipt_token_refusal_no_truncate BEFORE TRUNCATE ON pos.receipt_token_refusal
  FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_change();

CREATE FUNCTION pos.receipt_token_refusal_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pos.shift s JOIN pos.device_enrolment d ON d.register_id = s.register_id
                  WHERE s.id = NEW.shift_id AND d.id = NEW.device_id AND s.branch_id = NEW.branch_id AND s.cashier_id = NEW.cashier_id) THEN
    RAISE EXCEPTION 'pos.receipt_token_refusal %: shift % is not the cashier''s shift on the till device % is enrolled on', NEW.order_document_id, NEW.shift_id, NEW.device_id
      USING ERRCODE = 'HK010', CONSTRAINT = 'ck_receipt_token_refusal_device_shift';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pos.sale_sync y
                  WHERE y.order_document_id = NEW.order_document_id AND y.shift_id = NEW.shift_id
                    AND y.outcome IN ('APPLIED', 'APPLIED_WITH_EXCEPTION')) THEN
    RAISE EXCEPTION 'pos.receipt_token_refusal %: the sale is not applied on shift %', NEW.order_document_id, NEW.shift_id
      USING ERRCODE = 'HK010', CONSTRAINT = 'ck_receipt_token_refusal_synced';
  END IF;
  IF NEW.reason = 'TOKEN_ALREADY_BOUND' AND NOT EXISTS (
       SELECT 1 FROM pos.receipt_link l WHERE l.order_document_id = NEW.bound_order_document_id AND l.token_hash = NEW.token_hash) THEN
    RAISE EXCEPTION 'pos.receipt_token_refusal %: sale % holds no link of this token', NEW.order_document_id, NEW.bound_order_document_id
      USING ERRCODE = 'HK010', CONSTRAINT = 'ck_receipt_token_refusal_bound';
  END IF;
  IF EXISTS (SELECT 1 FROM pos.receipt_link l WHERE l.order_document_id = NEW.order_document_id) THEN
    RAISE EXCEPTION 'pos.receipt_token_refusal %: the sale already holds a link', NEW.order_document_id
      USING ERRCODE = 'HK010', CONSTRAINT = 'ck_receipt_token_refusal_unlinked';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION pos.receipt_token_refusal_guard() FROM PUBLIC;
CREATE TRIGGER trg_receipt_token_refusal_guard BEFORE INSERT ON pos.receipt_token_refusal
  FOR EACH ROW EXECUTE FUNCTION pos.receipt_token_refusal_guard();

REVOKE ALL ON pos.receipt_token_refusal FROM PUBLIC;
GRANT SELECT, INSERT ON pos.receipt_token_refusal TO hk_app, hk_worker;

-- migrate:down
DROP TABLE pos.receipt_token_refusal;
DROP FUNCTION pos.receipt_token_refusal_guard();
DROP TABLE pos.receipt_link_revocation;
DROP TABLE pos.receipt_link;
DROP FUNCTION pos.receipt_link_guard();
