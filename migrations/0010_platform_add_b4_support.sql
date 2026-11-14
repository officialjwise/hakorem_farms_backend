-- 0010_platform_add_b4_support
-- What the B4 pricing tables need from the platform: the btree_gist extension, so an exclusion constraint can say
-- "for one list (a uuid), no two ACTIVE versions overlap in time" and "for one species, no two weight bands
-- overlap" (ADR-0004, FR-MDM-005); and the PRICE_LIST_VERSION document type, so a version can be registered as a
-- business document and approved through iam.approval_request (ADR-0011, ADR-0017).
-- btree_gist is a trusted extension: hk_owner, which owns the database, may create it. It lives in `platform`.
-- Data category: none (catalogue objects and one lookup row).
-- Rollback: tested (`pnpm db:rollback`); safe only while no table uses the extension's operator classes, which is
-- why 0011 is rolled back first.

-- migrate:up
CREATE EXTENSION btree_gist WITH SCHEMA platform;

INSERT INTO platform.document_type (code, owner_module, name, is_numbered, series_prefix) VALUES
  ('PRICE_LIST_VERSION', 'mdm', 'Price list version', false, NULL);

-- migrate:down
DELETE FROM platform.document_type WHERE code = 'PRICE_LIST_VERSION';
DROP EXTENSION btree_gist;
