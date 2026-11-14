import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SQLSTATE, sqlStateOf } from '../../support/sql-state';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

const SYSTEM = '01900000-0000-7000-8000-000000000001';
const LIVE_ANIMALS_TAX = '01900000-0000-7000-8000-000000000201';
let database: TestDatabase;
let categoryId: string;
let goatSpeciesId: string;

interface ProductRow {
  sku: string;
  stock_policy: string;
  tracking: string;
  species_id: string | null;
  base_uom: string;
}

function insertProduct(row: ProductRow) {
  return database.pool('app').query(
    `INSERT INTO mdm.product (id, sku, name, category_id, stock_policy, tracking, species_id, base_uom, sale_uom, tax_category_id,
                              gl_group, online_mode, status, created_by, updated_by)
     VALUES ($1, $2, 'Fixture product', $3, $4, $5, $6, $7, $7, $8, 'LIVE_ANIMALS', 'HIDDEN', 'ACTIVE', $9, $9)`,
    [randomUUID(), row.sku, categoryId, row.stock_policy, row.tracking, row.species_id, row.base_uom, LIVE_ANIMALS_TAX, SYSTEM],
  );
}

beforeAll(async () => {
  database = await createTestDatabase();
  const app = database.pool('app');
  categoryId = randomUUID();
  goatSpeciesId = randomUUID();
  await app.query(
    `INSERT INTO mdm.category (id, code, name, product_line, gl_group, tax_category_id, created_by, updated_by)
     VALUES ($1, 'LIVE', 'Live animals', 'LIVE', 'LIVE_ANIMALS', $2, $3, $3)`,
    [categoryId, LIVE_ANIMALS_TAX, SYSTEM],
  );
  await app.query("INSERT INTO mdm.species (id, code, name, tracking_default, created_by, updated_by) VALUES ($1, 'GOAT', 'Goat', 'SERIAL', $2, $2)", [
    goatSpeciesId,
    SYSTEM,
  ]);
});

afterAll(async () => {
  await database.drop();
});

describe('mdm.product stock archetypes in the database (shared brief, domain model section 1)', () => {
  it('accepts a serialised animal with a species, a catch-weight lot in kilograms, and a plain countable', async () => {
    await insertProduct({ sku: 'LIV-GOAT', stock_policy: 'SERIALISED', tracking: 'SERIAL', species_id: goatSpeciesId, base_uom: 'HEAD' });
    await insertProduct({ sku: 'MEAT-GOAT-5KG', stock_policy: 'CATCH_WEIGHT', tracking: 'LOT', species_id: null, base_uom: 'KG' });
    await insertProduct({ sku: 'PRD-EGGS-BIG', stock_policy: 'COUNTABLE', tracking: 'LOT', species_id: null, base_uom: 'CRATE' });
  });

  it('refuses a serialised product without a species, or tracked by lot', async () => {
    expect(await sqlStateOf(insertProduct({ sku: 'LIV-SHEEP', stock_policy: 'SERIALISED', tracking: 'SERIAL', species_id: null, base_uom: 'HEAD' }))).toBe(
      SQLSTATE.checkViolation,
    );
    expect(await sqlStateOf(insertProduct({ sku: 'LIV-PIG', stock_policy: 'SERIALISED', tracking: 'LOT', species_id: goatSpeciesId, base_uom: 'HEAD' }))).toBe(
      SQLSTATE.checkViolation,
    );
  });

  it('refuses a catch-weight product held in anything but kilograms, and a non-stock product with tracking', async () => {
    expect(await sqlStateOf(insertProduct({ sku: 'MEAT-BEEF-15KG', stock_policy: 'CATCH_WEIGHT', tracking: 'LOT', species_id: null, base_uom: 'PACK' }))).toBe(
      SQLSTATE.checkViolation,
    );
    expect(await sqlStateOf(insertProduct({ sku: 'SVC-DELIVERY', stock_policy: 'NON_STOCK', tracking: 'LOT', species_id: null, base_uom: 'UNIT' }))).toBe(
      SQLSTATE.checkViolation,
    );
  });

  it('keeps a SKU unique among live products', async () => {
    await insertProduct({ sku: 'PRD-YAM', stock_policy: 'COUNTABLE', tracking: 'NONE', species_id: null, base_uom: 'TUBER' });
    expect(await sqlStateOf(insertProduct({ sku: 'PRD-YAM', stock_policy: 'COUNTABLE', tracking: 'NONE', species_id: null, base_uom: 'TUBER' }))).toBe(
      SQLSTATE.uniqueViolation,
    );
  });

  it('refuses hk_app a delete of a product (archive instead) and a change to the unit lookup', async () => {
    const app = database.pool('app');
    expect(await sqlStateOf(app.query("DELETE FROM mdm.product WHERE sku = 'PRD-YAM'"))).toBe(SQLSTATE.insufficientPrivilege);
    expect(await sqlStateOf(app.query("INSERT INTO mdm.uom (code, name, kind) VALUES ('SACK', 'Sack', 'COUNT')"))).toBe(SQLSTATE.insufficientPrivilege);
  });
});
