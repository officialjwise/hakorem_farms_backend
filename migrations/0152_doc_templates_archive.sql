-- 0152_doc_templates_archive
-- B08 continued 2b (FR-DOC-001 to FR-DOC-004, FR-BIL-008, FR-BIL-010, ADR-0010, ADR-0012, ADR-0061): schema `doc`.
--   doc.template          MASTER    one branded template per document type and output, editable without a deployment
--   doc.template_version  DOCUMENT  its versions: a body is never edited; a version is DRAFT, then ACTIVE once, then
--                                   RETIRED; at most one ACTIVE version per template
--   doc.archived_document LEDGER    the immutable archive: the stored bytes of every rendered document with their
--                                   SHA-256, the template versions and the exact data rendered; one row per document
--                                   and revision, and a billing document has exactly one revision
--   doc.render_job        WORK      a render requested through the outbox, rendered once per requesting message
-- The database holds (SQLSTATE HK004, the rule as the constraint name):
--   ck_template_version_frozen     a version's body, sample data, template and number never change; status moves only
--                                  DRAFT to ACTIVE (with who and when, once) and ACTIVE to RETIRED
--   ck_template_active_version     a template's active version is one of its own, and ACTIVE
--   ck_archived_document_revision  a billing document, statement, schedule or advice has exactly one revision
--   reject_change                  the archive refuses UPDATE, DELETE and TRUNCATE, for every role
-- Seeded: the built-in version 1 of each billing document's A4 template and the counter receipt's 80 mm thermal
-- template, written and activated by the SYSTEM principal; an administrator replaces them by drafting and activating
-- a new version (FR-DOC-004). Labels in a template are its own text, edited with it.
-- Data category: CONFIDENTIAL (DC-24): the archive's render data holds a customer's name, TIN and address as printed.
-- Rollback: tested (`pnpm db:rollback`), safe before the first archived document; afterwards forward fix only (the
-- archive is never removed).

-- migrate:up
CREATE SCHEMA doc AUTHORIZATION hk_owner;
REVOKE ALL ON SCHEMA doc FROM PUBLIC;
GRANT USAGE ON SCHEMA doc TO hk_app, hk_worker;

CREATE TABLE doc.template (
  id                uuid PRIMARY KEY,
  doc_type          text NOT NULL CONSTRAINT fk_template_doc_type REFERENCES platform.document_type (code) ON DELETE RESTRICT,
  output            text NOT NULL CONSTRAINT ck_template_output CHECK (output IN ('PDF_A4', 'THERMAL_80MM', 'THERMAL_58MM')),
  name              text NOT NULL CONSTRAINT ck_template_name CHECK (length(btrim(name)) BETWEEN 1 AND 100),
  active_version_id uuid NULL,
  version           integer NOT NULL DEFAULT 1,
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid NOT NULL CONSTRAINT fk_template_created_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  updated_by        uuid NOT NULL CONSTRAINT fk_template_updated_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  deleted_at        timestamptz NULL,
  deleted_by        uuid NULL CONSTRAINT fk_template_deleted_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  delete_reason     text NULL,
  CONSTRAINT ck_template_soft_delete CHECK ((deleted_at IS NULL) = (deleted_by IS NULL) AND (deleted_at IS NULL) = (delete_reason IS NULL))
);
COMMENT ON TABLE doc.template IS 'class=MASTER';
CREATE UNIQUE INDEX uq_template_type_output ON doc.template (doc_type, output) WHERE deleted_at IS NULL;
CREATE TRIGGER trg_template_version BEFORE UPDATE ON doc.template
  FOR EACH ROW EXECUTE FUNCTION platform.touch_version();

CREATE TABLE doc.template_version (
  id           uuid PRIMARY KEY,
  template_id  uuid NOT NULL CONSTRAINT fk_template_version_template REFERENCES doc.template (id) ON DELETE RESTRICT,
  version_no   integer NOT NULL CONSTRAINT ck_template_version_no CHECK (version_no > 0),
  body         text NOT NULL CONSTRAINT ck_template_version_body CHECK (octet_length(body) BETWEEN 1 AND 65536),
  sample_data  jsonb NULL,
  status       text NOT NULL CONSTRAINT ck_template_version_status CHECK (status IN ('DRAFT', 'ACTIVE', 'RETIRED')),
  activated_at timestamptz NULL,
  activated_by uuid NULL CONSTRAINT fk_template_version_activated_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  version      integer NOT NULL DEFAULT 1,
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid NOT NULL CONSTRAINT fk_template_version_created_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   uuid NOT NULL CONSTRAINT fk_template_version_updated_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  CONSTRAINT uq_template_version_no UNIQUE (template_id, version_no),
  CONSTRAINT ck_template_version_activated CHECK ((status = 'DRAFT') = (activated_at IS NULL) AND (activated_at IS NULL) = (activated_by IS NULL))
);
COMMENT ON TABLE doc.template_version IS 'class=DOCUMENT';
CREATE UNIQUE INDEX uq_template_version_active ON doc.template_version (template_id) WHERE status = 'ACTIVE';

ALTER TABLE doc.template ADD CONSTRAINT fk_template_active_version FOREIGN KEY (active_version_id) REFERENCES doc.template_version (id) ON DELETE RESTRICT;

CREATE FUNCTION doc.template_version_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'DRAFT' THEN
      RAISE EXCEPTION 'doc.template_version %: a version is drafted, then activated', NEW.id USING ERRCODE = 'HK004', CONSTRAINT = 'ck_template_version_frozen';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW.template_id, NEW.version_no, NEW.body, NEW.sample_data, NEW.created_at, NEW.created_by)
     IS DISTINCT FROM (OLD.id, OLD.template_id, OLD.version_no, OLD.body, OLD.sample_data, OLD.created_at, OLD.created_by)
     OR (OLD.status <> 'DRAFT' AND (NEW.activated_at, NEW.activated_by) IS DISTINCT FROM (OLD.activated_at, OLD.activated_by))
     OR NOT ((OLD.status = NEW.status) OR (OLD.status = 'DRAFT' AND NEW.status = 'ACTIVE') OR (OLD.status = 'ACTIVE' AND NEW.status = 'RETIRED')) THEN
    RAISE EXCEPTION 'doc.template_version %: a version never changes but DRAFT to ACTIVE to RETIRED', OLD.id USING ERRCODE = 'HK004', CONSTRAINT = 'ck_template_version_frozen';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION doc.template_version_guard() FROM PUBLIC;
CREATE TRIGGER trg_template_version_guard BEFORE INSERT OR UPDATE ON doc.template_version
  FOR EACH ROW EXECUTE FUNCTION doc.template_version_guard();
CREATE TRIGGER trg_template_version_version BEFORE UPDATE ON doc.template_version
  FOR EACH ROW EXECUTE FUNCTION platform.touch_version();

CREATE FUNCTION doc.template_active_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.active_version_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM doc.template_version v WHERE v.id = NEW.active_version_id AND v.template_id = NEW.id AND v.status = 'ACTIVE') THEN
    RAISE EXCEPTION 'doc.template %: the active version must be an ACTIVE version of this template', NEW.id USING ERRCODE = 'HK004', CONSTRAINT = 'ck_template_active_version';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION doc.template_active_guard() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER trg_template_active_guard AFTER INSERT OR UPDATE ON doc.template
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION doc.template_active_guard();

CREATE TABLE doc.archived_document (
  id                          uuid PRIMARY KEY,
  business_document_id        uuid NOT NULL CONSTRAINT fk_archived_document_business_document REFERENCES platform.business_document (id) ON DELETE RESTRICT,
  doc_type                    text NOT NULL CONSTRAINT fk_archived_document_doc_type REFERENCES platform.document_type (code) ON DELETE RESTRICT,
  document_no                 text NULL CONSTRAINT ck_archived_document_no CHECK (document_no IS NULL OR length(document_no) BETWEEN 1 AND 60),
  branch_id                   uuid NOT NULL CONSTRAINT fk_archived_document_branch REFERENCES mdm.branch (id) ON DELETE RESTRICT,
  template_version_id         uuid NOT NULL CONSTRAINT fk_archived_document_template_version REFERENCES doc.template_version (id) ON DELETE RESTRICT,
  file_id                     uuid NOT NULL CONSTRAINT fk_archived_document_file REFERENCES platform.stored_file (id) ON DELETE RESTRICT,
  sha256                      bytea NOT NULL CONSTRAINT ck_archived_document_sha256 CHECK (octet_length(sha256) = 32),
  thermal_template_version_id uuid NULL CONSTRAINT fk_archived_document_thermal_version REFERENCES doc.template_version (id) ON DELETE RESTRICT,
  thermal_file_id             uuid NULL CONSTRAINT fk_archived_document_thermal_file REFERENCES platform.stored_file (id) ON DELETE RESTRICT,
  thermal_sha256              bytea NULL CONSTRAINT ck_archived_document_thermal_sha256 CHECK (octet_length(thermal_sha256) = 32),
  render_data                 jsonb NOT NULL,
  revision                    integer NOT NULL DEFAULT 1 CONSTRAINT ck_archived_document_revision_positive CHECK (revision > 0),
  recorded_at                 timestamptz NOT NULL DEFAULT now(),
  actor_id                    uuid NOT NULL CONSTRAINT fk_archived_document_actor REFERENCES iam.principal (id) ON DELETE RESTRICT,
  CONSTRAINT uq_archived_document_revision UNIQUE (business_document_id, revision),
  CONSTRAINT ck_archived_document_thermal CHECK ((thermal_file_id IS NULL) = (thermal_sha256 IS NULL) AND (thermal_file_id IS NULL) = (thermal_template_version_id IS NULL)),
  CONSTRAINT ck_archived_document_revision CHECK (revision = 1 OR doc_type IN ('QUOTE', 'DELIVERY_NOTE'))
);
COMMENT ON TABLE doc.archived_document IS 'class=LEDGER';
CREATE INDEX ix_archived_document_branch ON doc.archived_document (branch_id, recorded_at, id);
CREATE INDEX ix_archived_document_number ON doc.archived_document (document_no);
CREATE TRIGGER trg_archived_document_immutable BEFORE UPDATE OR DELETE ON doc.archived_document
  FOR EACH ROW EXECUTE FUNCTION platform.reject_change();
CREATE TRIGGER trg_archived_document_no_truncate BEFORE TRUNCATE ON doc.archived_document
  FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_change();

CREATE TABLE doc.render_job (
  id                          uuid PRIMARY KEY,
  business_document_id        uuid NOT NULL CONSTRAINT fk_render_job_business_document REFERENCES platform.business_document (id) ON DELETE RESTRICT,
  source_event_ref            uuid NOT NULL CONSTRAINT uq_render_job_source UNIQUE,
  template_version_id         uuid NOT NULL CONSTRAINT fk_render_job_template_version REFERENCES doc.template_version (id) ON DELETE RESTRICT,
  thermal_template_version_id uuid NULL CONSTRAINT fk_render_job_thermal_version REFERENCES doc.template_version (id) ON DELETE RESTRICT,
  render_data                 jsonb NOT NULL,
  status                      text NOT NULL DEFAULT 'QUEUED' CONSTRAINT ck_render_job_status CHECK (status IN ('QUEUED', 'RENDERING', 'DONE', 'FAILED')),
  attempts                    integer NOT NULL DEFAULT 0 CONSTRAINT ck_render_job_attempts CHECK (attempts >= 0),
  last_error                  text NULL CONSTRAINT ck_render_job_error CHECK (last_error IS NULL OR length(last_error) <= 500),
  archived_document_id        uuid NULL CONSTRAINT fk_render_job_archived_document REFERENCES doc.archived_document (id) ON DELETE RESTRICT,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_render_job_done CHECK ((status = 'DONE') = (archived_document_id IS NOT NULL))
);
COMMENT ON TABLE doc.render_job IS 'class=WORK';
CREATE INDEX ix_render_job_document ON doc.render_job (business_document_id);

-- Published (ADR-0047): the archived rendering of a document with this SHA-256, for BIL's migration 0155 to relink a
-- document to its archive by its content hash when it is applied again after a rollback. Read only, by primary key.
CREATE FUNCTION doc.archived_rendering(p_business_document_id uuid, p_sha256 bytea) RETURNS uuid
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
  SELECT a.id FROM doc.archived_document a WHERE a.business_document_id = p_business_document_id AND a.revision = 1 AND a.sha256 = p_sha256
$$;
REVOKE ALL ON FUNCTION doc.archived_rendering(uuid, bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION doc.archived_rendering(uuid, bytea) TO hk_app, hk_worker;

REVOKE ALL ON doc.template, doc.template_version, doc.archived_document, doc.render_job FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON doc.template, doc.template_version TO hk_app, hk_worker;
GRANT SELECT, INSERT ON doc.archived_document TO hk_app, hk_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON doc.render_job TO hk_app, hk_worker;

-- The built-in templates, version 1 of each, written and activated by the SYSTEM principal.
INSERT INTO doc.template (id, doc_type, output, name, created_by, updated_by) VALUES
  ('01900000-0000-7000-8000-000000000501', 'INVOICE', 'PDF_A4', 'Invoice', '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001'),
  ('01900000-0000-7000-8000-000000000502', 'RECEIPT', 'PDF_A4', 'Receipt, A4', '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001'),
  ('01900000-0000-7000-8000-000000000503', 'PROFORMA', 'PDF_A4', 'Proforma invoice', '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001'),
  ('01900000-0000-7000-8000-000000000504', 'CREDIT_NOTE', 'PDF_A4', 'Credit note', '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001'),
  ('01900000-0000-7000-8000-000000000505', 'DEBIT_NOTE', 'PDF_A4', 'Debit note', '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001'),
  ('01900000-0000-7000-8000-000000000506', 'RECEIPT', 'THERMAL_80MM', 'Counter receipt', '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001');

WITH body (a4, thermal) AS (VALUES (
  '<header><h1>HaKorem Farms</h1><p>{{branch.name}}</p></header>'
  || '<h2>{{title}} {{documentNo}}</h2>'
  || '<row><cell>Issued</cell><cell>{{issueDate}}</cell></row>'
  || '{{#if dueDate}}<row><cell>Due</cell><cell>{{dueDate}}</cell></row>{{/if}}'
  || '{{#if provisionalRef}}<row><cell>Provisional reference</cell><cell>{{provisionalRef}}</cell></row>{{/if}}'
  || '{{#if customer}}<p>Bill to: {{customer.name}}</p>{{#if customer.tin}}<p>TIN {{customer.tin}}</p>{{/if}}{{#if customer.address}}<p>{{customer.address}}</p>{{/if}}{{/if}}'
  || '{{#if original}}<p>Corrects {{original.documentNo}}: {{reasonCode}}</p>{{/if}}'
  || '<hr/><row><cell>Item</cell><cell>Quantity</cell><cell>Unit price</cell><cell>Amount</cell></row><hr/>'
  || '{{#each lines}}<row><cell>{{description}}{{#if identifier}} ({{identifier}}){{/if}}</cell><cell>{{quantity}} {{uom}}</cell><cell>{{unitPrice}}</cell><cell>{{gross}}</cell></row>'
  || '{{#if weightKg}}<small>Weighed {{weightKg}} kg</small>{{/if}}{{#if discount}}<small>Discount {{discount}}</small>{{/if}}'
  || '{{#each levies}}<small>{{levyName}}, {{treatment}} at {{ratePercent}} percent on {{base}}: {{amount}}</small>{{/each}}{{/each}}'
  || '<hr/><row><cell>Net</cell><cell>{{net}}</cell></row>'
  || '<levies>{{#each levyTotals}}<row><cell>{{levyName}}</cell><cell>{{amount}}</cell></row>{{/each}}</levies>'
  || '<h2>Total {{gross}}</h2><p>Prices {{pricing}}. Amounts in Ghana cedis.</p>'
  || '<footer>Thank you for buying from HaKorem Farms.</footer>',
  '<header><h1>HaKorem Farms</h1><p>{{branch.name}}</p></header>'
  || '<p>{{title}} {{documentNo}}</p><p>{{issueDate}}</p>'
  || '{{#if provisionalRef}}<p>Provisional reference {{provisionalRef}}</p>{{/if}}<hr/>'
  || '{{#each lines}}<row><cell>{{description}} {{quantity}} {{uom}}</cell><cell>{{gross}}</cell></row>'
  || '{{#each levies}}<small>{{levyCode}} {{treatment}} {{ratePercent}}%: {{amount}}</small>{{/each}}{{/each}}'
  || '<hr/><row><cell>Net</cell><cell>{{net}}</cell></row>'
  || '{{#each levyTotals}}<row><cell>{{levyName}}</cell><cell>{{amount}}</cell></row>{{/each}}'
  || '<h1>TOTAL {{gross}}</h1><footer>Thank you for buying from HaKorem Farms.</footer>'
))
INSERT INTO doc.template_version (id, template_id, version_no, body, status, created_by, updated_by)
SELECT v.id::uuid, v.template_id::uuid, 1, CASE WHEN v.thermal THEN body.thermal ELSE body.a4 END, 'DRAFT',
       '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001'
  FROM body, (VALUES
    ('01900000-0000-7000-8000-000000000511', '01900000-0000-7000-8000-000000000501', false),
    ('01900000-0000-7000-8000-000000000512', '01900000-0000-7000-8000-000000000502', false),
    ('01900000-0000-7000-8000-000000000513', '01900000-0000-7000-8000-000000000503', false),
    ('01900000-0000-7000-8000-000000000514', '01900000-0000-7000-8000-000000000504', false),
    ('01900000-0000-7000-8000-000000000515', '01900000-0000-7000-8000-000000000505', false),
    ('01900000-0000-7000-8000-000000000516', '01900000-0000-7000-8000-000000000506', true)
  ) AS v (id, template_id, thermal);

UPDATE doc.template_version SET status = 'ACTIVE', activated_at = now(), activated_by = '01900000-0000-7000-8000-000000000001', version = version + 1
 WHERE template_id IN (SELECT id FROM doc.template) AND version_no = 1;
UPDATE doc.template t SET active_version_id = v.id, version = t.version + 1
  FROM doc.template_version v WHERE v.template_id = t.id AND v.version_no = 1;

-- migrate:down
DROP TABLE doc.render_job;
DROP TABLE doc.archived_document;
ALTER TABLE doc.template DROP CONSTRAINT fk_template_active_version;
DROP TABLE doc.template_version;
DROP TABLE doc.template;
DROP FUNCTION doc.archived_rendering(uuid, bytea);
DROP FUNCTION doc.template_active_guard();
DROP FUNCTION doc.template_version_guard();
DROP SCHEMA doc;
