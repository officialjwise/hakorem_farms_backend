-- 0253_quo_quotations
-- B10 (FR-QUO-001 to FR-QUO-012, ADR-0004, ADR-0017, ADR-0019, ADR-0074, CR-045, CR-047, A-309): schema `quo` with
-- requests for quote and quotes made of immutable versions. The database holds:
--   quo.rfq                   DOCUMENT, numbered when written (ck_rfq_number); a status moves only along its edges
--                             (ck_rfq_transition); a quantity always names its unit and a unit its product (ck_rfq_qty).
--   quo.quote                 DOCUMENT, numbered once and keeping its number across versions (ck_quote_number); a status
--                             moves only along DOMAIN_MODEL 5.12's machine (ck_quote_transition); an accepted version and
--                             a converted order are each named once and never changed (ck_quote_frozen); a quote
--                             converts to exactly one order (uq_quote_converted_order) and only once accepted.
--   quo.quote_version         DOCUMENT. Issued, a version is frozen: only its status moves (ISSUED to SUPERSEDED or
--                             ACCEPTED) and its archived rendering is set once (ck_quote_version_frozen). One version per
--                             number (uq_quote_version_no), at most one issued and one open draft per quote. A version
--                             below the margin floor is issued only with its approval request, decided by someone who
--                             is neither its author nor the person who issued it (ck_quote_version_margin_approved,
--                             FR-QUO-005, ADR-0017).
--   quo.quote_line            DOCUMENT, frozen with its version: written, changed or removed only while the version is a
--                             draft; its reservation is named once, before the version is issued (ck_quote_line_frozen).
--                             A product line keeps the quantity in its own unit and in the product's base unit
--                             (CR-045, ck_quote_line_base).
--   quo.quote_acceptance      LEDGER, insert-only: a version is accepted once (uq_quote_acceptance_version); an acceptance
--                             recorded by staff carries its note (FR-QUO-010).
--   quo.quote_link_token      LEDGER, insert-only: the SHA-256 of each acceptance link's random token, never the token
--                             (ADR-0074, CR-047), expiring no later than its version's validity.
-- Additions to docs/data-model/quo.md: rfq qty, uom and consent; quote cancel_reason; version approved_by and
-- approved_at, the margin as numeric(9,2) (it may be negative or above 100); line base_qty and the engine's floor;
-- acceptance note, recorded_at and actor_id; quo.quote_link_token in place of acceptance_token_hash (A-309 (e)).
-- Data category: CONFIDENTIAL (DC-22: commercial history; a buyer's name, phone and the address a request came from).
-- Rollback: tested (`pnpm db:rollback`), safe before the first quote; afterwards forward fix only (an issued quote is a
-- record sent to a customer and is never removed).

-- migrate:up
CREATE SCHEMA quo AUTHORIZATION hk_owner;
REVOKE ALL ON SCHEMA quo FROM PUBLIC;
GRANT USAGE ON SCHEMA quo TO hk_app, hk_worker, hk_report;

CREATE TABLE quo.rfq (
  id                  uuid PRIMARY KEY CONSTRAINT fk_rfq_document REFERENCES platform.business_document (id) ON DELETE RESTRICT,
  rfq_no              text NOT NULL CONSTRAINT uq_rfq_no UNIQUE,
  source              text NOT NULL CONSTRAINT ck_rfq_source CHECK (source IN ('PUBLIC_FORM', 'REQUEST_TO_BUY', 'PHONE', 'WHATSAPP', 'COUNTER', 'WHOLESALE_ORDER')),
  customer_id         uuid NULL CONSTRAINT fk_rfq_customer REFERENCES mdm.customer (id) ON DELETE RESTRICT,
  contact_name        text NOT NULL CONSTRAINT ck_rfq_contact_name CHECK (length(btrim(contact_name)) BETWEEN 1 AND 160),
  contact_phone_e164  text NOT NULL CONSTRAINT ck_rfq_contact_phone CHECK (contact_phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  contact_email       text NULL CONSTRAINT ck_rfq_contact_email CHECK (length(contact_email) BETWEEN 3 AND 254),
  requirements        text NOT NULL CONSTRAINT ck_rfq_requirements CHECK (length(btrim(requirements)) BETWEEN 1 AND 2000),
  product_id          uuid NULL CONSTRAINT fk_rfq_product REFERENCES mdm.product (id) ON DELETE RESTRICT,
  stock_unit_id       uuid NULL CONSTRAINT fk_rfq_stock_unit REFERENCES inv.stock_unit (id) ON DELETE RESTRICT,
  qty                 platform.qty NULL CONSTRAINT ck_rfq_qty_positive CHECK (qty > 0),
  uom                 text NULL CONSTRAINT fk_rfq_uom REFERENCES mdm.uom (code) ON DELETE RESTRICT,
  needed_by           date NULL,
  delivery_area       text NULL CONSTRAINT ck_rfq_delivery_area CHECK (length(btrim(delivery_area)) BETWEEN 1 AND 120),
  assigned_to         uuid NULL CONSTRAINT fk_rfq_assigned_to REFERENCES iam.principal (id) ON DELETE RESTRICT,
  submitted_ip        inet NULL,
  consent_to_contact  boolean NOT NULL,
  status              text NOT NULL CONSTRAINT ck_rfq_status CHECK (status IN ('NEW', 'IN_PROGRESS', 'QUOTED', 'CLOSED', 'SPAM')),
  branch_id           uuid NOT NULL CONSTRAINT fk_rfq_branch REFERENCES mdm.branch (id) ON DELETE RESTRICT,
  version             integer NOT NULL DEFAULT 1,
  created_at          timestamptz NOT NULL,
  created_by          uuid NOT NULL CONSTRAINT fk_rfq_created_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  updated_at          timestamptz NOT NULL,
  updated_by          uuid NOT NULL CONSTRAINT fk_rfq_updated_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  CONSTRAINT ck_rfq_qty CHECK ((qty IS NULL) = (uom IS NULL) AND (qty IS NULL OR product_id IS NOT NULL)),
  CONSTRAINT ck_rfq_public CHECK (source NOT IN ('PUBLIC_FORM', 'REQUEST_TO_BUY') OR consent_to_contact)
);
COMMENT ON TABLE quo.rfq IS 'class=DOCUMENT';
CREATE INDEX ix_rfq_branch ON quo.rfq (branch_id, id);
CREATE INDEX ix_rfq_customer ON quo.rfq (customer_id) WHERE customer_id IS NOT NULL;
CREATE TRIGGER trg_rfq_version BEFORE UPDATE ON quo.rfq FOR EACH ROW EXECUTE FUNCTION platform.touch_version();

CREATE FUNCTION quo.rfq_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  allowed text[];
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'NEW' THEN
      RAISE EXCEPTION 'quo.rfq %: a request is written NEW', NEW.id USING ERRCODE = 'HK004', CONSTRAINT = 'ck_rfq_transition';
    END IF;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - ARRAY['status', 'customer_id', 'assigned_to', 'version', 'updated_at', 'updated_by'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'customer_id', 'assigned_to', 'version', 'updated_at', 'updated_by']) THEN
    RAISE EXCEPTION 'quo.rfq %: only its status, customer and salesperson change', OLD.id USING ERRCODE = 'HK004', CONSTRAINT = 'ck_rfq_transition';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    allowed := CASE OLD.status
      WHEN 'NEW' THEN ARRAY['IN_PROGRESS', 'QUOTED', 'CLOSED', 'SPAM']
      WHEN 'IN_PROGRESS' THEN ARRAY['QUOTED', 'CLOSED', 'SPAM']
      WHEN 'QUOTED' THEN ARRAY['CLOSED']
      ELSE ARRAY[]::text[] END;
    IF NOT (NEW.status = ANY (allowed)) THEN
      RAISE EXCEPTION 'quo.rfq %: % cannot move to %', OLD.id, OLD.status, NEW.status USING ERRCODE = 'HK004', CONSTRAINT = 'ck_rfq_transition';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION quo.rfq_guard() FROM PUBLIC;
CREATE TRIGGER trg_rfq_guard BEFORE INSERT OR UPDATE ON quo.rfq FOR EACH ROW EXECUTE FUNCTION quo.rfq_guard();

CREATE TABLE quo.quote (
  id                   uuid PRIMARY KEY CONSTRAINT fk_quote_document REFERENCES platform.business_document (id) ON DELETE RESTRICT,
  quote_no             text NOT NULL CONSTRAINT uq_quote_no UNIQUE,
  rfq_id               uuid NULL CONSTRAINT fk_quote_rfq REFERENCES quo.rfq (id) ON DELETE RESTRICT,
  customer_id          uuid NULL CONSTRAINT fk_quote_customer REFERENCES mdm.customer (id) ON DELETE RESTRICT,
  contact_name         text NOT NULL CONSTRAINT ck_quote_contact_name CHECK (length(btrim(contact_name)) BETWEEN 1 AND 160),
  contact_phone_e164   text NOT NULL CONSTRAINT ck_quote_contact_phone CHECK (contact_phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  salesperson_id       uuid NOT NULL CONSTRAINT fk_quote_salesperson REFERENCES iam.principal (id) ON DELETE RESTRICT,
  product_line         text NULL,
  current_version_no   integer NOT NULL DEFAULT 1 CONSTRAINT ck_quote_current_version CHECK (current_version_no > 0),
  accepted_version_id  uuid NULL,
  converted_order_id   uuid NULL CONSTRAINT fk_quote_converted_order REFERENCES ord.sales_order (id) ON DELETE RESTRICT
                         CONSTRAINT uq_quote_converted_order UNIQUE,
  decline_reason       text NULL CONSTRAINT ck_quote_decline_reason CHECK (length(btrim(decline_reason)) BETWEEN 1 AND 500),
  cancel_reason        text NULL CONSTRAINT ck_quote_cancel_reason CHECK (length(btrim(cancel_reason)) BETWEEN 1 AND 500),
  status               text NOT NULL CONSTRAINT ck_quote_status CHECK (status IN ('DRAFT', 'PENDING_APPROVAL', 'ISSUED', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'CONVERTED', 'CANCELLED')),
  branch_id            uuid NOT NULL CONSTRAINT fk_quote_branch REFERENCES mdm.branch (id) ON DELETE RESTRICT,
  version              integer NOT NULL DEFAULT 1,
  created_at           timestamptz NOT NULL,
  created_by           uuid NOT NULL CONSTRAINT fk_quote_created_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  updated_at           timestamptz NOT NULL,
  updated_by           uuid NOT NULL CONSTRAINT fk_quote_updated_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  CONSTRAINT ck_quote_converted CHECK ((converted_order_id IS NOT NULL) = (status = 'CONVERTED')),
  CONSTRAINT ck_quote_accepted CHECK ((status NOT IN ('ACCEPTED', 'CONVERTED') OR accepted_version_id IS NOT NULL)
                                      AND (accepted_version_id IS NULL OR status IN ('ACCEPTED', 'CONVERTED', 'CANCELLED'))),
  CONSTRAINT ck_quote_declined CHECK ((status = 'DECLINED') = (decline_reason IS NOT NULL)),
  CONSTRAINT ck_quote_cancelled CHECK ((status = 'CANCELLED') = (cancel_reason IS NOT NULL))
);
COMMENT ON TABLE quo.quote IS 'class=DOCUMENT';
CREATE INDEX ix_quote_branch ON quo.quote (branch_id, id);
CREATE INDEX ix_quote_rfq ON quo.quote (rfq_id) WHERE rfq_id IS NOT NULL;
CREATE INDEX ix_quote_status ON quo.quote (status, branch_id);
CREATE TRIGGER trg_quote_version BEFORE UPDATE ON quo.quote FOR EACH ROW EXECUTE FUNCTION platform.touch_version();

CREATE FUNCTION quo.quote_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  allowed text[];
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'DRAFT' OR NEW.accepted_version_id IS NOT NULL OR NEW.converted_order_id IS NOT NULL THEN
      RAISE EXCEPTION 'quo.quote %: a quote is written DRAFT', NEW.id USING ERRCODE = 'HK004', CONSTRAINT = 'ck_quote_transition';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status IN ('DECLINED', 'EXPIRED', 'CONVERTED', 'CANCELLED') AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
    RAISE EXCEPTION 'quo.quote % is % and frozen', OLD.id, OLD.status USING ERRCODE = 'HK004', CONSTRAINT = 'ck_quote_frozen';
  END IF;
  IF NEW.quote_no IS DISTINCT FROM OLD.quote_no OR NEW.salesperson_id IS DISTINCT FROM OLD.salesperson_id OR NEW.branch_id IS DISTINCT FROM OLD.branch_id
     OR NEW.rfq_id IS DISTINCT FROM OLD.rfq_id OR NEW.current_version_no < OLD.current_version_no
     OR (OLD.accepted_version_id IS NOT NULL AND NEW.accepted_version_id IS DISTINCT FROM OLD.accepted_version_id) THEN
    RAISE EXCEPTION 'quo.quote %: its number, salesperson, branch, request and accepted version never change', OLD.id USING ERRCODE = 'HK004', CONSTRAINT = 'ck_quote_frozen';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    allowed := CASE OLD.status
      WHEN 'DRAFT' THEN ARRAY['PENDING_APPROVAL', 'ISSUED', 'CANCELLED']
      WHEN 'PENDING_APPROVAL' THEN ARRAY['DRAFT', 'ISSUED', 'CANCELLED']
      WHEN 'ISSUED' THEN ARRAY['ACCEPTED', 'DECLINED', 'EXPIRED', 'CANCELLED']
      WHEN 'ACCEPTED' THEN ARRAY['CONVERTED', 'CANCELLED']
      ELSE ARRAY[]::text[] END;
    IF NOT (NEW.status = ANY (allowed)) THEN
      RAISE EXCEPTION 'quo.quote %: % cannot move to %', OLD.id, OLD.status, NEW.status USING ERRCODE = 'HK004', CONSTRAINT = 'ck_quote_transition';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION quo.quote_guard() FROM PUBLIC;
CREATE TRIGGER trg_quote_guard BEFORE INSERT OR UPDATE ON quo.quote FOR EACH ROW EXECUTE FUNCTION quo.quote_guard();

CREATE TABLE quo.quote_version (
  id                     uuid PRIMARY KEY,
  quote_id               uuid NOT NULL CONSTRAINT fk_quote_version_quote REFERENCES quo.quote (id) ON DELETE RESTRICT,
  version_no             integer NOT NULL CONSTRAINT ck_quote_version_no CHECK (version_no > 0),
  status                 text NOT NULL CONSTRAINT ck_quote_version_status CHECK (status IN ('DRAFT', 'PENDING_APPROVAL', 'ISSUED', 'SUPERSEDED', 'ACCEPTED')),
  valid_until            timestamptz NOT NULL,
  terms                  text NULL CONSTRAINT ck_quote_version_terms CHECK (length(btrim(terms)) BETWEEN 1 AND 2000),
  delivery_estimate      text NULL CONSTRAINT ck_quote_version_delivery_estimate CHECK (length(btrim(delivery_estimate)) BETWEEN 1 AND 500),
  delivery_fee_pesewas   platform.pesewas NOT NULL DEFAULT 0,
  tax_inclusive          boolean NOT NULL,
  net_pesewas            platform.pesewas NOT NULL,
  tax_pesewas            platform.pesewas NOT NULL,
  gross_pesewas          platform.pesewas NOT NULL,
  estimated_cost_pesewas platform.pesewas NULL,
  margin_percent         numeric(9,2) NULL,
  below_margin_floor     boolean NOT NULL,
  approval_request_id    uuid NULL CONSTRAINT fk_quote_version_approval REFERENCES iam.approval_request (id) ON DELETE RESTRICT,
  approved_by            uuid NULL CONSTRAINT fk_quote_version_approved_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  approved_at            timestamptz NULL,
  change_note            text NULL CONSTRAINT ck_quote_version_change_note CHECK (length(btrim(change_note)) BETWEEN 1 AND 500),
  issued_at              timestamptz NULL,
  issued_by              uuid NULL CONSTRAINT fk_quote_version_issued_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  archived_document_id   uuid NULL CONSTRAINT fk_quote_version_archived_document REFERENCES doc.archived_document (id) ON DELETE RESTRICT,
  version                integer NOT NULL DEFAULT 1,
  created_at             timestamptz NOT NULL,
  created_by             uuid NOT NULL CONSTRAINT fk_quote_version_created_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  updated_at             timestamptz NOT NULL,
  updated_by             uuid NOT NULL CONSTRAINT fk_quote_version_updated_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  CONSTRAINT uq_quote_version_no UNIQUE (quote_id, version_no),
  CONSTRAINT ck_quote_version_gross CHECK (gross_pesewas::numeric = net_pesewas::numeric + tax_pesewas),
  CONSTRAINT ck_quote_version_margin CHECK ((margin_percent IS NULL) OR estimated_cost_pesewas IS NOT NULL),
  CONSTRAINT ck_quote_version_issued CHECK ((status IN ('ISSUED', 'SUPERSEDED', 'ACCEPTED')) = (issued_at IS NOT NULL AND issued_by IS NOT NULL)),
  CONSTRAINT ck_quote_version_pending CHECK (status <> 'PENDING_APPROVAL' OR approval_request_id IS NOT NULL),
  CONSTRAINT ck_quote_version_approved CHECK ((approved_by IS NULL) = (approved_at IS NULL) AND (approved_by IS NULL OR approval_request_id IS NOT NULL)),
  -- FR-QUO-005, ADR-0017: below the floor, issued only with its approval, by someone neither its author nor its issuer.
  CONSTRAINT ck_quote_version_margin_approved CHECK (
    status NOT IN ('ISSUED', 'SUPERSEDED', 'ACCEPTED') OR NOT below_margin_floor
    OR (approval_request_id IS NOT NULL AND approved_by IS NOT NULL AND approved_by <> created_by AND approved_by <> issued_by))
);
COMMENT ON TABLE quo.quote_version IS 'class=DOCUMENT';
CREATE UNIQUE INDEX uq_quote_version_issued ON quo.quote_version (quote_id) WHERE status = 'ISSUED';
CREATE UNIQUE INDEX uq_quote_version_open ON quo.quote_version (quote_id) WHERE status IN ('DRAFT', 'PENDING_APPROVAL');
CREATE INDEX ix_quote_version_approval ON quo.quote_version (approval_request_id) WHERE approval_request_id IS NOT NULL;
CREATE INDEX ix_quote_version_valid ON quo.quote_version (valid_until) WHERE status = 'ISSUED';
CREATE TRIGGER trg_quote_version_version BEFORE UPDATE ON quo.quote_version FOR EACH ROW EXECUTE FUNCTION platform.touch_version();

ALTER TABLE quo.quote ADD CONSTRAINT fk_quote_accepted_version FOREIGN KEY (accepted_version_id) REFERENCES quo.quote_version (id) ON DELETE RESTRICT;

-- An issued version is immutable (FR-QUO-006): only its status moves on, and its archived rendering is set once.
CREATE FUNCTION quo.quote_version_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  allowed text[];
  moving text[] := ARRAY['status', 'version', 'updated_at', 'updated_by'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'quo.quote_version % is never removed', OLD.id USING ERRCODE = 'HK004', CONSTRAINT = 'ck_quote_version_frozen';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'DRAFT' OR NEW.archived_document_id IS NOT NULL OR NEW.approved_by IS NOT NULL THEN
      RAISE EXCEPTION 'quo.quote_version %: a version is written DRAFT', NEW.id USING ERRCODE = 'HK004', CONSTRAINT = 'ck_quote_version_frozen';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.quote_id IS DISTINCT FROM OLD.quote_id OR NEW.version_no IS DISTINCT FROM OLD.version_no OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'quo.quote_version %: its quote, number and author never change', OLD.id USING ERRCODE = 'HK004', CONSTRAINT = 'ck_quote_version_frozen';
  END IF;
  IF OLD.status IN ('ISSUED', 'SUPERSEDED', 'ACCEPTED') THEN
    IF (to_jsonb(NEW) - (moving || ARRAY['archived_document_id'])) IS DISTINCT FROM (to_jsonb(OLD) - (moving || ARRAY['archived_document_id']))
       OR (OLD.archived_document_id IS NOT NULL AND NEW.archived_document_id IS DISTINCT FROM OLD.archived_document_id) THEN
      RAISE EXCEPTION 'quo.quote_version % is issued and frozen; a change is a new version', OLD.id USING ERRCODE = 'HK004', CONSTRAINT = 'ck_quote_version_frozen';
    END IF;
  ELSIF OLD.status = 'PENDING_APPROVAL' AND NEW.status = 'PENDING_APPROVAL'
     AND (to_jsonb(NEW) - moving) IS DISTINCT FROM (to_jsonb(OLD) - moving) THEN
    RAISE EXCEPTION 'quo.quote_version % waits for its approval and is not edited', OLD.id USING ERRCODE = 'HK004', CONSTRAINT = 'ck_quote_version_frozen';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    allowed := CASE OLD.status
      WHEN 'DRAFT' THEN ARRAY['PENDING_APPROVAL', 'ISSUED']
      WHEN 'PENDING_APPROVAL' THEN ARRAY['DRAFT', 'ISSUED']
      WHEN 'ISSUED' THEN ARRAY['SUPERSEDED', 'ACCEPTED']
      ELSE ARRAY[]::text[] END;
    IF NOT (NEW.status = ANY (allowed)) THEN
      RAISE EXCEPTION 'quo.quote_version %: % cannot move to %', OLD.id, OLD.status, NEW.status USING ERRCODE = 'HK004', CONSTRAINT = 'ck_quote_version_frozen';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION quo.quote_version_guard() FROM PUBLIC;
CREATE TRIGGER trg_quote_version_guard BEFORE INSERT OR UPDATE OR DELETE ON quo.quote_version FOR EACH ROW EXECUTE FUNCTION quo.quote_version_guard();

CREATE TABLE quo.quote_line (
  id                              uuid PRIMARY KEY,
  quote_version_id                uuid NOT NULL CONSTRAINT fk_quote_line_version REFERENCES quo.quote_version (id) ON DELETE RESTRICT,
  line_no                         integer NOT NULL CONSTRAINT ck_quote_line_no CHECK (line_no > 0),
  product_id                      uuid NULL CONSTRAINT fk_quote_line_product REFERENCES mdm.product (id) ON DELETE RESTRICT,
  description                     text NOT NULL CONSTRAINT ck_quote_line_description CHECK (length(btrim(description)) BETWEEN 1 AND 500),
  grade_id                        uuid NULL CONSTRAINT fk_quote_line_grade REFERENCES mdm.grade (id) ON DELETE RESTRICT,
  weight_band_id                  uuid NULL CONSTRAINT fk_quote_line_weight_band REFERENCES mdm.weight_band (id) ON DELETE RESTRICT,
  stock_unit_id                   uuid NULL CONSTRAINT fk_quote_line_stock_unit REFERENCES inv.stock_unit (id) ON DELETE RESTRICT,
  reservation_id                  uuid NULL CONSTRAINT fk_quote_line_reservation REFERENCES inv.stock_reservation (id) ON DELETE RESTRICT,
  qty                             platform.qty NOT NULL CONSTRAINT ck_quote_line_qty CHECK (qty > 0),
  uom                             text NOT NULL CONSTRAINT fk_quote_line_uom REFERENCES mdm.uom (code) ON DELETE RESTRICT,
  base_qty                        platform.qty NULL CONSTRAINT ck_quote_line_base_qty CHECK (base_qty > 0),
  price_basis                     text NOT NULL CONSTRAINT ck_quote_line_price_basis CHECK (price_basis IN ('PER_HEAD', 'PER_KG', 'PER_UNIT')),
  resolved_unit_price_pesewas     platform.pesewas NULL,
  resolved_floor_unit_price_pesewas platform.pesewas NULL,
  unit_price_pesewas              platform.pesewas NOT NULL,
  line_net_pesewas                platform.pesewas NOT NULL,
  estimated_unit_cost_pesewas     platform.pesewas NULL,
  CONSTRAINT uq_quote_line UNIQUE (quote_version_id, line_no),
  CONSTRAINT ck_quote_line_base CHECK ((product_id IS NULL) = (base_qty IS NULL) AND (stock_unit_id IS NULL OR product_id IS NOT NULL)),
  CONSTRAINT ck_quote_line_resolved CHECK ((resolved_unit_price_pesewas IS NULL) = (resolved_floor_unit_price_pesewas IS NULL)
                                          AND (resolved_unit_price_pesewas IS NULL OR product_id IS NOT NULL))
);
COMMENT ON TABLE quo.quote_line IS 'class=DOCUMENT';
CREATE INDEX ix_quote_line_stock_unit ON quo.quote_line (stock_unit_id) WHERE stock_unit_id IS NOT NULL;

-- Lines are frozen with their version: changed only while it is a draft; the reservation is named once before issue.
CREATE FUNCTION quo.quote_line_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  version_status text;
BEGIN
  SELECT v.status INTO version_status FROM quo.quote_version v
   WHERE v.id = CASE WHEN TG_OP = 'DELETE' THEN OLD.quote_version_id ELSE NEW.quote_version_id END;
  IF TG_OP = 'UPDATE' AND version_status IN ('DRAFT', 'PENDING_APPROVAL') AND OLD.reservation_id IS NULL AND NEW.reservation_id IS NOT NULL
     AND (to_jsonb(NEW) - 'reservation_id') = (to_jsonb(OLD) - 'reservation_id') THEN
    RETURN NEW;
  END IF;
  IF version_status IS DISTINCT FROM 'DRAFT' OR (TG_OP = 'UPDATE' AND NEW.quote_version_id IS DISTINCT FROM OLD.quote_version_id) THEN
    RAISE EXCEPTION 'quo.quote_line: the lines of a version that is % are frozen', version_status USING ERRCODE = 'HK004', CONSTRAINT = 'ck_quote_line_frozen';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;
REVOKE ALL ON FUNCTION quo.quote_line_guard() FROM PUBLIC;
CREATE TRIGGER trg_quote_line_guard BEFORE INSERT OR UPDATE OR DELETE ON quo.quote_line FOR EACH ROW EXECUTE FUNCTION quo.quote_line_guard();

CREATE TABLE quo.quote_acceptance (
  id                uuid PRIMARY KEY,
  quote_version_id  uuid NOT NULL CONSTRAINT fk_quote_acceptance_version REFERENCES quo.quote_version (id) ON DELETE RESTRICT,
  method            text NOT NULL CONSTRAINT ck_quote_acceptance_method CHECK (method IN ('SIGNED_LINK', 'IN_PERSON', 'PHONE_CONFIRMED')),
  accepted_name     text NOT NULL CONSTRAINT ck_quote_acceptance_name CHECK (length(btrim(accepted_name)) BETWEEN 1 AND 160),
  note              text NULL CONSTRAINT ck_quote_acceptance_note_text CHECK (length(btrim(note)) BETWEEN 1 AND 1000),
  ip                inet NULL,
  user_agent        text NULL CONSTRAINT ck_quote_acceptance_user_agent CHECK (length(user_agent) <= 500),
  accepted_at       timestamptz NOT NULL,
  recorded_at       timestamptz NOT NULL,
  actor_id          uuid NOT NULL CONSTRAINT fk_quote_acceptance_actor REFERENCES iam.principal (id) ON DELETE RESTRICT,
  CONSTRAINT uq_quote_acceptance_version UNIQUE (quote_version_id),
  CONSTRAINT ck_quote_acceptance_note CHECK (method = 'SIGNED_LINK' OR note IS NOT NULL)
);
COMMENT ON TABLE quo.quote_acceptance IS 'class=LEDGER';
CREATE TRIGGER trg_quote_acceptance_immutable BEFORE UPDATE OR DELETE ON quo.quote_acceptance FOR EACH ROW EXECUTE FUNCTION platform.reject_change();
CREATE TRIGGER trg_quote_acceptance_no_truncate BEFORE TRUNCATE ON quo.quote_acceptance FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_change();

CREATE TABLE quo.quote_link_token (
  id                uuid PRIMARY KEY,
  quote_version_id  uuid NOT NULL CONSTRAINT fk_quote_link_token_version REFERENCES quo.quote_version (id) ON DELETE RESTRICT,
  token_hash        bytea NOT NULL CONSTRAINT ck_quote_link_token_hash CHECK (octet_length(token_hash) = 32),
  recorded_at       timestamptz NOT NULL,
  expires_at        timestamptz NOT NULL,
  actor_id          uuid NOT NULL CONSTRAINT fk_quote_link_token_actor REFERENCES iam.principal (id) ON DELETE RESTRICT,
  CONSTRAINT uq_quote_link_token_hash UNIQUE (token_hash),
  CONSTRAINT ck_quote_link_token_expiry CHECK (expires_at > recorded_at)
);
COMMENT ON TABLE quo.quote_link_token IS 'class=LEDGER';
CREATE INDEX ix_quote_link_token_version ON quo.quote_link_token (quote_version_id);
CREATE TRIGGER trg_quote_link_token_immutable BEFORE UPDATE OR DELETE ON quo.quote_link_token FOR EACH ROW EXECUTE FUNCTION platform.reject_change();
CREATE TRIGGER trg_quote_link_token_no_truncate BEFORE TRUNCATE ON quo.quote_link_token FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_change();

-- A link is made only for an issued version and expires no later than the version's validity (CR-047).
CREATE FUNCTION quo.quote_link_token_check() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  v quo.quote_version;
BEGIN
  SELECT * INTO v FROM quo.quote_version x WHERE x.id = NEW.quote_version_id;
  IF v.status <> 'ISSUED' OR NEW.expires_at > v.valid_until THEN
    RAISE EXCEPTION 'quo.quote_link_token: a link opens an issued version until its validity ends' USING ERRCODE = 'HK004', CONSTRAINT = 'ck_quote_link_token_version';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION quo.quote_link_token_check() FROM PUBLIC;
CREATE TRIGGER trg_quote_link_token_check BEFORE INSERT ON quo.quote_link_token FOR EACH ROW EXECUTE FUNCTION quo.quote_link_token_check();

-- At commit: a request and a quote carry the number allocated to them; an accepted quote names its own accepted version,
-- which has its acceptance; a version marked accepted has one.
CREATE FUNCTION quo.quote_check() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  q quo.quote;
BEGIN
  IF TG_TABLE_NAME = 'rfq' THEN
    IF NOT platform.number_allocated(NEW.id, NEW.rfq_no, 'RFQ') THEN
      RAISE EXCEPTION 'quo.rfq %: % was not allocated to it', NEW.id, NEW.rfq_no USING ERRCODE = 'HK010', CONSTRAINT = 'ck_rfq_number';
    END IF;
    RETURN NULL;
  END IF;
  SELECT * INTO q FROM quo.quote x WHERE x.id = NEW.id;
  IF NOT platform.number_allocated(q.id, q.quote_no, 'QUOTE') THEN
    RAISE EXCEPTION 'quo.quote %: % was not allocated to it', q.id, q.quote_no USING ERRCODE = 'HK010', CONSTRAINT = 'ck_quote_number';
  END IF;
  IF q.accepted_version_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM quo.quote_version v JOIN quo.quote_acceptance a ON a.quote_version_id = v.id
        WHERE v.id = q.accepted_version_id AND v.quote_id = q.id AND v.status = 'ACCEPTED') THEN
    RAISE EXCEPTION 'quo.quote %: its accepted version is not an accepted version of it', q.id USING ERRCODE = 'HK010', CONSTRAINT = 'ck_quote_acceptance';
  END IF;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION quo.quote_check() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER trg_rfq_check AFTER INSERT ON quo.rfq DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION quo.quote_check();
CREATE CONSTRAINT TRIGGER trg_quote_check AFTER INSERT OR UPDATE ON quo.quote DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION quo.quote_check();

CREATE FUNCTION quo.quote_version_accepted_check() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.status = 'ACCEPTED' AND NOT EXISTS (SELECT 1 FROM quo.quote_acceptance a WHERE a.quote_version_id = NEW.id) THEN
    RAISE EXCEPTION 'quo.quote_version %: accepted with no acceptance', NEW.id USING ERRCODE = 'HK010', CONSTRAINT = 'ck_quote_acceptance';
  END IF;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION quo.quote_version_accepted_check() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER trg_quote_version_accepted_check AFTER UPDATE ON quo.quote_version DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION quo.quote_version_accepted_check();

REVOKE ALL ON ALL TABLES IN SCHEMA quo FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON quo.rfq, quo.quote, quo.quote_version TO hk_app, hk_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON quo.quote_line TO hk_app, hk_worker;
GRANT SELECT, INSERT ON quo.quote_acceptance, quo.quote_link_token TO hk_app, hk_worker;

-- migrate:down
DROP TABLE quo.quote_link_token;
DROP TABLE quo.quote_acceptance;
DROP TABLE quo.quote_line;
ALTER TABLE quo.quote DROP CONSTRAINT fk_quote_accepted_version;
DROP TABLE quo.quote_version;
DROP TABLE quo.quote;
DROP TABLE quo.rfq;
DROP FUNCTION quo.quote_version_accepted_check();
DROP FUNCTION quo.quote_check();
DROP FUNCTION quo.quote_link_token_check();
DROP FUNCTION quo.quote_line_guard();
DROP FUNCTION quo.quote_version_guard();
DROP FUNCTION quo.quote_guard();
DROP FUNCTION quo.rfq_guard();
DROP SCHEMA quo;
