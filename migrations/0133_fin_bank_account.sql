-- 0133_fin_bank_account
-- B08 continued 1b2 (docs/data-model/fin.md, ADR-0003, ADR-0022, ADR-0057, A-193, A-194): the business's own bank
-- accounts and mobile money wallets. The number is Restricted (DC-40): it is stored only sealed with a data key of its
-- own, wrapped by the key-encryption key, and shown only as its last four digits. Each account posts to its GL account
-- (1100 for a bank, 1110 for a wallet) against its own BANK_ACCOUNT subledger party.
--
-- The database refuses, whoever writes (SQLSTATE HK012, the rule as the constraint name):
--   ck_bank_account_gl       the GL account is not the postable, active BANK_ACCOUNT control account of the kind
--                            (1100 for BANK, 1110 for MOBILE_MONEY)
--   ck_bank_account_change   the kind, the sealed number, its last four digits or the GL account change, the data key
--                            is re-wrapped without a higher key-encryption key version, or the account is archived
--                            (an account is deactivated, never removed; a wrong number is a new account)
--   ck_bank_account_party    at commit: a new account has no BANK_ACCOUNT subledger party of its own
-- Data category: RESTRICTED (DC-40) for account_no_enc and account_no_data_key; CONFIDENTIAL for account_no_last4.
-- Rollback: tested (`pnpm db:rollback`); safe only before the first account is used by a journal line or a payment,
-- afterwards a forward fix.

-- migrate:up
CREATE TABLE fin.bank_account (
  id                     uuid PRIMARY KEY,
  kind                   text NOT NULL CONSTRAINT ck_bank_account_kind CHECK (kind IN ('BANK', 'MOBILE_MONEY')),
  name                   text NOT NULL CONSTRAINT ck_bank_account_name CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  institution            text NOT NULL CONSTRAINT ck_bank_account_institution CHECK (length(btrim(institution)) BETWEEN 1 AND 120),
  -- format byte, 12-byte nonce, 16-byte tag, then at least one byte of ciphertext (platform/crypto/envelope-cipher.ts)
  account_no_enc         bytea NOT NULL CONSTRAINT ck_bank_account_no_enc CHECK (octet_length(account_no_enc) > 29),
  -- the 32-byte data key sealed the same way under the key-encryption key: exactly 61 bytes
  account_no_data_key    bytea NOT NULL CONSTRAINT ck_bank_account_data_key CHECK (octet_length(account_no_data_key) = 61),
  account_no_kek_version integer NOT NULL CONSTRAINT ck_bank_account_kek_version CHECK (account_no_kek_version > 0),
  account_no_last4       text NOT NULL CONSTRAINT ck_bank_account_last4 CHECK (account_no_last4 ~ '^[0-9]{4}$'),
  gl_account_id          uuid NOT NULL CONSTRAINT fk_bank_account_gl REFERENCES fin.account (id) ON DELETE RESTRICT,
  branch_id              uuid NULL CONSTRAINT fk_bank_account_branch REFERENCES mdm.branch (id) ON DELETE RESTRICT,
  is_active              boolean NOT NULL DEFAULT true,
  version                integer NOT NULL DEFAULT 1,
  created_at             timestamptz NOT NULL DEFAULT now(),
  created_by             uuid NOT NULL CONSTRAINT fk_bank_account_created_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  updated_at             timestamptz NOT NULL DEFAULT now(),
  updated_by             uuid NOT NULL CONSTRAINT fk_bank_account_updated_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  deleted_at             timestamptz NULL,
  deleted_by             uuid NULL CONSTRAINT fk_bank_account_deleted_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  delete_reason          text NULL,
  CONSTRAINT ck_bank_account_soft_delete CHECK ((deleted_at IS NULL) = (deleted_by IS NULL) AND (deleted_at IS NULL) = (delete_reason IS NULL))
);
COMMENT ON TABLE fin.bank_account IS 'class=MASTER';
COMMENT ON COLUMN fin.bank_account.account_no_enc IS 'RESTRICTED (DC-40): AES-256-GCM under account_no_data_key, bound to fin.bank_account.account_no_enc:<id> (ADR-0057)';
COMMENT ON COLUMN fin.bank_account.account_no_data_key IS 'RESTRICTED (DC-40): the data key wrapped by key-encryption key version account_no_kek_version, bound to fin.bank_account.account_no:<id>';
CREATE UNIQUE INDEX uq_bank_account_name ON fin.bank_account (lower(btrim(name))) WHERE deleted_at IS NULL;
CREATE INDEX ix_bank_account_list ON fin.bank_account (lower(btrim(name)), id);
CREATE TRIGGER trg_bank_account_version BEFORE UPDATE ON fin.bank_account
  FOR EACH ROW EXECUTE FUNCTION platform.touch_version();

CREATE FUNCTION fin.bank_account_guard() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
DECLARE
  gl record;
  expected text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.kind, NEW.account_no_enc, NEW.account_no_last4, NEW.gl_account_id) IS DISTINCT FROM (OLD.kind, OLD.account_no_enc, OLD.account_no_last4, OLD.gl_account_id)
       OR (NEW.account_no_data_key IS DISTINCT FROM OLD.account_no_data_key AND NEW.account_no_kek_version <= OLD.account_no_kek_version)
       OR (NEW.account_no_data_key IS NOT DISTINCT FROM OLD.account_no_data_key AND NEW.account_no_kek_version IS DISTINCT FROM OLD.account_no_kek_version)
       OR NEW.deleted_at IS NOT NULL THEN
      PERFORM fin.refuse('ck_bank_account_change', format('bank account %s keeps its kind, number and GL account, and is deactivated, never removed', OLD.id));
    END IF;
    RETURN NEW;
  END IF;
  -- The control account of the kind (ADR-0003), set apart because PL/pgSQL ends an IF condition at its first THEN.
  expected := CASE NEW.kind WHEN 'BANK' THEN '1100' ELSE '1110' END;
  SELECT a.code, a.is_postable, a.status, a.deleted_at, a.subledger_kind INTO gl FROM fin.account a WHERE a.id = NEW.gl_account_id;
  IF NOT FOUND OR NOT gl.is_postable OR gl.status <> 'ACTIVE' OR gl.deleted_at IS NOT NULL OR gl.subledger_kind IS DISTINCT FROM 'BANK_ACCOUNT'
     OR gl.code <> expected THEN
    PERFORM fin.refuse('ck_bank_account_gl', format('bank account %s of kind %s posts to %s, its control account', NEW.id, NEW.kind, expected));
  END IF;
  IF NEW.deleted_at IS NOT NULL THEN
    PERFORM fin.refuse('ck_bank_account_change', format('bank account %s cannot be written archived', NEW.id));
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION fin.bank_account_guard() FROM PUBLIC;
CREATE TRIGGER trg_bank_account_guard BEFORE INSERT OR UPDATE ON fin.bank_account
  FOR EACH ROW EXECUTE FUNCTION fin.bank_account_guard();

-- Every account has its own subledger party from the transaction that adds it, so the ledger and a manual journal can
-- name it before anything has posted to it (A-194).
CREATE FUNCTION fin.bank_account_party_check() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM fin.subledger_party s WHERE s.kind = 'BANK_ACCOUNT' AND s.ref_id = NEW.id) THEN
    PERFORM fin.refuse('ck_bank_account_party', format('bank account %s has no BANK_ACCOUNT subledger party of its own', NEW.id));
  END IF;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION fin.bank_account_party_check() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER trg_bank_account_party AFTER INSERT ON fin.bank_account
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION fin.bank_account_party_check();

REVOKE ALL ON fin.bank_account FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON fin.bank_account TO hk_app, hk_worker;

-- migrate:down
DELETE FROM fin.subledger_party s USING fin.bank_account b WHERE s.kind = 'BANK_ACCOUNT' AND s.ref_id = b.id;
DROP TABLE fin.bank_account;
DROP FUNCTION fin.bank_account_party_check();
DROP FUNCTION fin.bank_account_guard();
