import { randomUUID } from 'node:crypto';
import { ManualClock } from '@hakorem/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { consoleGet, createUser, login, relaxRateLimits, testStartTime, type TestSession } from '../../support/iam';
import { startTestApp, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * Unit names and the egg base unit (B09u, the owner's decision 1, A-303): every unit answers a singular and a plural
 * name, so a screen can say "540 eggs" and "from 10 crates"; the seeded eggs are counted in the unit named "egg", not
 * the generic UNIT, with every stored figure as before: 900 big eggs at 105,000 on the shop floor, a crate 30 of them,
 * a crate at 6,000 and a single egg at 220 on the base list. Figures are read back by SQL over the tables.
 */
let database: TestDatabase;
let api: TestApp;
let storekeeper: TestSession;
const admin = () => database.pool('admin');
const one = async <T>(sql: string, values: unknown[] = []): Promise<T> => (await admin().query(sql, values)).rows[0] as T;

beforeAll(async () => {
  database = await createTestDatabase();
  const clock = new ManualClock(testStartTime());
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock });
  await runSeedUnits(database.pool('app'), api.app, seedUnits({ SEED_STAFF_PASSWORD: `Seed-${randomUUID()}` }));
  const branchId = (await one<{ id: string }>("SELECT id FROM mdm.branch WHERE code = 'DDW'")).id;
  storekeeper = await login(api.server, await createUser(database, { name: 'Kofi Mensah', grants: [{ role: 'STOREKEEPER', branchId }] }));
});

afterAll(async () => {
  await api?.close();
  await database.drop();
});

describe('every unit answers a singular and a plural name', () => {
  it('lists each unit with both names, egg and eggs, crate and crates, head and head', async () => {
    const listed = await consoleGet(api.server, storekeeper, '/v1/units-of-measure?limit=100');
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    const byCode = new Map((listed.body.data as Array<{ code: string; singularName: string; pluralName: string; kind: string; displayDecimals: number }>).map((u) => [u.code, u]));
    expect(byCode.get('EGG')).toMatchObject({ name: 'Egg', singularName: 'egg', pluralName: 'eggs', kind: 'COUNT', displayDecimals: 0 });
    expect(byCode.get('CRATE')).toMatchObject({ singularName: 'crate', pluralName: 'crates' });
    expect(byCode.get('HEAD')).toMatchObject({ singularName: 'head', pluralName: 'head' });
    expect(byCode.get('KG')).toMatchObject({ singularName: 'kilogram', pluralName: 'kilograms' });
    expect(byCode.get('BUNCH')).toMatchObject({ singularName: 'bunch', pluralName: 'bunches' });
    for (const unit of byCode.values()) {
      expect(unit.singularName, unit.code).toMatch(/^\S(.*\S)?$/);
      expect(unit.pluralName, unit.code).toMatch(/^\S(.*\S)?$/);
    }
    expect(byCode.size).toBe((await one<{ n: number }>('SELECT count(*)::int AS n FROM mdm.uom')).n);
  });

  it('refuses the unit list to a caller with no grant (403) and an anonymous one (401)', async () => {
    const nobody = await login(api.server, await createUser(database, { name: 'Efua Nkansah' }));
    expect((await consoleGet(api.server, nobody, '/v1/units-of-measure')).status).toBe(403);
    const { default: request } = await import('supertest');
    expect((await request(api.server).get('/v1/units-of-measure')).status).toBe(401);
  });

  it('holds both names in the database: an empty or padded name is refused', async () => {
    await expect(admin().query("UPDATE mdm.uom SET plural_name = ' eggs' WHERE code = 'EGG'")).rejects.toMatchObject({ code: '23514', constraint: 'ck_uom_plural_name' });
    await expect(admin().query("UPDATE mdm.uom SET singular_name = '' WHERE code = 'EGG'")).rejects.toMatchObject({ code: '23514', constraint: 'ck_uom_singular_name' });
  });
});

describe('the seeded eggs are counted in the egg unit, every stored figure unchanged', () => {
  it('counts EGG-0001 to EGG-0003 in EGG and sells them by the crate of 30 eggs', async () => {
    const { rows } = await admin().query<{ sku: string; base_uom: string; sale_uom: string; from_uom: string; numerator: string; denominator: string }>(
      `SELECT p.sku, p.base_uom, p.sale_uom, c.from_uom, c.numerator::text, c.denominator::text
         FROM mdm.product p JOIN mdm.product_uom_conversion c ON c.product_id = p.id AND c.deleted_at IS NULL
        WHERE p.sku LIKE 'EGG-%' ORDER BY p.sku`,
    );
    expect(rows).toEqual(['EGG-0001', 'EGG-0002', 'EGG-0003'].map((sku) => ({ sku, base_uom: 'EGG', sale_uom: 'CRATE', from_uom: 'CRATE', numerator: '30', denominator: '1' })));
    expect((await one<{ n: number }>("SELECT count(*)::int AS n FROM mdm.product WHERE sku LIKE 'EGG-%' AND base_uom = 'UNIT'")).n).toBe(0);
  });

  it('holds 900 big eggs at 105,000 on the shop floor, as before the unit had its own name', async () => {
    const stock = await one<{ qty: string; value: string }>(
      `SELECT sum(b.on_hand_qty)::text AS qty,
              (SELECT sum(cp.value_pesewas) FROM inv.cost_pool cp WHERE cp.product_id = p.id)::text AS value
         FROM inv.stock_balance b JOIN mdm.product p ON p.id = b.product_id JOIN mdm.location l ON l.id = b.location_id
        WHERE p.sku = 'EGG-0003' AND l.code = 'SHOP' GROUP BY p.id`,
    );
    expect(stock).toEqual({ qty: '900.000', value: '105000' });
    const receipt = await one<{ uom: string; qty_received_uom: string; qty_received: string; value: string }>(
      `SELECT gl.uom, gl.qty_received_uom::text, gl.qty_received::text, gl.value_pesewas::text AS value
         FROM inv.goods_receipt_line gl JOIN mdm.product p ON p.id = gl.product_id WHERE p.sku = 'EGG-0003' AND gl.batch_no = 'EGG-BIG-2026-1110'`,
    );
    expect(receipt).toEqual({ uom: 'CRATE', qty_received_uom: '30.000', qty_received: '900.000', value: '105000' });
  });

  it('prices a crate of big eggs at 6,000 and a single egg at 220 on the base list, each for its own unit', async () => {
    const { rows } = await admin().query<{ uom: string | null; list: string }>(
      `SELECT e.uom, e.list_price_pesewas::text AS list FROM mdm.price_list_entry e JOIN mdm.product p ON p.id = e.product_id
         JOIN mdm.price_list_version v ON v.id = e.version_id JOIN mdm.price_list l ON l.id = v.price_list_id
        WHERE p.sku = 'EGG-0003' AND l.code = 'BASE' ORDER BY e.uom NULLS LAST`,
    );
    expect(rows).toEqual([
      { uom: 'CRATE', list: '6000' },
      { uom: null, list: '220' },
    ]);
  });
});
