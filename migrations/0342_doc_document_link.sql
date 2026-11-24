-- 0342_doc_document_link
-- B11 continued 13 (ADR-0062, ADR-0074, ADR-0084, ADR-0099, A-288): a document sent by message (a billing document, a
-- customer's statement, a supplier's remittance advice) carries a link of its own, made by DOC for NTF's sending worker
-- just before the provider call, a fresh one at each attempt, never stored in clear.
--   doc.document_link (LEDGER)   the SHA-256 of a fresh `doc_` token (unique, uq_document_link_token) and the one
--                                archived rendering it opens (archived_document_id), with its expiry: more than nothing
--                                and at most thirty days after it was made (ck_document_link_expiry). The public read
--                                by the token alone (`getSharedDocument`) answers a signed link to exactly that
--                                rendering's archived bytes, whose SHA-256 never changes (doc.archived_document is
--                                insert-only); expired, another document's and unknown tokens are one 404.
-- Every time is written by the application from its clock (ADR-0067); nothing here reads now().
-- Data category: the token hash is DC-43 (Restricted, an authentication verifier); never the token.
-- Rollback: tested before the first document link; afterwards the rows are evidence and only a forward fix applies.

-- migrate:up
CREATE TABLE doc.document_link (
  id                    uuid PRIMARY KEY,
  archived_document_id  uuid NOT NULL CONSTRAINT fk_document_link_archived REFERENCES doc.archived_document (id) ON DELETE RESTRICT,
  token_hash            bytea NOT NULL CONSTRAINT ck_document_link_hash CHECK (octet_length(token_hash) = 32),
  expires_at            timestamptz NOT NULL,
  recorded_at           timestamptz NOT NULL,
  actor_id              uuid NOT NULL CONSTRAINT fk_document_link_actor REFERENCES iam.principal (id) ON DELETE RESTRICT,
  CONSTRAINT ck_document_link_expiry CHECK (expires_at > recorded_at AND expires_at <= recorded_at + interval '30 days')
);
COMMENT ON TABLE doc.document_link IS 'class=LEDGER';
CREATE UNIQUE INDEX uq_document_link_token ON doc.document_link (token_hash);
CREATE INDEX ix_document_link_archived ON doc.document_link (archived_document_id);
CREATE TRIGGER trg_document_link_immutable BEFORE UPDATE OR DELETE ON doc.document_link
  FOR EACH ROW EXECUTE FUNCTION platform.reject_change();
CREATE TRIGGER trg_document_link_no_truncate BEFORE TRUNCATE ON doc.document_link
  FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_change();

REVOKE ALL ON doc.document_link FROM PUBLIC;
GRANT SELECT, INSERT ON doc.document_link TO hk_app, hk_worker;

-- migrate:down
DROP TABLE doc.document_link;
