-- 0037_mdm_product_image
-- Photographs of a product (FR-MDM-001, FR-DOC-005, ADR-0045). A product image refers to a file in the platform file
-- store (`platform.stored_file`, a published key, downward from MDM to platform); its public variants are the file
-- store's. The database holds the two rules that keep an unscanned or wrong file off the catalogue: an image is a
-- PRODUCT_IMAGE file, and the file is CLEAN when it is attached (SQLSTATE HK008). One live image per file and
-- product; removing an image is a soft delete with the actor and a reason.
-- Data category: PUBLIC (alt text and order of the photographs the shop shows).
-- The guard asks the file store through `platform.require_clean_file` (ADR-0045), never by reading its table.
-- Rollback: tested (`pnpm db:rollback`); afterwards forward fix only once images are attached.

-- migrate:up
CREATE TABLE mdm.product_image (
  id            uuid PRIMARY KEY,
  product_id    uuid NOT NULL CONSTRAINT fk_product_image_product REFERENCES mdm.product (id) ON DELETE RESTRICT,
  file_id       uuid NOT NULL CONSTRAINT fk_product_image_file REFERENCES platform.stored_file (id) ON DELETE RESTRICT,
  alt_text      text NOT NULL CONSTRAINT ck_product_image_alt_text CHECK (length(btrim(alt_text)) BETWEEN 1 AND 200),
  sort_order    integer NOT NULL DEFAULT 0 CONSTRAINT ck_product_image_sort_order CHECK (sort_order BETWEEN 0 AND 999),
  version       integer NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid NOT NULL CONSTRAINT fk_product_image_created_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    uuid NOT NULL CONSTRAINT fk_product_image_updated_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  deleted_at    timestamptz NULL,
  deleted_by    uuid NULL CONSTRAINT fk_product_image_deleted_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  delete_reason text NULL,
  CONSTRAINT ck_product_image_soft_delete CHECK ((deleted_at IS NULL) = (deleted_by IS NULL) AND (deleted_at IS NULL) = (delete_reason IS NULL))
);
COMMENT ON TABLE mdm.product_image IS 'class=MASTER';
CREATE UNIQUE INDEX uq_product_image_file ON mdm.product_image (product_id, file_id) WHERE deleted_at IS NULL;
CREATE INDEX ix_product_image_product ON mdm.product_image (product_id, sort_order) WHERE deleted_at IS NULL;
CREATE TRIGGER trg_product_image_version BEFORE UPDATE ON mdm.product_image
  FOR EACH ROW EXECUTE FUNCTION platform.touch_version();

-- An image is a product photograph that passed the malware scan, and which file it shows never changes. SQLSTATE HK008.
CREATE FUNCTION mdm.product_image_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.product_id, NEW.file_id, NEW.created_at, NEW.created_by) IS DISTINCT FROM (OLD.product_id, OLD.file_id, OLD.created_at, OLD.created_by) THEN
      RAISE EXCEPTION 'mdm.product_image %: the product and file of an image never change', OLD.id USING ERRCODE = 'HK008';
    END IF;
    RETURN NEW;
  END IF;
  -- The file store's own rule (migration 0036), asked through its shared function: no read of its table from here.
  PERFORM platform.require_clean_file(NEW.file_id, 'PRODUCT_IMAGE');
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION mdm.product_image_guard() FROM PUBLIC;
CREATE TRIGGER trg_product_image_guard BEFORE INSERT OR UPDATE ON mdm.product_image
  FOR EACH ROW EXECUTE FUNCTION mdm.product_image_guard();

REVOKE ALL ON mdm.product_image FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON mdm.product_image TO hk_app, hk_worker;

-- migrate:down
DROP TABLE mdm.product_image;
DROP FUNCTION mdm.product_image_guard();
