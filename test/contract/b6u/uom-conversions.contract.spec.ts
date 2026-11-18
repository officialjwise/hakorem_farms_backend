import { randomUUID } from 'node:crypto';
import { ManualClock } from '@hakorem/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { contractSchema } from '../../support/contract-schemas';
import { consoleGet, consolePost, createUser, enrolAndLogin, relaxRateLimits, testStartTime, type TestSession } from '../../support/iam';
import { startTestApp, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/** The B06u operations answer in the shapes of contract/openapi.yaml 1.27.0, over the seeded farm. */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let manager: TestSession;
const products = new Map<string, string>();
const v1 = (path: string) => `/v1${path}`;

function expectShape(schema: string, body: unknown): void {
  const validate = contractSchema(schema);
  expect(validate(body), `${schema}: ${JSON.stringify(validate.errors)}`).toBe(true);
}

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock });
  await runSeedUnits(database.pool('app'), api.app, seedUnits({ SEED_STAFF_PASSWORD: `Seed-${randomUUID()}` }));
  for (const row of (await database.pool('admin').query<{ sku: string; id: string }>('SELECT sku, id FROM mdm.product')).rows) products.set(row.sku, row.id);
  const branchId = (await database.pool('admin').query<{ id: string }>("SELECT id FROM mdm.branch WHERE code = 'DDW'")).rows[0]!.id;
  manager = await enrolAndLogin(api.server, await createUser(database, { name: 'Akosua Boateng', grants: [{ role: 'MANAGER', branchId }] }), () => clock.now());
});

afterAll(async () => {
  await api.close();
  await database.drop();
});

describe('B06u operations answer in the contract shapes', () => {
  it('lists the seeded farm conversions: three egg crates of 30 (A-261), two feed bags and a crate of cabbages, counted by hand', async () => {
    const listed = await consoleGet(api.server, manager, v1('/uom-conversions'));
    expect(listed.status).toBe(200);
    expectShape('UomConversionPage', listed.body);
    expect(listed.body.data.map((row: { product: { sku: string }; fromUom: string; toUom: string; factor: string }) => `${row.product.sku} ${row.fromUom}=${row.factor} ${row.toUom}`)).toEqual([
      'EGG-0001 CRATE=30.000 EGG',
      'EGG-0002 CRATE=30.000 EGG',
      'EGG-0003 CRATE=30.000 EGG',
      'FEED-0001 BAG=50.000 KG',
      'FEED-0002 BAG=25.000 KG',
      'PRD-0002 CRATE=24.000 UNIT',
    ]);
  });

  it('makes and archives a conversion, and refuses an inexact one in the error envelope', async () => {
    const made = await consolePost(api.server, manager, v1('/uom-conversions')).send({ productId: products.get('PRD-0006'), fromUom: 'CRATE', numerator: 40, denominator: 1 });
    expect(made.status).toBe(201);
    expectShape('UomConversion', made.body);
    const archived = await consolePost(api.server, manager, v1(`/uom-conversions/${made.body.id}/archive`)).send({ version: 1, reason: 'Traders now take crates of 36' });
    expect(archived.status).toBe(200);
    expectShape('UomConversion', archived.body);
    const refused = await consolePost(api.server, manager, v1('/uom-conversions')).send({ productId: products.get('PRD-0005'), fromUom: 'BAG', numerator: 1, denominator: 3 });
    expect(refused.status).toBe(422);
    expectShape('Error', refused.body);
    expect(refused.body.error).toMatchObject({ code: 'UOM_CONVERSION_INVALID', details: [{ field: '/denominator', code: 'INEXACT_FACTOR' }] });
  });
});
