-- 0009_mdm_create_catalogue
-- The catalogue tables the B3 Product slice needs (docs/data-model/mdm.md): units of measure (seeded), tax
-- categories (the seven codes the tax engine of ADR-0020 keys on, seeded), categories, species and products.
-- Grades, weight bands, images, unit conversions and the tax scheme arrive with the rest of MDM in B4.
-- Data category: PUBLIC (catalogue), INTERNAL (ledger grouping).

-- migrate:up
CREATE TABLE mdm.uom (
  code text PRIMARY KEY CONSTRAINT ck_uom_code CHECK (code ~ '^[A-Z]{2,10}$'),
  name text NOT NULL,
  kind text NOT NULL CONSTRAINT ck_uom_kind CHECK (kind IN ('COUNT', 'WEIGHT', 'VOLUME'))
);
COMMENT ON TABLE mdm.uom IS 'class=LOOKUP';
INSERT INTO mdm.uom (code, name, kind) VALUES
  ('HEAD', 'Head', 'COUNT'), ('KG', 'Kilogram', 'WEIGHT'), ('CRATE', 'Crate', 'COUNT'), ('BUNCH', 'Bunch', 'COUNT'),
  ('TUBER', 'Tuber', 'COUNT'), ('PACK', 'Pack', 'COUNT'), ('UNIT', 'Unit', 'COUNT'), ('BAG', 'Bag', 'COUNT'),
  ('LITRE', 'Litre', 'VOLUME');

CREATE TABLE mdm.tax_category (
  id            uuid PRIMARY KEY,
  code          text NOT NULL CONSTRAINT uq_tax_category_code UNIQUE CONSTRAINT ck_tax_category_code CHECK (code ~ '^[A-Z][A-Z_]{2,39}$'),
  name          text NOT NULL,
  version       integer NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid NOT NULL CONSTRAINT fk_tax_category_created_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    uuid NOT NULL CONSTRAINT fk_tax_category_updated_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  deleted_at    timestamptz NULL,
  deleted_by    uuid NULL CONSTRAINT fk_tax_category_deleted_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  delete_reason text NULL,
  CONSTRAINT ck_tax_category_soft_delete CHECK ((deleted_at IS NULL) = (deleted_by IS NULL) AND (deleted_at IS NULL) = (delete_reason IS NULL))
);
COMMENT ON TABLE mdm.tax_category IS 'class=MASTER';
CREATE TRIGGER trg_tax_category_version BEFORE UPDATE ON mdm.tax_category
  FOR EACH ROW EXECUTE FUNCTION platform.touch_version();
INSERT INTO mdm.tax_category (id, code, name, created_by, updated_by) VALUES
  ('01900000-0000-7000-8000-000000000201', 'LIVE_ANIMALS', 'Live animals', '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001'),
  ('01900000-0000-7000-8000-000000000202', 'RAW_PRODUCE', 'Raw produce', '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001'),
  ('01900000-0000-7000-8000-000000000203', 'EGGS', 'Eggs', '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001'),
  ('01900000-0000-7000-8000-000000000204', 'PROCESSED_MEAT', 'Processed meat', '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001'),
  ('01900000-0000-7000-8000-000000000205', 'FARM_INPUTS', 'Farm inputs', '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001'),
  ('01900000-0000-7000-8000-000000000206', 'DELIVERY_SERVICE', 'Delivery service', '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001'),
  ('01900000-0000-7000-8000-000000000207', 'OTHER_GOODS', 'Other goods', '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001');

CREATE TABLE mdm.category (
  id                uuid PRIMARY KEY,
  parent_id         uuid NULL CONSTRAINT fk_category_parent REFERENCES mdm.category (id) ON DELETE RESTRICT,
  code              text NOT NULL CONSTRAINT ck_category_code CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{1,39}$'),
  name              text NOT NULL CONSTRAINT ck_category_name CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  product_line      text NOT NULL CONSTRAINT ck_category_product_line CHECK (product_line IN ('LIVE', 'MEAT', 'PRODUCE', 'BY_PRODUCT', 'FEED', 'SUPPLY', 'SERVICE')),
  gl_group          text NOT NULL CONSTRAINT ck_category_gl_group CHECK (gl_group IN ('LIVE_ANIMALS', 'MEAT', 'OFFAL', 'PRODUCE_EGGS', 'FEED_MEDICATION', 'SUPPLIES', 'SERVICE')),
  tax_category_id   uuid NOT NULL CONSTRAINT fk_category_tax_category REFERENCES mdm.tax_category (id) ON DELETE RESTRICT,
  sort_order        integer NOT NULL DEFAULT 0,
  is_online_visible boolean NOT NULL DEFAULT true,
  version           integer NOT NULL DEFAULT 1,
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid NOT NULL CONSTRAINT fk_category_created_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  updated_by        uuid NOT NULL CONSTRAINT fk_category_updated_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  deleted_at        timestamptz NULL,
  deleted_by        uuid NULL CONSTRAINT fk_category_deleted_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  delete_reason     text NULL,
  CONSTRAINT ck_category_soft_delete CHECK ((deleted_at IS NULL) = (deleted_by IS NULL) AND (deleted_at IS NULL) = (delete_reason IS NULL))
);
COMMENT ON TABLE mdm.category IS 'class=MASTER';
CREATE UNIQUE INDEX uq_category_code ON mdm.category (code) WHERE deleted_at IS NULL;
CREATE TRIGGER trg_category_version BEFORE UPDATE ON mdm.category
  FOR EACH ROW EXECUTE FUNCTION platform.touch_version();

CREATE TABLE mdm.species (
  id               uuid PRIMARY KEY,
  code             text NOT NULL CONSTRAINT ck_species_code CHECK (code ~ '^[A-Z][A-Z_]{1,39}$'),
  name             text NOT NULL,
  tracking_default text NOT NULL CONSTRAINT ck_species_tracking CHECK (tracking_default IN ('SERIAL', 'LOT')),
  version          integer NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid NOT NULL CONSTRAINT fk_species_created_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       uuid NOT NULL CONSTRAINT fk_species_updated_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  deleted_at       timestamptz NULL,
  deleted_by       uuid NULL CONSTRAINT fk_species_deleted_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  delete_reason    text NULL,
  CONSTRAINT ck_species_soft_delete CHECK ((deleted_at IS NULL) = (deleted_by IS NULL) AND (deleted_at IS NULL) = (delete_reason IS NULL))
);
COMMENT ON TABLE mdm.species IS 'class=MASTER';
CREATE UNIQUE INDEX uq_species_code ON mdm.species (code) WHERE deleted_at IS NULL;
CREATE TRIGGER trg_species_version BEFORE UPDATE ON mdm.species
  FOR EACH ROW EXECUTE FUNCTION platform.touch_version();

CREATE TABLE mdm.product (
  id                       uuid PRIMARY KEY,
  sku                      text NOT NULL CONSTRAINT ck_product_sku CHECK (sku ~ '^[A-Z0-9][A-Z0-9-]{1,39}$'),
  name                     text NOT NULL CONSTRAINT ck_product_name CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  category_id              uuid NOT NULL CONSTRAINT fk_product_category REFERENCES mdm.category (id) ON DELETE RESTRICT,
  stock_policy             text NOT NULL CONSTRAINT ck_product_stock_policy CHECK (stock_policy IN ('SERIALISED', 'CATCH_WEIGHT', 'COUNTABLE', 'NON_STOCK')),
  tracking                 text NOT NULL CONSTRAINT ck_product_tracking CHECK (tracking IN ('SERIAL', 'LOT', 'NONE')),
  species_id               uuid NULL CONSTRAINT fk_product_species REFERENCES mdm.species (id) ON DELETE RESTRICT,
  base_uom                 text NOT NULL CONSTRAINT fk_product_base_uom REFERENCES mdm.uom (code) ON DELETE RESTRICT,
  sale_uom                 text NOT NULL CONSTRAINT fk_product_sale_uom REFERENCES mdm.uom (code) ON DELETE RESTRICT,
  nominal_pack_kg          platform.kg NULL CONSTRAINT ck_product_nominal_pack CHECK (nominal_pack_kg > 0),
  weight_tolerance_percent platform.percent NOT NULL DEFAULT 10,
  tax_category_id          uuid NOT NULL CONSTRAINT fk_product_tax_category REFERENCES mdm.tax_category (id) ON DELETE RESTRICT,
  gl_group                 text NOT NULL CONSTRAINT ck_product_gl_group CHECK (gl_group IN ('LIVE_ANIMALS', 'MEAT', 'OFFAL', 'PRODUCE_EGGS', 'FEED_MEDICATION', 'SUPPLIES', 'SERVICE')),
  shelf_life_days          integer NULL CONSTRAINT ck_product_shelf_life CHECK (shelf_life_days > 0),
  storage_temp_class       text NULL CONSTRAINT ck_product_temp_class CHECK (storage_temp_class IN ('AMBIENT', 'CHILLED', 'FROZEN')),
  withdrawal_days          integer NULL CONSTRAINT ck_product_withdrawal CHECK (withdrawal_days >= 0),
  barcode                  text NULL CONSTRAINT ck_product_barcode CHECK (barcode ~ '^[0-9A-Za-z-]{4,40}$'),
  description              text NULL CONSTRAINT ck_product_description CHECK (length(description) <= 2000),
  online_mode              text NOT NULL CONSTRAINT ck_product_online_mode CHECK (online_mode IN ('HIDDEN', 'LISTED', 'REQUEST_TO_BUY')),
  seo_slug                 text NULL CONSTRAINT ck_product_seo_slug CHECK (seo_slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(seo_slug) <= 80),
  seo_title                text NULL CONSTRAINT ck_product_seo_title CHECK (length(seo_title) <= 120),
  seo_description          text NULL CONSTRAINT ck_product_seo_description CHECK (length(seo_description) <= 300),
  is_purchasable           boolean NOT NULL DEFAULT true,
  is_sellable              boolean NOT NULL DEFAULT true,
  status                   text NOT NULL CONSTRAINT ck_product_status CHECK (status IN ('DRAFT', 'ACTIVE', 'DISCONTINUED')),
  version                  integer NOT NULL DEFAULT 1,
  created_at               timestamptz NOT NULL DEFAULT now(),
  created_by               uuid NOT NULL CONSTRAINT fk_product_created_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  updated_at               timestamptz NOT NULL DEFAULT now(),
  updated_by               uuid NOT NULL CONSTRAINT fk_product_updated_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  deleted_at               timestamptz NULL,
  deleted_by               uuid NULL CONSTRAINT fk_product_deleted_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  delete_reason            text NULL,
  -- The three archetypes and services (shared brief, domain model 1).
  CONSTRAINT ck_product_serialised CHECK (stock_policy <> 'SERIALISED' OR (tracking = 'SERIAL' AND species_id IS NOT NULL)),
  CONSTRAINT ck_product_catch_weight CHECK (stock_policy <> 'CATCH_WEIGHT' OR (tracking = 'LOT' AND base_uom = 'KG')),
  CONSTRAINT ck_product_countable CHECK (stock_policy <> 'COUNTABLE' OR tracking IN ('LOT', 'NONE')),
  CONSTRAINT ck_product_non_stock CHECK (stock_policy <> 'NON_STOCK' OR tracking = 'NONE'),
  CONSTRAINT ck_product_soft_delete CHECK ((deleted_at IS NULL) = (deleted_by IS NULL) AND (deleted_at IS NULL) = (delete_reason IS NULL))
);
COMMENT ON TABLE mdm.product IS 'class=MASTER';
CREATE UNIQUE INDEX uq_product_sku ON mdm.product (sku) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX uq_product_barcode ON mdm.product (barcode) WHERE deleted_at IS NULL AND barcode IS NOT NULL;
CREATE UNIQUE INDEX uq_product_seo_slug ON mdm.product (seo_slug) WHERE deleted_at IS NULL AND seo_slug IS NOT NULL;
CREATE INDEX ix_product_category ON mdm.product (category_id) WHERE deleted_at IS NULL;
CREATE INDEX ix_product_name ON mdm.product (lower(name) text_pattern_ops) WHERE deleted_at IS NULL;
CREATE TRIGGER trg_product_version BEFORE UPDATE ON mdm.product
  FOR EACH ROW EXECUTE FUNCTION platform.touch_version();

REVOKE ALL ON mdm.uom, mdm.tax_category, mdm.category, mdm.species, mdm.product FROM PUBLIC;
GRANT SELECT ON mdm.uom TO hk_app, hk_worker;
GRANT SELECT, INSERT, UPDATE ON mdm.tax_category, mdm.category, mdm.species, mdm.product TO hk_app, hk_worker;

-- migrate:down
DROP TABLE mdm.product;
DROP TABLE mdm.species;
DROP TABLE mdm.category;
DROP TABLE mdm.tax_category;
DROP TABLE mdm.uom;
