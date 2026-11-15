-- 0014_mdm_create_tax
-- The tax sub-domain (docs/data-model/mdm.md "Tax", ADR-0020, ADR-0039): named levies (VAT, NHIL and GETFund
-- seeded), effective-dated scheme versions with maker-checker activation, the matrix cells of a version (one per
-- category and levy) and the levies a compounding cell adds to its base. The tax categories exist since 0009.
-- What the database refuses: a rate on a cell that is not STANDARD; two cells of one category with the same
-- calculation order; a base levy from another version or category, or calculated at or after the levy it feeds
-- (so no definition is circular); any change to a cell once its version leaves DRAFT; a version submitted or
-- activated without a cell for every live category and levy; two ACTIVE versions whose dates overlap; a late
-- approval moving a version's first day earlier.
-- No scheme version is seeded here: the rates are business data, entered by the accountant and approved by the owner
-- (the seeded farm does this through the service, A-085).
-- Data category: INTERNAL.
-- Rollback: tested (`pnpm db:rollback`) while no version has been used to tax a line; afterwards forward fix only.

-- migrate:up
CREATE TABLE mdm.tax_levy (
  id            uuid PRIMARY KEY,
  code          text NOT NULL CONSTRAINT ck_tax_levy_code CHECK (code ~ '^[A-Z][A-Z0-9_]{1,19}$'),
  name          text NOT NULL CONSTRAINT ck_tax_levy_name CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  sort_order    integer NOT NULL DEFAULT 0,
  version       integer NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid NOT NULL CONSTRAINT fk_tax_levy_created_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    uuid NOT NULL CONSTRAINT fk_tax_levy_updated_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  deleted_at    timestamptz NULL,
  deleted_by    uuid NULL CONSTRAINT fk_tax_levy_deleted_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  delete_reason text NULL,
  CONSTRAINT ck_tax_levy_soft_delete CHECK ((deleted_at IS NULL) = (deleted_by IS NULL) AND (deleted_at IS NULL) = (delete_reason IS NULL))
);
COMMENT ON TABLE mdm.tax_levy IS 'class=MASTER';
CREATE UNIQUE INDEX uq_tax_levy_code ON mdm.tax_levy (code) WHERE deleted_at IS NULL;
CREATE TRIGGER trg_tax_levy_version BEFORE UPDATE ON mdm.tax_levy
  FOR EACH ROW EXECUTE FUNCTION platform.touch_version();
-- The levy names as the Ghana Revenue Authority prints them (docs/security/COMPLIANCE.md, checked 2026-11-13).
INSERT INTO mdm.tax_levy (id, code, name, sort_order, created_by, updated_by) VALUES
  ('01900000-0000-7000-8000-000000000501', 'VAT', 'Value Added Tax', 1, '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001'),
  ('01900000-0000-7000-8000-000000000502', 'NHIL', 'National Health Insurance Levy', 2, '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001'),
  ('01900000-0000-7000-8000-000000000503', 'GETFUND', 'GETFund Levy', 3, '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001');

CREATE TABLE mdm.tax_scheme_version (
  id                  uuid PRIMARY KEY CONSTRAINT fk_tax_scheme_version_document REFERENCES platform.business_document (id) ON DELETE RESTRICT,
  version_no          integer NOT NULL CONSTRAINT uq_tax_scheme_version_no UNIQUE CONSTRAINT ck_tax_scheme_version_no CHECK (version_no > 0),
  status              text NOT NULL CONSTRAINT ck_tax_scheme_version_status CHECK (status IN ('DRAFT', 'PENDING_APPROVAL', 'ACTIVE', 'SUPERSEDED', 'REJECTED')),
  valid_from          date NOT NULL,
  valid_to            date NULL,
  source_note         text NOT NULL CONSTRAINT ck_tax_scheme_version_source_note CHECK (length(btrim(source_note)) BETWEEN 1 AND 1000),
  approval_request_id uuid NULL CONSTRAINT fk_tax_scheme_version_approval REFERENCES iam.approval_request (id) ON DELETE RESTRICT,
  activated_at        timestamptz NULL,
  activated_by        uuid NULL CONSTRAINT fk_tax_scheme_version_activated_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  branch_id           uuid NOT NULL CONSTRAINT fk_tax_scheme_version_branch REFERENCES mdm.branch (id) ON DELETE RESTRICT,
  version             integer NOT NULL DEFAULT 1,
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid NOT NULL CONSTRAINT fk_tax_scheme_version_created_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  updated_by          uuid NOT NULL CONSTRAINT fk_tax_scheme_version_updated_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  CONSTRAINT ck_tax_scheme_version_window CHECK (valid_to IS NULL OR valid_to > valid_from),
  CONSTRAINT ck_tax_scheme_version_approved CHECK (status NOT IN ('PENDING_APPROVAL', 'ACTIVE', 'SUPERSEDED') OR approval_request_id IS NOT NULL),
  CONSTRAINT ck_tax_scheme_version_activation CHECK ((status IN ('ACTIVE', 'SUPERSEDED')) = (activated_at IS NOT NULL AND activated_by IS NOT NULL)),
  -- One matrix in force on any tax date. Half-open: valid_to is the first day the version no longer applies.
  CONSTRAINT ex_tax_scheme_version_no_overlap EXCLUDE USING gist (daterange(valid_from, valid_to, '[)') WITH &&) WHERE (status = 'ACTIVE')
);
COMMENT ON TABLE mdm.tax_scheme_version IS 'class=DOCUMENT';
CREATE INDEX ix_tax_scheme_version_active ON mdm.tax_scheme_version (valid_from) WHERE status = 'ACTIVE';
-- One open version at a time: the matrix is one thing, and two drafts of it would race each other (ADR-0039).
CREATE UNIQUE INDEX uq_tax_scheme_version_open ON mdm.tax_scheme_version ((true)) WHERE status IN ('DRAFT', 'PENDING_APPROVAL');
CREATE TRIGGER trg_tax_scheme_version_version BEFORE UPDATE ON mdm.tax_scheme_version
  FOR EACH ROW EXECUTE FUNCTION platform.touch_version();

-- The version lifecycle, as for price list versions (ADR-0036, ADR-0039): DRAFT -> PENDING_APPROVAL -> ACTIVE or
-- REJECTED; ACTIVE -> SUPERSEDED. Once submitted only the lifecycle columns move; once ACTIVE only status (to
-- SUPERSEDED) and an earlier valid_to may change. Activation may move valid_from later, to the day of approval,
-- never earlier. SQLSTATE HK004.
CREATE FUNCTION mdm.tax_scheme_version_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  lifecycle text[] := ARRAY['status', 'approval_request_id', 'activated_at', 'activated_by', 'valid_from', 'valid_to', 'version', 'updated_at', 'updated_by'];
BEGIN
  IF OLD.status = 'DRAFT' AND NEW.status IN ('DRAFT', 'PENDING_APPROVAL') THEN
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - lifecycle) IS DISTINCT FROM (to_jsonb(OLD) - lifecycle)
     OR NOT ((OLD.status = 'PENDING_APPROVAL' AND NEW.status IN ('ACTIVE', 'REJECTED'))
          OR (OLD.status = 'ACTIVE' AND NEW.status IN ('ACTIVE', 'SUPERSEDED')))
     OR (NEW.valid_from IS DISTINCT FROM OLD.valid_from
         AND NOT (OLD.status = 'PENDING_APPROVAL' AND NEW.status = 'ACTIVE' AND NEW.valid_from > OLD.valid_from))
     OR (NEW.valid_to IS DISTINCT FROM OLD.valid_to
         AND (OLD.status <> 'ACTIVE' OR NEW.valid_to IS NULL OR (OLD.valid_to IS NOT NULL AND NEW.valid_to > OLD.valid_to)))
     OR (OLD.status = 'ACTIVE' AND (NEW.approval_request_id, NEW.activated_at, NEW.activated_by)
                                   IS DISTINCT FROM (OLD.approval_request_id, OLD.activated_at, OLD.activated_by)) THEN
    RAISE EXCEPTION 'mdm.tax_scheme_version % is frozen in status %; it cannot become % with these values', OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'HK004';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION mdm.tax_scheme_version_guard() FROM PUBLIC;
CREATE TRIGGER trg_tax_scheme_version_guard BEFORE UPDATE ON mdm.tax_scheme_version
  FOR EACH ROW EXECUTE FUNCTION mdm.tax_scheme_version_guard();

CREATE TABLE mdm.tax_category_levy (
  id              uuid PRIMARY KEY,
  version_id      uuid NOT NULL CONSTRAINT fk_tax_category_levy_version REFERENCES mdm.tax_scheme_version (id) ON DELETE RESTRICT,
  tax_category_id uuid NOT NULL CONSTRAINT fk_tax_category_levy_category REFERENCES mdm.tax_category (id) ON DELETE RESTRICT,
  levy_id         uuid NOT NULL CONSTRAINT fk_tax_category_levy_levy REFERENCES mdm.tax_levy (id) ON DELETE RESTRICT,
  treatment       text NOT NULL CONSTRAINT ck_tax_category_levy_treatment CHECK (treatment IN ('STANDARD', 'ZERO_RATED', 'EXEMPT', 'OUT_OF_SCOPE')),
  rate_percent    platform.percent NOT NULL,
  base_kind       text NOT NULL CONSTRAINT ck_tax_category_levy_base_kind CHECK (base_kind IN ('NET', 'NET_PLUS_LEVIES')),
  is_reclaimable  boolean NOT NULL,
  calc_order      integer NOT NULL CONSTRAINT ck_tax_category_levy_calc_order CHECK (calc_order > 0),
  version         integer NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid NOT NULL CONSTRAINT fk_tax_category_levy_created_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      uuid NOT NULL CONSTRAINT fk_tax_category_levy_updated_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  -- Zero where the levy does not apply; a rate only on a STANDARD cell (FR-MDM-012).
  CONSTRAINT ck_tax_category_levy_rate CHECK (treatment = 'STANDARD' OR rate_percent = 0),
  CONSTRAINT uq_tax_category_levy_cell UNIQUE (version_id, tax_category_id, levy_id),
  -- The tie-break order of the inclusive split: two levies of one category never share it.
  CONSTRAINT uq_tax_category_levy_calc_order UNIQUE (version_id, tax_category_id, calc_order)
);
COMMENT ON TABLE mdm.tax_category_levy IS 'class=MASTER';
CREATE TRIGGER trg_tax_category_levy_version BEFORE UPDATE ON mdm.tax_category_levy
  FOR EACH ROW EXECUTE FUNCTION platform.touch_version();

CREATE TABLE mdm.tax_levy_base_component (
  tax_category_levy_id      uuid NOT NULL CONSTRAINT fk_tax_levy_base_component_cell REFERENCES mdm.tax_category_levy (id) ON DELETE RESTRICT,
  included_category_levy_id uuid NOT NULL CONSTRAINT fk_tax_levy_base_component_included REFERENCES mdm.tax_category_levy (id) ON DELETE RESTRICT,
  created_at                timestamptz NOT NULL DEFAULT now(),
  created_by                uuid NOT NULL CONSTRAINT fk_tax_levy_base_component_created_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  CONSTRAINT pk_tax_levy_base_component PRIMARY KEY (tax_category_levy_id, included_category_levy_id)
);
COMMENT ON TABLE mdm.tax_levy_base_component IS 'class=MASTER';

-- Cells and their base components change only while the version is a DRAFT. SQLSTATE HK004.
CREATE FUNCTION mdm.tax_cell_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  cell_id        uuid;
  version_status text;
BEGIN
  IF TG_TABLE_NAME = 'tax_category_levy' THEN
    SELECT v.status INTO version_status FROM mdm.tax_scheme_version v
     WHERE v.id = CASE WHEN TG_OP = 'DELETE' THEN OLD.version_id ELSE NEW.version_id END;
    IF TG_OP = 'UPDATE' AND NEW.version_id <> OLD.version_id THEN
      version_status := 'MOVED';
    END IF;
  ELSE
    cell_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.tax_category_levy_id ELSE NEW.tax_category_levy_id END;
    SELECT v.status INTO version_status FROM mdm.tax_category_levy c JOIN mdm.tax_scheme_version v ON v.id = c.version_id WHERE c.id = cell_id;
  END IF;
  IF version_status IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION 'tax cells are frozen once their version leaves DRAFT (version is %)', version_status
      USING ERRCODE = 'HK004';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;
REVOKE ALL ON FUNCTION mdm.tax_cell_guard() FROM PUBLIC;
CREATE TRIGGER trg_tax_category_levy_guard BEFORE INSERT OR UPDATE OR DELETE ON mdm.tax_category_levy
  FOR EACH ROW EXECUTE FUNCTION mdm.tax_cell_guard();
CREATE TRIGGER trg_tax_levy_base_component_guard BEFORE INSERT OR UPDATE OR DELETE ON mdm.tax_levy_base_component
  FOR EACH ROW EXECUTE FUNCTION mdm.tax_cell_guard();

-- A base component is a levy of the same version and category, calculated earlier, added to a NET_PLUS_LEVIES cell.
-- The order rule is what makes a circular definition impossible (ADR-0020). SQLSTATE 23514, as a CHECK would raise.
CREATE FUNCTION mdm.tax_levy_base_component_rule() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM mdm.tax_category_levy owner_cell
      JOIN mdm.tax_category_levy included ON included.id = NEW.included_category_levy_id
     WHERE owner_cell.id = NEW.tax_category_levy_id
       AND owner_cell.base_kind = 'NET_PLUS_LEVIES'
       AND included.version_id = owner_cell.version_id
       AND included.tax_category_id = owner_cell.tax_category_id
       AND included.calc_order < owner_cell.calc_order) THEN
    RAISE EXCEPTION 'base component % of cell % is not an earlier levy of the same category and version', NEW.included_category_levy_id, NEW.tax_category_levy_id
      USING ERRCODE = '23514', CONSTRAINT = 'ck_tax_levy_base_component_rule';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION mdm.tax_levy_base_component_rule() FROM PUBLIC;
CREATE TRIGGER trg_tax_levy_base_component_rule BEFORE INSERT OR UPDATE ON mdm.tax_levy_base_component
  FOR EACH ROW EXECUTE FUNCTION mdm.tax_levy_base_component_rule();

-- A version leaves DRAFT only with a cell for every live category and levy: missing never means zero (ADR-0020).
-- Checked at commit, so the cells and the status change can land in one transaction in any order. SQLSTATE 23514.
CREATE FUNCTION mdm.tax_scheme_version_complete() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  missing integer;
BEGIN
  SELECT count(*) INTO missing
    FROM mdm.tax_category c
   CROSS JOIN mdm.tax_levy l
   WHERE c.deleted_at IS NULL AND l.deleted_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM mdm.tax_category_levy cell
                      WHERE cell.version_id = NEW.id AND cell.tax_category_id = c.id AND cell.levy_id = l.id);
  IF missing > 0 THEN
    RAISE EXCEPTION 'tax scheme version % lacks % category and levy cells', NEW.id, missing
      USING ERRCODE = '23514', CONSTRAINT = 'ck_tax_scheme_version_complete';
  END IF;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION mdm.tax_scheme_version_complete() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER trg_tax_scheme_version_complete AFTER UPDATE OF status ON mdm.tax_scheme_version
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.status IN ('PENDING_APPROVAL', 'ACTIVE') AND OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION mdm.tax_scheme_version_complete();

-- replaceTaxSchemeCells replaces a draft's matrix outright. hk_app holds no DELETE on a MASTER table (ADR-0024), so
-- the removal is this one function, owned by hk_owner, which can only empty a DRAFT (the guard refuses the rest).
CREATE FUNCTION mdm.clear_draft_tax_cells(p_version_id uuid) RETURNS integer
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
DECLARE
  removed integer;
BEGIN
  DELETE FROM mdm.tax_levy_base_component b USING mdm.tax_category_levy c
   WHERE b.tax_category_levy_id = c.id AND c.version_id = p_version_id;
  DELETE FROM mdm.tax_category_levy WHERE version_id = p_version_id;
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END
$$;
REVOKE ALL ON FUNCTION mdm.clear_draft_tax_cells(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mdm.clear_draft_tax_cells(uuid) TO hk_app, hk_worker;

REVOKE ALL ON mdm.tax_levy, mdm.tax_scheme_version, mdm.tax_category_levy, mdm.tax_levy_base_component FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON mdm.tax_levy, mdm.tax_scheme_version, mdm.tax_category_levy, mdm.tax_levy_base_component TO hk_app, hk_worker;

-- migrate:down
DROP FUNCTION mdm.clear_draft_tax_cells(uuid);
DROP TABLE mdm.tax_levy_base_component;
DROP TABLE mdm.tax_category_levy;
DROP FUNCTION mdm.tax_levy_base_component_rule();
DROP FUNCTION mdm.tax_cell_guard();
DROP TABLE mdm.tax_scheme_version;
DROP FUNCTION mdm.tax_scheme_version_complete();
DROP FUNCTION mdm.tax_scheme_version_guard();
DROP TABLE mdm.tax_levy;
