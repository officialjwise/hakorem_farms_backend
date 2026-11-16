import { randomUUID } from 'node:crypto';
import { ManualClock } from '@hakorem/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCatalogue, TAX_CATEGORY, type TestCatalogue } from '../../support/catalogue';
import { consoleGet, createBranch, createUser, login, relaxRateLimits, SYSTEM_PRINCIPAL, testStartTime, type TestSession } from '../../support/iam';
import { startTestApp, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * listProducts sorted on the server (CR-019, ADR-0054): `sort` and `direction` order the whole list before paging,
 * through the shared keyset, with the product id as the tie-breaker. A walk two rows a page through long runs of tied
 * names, SKUs, categories, statuses and update times, while products arrive between pages, sees every original
 * product exactly once, in the asked order. Without `sort` the list answers exactly as before: newest first.
 */
let database: TestDatabase;
let api: TestApp;
let catalogue: TestCatalogue;
let storekeeper: TestSession;
let nobody: TestSession;
const app = () => database.pool('app');
const get = (session: TestSession, query: string) => consoleGet(api.server, session, `/v1/products?${query}`);

/** The expression each field sorts by, as the one-shot order the walk must reproduce. */
const ORDER_SQL: Readonly<Record<string, string>> = {
  name: 'lower(p.name)',
  sku: 'p.sku',
  category: 'lower(c.name)',
  status: 'p.status',
  updatedAt: 'p.updated_at',
};

/** Products in one statement, so their update times tie; names, SKUs and statuses tie in runs too. */
async function insertProducts(rows: ReadonlyArray<{ readonly sku: string; readonly name: string; readonly categoryId: string; readonly status: string }>): Promise<string[]> {
  const ids = rows.map(() => randomUUID());
  await app().query(
    `INSERT INTO mdm.product (id, sku, name, category_id, stock_policy, tracking, base_uom, sale_uom, tax_category_id, gl_group, online_mode, status, created_by, updated_by)
     SELECT r.id, r.sku, r.name, r.category_id, 'COUNTABLE', 'NONE', 'CRATE', 'CRATE', $5, 'PRODUCE_EGGS', 'HIDDEN', r.status, $6, $6
       FROM unnest($1::uuid[], $2::text[], $3::text[], $4::uuid[], $7::text[]) AS r(id, sku, name, category_id, status)`,
    [ids, rows.map((r) => r.sku), rows.map((r) => r.name), rows.map((r) => r.categoryId), TAX_CATEGORY.EGGS, SYSTEM_PRINCIPAL, rows.map((r) => r.status)],
  );
  return ids;
}

let counter = 0;
/** Two products that tie with the originals on every field: a name, a category and a status already present. */
async function arrivals(): Promise<string[]> {
  counter += 1;
  return insertProducts([
    { sku: `EGG-NEW-${counter}-A`, name: 'Eggs, big', categoryId: catalogue.eggsCategoryId, status: 'ACTIVE' },
    { sku: `EGG-NEW-${counter}-B`, name: 'goat', categoryId: catalogue.liveCategoryId, status: 'DRAFT' },
  ]);
}

/** Every id the list answers, two at a time, calling `between` after each page. */
async function walk(query: string, between: (pageNo: number) => Promise<void> = async () => undefined): Promise<string[]> {
  const seen: string[] = [];
  let cursor: string | null = null;
  for (let pageNo = 0; pageNo < 200; pageNo += 1) {
    const response = await get(storekeeper, `${query}&limit=2${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`);
    expect(response.status).toBe(200);
    seen.push(...(response.body.data as Array<{ id: string }>).map((row) => row.id));
    cursor = response.body.page.nextCursor as string | null;
    if (cursor === null) return seen;
    await between(pageNo);
  }
  throw new Error('the walk did not end');
}

async function orderedIds(field: string, direction: 'asc' | 'desc', among: readonly string[]): Promise<string[]> {
  const dir = direction === 'asc' ? 'ASC' : 'DESC';
  const { rows } = await app().query<{ id: string }>(
    `SELECT p.id FROM mdm.product p JOIN mdm.category c ON c.id = p.category_id WHERE p.id = ANY($1::uuid[]) ORDER BY ${ORDER_SQL[field]} ${dir}, p.id ${dir}`,
    [among],
  );
  return rows.map((row) => row.id);
}

async function allIds(): Promise<string[]> {
  const { rows } = await app().query<{ id: string }>('SELECT id FROM mdm.product WHERE deleted_at IS NULL');
  return rows.map((row) => row.id);
}

beforeAll(async () => {
  database = await createTestDatabase();
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock: new ManualClock(testStartTime()) });
  const dodowa = await createBranch(database);
  catalogue = await createCatalogue(database);
  storekeeper = await login(api.server, await createUser(database, { name: 'Kofi Mensah', grants: [{ role: 'STOREKEEPER', branchId: dodowa.branchId }] }));
  nobody = await login(api.server, await createUser(database, { name: 'Ama Owusu' }));
  // Thirteen products in three statements: names tie in case-insensitive runs, statuses and categories in long runs.
  await insertProducts([
    { sku: 'EGG-CRATE-BIG', name: 'Eggs, big', categoryId: catalogue.eggsCategoryId, status: 'ACTIVE' },
    { sku: 'EGG-CRATE-SML', name: 'Eggs, small', categoryId: catalogue.eggsCategoryId, status: 'ACTIVE' },
    { sku: 'EGG-CRATE-LOC', name: 'EGGS, BIG', categoryId: catalogue.eggsCategoryId, status: 'DRAFT' },
    { sku: 'LIV-GOAT', name: 'Goat', categoryId: catalogue.liveCategoryId, status: 'ACTIVE' },
    { sku: 'LIV-GOAT-KID', name: 'goat', categoryId: catalogue.liveCategoryId, status: 'DISCONTINUED' },
  ]);
  await insertProducts([
    { sku: 'LIV-SHEEP', name: 'Sheep', categoryId: catalogue.liveCategoryId, status: 'ACTIVE' },
    { sku: 'LIV-PIG', name: 'Baby pig', categoryId: catalogue.liveCategoryId, status: 'ACTIVE' },
    { sku: 'MEAT-BEEF-15', name: 'Beef', categoryId: catalogue.meatCategoryId, status: 'ACTIVE' },
    { sku: 'MEAT-GOAT-15', name: 'Goat meat', categoryId: catalogue.meatCategoryId, status: 'DRAFT' },
  ]);
  await insertProducts([
    { sku: 'MEAT-PORK-15', name: 'Pork', categoryId: catalogue.meatCategoryId, status: 'ACTIVE' },
    { sku: 'MEAT-CHK-WINGS', name: 'Chicken wings', categoryId: catalogue.meatCategoryId, status: 'ACTIVE' },
    { sku: 'MEAT-CHK-FULL', name: 'Full chicken', categoryId: catalogue.meatCategoryId, status: 'DISCONTINUED' },
    { sku: 'LIV-DUCK', name: 'Duck', categoryId: catalogue.liveCategoryId, status: 'ACTIVE' },
  ]);
});

afterAll(async () => {
  await api.close();
  await database.drop();
});

describe('listProducts sorted on the server (CR-019, ADR-0054)', () => {
  it('answers newest first without a sort, exactly as before', async () => {
    const { rows } = await app().query<{ id: string }>('SELECT id FROM mdm.product WHERE deleted_at IS NULL ORDER BY id DESC');
    expect(await walk('')).toEqual(rows.map((row) => row.id));
  });

  for (const field of ['name', 'sku', 'category', 'status', 'updatedAt'] as const) {
    for (const direction of ['asc', 'desc'] as const) {
      it(`pages by ${field} ${direction} without skipping or repeating a product through ties and arrivals between pages`, async () => {
        const original = await allIds();
        const arrived = new Set<string>();
        const seen = await walk(`sort=${field}&direction=${direction}`, async (pageNo) => {
          if (pageNo < 3) for (const id of await arrivals()) arrived.add(id);
        });
        expect(new Set(seen).size).toBe(seen.length);
        expect(seen.every((id) => original.includes(id) || arrived.has(id))).toBe(true);
        expect(seen.filter((id) => original.includes(id))).toEqual(await orderedIds(field, direction, original));
      });
    }
  }

  it('sorts ascending when only the field is named, by category name then id', async () => {
    const seen = await walk('sort=category');
    expect(seen).toEqual(await orderedIds('category', 'asc', await allIds()));
    const first = await get(storekeeper, 'sort=category&limit=1');
    expect(first.body.data[0].category.name).toBe('Eggs');
  });

  it('keeps the filters with a sort: ACTIVE live animals by name, Baby pig first', async () => {
    const response = await get(storekeeper, `sort=name&categoryId=${catalogue.liveCategoryId}&status=ACTIVE&limit=100`);
    expect(response.status).toBe(200);
    expect((response.body.data as Array<{ name: string }>).map((p) => p.name).slice(0, 3)).toEqual(['Baby pig', 'Duck', 'Goat']);
  });

  it('refuses a field outside the allow-list, a direction other than asc or desc, and a direction with no field', async () => {
    for (const [query, pointer] of [
      ['sort=description', '/sort'],
      ['sort=costPesewas', '/sort'],
      ['sort=name&direction=up', '/direction'],
      ['direction=desc', '/direction'],
    ] as const) {
      const response = await get(storekeeper, query);
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
      expect(response.body.error.details).toEqual([expect.objectContaining({ field: pointer, code: 'SORT_NOT_ALLOWED' })]);
    }
  });

  it('refuses a cursor from another sort or from the default order', async () => {
    const byName = await get(storekeeper, 'sort=name&limit=2');
    const bySku = await get(storekeeper, `sort=sku&limit=2&cursor=${encodeURIComponent(byName.body.page.nextCursor as string)}`);
    expect(bySku.status).toBe(400);
    expect(bySku.body.error.details[0].code).toBe('INVALID_CURSOR');
    const descending = await get(storekeeper, `sort=name&direction=desc&limit=2&cursor=${encodeURIComponent(byName.body.page.nextCursor as string)}`);
    expect(descending.status).toBe(400);
    const plain = await get(storekeeper, 'limit=2');
    const sorted = await get(storekeeper, `sort=name&limit=2&cursor=${encodeURIComponent(plain.body.page.nextCursor as string)}`);
    expect(sorted.status).toBe(400);
    expect(sorted.body.error.details[0].code).toBe('INVALID_CURSOR');
  });

  it('refuses a sorted read to a user with no grant, in the handler (ADR-0035)', async () => {
    const response = await get(nobody, 'sort=name&direction=asc');
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('FORBIDDEN');
  });
});

/** The plan of a query with sorting and sequential scans priced out: which indexes it reads, and whether it still sorts. */
async function plan(sql: string): Promise<{ indexes: string[]; sorts: boolean }> {
  const client = await database.pool('admin').connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL enable_sort = off');
    await client.query('SET LOCAL enable_seqscan = off');
    const { rows } = await client.query<{ 'QUERY PLAN': unknown }>(`EXPLAIN (FORMAT JSON) ${sql}`);
    await client.query('ROLLBACK');
    const text = JSON.stringify(rows[0]!['QUERY PLAN']);
    return { indexes: [...text.matchAll(/"Index Name":"([a-z_]+)"/g)].map((m) => m[1]!), sorts: /"Node Type":"(Incremental )?Sort"/.test(text) };
  } finally {
    client.release();
  }
}

describe('each product sort field is backed by an index of migration 0120 (CR-019)', () => {
  for (const [field, expression, index] of [
    ['name', 'lower(p.name)', 'ix_product_sort_name'],
    ['sku', 'p.sku', 'ix_product_sort_sku'],
    ['status', 'p.status', 'ix_product_sort_status'],
    ['updatedAt', 'p.updated_at', 'ix_product_sort_updated'],
  ] as const) {
    it(`reads ${field} in order from ${index}, both ways, without sorting`, async () => {
      for (const dir of ['ASC', 'DESC']) {
        const found = await plan(`SELECT p.id FROM mdm.product p WHERE p.deleted_at IS NULL ORDER BY ${expression} ${dir}, p.id ${dir} LIMIT 26`);
        expect(found).toEqual({ indexes: [index], sorts: false });
      }
    });
  }

  it('has the category name and the product category indexed for the category sort', async () => {
    expect((await plan('SELECT c.id FROM mdm.category c ORDER BY lower(c.name), c.id LIMIT 26')).indexes).toEqual(['ix_category_sort_name']);
    expect((await plan(`SELECT p.id FROM mdm.product p WHERE p.deleted_at IS NULL AND p.category_id = '${catalogue.meatCategoryId}' ORDER BY p.id LIMIT 26`)).indexes).toEqual([
      'ix_product_sort_category',
    ]);
  });
});
