import { randomUUID } from 'node:crypto';
import { ManualClock, toBusinessDate } from '@hakorem/kernel';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { contractSchema } from '../../support/contract-schemas';
import { consoleGet, consolePost, createUser, enrolAndLogin, relaxRateLimits, testStartTime, type TestSession } from '../../support/iam';
import { startTestApp, TEST_ORIGIN, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/** The B06 continued 2 livestock operations answer in the shapes of contract/openapi.yaml 1.25.0, over the seeded farm. */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let manager: TestSession;
const ids = new Map<string, string>();
const id = (code: string) => ids.get(code)!;

function expectShape(schema: string, body: unknown): void {
  const validate = contractSchema(schema);
  expect(validate(body), `${schema}: ${JSON.stringify(validate.errors)}`).toBe(true);
}

const v1 = (path: string) => `/v1${path}`;
const get = (path: string) => consoleGet(api.server, manager, v1(path));
const post = (path: string, body: object = {}) => consolePost(api.server, manager, v1(path)).send(body);
const patch = (path: string, body: object) =>
  request(api.server).patch(v1(path)).set('Cookie', manager.jar.header()).set('X-CSRF-Token', manager.csrfToken).set('Origin', TEST_ORIGIN).set('Idempotency-Key', randomUUID()).send(body);

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock });
  await runSeedUnits(database.pool('app'), api.app, seedUnits({ SEED_STAFF_PASSWORD: `Seed-${randomUUID()}` }));
  for (const row of (
    await database.pool('admin').query<{ code: string; id: string }>(
      `SELECT 'branch:' || code AS code, id FROM mdm.branch
       UNION ALL SELECT 'unit:' || identifier, id FROM inv.stock_unit
       UNION ALL SELECT 'species:' || code, id FROM mdm.species
       UNION ALL SELECT 'location:' || l.code, l.id FROM mdm.location l JOIN mdm.branch b ON b.id = l.branch_id WHERE b.code = 'DDW'
       UNION ALL SELECT 'batch:' || batch_no, id FROM liv.batch`,
    )
  ).rows) {
    ids.set(row.code, row.id);
  }
  manager = await enrolAndLogin(api.server, await createUser(database, { name: 'Akosua Boateng', grants: [{ role: 'MANAGER', branchId: id('branch:DDW') }] }), () => clock.now());
});

afterAll(async () => {
  await api.close();
  await database.drop();
});

describe('B06 continued 2 operations answer in the contract shapes', () => {
  it('an edit, a move, the timeline and growth', async () => {
    const goat = (await get(`/animals/${id('unit:G-0142')}`)).body;
    const edited = await patch(`/animals/${id('unit:G-0142')}`, { version: goat.version, purpose: 'BREEDING' });
    expect(edited.status).toBe(200);
    expectShape('Animal', edited.body);
    const moved = await post(`/animals/${id('unit:G-0142')}/move`, { toLocationId: id('location:SHOP') });
    expect(moved.status).toBe(200);
    expectShape('Animal', moved.body);
    expectShape('AnimalEventPage', (await get(`/animals/${id('unit:G-0142')}/timeline`)).body);
    const today = toBusinessDate(clock.now());
    expectShape('GrowthRowPage', (await get(`/livestock/growth?groupBy=PEN&from=2026-11-01&to=${today}`)).body);
    expectShape('GrowthRowPage', (await get(`/livestock/growth?groupBy=BATCH&from=2026-11-01&to=${today}`)).body);
    const backwards = await get(`/livestock/growth?groupBy=PEN&from=${today}&to=2026-11-01`);
    expect(backwards.status).toBe(422);
    expectShape('Error', backwards.body);
  });

  it('the batches: the seeded flock, a hatch, a purpose change and a refused close', async () => {
    expectShape('BatchPage', (await get('/batches')).body);
    expectShape('Batch', (await get(`/batches/${id('batch:BR-2026-1110')}`)).body);
    const hatched = await post('/batches', { batchNo: 'BRL-2611-01', speciesId: id('species:BROILER'), startedOn: toBusinessDate(clock.now()), initialHead: 50, purpose: 'GROWING', locationId: id('location:PENS') });
    expect(hatched.status).toBe(201);
    expectShape('Batch', hatched.body);
    const laying = await patch(`/batches/${hatched.body.id as string}`, { version: hatched.body.version, purpose: 'LAYING' });
    expect(laying.status).toBe(200);
    expectShape('Batch', laying.body);
    const close = await post(`/batches/${hatched.body.id as string}/close`, { reason: 'House to be cleaned' });
    expect(close.status).toBe(422);
    expectShape('Error', close.body);
  });

  it('breeding: a mating, its confirmation, its birth and a failed mating', async () => {
    const doe = await post('/goods-receipts', {
      kind: 'PURCHASE',
      supplierId: (await database.pool('admin').query<{ id: string }>("SELECT id FROM mdm.supplier WHERE name = 'Kpone Livestock Traders (SEED)'")).rows[0]!.id,
      locationId: id('location:PENS'),
      receivedAt: new Date(clock.now().getTime() - 3_600_000).toISOString(),
      lines: [{ productId: (await database.pool('admin').query<{ id: string }>("SELECT id FROM mdm.product WHERE sku = 'LIV-0004'")).rows[0]!.id, qtyReceived: '2.000', valuePesewas: 80_000, animals: [{ tagNo: 'D-0501', sex: 'FEMALE', purpose: 'BREEDING' }, { tagNo: 'D-0502', sex: 'FEMALE', purpose: 'BREEDING' }] }],
    });
    expect(doe.status, JSON.stringify(doe.body)).toBe(201);
    expect((await post(`/goods-receipts/${doe.body.id as string}/post`)).status).toBe(200);
    const units = await database.pool('admin').query<{ identifier: string; id: string }>("SELECT identifier, id FROM inv.stock_unit WHERE identifier IN ('D-0501', 'D-0502')");
    const unit = (tag: string) => units.rows.find((r) => r.identifier === tag)!.id;
    const mated = await post('/breeding-records', { damId: unit('D-0501'), sireId: id('unit:G-0143'), matedOn: '2026-06-02' });
    expect(mated.status, JSON.stringify(mated.body)).toBe(201);
    expectShape('BreedingRecord', mated.body);
    const confirmed = await patch(`/breeding-records/${mated.body.id as string}`, { version: 1, status: 'CONFIRMED' });
    expectShape('BreedingRecord', confirmed.body);
    const born = await post(`/breeding-records/${mated.body.id as string}/record-birth`, { actualBirthOn: '2026-10-29', litterSize: 2, offspring: [{ tagNo: 'G-0181', sex: 'MALE', weightKg: '2.100', weightSource: 'SCALE' }] });
    expect(born.status, JSON.stringify(born.body)).toBe(200);
    expectShape('BreedingRecord', born.body);
    expectShape('BreedingRecord', (await get(`/breeding-records/${mated.body.id as string}`)).body);
    const other = await post('/breeding-records', { damId: unit('D-0502'), matedOn: '2026-09-01' });
    const failed = await post(`/breeding-records/${other.body.id as string}/fail`, { reason: 'Came back on heat 21 days after mating' });
    expectShape('BreedingRecord', failed.body);
    expectShape('BreedingRecordPage', (await get('/breeding-records')).body);
    const male = await post('/breeding-records', { damId: id('unit:G-0144'), matedOn: '2026-09-01' });
    expect(male.status).toBe(422);
    expectShape('Error', male.body);
  });
});
