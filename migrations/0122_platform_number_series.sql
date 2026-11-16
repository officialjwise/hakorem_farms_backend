-- 0122_platform_number_series
-- Gap-free document numbers (ADR-0015, docs/data-model/platform.md): `platform.number_series`, one row-locked counter
-- per document type, fiscal year, branch and sub-scope, and `platform.number_allocation`, the insert-only evidence that
-- each issued number belongs to exactly one document. Numbers are allocated only by `platform.allocate_number`, inside
-- the caller's transaction, so a rollback returns the number and the series stays contiguous. The journal is the first
-- numbered document type (B8): `JOURNAL`, prefix `JNL`, owned by FIN.
-- A refusal is SQLSTATE HK011 with the rule as its constraint name:
--   ck_number_allocation_writer   a number allocated other than by platform.allocate_number
--   ck_number_series_unknown      allocate_number named a series that does not exist
-- The series is opened by `platform.open_number_series`, which takes its prefix from the document type and its branch
-- code from the caller (platform does not read a module's tables); the first call for a year writes it.
-- Data category: INTERNAL (DC-13): document numbers; no personal data.
-- Rollback: tested (`pnpm db:rollback`), safe before the first allocation; afterwards forward fix only.

-- migrate:up
CREATE TABLE platform.number_series (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  doc_type    text NOT NULL CONSTRAINT fk_number_series_doc_type REFERENCES platform.document_type (code) ON DELETE RESTRICT,
  fiscal_year integer NOT NULL CONSTRAINT ck_number_series_year CHECK (fiscal_year BETWEEN 2020 AND 2100),
  branch_id   uuid NOT NULL CONSTRAINT fk_number_series_branch REFERENCES mdm.branch (id) ON DELETE RESTRICT,
  branch_code text NOT NULL CONSTRAINT ck_number_series_branch_code CHECK (branch_code ~ '^[A-Z0-9]{2,10}$'),
  sub_scope   text NOT NULL DEFAULT '' CONSTRAINT ck_number_series_sub_scope CHECK (sub_scope ~ '^([A-Z0-9]{1,10})?$'),
  prefix      text NOT NULL CONSTRAINT ck_number_series_prefix CHECK (prefix ~ '^[A-Z]{1,8}$'),
  padding     integer NOT NULL DEFAULT 6 CONSTRAINT ck_number_series_padding CHECK (padding BETWEEN 4 AND 10),
  next_value  bigint NOT NULL DEFAULT 1 CONSTRAINT ck_number_series_next CHECK (next_value > 0),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_number_series_scope UNIQUE (doc_type, fiscal_year, branch_id, sub_scope)
);
COMMENT ON TABLE platform.number_series IS 'class=PROJECTION';

CREATE TABLE platform.number_allocation (
  series_id    uuid NOT NULL CONSTRAINT fk_number_allocation_series REFERENCES platform.number_series (id) ON DELETE RESTRICT,
  value        bigint NOT NULL CONSTRAINT ck_number_allocation_value CHECK (value > 0),
  document_id  uuid NOT NULL CONSTRAINT fk_number_allocation_document REFERENCES platform.business_document (id) ON DELETE RESTRICT,
  formatted    text NOT NULL CONSTRAINT uq_number_allocation_formatted UNIQUE,
  allocated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_number_allocation PRIMARY KEY (series_id, value),
  CONSTRAINT uq_number_allocation_document UNIQUE (series_id, document_id)
);
COMMENT ON TABLE platform.number_allocation IS 'class=LEDGER';
CREATE TRIGGER trg_number_allocation_immutable BEFORE UPDATE OR DELETE ON platform.number_allocation
  FOR EACH ROW EXECUTE FUNCTION platform.reject_change();
CREATE TRIGGER trg_number_allocation_no_truncate BEFORE TRUNCATE ON platform.number_allocation
  FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_change();

-- Only allocate_number (SECURITY DEFINER, owned by hk_owner) writes an allocation, so no number exists without its
-- series having moved past it.
CREATE FUNCTION platform.number_allocation_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF current_user <> 'hk_owner' THEN
    RAISE EXCEPTION 'number % of series % was not allocated by platform.allocate_number', NEW.value, NEW.series_id
      USING ERRCODE = 'HK011', CONSTRAINT = 'ck_number_allocation_writer';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION platform.number_allocation_guard() FROM PUBLIC;
CREATE TRIGGER trg_number_allocation_guard BEFORE INSERT ON platform.number_allocation
  FOR EACH ROW EXECUTE FUNCTION platform.number_allocation_guard();

-- The series for one document type, year, branch and sub-scope, written on first use with the type's prefix.
CREATE FUNCTION platform.open_number_series(p_doc_type text, p_fiscal_year integer, p_branch_id uuid, p_branch_code text, p_sub_scope text)
  RETURNS uuid
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
DECLARE
  series uuid;
  type_prefix text;
BEGIN
  SELECT s.id INTO series FROM platform.number_series s
   WHERE s.doc_type = p_doc_type AND s.fiscal_year = p_fiscal_year AND s.branch_id = p_branch_id AND s.sub_scope = p_sub_scope;
  IF FOUND THEN
    RETURN series;
  END IF;
  SELECT t.series_prefix INTO type_prefix FROM platform.document_type t WHERE t.code = p_doc_type AND t.is_numbered;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'document type % is not numbered', p_doc_type USING ERRCODE = 'HK011', CONSTRAINT = 'ck_number_series_unknown';
  END IF;
  INSERT INTO platform.number_series (doc_type, fiscal_year, branch_id, branch_code, sub_scope, prefix)
  VALUES (p_doc_type, p_fiscal_year, p_branch_id, p_branch_code, p_sub_scope, type_prefix)
  ON CONFLICT ON CONSTRAINT uq_number_series_scope DO NOTHING;
  SELECT s.id INTO STRICT series FROM platform.number_series s
   WHERE s.doc_type = p_doc_type AND s.fiscal_year = p_fiscal_year AND s.branch_id = p_branch_id AND s.sub_scope = p_sub_scope;
  RETURN series;
END
$$;
REVOKE ALL ON FUNCTION platform.open_number_series(text, integer, uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.open_number_series(text, integer, uuid, text, text) TO hk_app, hk_worker;

-- ADR-0015: the series row is locked by the update, the number is the value it held, and the allocation row is
-- written in the same transaction. A rollback undoes both, so the next caller takes the same number.
-- Format: <PREFIX>-<YEAR>-<BRANCH>[-<SUB SCOPE>]-<SEQUENCE>, the sequence zero-padded and never truncated.
CREATE FUNCTION platform.allocate_number(p_series_id uuid, p_document_id uuid) RETURNS text
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
DECLARE
  s record;
  issued bigint;
  sequence_text text;
  number_text text;
BEGIN
  UPDATE platform.number_series SET next_value = next_value + 1 WHERE id = p_series_id
  RETURNING next_value - 1 AS issued, prefix, fiscal_year, branch_code, sub_scope, padding INTO s;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'number series % does not exist', p_series_id USING ERRCODE = 'HK011', CONSTRAINT = 'ck_number_series_unknown';
  END IF;
  issued := s.issued;
  sequence_text := CASE WHEN length(issued::text) >= s.padding THEN issued::text ELSE lpad(issued::text, s.padding, '0') END;
  number_text := s.prefix || '-' || s.fiscal_year::text || '-' || s.branch_code
                 || CASE WHEN s.sub_scope = '' THEN '' ELSE '-' || s.sub_scope END || '-' || sequence_text;
  INSERT INTO platform.number_allocation (series_id, value, document_id, formatted) VALUES (p_series_id, issued, p_document_id, number_text);
  RETURN number_text;
END
$$;
REVOKE ALL ON FUNCTION platform.allocate_number(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.allocate_number(uuid, uuid) TO hk_app, hk_worker;

REVOKE ALL ON platform.number_series, platform.number_allocation FROM PUBLIC;
GRANT SELECT ON platform.number_series TO hk_app, hk_worker;
GRANT SELECT, INSERT ON platform.number_allocation TO hk_app, hk_worker;

INSERT INTO platform.document_type (code, owner_module, name, is_numbered, series_prefix) VALUES
  ('JOURNAL', 'fin', 'Journal entry', true, 'JNL');

-- migrate:down
DELETE FROM platform.document_type WHERE code = 'JOURNAL';
DROP FUNCTION platform.allocate_number(uuid, uuid);
DROP FUNCTION platform.open_number_series(text, integer, uuid, text, text);
DROP TRIGGER trg_number_allocation_guard ON platform.number_allocation;
DROP FUNCTION platform.number_allocation_guard();
DROP TABLE platform.number_allocation;
DROP TABLE platform.number_series;
