-- 0236_platform_document_entry_state
-- B09b continued (ADR-0077 Amendments, the parent session for the owner, 2026-11-17): a published fact a lower module's
-- constraint may read about a document that takes entries, without reading the owning module's tables (ADR-0008). For
-- a document registered in platform.business_document: whether it accepts entries now, whose it is (the principal who
-- holds it) and what it is part of (its container). The owning module keeps it in step through its own SECURITY
-- DEFINER trigger; the setter is executable by the owner role only, so application code cannot write it. Once a
-- document stops accepting entries it never accepts them again, and its holder and container never change. The first
-- user is POS's till shift (OPEN, its cashier, its register), which PAY's till cash constraints read (migration 0239).
-- Data category: internal (a document's state).
-- Rollback: tested (`pnpm db:rollback`), after 0238 and 0239 are rolled back.

-- migrate:up
CREATE TABLE platform.document_entry_state (
  document_id     uuid PRIMARY KEY CONSTRAINT fk_document_entry_state_document REFERENCES platform.business_document (id) ON DELETE RESTRICT,
  accepts_entries boolean NOT NULL,
  holder_id       uuid NOT NULL,
  container_id    uuid NOT NULL,
  changed_at      timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE platform.document_entry_state IS 'class=PROJECTION';

CREATE FUNCTION platform.set_document_entry_state(p_document_id uuid, p_accepts boolean, p_holder uuid, p_container uuid) RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
DECLARE
  current record;
BEGIN
  SELECT s.accepts_entries, s.holder_id, s.container_id INTO current FROM platform.document_entry_state s WHERE s.document_id = p_document_id FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO platform.document_entry_state (document_id, accepts_entries, holder_id, container_id) VALUES (p_document_id, p_accepts, p_holder, p_container);
    RETURN;
  END IF;
  IF (current.holder_id, current.container_id) IS DISTINCT FROM (p_holder, p_container) THEN
    RAISE EXCEPTION 'platform.document_entry_state %: its holder and container never change', p_document_id USING ERRCODE = 'HK004';
  END IF;
  IF p_accepts AND NOT current.accepts_entries THEN
    RAISE EXCEPTION 'platform.document_entry_state %: a document that stopped taking entries never takes them again', p_document_id USING ERRCODE = 'HK004';
  END IF;
  IF current.accepts_entries IS DISTINCT FROM p_accepts THEN
    UPDATE platform.document_entry_state SET accepts_entries = p_accepts, changed_at = now() WHERE document_id = p_document_id;
  END IF;
END
$$;
REVOKE ALL ON FUNCTION platform.set_document_entry_state(uuid, boolean, uuid, uuid) FROM PUBLIC;

CREATE FUNCTION platform.document_entry_state(p_document_id uuid)
  RETURNS TABLE (doc_type text, branch_id uuid, accepts_entries boolean, holder_id uuid, container_id uuid)
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
  SELECT d.doc_type, d.branch_id, s.accepts_entries, s.holder_id, s.container_id
    FROM platform.business_document d JOIN platform.document_entry_state s ON s.document_id = d.id
   WHERE d.id = p_document_id
$$;
REVOKE ALL ON FUNCTION platform.document_entry_state(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.document_entry_state(uuid) TO hk_app, hk_worker, hk_report;

REVOKE ALL ON platform.document_entry_state FROM PUBLIC;
GRANT SELECT ON platform.document_entry_state TO hk_app, hk_worker, hk_report;

-- migrate:down
DROP FUNCTION platform.document_entry_state(uuid);
DROP FUNCTION platform.set_document_entry_state(uuid, boolean, uuid, uuid);
DROP TABLE platform.document_entry_state;
