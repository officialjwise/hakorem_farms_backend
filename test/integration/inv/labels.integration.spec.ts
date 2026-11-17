import { randomUUID } from 'node:crypto';
import { ManualClock } from '@hakorem/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedCalendar, type SeedCalendar } from '../../../src/seed/seed-calendar';
import { seedUnits } from '../../../src/seed/seed-units';
import { consoleGet, createUser, enrolAndLogin, login, relaxRateLimits, testStartTime, type RoleCode, type TestSession } from '../../support/iam';
import { startTestApp, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * Label data for lots, animals and products (B05x, A-151): what a label prints, from the real API on the seeded farm,
 * for the client to draw; no image is rendered. From contract 2.0.0 (B09q, ADR-0072) neither label carries a barcode:
 * they print their text only, the SKU, the batch or tag, the dates and the weight. Each read refuses the wrong role and, for a stock unit, the
 * wrong location.
 */
let database: TestDatabase;
let api: TestApp;
let manager: TestSession;
let coldStorekeeper: TestSession;
let cashier: TestSession;
let investor: TestSession;
/** The seeded farm's dates, from the clock the seed ran on (B09t2). */
let seeded: SeedCalendar;
const wrongForStock = new Map<string, TestSession>();
const ids = new Map<string, string>();
const id = (code: string) => ids.get(code)!;
const get = (session: TestSession, path: string) => consoleGet(api.server, session, `/v1${path}`);

beforeAll(async () => {
  database = await createTestDatabase();
  const clock = new ManualClock(testStartTime());
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock });
  await runSeedUnits(database.pool('app'), api.app, seedUnits({ SEED_STAFF_PASSWORD: `Seed-${randomUUID()}` }));
  seeded = seedCalendar(clock.now());
  for (const row of (
    await database.pool('admin').query<{ code: string; id: string }>(
      `SELECT 'branch:' || code AS code, id FROM mdm.branch
       UNION ALL SELECT 'location:' || l.code, l.id FROM mdm.location l JOIN mdm.branch b ON b.id = l.branch_id WHERE b.code = 'DDW'
       UNION ALL SELECT 'product:' || sku, id FROM mdm.product
       UNION ALL SELECT 'unit:' || identifier, id FROM inv.stock_unit`,
    )
  ).rows) {
    ids.set(row.code, row.id);
  }
  const branchId = id('branch:DDW');
  manager = await enrolAndLogin(api.server, await createUser(database, { name: 'Akosua Boateng', grants: [{ role: 'MANAGER', branchId }] }), () => clock.now());
  coldStorekeeper = await login(api.server, await createUser(database, { name: 'Kofi Mensah', grants: [{ role: 'STOREKEEPER', branchId, locationId: id('location:COLD') }] }));
  cashier = await login(api.server, await createUser(database, { name: 'Adwoa Darko', grants: [{ role: 'CASHIER', branchId, locationId: id('location:SHOP') }] }));
  investor = await login(api.server, await createUser(database, { name: 'Investor reader', grants: [{ role: 'INVESTOR', branchId }] }));
  for (const role of ['CASHIER', 'SALES', 'DRIVER', 'FARM_HAND'] as const satisfies readonly RoleCode[]) {
    wrongForStock.set(role, await login(api.server, await createUser(database, { name: `Wrong ${role.toLowerCase()}`, grants: [{ role, branchId }] })));
  }
});

afterAll(async () => {
  await api.close();
  await database.drop();
});

describe('B05x gate: lot and animal label data answers from the real API', () => {
  it('prints the beef lot with its batch, its 45.000 kg on hand and its expiry, and no barcode', async () => {
    const response = await get(manager, `/stock-units/${id('unit:LOT-BEEF-2026-1110')}/label`);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      stockUnit: { id: id('unit:LOT-BEEF-2026-1110'), identifier: 'LOT-BEEF-2026-1110', tracking: 'LOT' },
      product: { sku: 'MEAT-0005' },
      branchId: id('branch:DDW'),
      kind: 'LOT',
      lotNo: 'LOT-BEEF-2026-1110',
      tagNo: null,
      weightKg: '45.000',
      weighedAt: null,
      onHandQty: '45.000',
      uom: 'KG',
      uomDisplayDecimals: 3,
      expiresOn: seeded.meatExpiresOn,
    });
    expect(Object.keys(response.body).sort()).toEqual(
      ['branchId', 'expiresOn', 'kind', 'lotNo', 'onHandQty', 'producedOn', 'product', 'stockUnit', 'storageTempClass', 'tagNo', 'uom', 'uomDisplayDecimals', 'weighedAt', 'weightKg'],
    );
  });

  it('prints a goat by its tag, with no weight before it is weighed, and a lot of egg crates with no weight', async () => {
    const goat = await get(manager, `/stock-units/${id('unit:G-0143')}/label`);
    expect(goat.status).toBe(200);
    expect(goat.body).toMatchObject({ kind: 'ANIMAL', lotNo: null, tagNo: 'G-0143', onHandQty: '1.000', uom: 'HEAD', });
    expect(goat.body).not.toHaveProperty('barcode');
    const weight = await database.pool('admin').query<{ kg: string | null }>('SELECT last_weight_kg::text AS kg FROM inv.stock_unit WHERE id = $1', [id('unit:G-0143')]);
    expect(goat.body.weightKg).toBe(weight.rows[0]!.kg);
    const eggs = await get(manager, `/stock-units/${id('unit:EGG-BIG-2026-1110')}/label`);
    expect(eggs.body).toMatchObject({ kind: 'LOT', lotNo: 'EGG-BIG-2026-1110', weightKg: null, onHandQty: '30.000', uom: 'CRATE', expiresOn: seeded.eggsExpireOn });
  });

  it('refuses a stock unit label to the Cashier, Sales, Driver and Farm hand, and to a Storekeeper at another location', async () => {
    for (const [role, session] of wrongForStock) {
      const refused = await get(session, `/stock-units/${id('unit:G-0143')}/label`);
      expect(refused.status, role).toBe(403);
      expect(refused.body.error.code).toBe('FORBIDDEN');
    }
    expect((await get(coldStorekeeper, `/stock-units/${id('unit:G-0143')}/label`)).status).toBe(403);
    expect((await get(manager, `/stock-units/${randomUUID()}/label`)).status).toBe(404);
  });
});

describe('B05x gate: product label data answers from the real API', () => {
  it('prints what the shelf label prints, the SKU among it, and no barcode', async () => {
    const products = await database.pool('admin').query<{ sku: string; sale_uom: string; shelf_life_days: number | null }>(
      "SELECT sku, sale_uom, shelf_life_days FROM mdm.product WHERE sku IN ('EGG-0003', 'PRD-0005', 'MEAT-0005')",
    );
    for (const product of products.rows) {
      const response = await get(cashier, `/products/${id(`product:${product.sku}`)}/label`);
      expect(response.status, product.sku).toBe(200);
      expect(response.body).toMatchObject({
        product: { id: id(`product:${product.sku}`), sku: product.sku },
        saleUom: product.sale_uom,
        shelfLifeDays: product.shelf_life_days,
      });
      expect(Object.keys(response.body).sort()).toEqual(['nominalPackKg', 'product', 'saleUom', 'shelfLifeDays', 'storageTempClass']);
    }
  });

  it('refuses a product label to a role that does not read the catalogue, and answers 404 for an unknown product', async () => {
    const refused = await get(investor, `/products/${id('product:LIV-0004')}/label`);
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('FORBIDDEN');
    expect((await get(manager, `/products/${randomUUID()}/label`)).status).toBe(404);
  });
});
