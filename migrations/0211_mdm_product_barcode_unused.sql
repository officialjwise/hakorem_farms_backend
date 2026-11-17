-- 0211_mdm_product_barcode_unused
-- B09q (owner, 2026-11-17; ADR-0072), the expand step of removing the product barcode: contract 2.0.0 has no product
-- barcode, no barcode lookup and no till scanning, and from this release the API neither reads nor writes
-- `mdm.product.barcode`. Its unique index goes now, so the column holds nothing a write could collide with; the column
-- itself stays one release so the previous API version still runs against this schema (expand then contract,
-- docs/DATA_MODEL.md, Migrations). The contract step, `ALTER TABLE mdm.product DROP COLUMN barcode`, is the first
-- migration after 2.0.0 is deployed (BL-075, A-249). The meat pack barcode (`prc.pack.barcode`, 0085) is untouched.
-- Data category: PUBLIC (catalogue); no personal data.
-- Rollback: tested (`pnpm db:rollback`): the index returns, which holds while no two live products share a barcode
-- (nothing writes one from 2.0.0).

-- migrate:up
DROP INDEX mdm.uq_product_barcode;
COMMENT ON COLUMN mdm.product.barcode IS 'Unused from contract 2.0.0 (ADR-0072); dropped by the first migration after 2.0.0 is deployed';

-- migrate:down
COMMENT ON COLUMN mdm.product.barcode IS NULL;
CREATE UNIQUE INDEX uq_product_barcode ON mdm.product (barcode) WHERE deleted_at IS NULL AND barcode IS NOT NULL;
