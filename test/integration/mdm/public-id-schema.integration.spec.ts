import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SQLSTATE, sqlStateOf } from '../../support/sql-state';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * Public IDs of customers and suppliers in the database (B09q, ADR-0073, migration 0212): every row has one, of its
 * kind's pattern, unique over every row ever made, and it never changes; a row inserted without one (the previous API
 * version, a fixture) is given one by `mdm.new_public_id`, from PostgreSQL's strong random source.
 */
const SYSTEM = '01900000-0000-7000-8000-000000000001';
const RETAIL_TIER = '01900000-0000-7000-8000-000000000301';
const PUBLIC_ID = { cus: /^cus_[0-9A-HJKMNP-TV-Z]{16}$/, sup: /^sup_[0-9A-HJKMNP-TV-Z]{16}$/ } as const;
let database: TestDatabase;
let serial = 0;

function insertCustomer(publicId?: string) {
  serial += 1;
  const columns = publicId === undefined ? '' : ', public_id';
  const value = publicId === undefined ? '' : ', $5';
  return database.pool('app').query<{ id: string; public_id: string }>(
    `INSERT INTO mdm.customer (id, customer_no, kind, name, tier_id, status, created_by, updated_by${columns})
     VALUES ($1, $2, 'INDIVIDUAL', 'Ama Boateng', $3, 'ACTIVE', $4, $4${value}) RETURNING id, public_id`,
    [randomUUID(), `C-${String(90_000 + serial)}`, RETAIL_TIER, SYSTEM, ...(publicId === undefined ? [] : [publicId])],
  );
}

function insertSupplier(publicId?: string) {
  serial += 1;
  const columns = publicId === undefined ? '' : ', public_id';
  const value = publicId === undefined ? '' : ', $4';
  return database.pool('app').query<{ id: string; public_id: string }>(
    `INSERT INTO mdm.supplier (id, supplier_no, name, status, created_by, updated_by${columns})
     VALUES ($1, $2, 'Awutu Poultry Farm', 'ACTIVE', $3, $3${value}) RETURNING id, public_id`,
    [randomUUID(), `S-${String(9_000 + serial)}`, SYSTEM, ...(publicId === undefined ? [] : [publicId])],
  );
}

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database.drop();
});

describe('mdm.new_public_id and the column defaults', () => {
  it('gives a customer and a supplier inserted without one a public ID of their own pattern', async () => {
    expect((await insertCustomer()).rows[0]!.public_id).toMatch(PUBLIC_ID.cus);
    expect((await insertSupplier()).rows[0]!.public_id).toMatch(PUBLIC_ID.sup);
  });

  it('draws two thousand IDs with no repeat, every character of the alphabet in use, and none of I, L, O or U', async () => {
    const { rows } = await database.pool('app').query<{ id: string }>("SELECT mdm.new_public_id('cus') AS id FROM generate_series(1, 2000)");
    const ids = rows.map((row) => row.id);
    expect(new Set(ids).size).toBe(2_000);
    expect(ids.every((id) => PUBLIC_ID.cus.test(id))).toBe(true);
    const characters = new Set(ids.flatMap((id) => [...id.slice(4)]));
    expect(characters.size).toBe(32);
    expect([...characters].some((c) => 'ILOU'.includes(c))).toBe(false);
  });
});

describe('a public ID is unique over every row, of its pattern, and never changes', () => {
  it('refuses a public ID another customer holds, even an archived one', async () => {
    const { rows } = await insertCustomer('cus_8F3K2M9Q7X4T1V6B');
    await database.pool('app').query("UPDATE mdm.customer SET deleted_at = now(), deleted_by = $2, delete_reason = 'Duplicate record', version = version + 1 WHERE id = $1", [rows[0]!.id, SYSTEM]);
    expect(await sqlStateOf(insertCustomer('cus_8F3K2M9Q7X4T1V6B'))).toBe(SQLSTATE.uniqueViolation);
    await insertSupplier('sup_8F3K2M9Q7X4T1V6B');
    expect(await sqlStateOf(insertSupplier('sup_8F3K2M9Q7X4T1V6B'))).toBe(SQLSTATE.uniqueViolation);
  });

  it('refuses an ID of the wrong kind, length or alphabet', async () => {
    for (const id of ['sup_8F3K2M9Q7X4T1V6C', 'cus_8F3K2M9Q7X4T1V6', 'cus_8F3K2M9Q7X4T1V6O', 'cus_8f3k2m9q7x4t1v6c', 'C-00001']) {
      expect(await sqlStateOf(insertCustomer(id)), id).toBe(SQLSTATE.checkViolation);
    }
    expect(await sqlStateOf(insertSupplier('cus_8F3K2M9Q7X4T1V6D'))).toBe(SQLSTATE.checkViolation);
  });

  it('refuses any change to a public ID, by any role, and lets the rest of the row change', async () => {
    const customer = (await insertCustomer()).rows[0]!;
    const supplier = (await insertSupplier()).rows[0]!;
    for (const pool of [database.pool('app'), database.pool('admin')]) {
      expect(await sqlStateOf(pool.query("UPDATE mdm.customer SET public_id = 'cus_0000000000000001', version = version + 1 WHERE id = $1", [customer.id]))).toBe(SQLSTATE.documentFrozen);
      expect(await sqlStateOf(pool.query("UPDATE mdm.supplier SET public_id = 'sup_0000000000000001', version = version + 1 WHERE id = $1", [supplier.id]))).toBe(SQLSTATE.documentFrozen);
    }
    expect(await sqlStateOf(database.pool('app').query("UPDATE mdm.customer SET name = 'Ama Boateng-Mensah', version = version + 1 WHERE id = $1", [customer.id]))).toBeUndefined();
    const after = await database.pool('admin').query<{ public_id: string }>('SELECT public_id FROM mdm.customer WHERE id = $1', [customer.id]);
    expect(after.rows[0]!.public_id).toBe(customer.public_id);
  });
});
