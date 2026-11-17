import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SQLSTATE, sqlStateOf } from '../../support/sql-state';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * Server-generated SKUs in the database (B09q, ADR-0072, migration 0210): a category carries its SKU prefix, derived
 * from its code when none is given; `mdm.allocate_sku` takes the next number of the prefix's own counter, which only
 * ever moves forward, and steps over a SKU a product already holds; a SKU is unique over every product ever made, live
 * or archived, and never changes. The product barcode's unique index is gone (expand, migration 0211).
 */
const SYSTEM = '01900000-0000-7000-8000-000000000001';
const EGGS_TAX = '01900000-0000-7000-8000-000000000203';
let database: TestDatabase;
let eggsCategoryId: string;

async function category(code: string, skuPrefix: string | null): Promise<string> {
  const id = randomUUID();
  await database.pool('app').query(
    `INSERT INTO mdm.category (id, code, name, product_line, gl_group, tax_category_id, sku_prefix, created_by, updated_by)
     VALUES ($1, $2, $2, 'PRODUCE', 'PRODUCE_EGGS', $3, $4, $5, $5)`,
    [id, code, EGGS_TAX, skuPrefix, SYSTEM],
  );
  return id;
}

function insertProduct(sku: string, barcode: string | null = null) {
  return database.pool('app').query(
    `INSERT INTO mdm.product (id, sku, name, category_id, stock_policy, tracking, base_uom, sale_uom, tax_category_id, gl_group, barcode, online_mode, status, created_by, updated_by)
     VALUES ($1, $2, 'Fixture eggs', $3, 'COUNTABLE', 'NONE', 'CRATE', 'CRATE', $4, 'PRODUCE_EGGS', $5, 'HIDDEN', 'ACTIVE', $6, $6) RETURNING id`,
    [randomUUID(), sku, eggsCategoryId, EGGS_TAX, barcode, SYSTEM],
  );
}

const allocate = async (prefix: string): Promise<string> => (await database.pool('app').query<{ sku: string }>('SELECT mdm.allocate_sku($1) AS sku', [prefix])).rows[0]!.sku;
const prefixOf = async (id: string): Promise<string> => (await database.pool('app').query<{ p: string }>('SELECT sku_prefix AS p FROM mdm.category WHERE id = $1', [id])).rows[0]!.p;

beforeAll(async () => {
  database = await createTestDatabase();
  eggsCategoryId = await category('EGGS', 'EGG');
});

afterAll(async () => {
  await database.drop();
});

describe('a category carries the prefix of its SKUs', () => {
  it('keeps a prefix it is given, and derives one from the first three letters of its code when it has none', async () => {
    expect(await prefixOf(eggsCategoryId)).toBe('EGG');
    expect(await prefixOf(await category('LIVE', null))).toBe('LIV');
    expect(await prefixOf(await category('FEED-MED', null))).toBe('FEE');
    expect(await prefixOf(await category('B2', null))).toBe('CAT');
  });

  it('refuses a prefix that is not two to five capital letters', async () => {
    for (const prefix of ['E', 'EGGSXX', 'eg', 'EG1', 'E-G']) {
      expect(await sqlStateOf(category(`X${prefix.length}${randomUUID().slice(0, 4).toUpperCase()}`, prefix)), prefix).toBe(SQLSTATE.checkViolation);
    }
  });
});

describe('mdm.allocate_sku numbers each prefix on its own counter, which never goes back', () => {
  it('hands out EGG-0001 then EGG-0002, and another prefix starts at 0001', async () => {
    expect(await allocate('EGG')).toBe('EGG-0001');
    expect(await allocate('EGG')).toBe('EGG-0002');
    expect(await allocate('PRD')).toBe('PRD-0001');
  });

  it('steps over a SKU a product already holds, so it never hands out one in use', async () => {
    await insertProduct('EGG-0003');
    expect(await allocate('EGG')).toBe('EGG-0004');
  });

  it('keeps counting past 9999 without truncating', async () => {
    await database.pool('admin').query("UPDATE mdm.sku_counter SET last_value = 9999 WHERE prefix = 'PRD'");
    expect(await allocate('PRD')).toBe('PRD-10000');
  });

  it('is never reset: lowering, deleting or truncating the counter is refused, and the application role cannot write it', async () => {
    const admin = database.pool('admin');
    expect(await sqlStateOf(admin.query("UPDATE mdm.sku_counter SET last_value = 1 WHERE prefix = 'EGG'"))).toBe(SQLSTATE.documentFrozen);
    expect(await sqlStateOf(admin.query("DELETE FROM mdm.sku_counter WHERE prefix = 'EGG'"))).toBe(SQLSTATE.documentFrozen);
    expect(await sqlStateOf(admin.query('TRUNCATE mdm.sku_counter'))).toBe(SQLSTATE.documentFrozen);
    const app = database.pool('app');
    expect(await sqlStateOf(app.query("UPDATE mdm.sku_counter SET last_value = 100 WHERE prefix = 'EGG'"))).toBe(SQLSTATE.insufficientPrivilege);
    expect(await sqlStateOf(app.query("INSERT INTO mdm.sku_counter (prefix, last_value) VALUES ('ZZZ', 1)"))).toBe(SQLSTATE.insufficientPrivilege);
    expect(await allocate('EGG')).toBe('EGG-0005');
  });

  it('gives fifty concurrent allocations fifty different numbers', async () => {
    const skus = await Promise.all(Array.from({ length: 50 }, () => allocate('MIX')));
    expect(new Set(skus).size).toBe(50);
    expect([...skus].sort()).toEqual(Array.from({ length: 50 }, (_, i) => `MIX-${String(i + 1).padStart(4, '0')}`));
  });
});

describe('a SKU is unique over every product ever made, and never changes', () => {
  it('refuses the SKU of an archived product', async () => {
    const { rows } = await insertProduct('EGG-0901');
    await database.pool('app').query("UPDATE mdm.product SET deleted_at = now(), deleted_by = $2, delete_reason = 'Discontinued', version = version + 1 WHERE id = $1", [rows[0]!.id, SYSTEM]);
    expect(await sqlStateOf(insertProduct('EGG-0901'))).toBe(SQLSTATE.uniqueViolation);
  });

  it("refuses any change to a product's SKU, by any role", async () => {
    const { rows } = await insertProduct('EGG-0902');
    expect(await sqlStateOf(database.pool('app').query("UPDATE mdm.product SET sku = 'EGG-0903', version = version + 1 WHERE id = $1", [rows[0]!.id]))).toBe(SQLSTATE.documentFrozen);
    expect(await sqlStateOf(database.pool('admin').query("UPDATE mdm.product SET sku = 'EGG-0903', version = version + 1 WHERE id = $1", [rows[0]!.id]))).toBe(SQLSTATE.documentFrozen);
    expect(await sqlStateOf(database.pool('app').query("UPDATE mdm.product SET name = 'Eggs, renamed', version = version + 1 WHERE id = $1", [rows[0]!.id]))).toBeUndefined();
  });

  it('no longer holds a barcode unique: the column is unused and on its way out (expand, then contract)', async () => {
    await insertProduct('EGG-0904', '6034123757');
    expect(await sqlStateOf(insertProduct('EGG-0905', '6034123757'))).toBeUndefined();
  });
});
