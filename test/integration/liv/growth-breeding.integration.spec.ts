import { randomUUID } from 'node:crypto';
import { ManualClock, Quantity, toBusinessDate } from '@hakorem/kernel';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Stock } from '../../../src/modules/inv';
import { runAsSystem } from '../../../src/platform/context/request-context';
import { UnitOfWork } from '../../../src/platform/database/unit-of-work';
import { DocumentRegistry } from '../../../src/platform/documents/document-registry';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { consoleGet, consolePost, createUser, enrolAndLogin, login, relaxRateLimits, SYSTEM_PRINCIPAL, testStartTime, type RoleCode, type TestSession } from '../../support/iam';
import { startTestApp, TEST_ORIGIN, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * The B06 continued 2 gate (FR-LIV-002, FR-LIV-003, FR-LIV-005, FR-LIV-006, FR-LIV-010, FR-LIV-011, FR-LIV-016; ADR-0018),
 * over the real API on the seeded farm: every remaining LIV write refuses the wrong role; a move starts only where the
 * animal is and changes no cost; average daily gain and feed conversion match a hand calculation; a batch closes only
 * when empty; a birth registers each live offspring at nil cost linked to its dam, and refuses a dam that was not alive
 * and female. The feed comes from the seeded store (the seed's feed, medicine and rations, counted by hand in the B5
 * and B05x gates). Every date is set back from now, so the window of the growth report needs no jump of the clock.
 */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let manager: TestSession;
let storekeeper: TestSession;
let farmHand: TestSession;
let farmHandUser: Awaited<ReturnType<typeof createUser>>;
let accountant: TestSession;
const wrong = new Map<string, TestSession>();
const ids = new Map<string, string>();
const id = (code: string) => ids.get(code)!;
const v1 = (path: string) => `/v1${path}`;
const post = (session: TestSession, path: string, body: object = {}) => consolePost(api.server, session, v1(path)).send(body);
const get = (session: TestSession, path: string) => consoleGet(api.server, session, v1(path));
const patch = (session: TestSession, path: string, body: object) =>
  request(api.server).patch(v1(path)).set('Cookie', session.jar.header()).set('X-CSRF-Token', session.csrfToken).set('Origin', TEST_ORIGIN).set('Idempotency-Key', randomUUID()).send(body);
const admin = () => database.pool('admin');
const DAY = 86_400_000;
const daysAgo = (days: number) => new Date(clock.now().getTime() - days * DAY);
const dayOf = (days: number) => toBusinessDate(daysAgo(days));
const poolOf = async (unit: string) =>
  (await admin().query<{ value: string }>('SELECT value_pesewas::text AS value FROM inv.cost_pool WHERE stock_unit_id = $1', [id(`unit:${unit}`)])).rows[0]?.value;
/** The growth report's window: thirty days, ending nine days ago. */
let FROM: string;
let TO: string;

async function refresh(): Promise<void> {
  for (const row of (
    await admin().query<{ code: string; id: string }>(
      `SELECT 'branch:' || code AS code, id FROM mdm.branch
       UNION ALL SELECT 'location:' || l.code, l.id FROM mdm.location l JOIN mdm.branch b ON b.id = l.branch_id WHERE b.code = 'DDW'
       UNION ALL SELECT 'virtual:' || l.kind, l.id FROM mdm.location l JOIN mdm.branch b ON b.id = l.branch_id WHERE b.code = 'DDW' AND l.is_virtual
       UNION ALL SELECT 'product:' || sku, id FROM mdm.product
       UNION ALL SELECT 'species:' || code, id FROM mdm.species
       UNION ALL SELECT 'supplier:' || name, id FROM mdm.supplier
       UNION ALL SELECT 'unit:' || identifier, id FROM inv.stock_unit
       UNION ALL SELECT 'batch:' || batch_no, id FROM liv.batch`,
    )
  ).rows) {
    ids.set(row.code, row.id);
  }
}

async function receive(locationCode: string, receivedAt: Date, lines: object[]): Promise<void> {
  const created = await post(manager, '/goods-receipts', {
    kind: 'PURCHASE',
    supplierId: id('supplier:Kpone Livestock Traders (SEED)'),
    locationId: id(`location:${locationCode}`),
    deliveryNoteRef: `LIV2-TEST-${randomUUID().slice(0, 8)}`,
    receivedAt: receivedAt.toISOString(),
    lines,
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const posted = await post(manager, `/goods-receipts/${created.body.id as string}/post`);
  expect(posted.status, JSON.stringify(posted.body)).toBe(200);
  await refresh();
}

/** A movement of a unit through INV's `Stock.postIn`, as a sale (B9b) or a forged move would post it; the refusal's code otherwise. */
async function postMovement(movementType: string, unit: string, product: string, from: string, to: string, qty: string): Promise<string> {
  return runAsSystem({ principalId: SYSTEM_PRINCIPAL, displayName: 'Movement test' }, randomUUID(), () =>
    api.app.get(UnitOfWork).run({ isolation: 'serializable' }, async (tx) => {
      const documentId = randomUUID();
      await api.app.get(DocumentRegistry).register(tx, { id: documentId, docType: 'STOCK_ADJUSTMENT', ownerModule: 'inv', branchId: id('branch:DDW'), actorId: SYSTEM_PRINCIPAL });
      const posted = await api.app.get(Stock).postIn(tx, SYSTEM_PRINCIPAL, {
        movementType,
        productId: id(`product:${product}`),
        stockUnitId: id(`unit:${unit}`),
        branchId: id('branch:DDW'),
        fromLocationId: id(from),
        toLocationId: id(to),
        qty: Quantity.parse(qty),
        sourceDocumentId: documentId,
        occurredAt: clock.now(),
      });
      return posted.id;
    }),
  ).catch((error: unknown) => (error as { code?: string }).code ?? String(error));
}

async function weigh(unit: string, kg: string, day: string, head = 1): Promise<void> {
  const weighed = await post(farmHand, '/weight-records', { records: [{ id: randomUUID(), stockUnitId: id(`unit:${unit}`), weightKg: kg, weightSource: 'SCALE', headWeighed: head, measuredAt: `${day}T07:00:00Z` }] });
  expect(weighed.status, JSON.stringify(weighed.body)).toBe(200);
}

async function feed(pen: string, sku: string, qty: string, consumedOn: string): Promise<{ allocations: Array<{ stockUnit: { identifier: string }; amountPesewas: number; treatment: string }> }> {
  // The Farm hand records feed through the care door, which answers without its value (A-160); the manager reads it.
  const fed = await post(farmHand, '/care/feed-consumption', { locationId: id(`location:${pen}`), feedProductId: id(`product:${sku}`), qty, consumedOn });
  expect(fed.status, JSON.stringify(fed.body)).toBe(201);
  return (await get(manager, `/feed-consumption/${fed.body.id as string}`)).body;
}

async function animal(tag: string): Promise<Record<string, unknown>> {
  return (await get(manager, `/animals/${id(`unit:${tag}`)}`)).body;
}

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock });
  await runSeedUnits(database.pool('app'), api.app, seedUnits({ SEED_STAFF_PASSWORD: `Seed-${randomUUID()}` }));
  await refresh();
  FROM = dayOf(39);
  TO = dayOf(9);
  const branchId = id('branch:DDW');
  manager = await enrolAndLogin(api.server, await createUser(database, { name: 'Akosua Boateng', grants: [{ role: 'MANAGER', branchId }] }), () => clock.now());
  accountant = await enrolAndLogin(api.server, await createUser(database, { name: 'Efua Asante', grants: [{ role: 'ACCOUNTANT', branchId }] }), () => clock.now());
  storekeeper = await login(api.server, await createUser(database, { name: 'Kwabena Owusu', grants: [{ role: 'STOREKEEPER', branchId }] }));
  farmHandUser = await createUser(database, { name: 'Abena Quaye', grants: [{ role: 'FARM_HAND', branchId }] });
  farmHand = await login(api.server, farmHandUser);
  for (const role of ['CASHIER', 'SALES', 'DRIVER', 'INVESTOR'] as const satisfies readonly RoleCode[]) {
    wrong.set(role, await login(api.server, await createUser(database, { name: `Wrong ${role.toLowerCase()}`, grants: [{ role, branchId }] })));
  }
  for (const [code, name] of [
    ['PEN-GR', 'Goat growing pen'],
    ['PEN-GR2', 'Goat pen 2'],
    ['PEN-BR', 'Broiler house 3'],
    ['PEN-BR2', 'Brooder house'],
  ] as const) {
    const location = await post(manager, '/locations', { branchId, code, name, kind: 'PEN' });
    expect(location.status, JSON.stringify(location.body)).toBe(201);
  }
  await refresh();
  // Two goats in the growing pen 41 days ago, before the window opens; a third joins 25 days ago, inside it. Two does
  // and a buck for breeding in pen 2. A flock of 20 broilers in house 3 before the window.
  await receive('PEN-GR', daysAgo(41), [
    {
      productId: id('product:LIV-GOAT'),
      qtyReceived: '2.000',
      valuePesewas: 100_000,
      animals: [
        { tagNo: 'GR-A', sex: 'MALE', breed: 'West African Dwarf', purpose: 'GROWING' },
        { tagNo: 'GR-B', sex: 'MALE', breed: 'West African Dwarf', purpose: 'GROWING' },
      ],
    },
  ]);
  // The breeding stock stands in pen 2 from the start, at 40,000 each, below the mortality threshold.
  await receive('PEN-GR2', daysAgo(41), [
    {
      productId: id('product:LIV-GOAT'),
      qtyReceived: '3.000',
      valuePesewas: 120_000,
      animals: [
        { tagNo: 'GR-D', sex: 'FEMALE', breed: 'West African Dwarf', purpose: 'BREEDING' },
        { tagNo: 'GR-S', sex: 'MALE', breed: 'West African Dwarf', purpose: 'BREEDING' },
        { tagNo: 'GR-E', sex: 'FEMALE', breed: 'West African Dwarf', purpose: 'BREEDING' },
      ],
    },
  ]);
  await receive('PEN-GR', daysAgo(25), [{ productId: id('product:LIV-GOAT'), qtyReceived: '1.000', valuePesewas: 50_000, animals: [{ tagNo: 'GR-C', sex: 'MALE', purpose: 'GROWING' }] }]);
  await receive('PEN-BR', daysAgo(41), [{ productId: id('product:LIV-BROILER'), qtyReceived: '20.000', valuePesewas: 40_000, batchNo: 'BRG-01' }]);
});

afterAll(async () => {
  await api.close();
  await database.drop();
});

describe('growth and feed conversion against a hand calculation (FR-LIV-005, FR-LIV-016)', () => {
  beforeAll(async () => {
    for (const tag of ['GR-A', 'GR-B']) {
      await weigh(tag, '18.000', FROM);
      await weigh(tag, '24.600', TO);
    }
    await weigh('GR-C', '20.000', dayOf(20));
    await weigh('GR-C', '30.000', TO);
    await weigh('BRG-01', '0.500', FROM, 10);
    await weigh('BRG-01', '2.500', TO, 10);
    // 33.000 kg of concentrate to the goats and 100.000 kg of grower to the broilers, both inside the window.
    await feed('PEN-GR', 'FEED-GOAT-CONC', '33.000', dayOf(20));
    await feed('PEN-BR', 'FEED-BRL-GROWER', '100.000', dayOf(20));
  });

  it('reports the growing pen over its two full-window goats: 0.220 kg a day, 13.200 kg gained on 33.000 kg of feed, 2.500', async () => {
    const report = await get(manager, `/livestock/growth?groupBy=PEN&from=${FROM}&to=${TO}&speciesId=${id('species:GOAT')}`);
    expect(report.status, JSON.stringify(report.body)).toBe(200);
    const pen = report.body.data.find((row: { group: { code: string } }) => row.group.code === 'PEN-GR');
    expect(pen).toEqual({
      group: { id: id('location:PEN-GR'), code: 'PEN-GR', name: 'Goat growing pen', kind: 'PEN' },
      species: expect.objectContaining({ code: 'GOAT' }),
      head: 2,
      startAverageKg: '18.000',
      endAverageKg: '24.600',
      averageDailyGainKg: '0.220',
      feedQty: '33.000',
      feedConversionRatio: '2.500',
      mortalityPercent: '0.00',
    });
  });

  it('reports the broiler batch over the window: 20 head, 0.067 kg a day, 40.000 kg gained on 100.000 kg of feed, 2.500', async () => {
    const report = await get(accountant, `/livestock/growth?groupBy=BATCH&from=${FROM}&to=${TO}`);
    expect(report.status).toBe(200);
    expect(report.body.data.find((row: { group: { code: string } }) => row.group.code === 'BRG-01')).toEqual({
      group: { id: id('batch:BRG-01'), code: 'BRG-01', name: 'BRG-01', kind: 'BATCH' },
      species: expect.objectContaining({ code: 'BROILER' }),
      head: 20,
      startAverageKg: '0.500',
      endAverageKg: '2.500',
      averageDailyGainKg: '0.067',
      feedQty: '100.000',
      feedConversionRatio: '2.500',
      mortalityPercent: '0.00',
    });
    const pens = await get(manager, `/livestock/growth?groupBy=PEN&from=${FROM}&to=${TO}&speciesId=${id('species:BROILER')}`);
    expect(pens.body.data.find((row: { group: { code: string } }) => row.group.code === 'PEN-BR')).toMatchObject({ head: 20, averageDailyGainKg: '0.067', feedConversionRatio: '2.500' });
  });

  it('pages the rows without losing or repeating one, and refuses a window that runs backwards', async () => {
    const whole = (await get(manager, `/livestock/growth?groupBy=PEN&from=${FROM}&to=${TO}`)).body.data as Array<{ group: { id: string }; species: { id: string } }>;
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: request.Response = await get(manager, `/livestock/growth?groupBy=PEN&from=${FROM}&to=${TO}&limit=1${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`);
      seen.push(...page.body.data.map((r: { group: { id: string }; species: { id: string } }) => `${r.group.id}|${r.species.id}`));
      cursor = page.body.page.nextCursor;
    } while (cursor !== null);
    expect(seen).toEqual(whole.map((r) => `${r.group.id}|${r.species.id}`));
    const backwards = await get(manager, `/livestock/growth?groupBy=PEN&from=${TO}&to=${FROM}`);
    expect(backwards.status).toBe(422);
    expect(backwards.body.error.details).toEqual([expect.objectContaining({ code: 'WINDOW_BACKWARDS' })]);
  });
});

describe('editing an animal (FR-LIV-002)', () => {
  it('changes purpose from GROWING to BREEDING, audited, so the next feed is expensed instead of capitalised', async () => {
    const before = await animal('GR-A');
    const edited = await patch(manager, `/animals/${id('unit:GR-A')}`, { version: before['version'], purpose: 'BREEDING', breed: 'Sahelian cross' });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    expect(edited.body).toMatchObject({ purpose: 'BREEDING', breed: 'Sahelian cross', version: (before['version'] as number) + 1 });
    const audit = await admin().query<{ before: { purpose: string }; after: { purpose: string } }>(
      "SELECT convert_from(before, 'UTF8')::jsonb AS before, convert_from(after, 'UTF8')::jsonb AS after FROM platform.audit_event WHERE entity_type = 'Animal' AND entity_id = $1 AND action = 'UPDATE' ORDER BY recorded_at",
      [id('unit:GR-A')],
    );
    expect(audit.rows.map((r) => [r.before.purpose, r.after.purpose])).toEqual([['GROWING', 'BREEDING']]);
    const poolA = await poolOf('GR-A');
    const fed = await feed('PEN-GR', 'FEED-GOAT-CONC', '3.000', toBusinessDate(clock.now()));
    expect(fed.allocations.map((a) => [a.stockUnit.identifier, a.treatment])).toEqual([
      ['GR-A', 'EXPENSED'],
      ['GR-B', 'CAPITALISED'],
      ['GR-C', 'CAPITALISED'],
    ]);
    expect(await poolOf('GR-A')).toBe(poolA);
  });

  it('refuses a fixed attribute in the request, a different tag, a stale version, and the database refuses a species change', async () => {
    const goat = await animal('GR-B');
    expect((await patch(manager, `/animals/${id('unit:GR-B')}`, { version: goat['version'], speciesId: id('species:SHEEP') })).status).toBe(400);
    expect((await patch(manager, `/animals/${id('unit:GR-B')}`, { version: goat['version'], acquisitionCostPesewas: 1 })).status).toBe(400);
    const retag = await patch(manager, `/animals/${id('unit:GR-B')}`, { version: goat['version'], tagNo: 'GR-B2' });
    expect(retag.status).toBe(422);
    expect(retag.body.error.details).toEqual([expect.objectContaining({ field: '/tagNo', code: 'TAG_NOT_EDITABLE' })]);
    expect((await patch(manager, `/animals/${id('unit:GR-B')}`, { version: (goat['version'] as number) + 5, breed: 'Sahelian' })).status).toBe(409);
    await expect(database.pool('app').query('UPDATE liv.animal SET species_id = $2, version = version + 1 WHERE stock_unit_id = $1', [id('unit:GR-B'), id('species:SHEEP')])).rejects.toMatchObject({ code: 'HK004' });
  });

  it("sets the grade on the animal's stock unit", async () => {
    const grade = (await admin().query<{ id: string }>("SELECT g.id FROM mdm.grade g JOIN mdm.species s ON s.id = g.species_id WHERE s.code = 'GOAT' ORDER BY g.code LIMIT 1")).rows[0]!.id;
    const goat = await animal('GR-B');
    const graded = await patch(storekeeper, `/animals/${id('unit:GR-B')}`, { version: goat['version'], gradeId: grade });
    expect(graded.status, JSON.stringify(graded.body)).toBe(200);
    expect(graded.body.grade).toMatchObject({ id: grade });
  });
});

describe('moving an animal between pens (FR-LIV-003)', () => {
  it('moves GR-B from the growing pen to pen 2 by one TRANSFER_INTERNAL movement, its cost unchanged, and shows it on the timeline', async () => {
    const cost = await poolOf('GR-B');
    const moved = await post(storekeeper, `/animals/${id('unit:GR-B')}/move`, { toLocationId: id('location:PEN-GR2'), note: 'Separated for the buyer to see' });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect(moved.body).toMatchObject({ currentLocation: { code: 'PEN-GR2' }, accumulatedCostPesewas: Number(cost) });
    expect(await poolOf('GR-B')).toBe(cost);
    const movements = await admin().query<{ type: string; from: string; to: string; value: string }>(
      "SELECT movement_type AS type, from_location_id AS from, to_location_id AS to, value_pesewas::text AS value FROM inv.stock_movement WHERE stock_unit_id = $1 AND movement_type = 'TRANSFER_INTERNAL'",
      [id('unit:GR-B')],
    );
    // The movement carries the animal's cost with it, from one pen to the other; the pool is the same before and after.
    expect(movements.rows).toEqual([{ type: 'TRANSFER_INTERNAL', from: id('location:PEN-GR'), to: id('location:PEN-GR2'), value: cost }]);
    const timeline = await get(manager, `/animals/${id('unit:GR-B')}/timeline?limit=100`);
    expect(timeline.status).toBe(200);
    const kinds = timeline.body.data.map((e: { kind: string }) => e.kind);
    expect(kinds[0]).toBe('ACQUIRED');
    expect(kinds).toEqual(expect.arrayContaining(['WEIGHED', 'COST_ADDED', 'MOVED']));
    expect(timeline.body.data.find((e: { kind: string }) => e.kind === 'MOVED')).toMatchObject({
      summary: 'Moved from Goat growing pen to Goat pen 2',
      document: { docType: 'ANIMAL_MOVE', number: null },
      actor: { displayName: 'Kwabena Owusu' },
      valuePesewas: null,
    });
    expect(timeline.body.data.filter((e: { kind: string }) => e.kind === 'WEIGHED').at(-1).summary).toBe('24.600 kg by scale; average daily gain 0.220 kg');
  });

  it('refuses a move to where the animal is, and the database refuses a movement from the pen it has left', async () => {
    const again = await post(manager, `/animals/${id('unit:GR-B')}/move`, { toLocationId: id('location:PEN-GR2') });
    expect(again.status).toBe(422);
    expect(again.body.error.details).toEqual([expect.objectContaining({ code: 'ALREADY_THERE' })]);
    expect(await postMovement('TRANSFER_INTERNAL', 'GR-B', 'LIV-GOAT', 'location:PEN-GR', 'location:PEN-GR2', '1.000')).toBe('STOCK_UNIT_NOT_AVAILABLE');
    const virtual = await post(manager, `/animals/${id('unit:GR-B')}/move`, { toLocationId: id('virtual:CUSTOMER') });
    expect(virtual.body.error.details).toEqual([expect.objectContaining({ code: 'NOT_A_PEN' })]);
  });

  it('moves an animal under a withdrawal hold, which blocks a sale but not a pen move', async () => {
    const treated = await post(farmHand, '/care/health-events', { kind: 'DEWORMING', stockUnitId: id('unit:GR-C'), productId: id('product:MED-ALBENDAZOLE'), qtyUsed: '0.010', occurredAt: daysAgo(0.01).toISOString() });
    expect(treated.status, JSON.stringify(treated.body)).toBe(201);
    expect((await animal('GR-C'))['sellable']).toBe(false);
    const moved = await post(manager, `/animals/${id('unit:GR-C')}/move`, { toLocationId: id('location:PEN-GR2') });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect(moved.body.currentLocation).toMatchObject({ code: 'PEN-GR2' });
  });
});

describe('batches (FR-LIV-006)', () => {
  it('opened the received flock as a batch of 20, and closes it only once its head is gone', async () => {
    const batch = (await get(manager, `/batches/${id('batch:BRG-01')}`)).body;
    expect(batch).toMatchObject({ batchNo: 'BRG-01', species: { code: 'BROILER' }, stockUnit: { identifier: 'BRG-01', tracking: 'LOT' }, initialHead: 20, currentHead: 20, purpose: 'GROWING', status: 'ACTIVE', location: { code: 'PEN-BR' }, mortalityPercent: '0.00' });
    // Two birds die: 2 of 20 head at a pool of 95,000 writes off 9,500, below the threshold, so it posts on submit.
    const reported = await post(farmHand, '/care/mortality-records', { kind: 'DEATH', stockUnitId: id('unit:BRG-01'), head: 2, reasonCode: 'UNKNOWN_CAUSE', foundAt: daysAgo(1).toISOString() });
    expect(reported.status, JSON.stringify(reported.body)).toBe(201);
    expect((await post(farmHand, `/care/mortality-records/${reported.body.id as string}/submit`)).status).toBe(200);
    const after = (await get(manager, `/batches/${id('batch:BRG-01')}`)).body;
    expect(after).toMatchObject({ currentHead: 18, mortalityPercent: '10.00', accumulatedCostPesewas: 85_500 });
    const early = await post(manager, `/batches/${id('batch:BRG-01')}/close`, { reason: 'House to be cleaned' });
    expect(early.status).toBe(422);
    expect(early.body.error.details).toEqual([expect.objectContaining({ code: 'BATCH_NOT_EMPTY' })]);
    expect(await postMovement('SALE_ISSUE', 'BRG-01', 'LIV-BROILER', 'location:PEN-BR', 'virtual:CUSTOMER', '18.000')).toMatch(/^[0-9a-f-]{36}$/);
    const closed = await post(manager, `/batches/${id('batch:BRG-01')}/close`, { reason: 'All birds sold' });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect(closed.body).toMatchObject({ status: 'CLOSED', currentHead: 0, accumulatedCostPesewas: 0, mortalityPercent: '10.00' });
    const twice = await post(manager, `/batches/${id('batch:BRG-01')}/close`, { reason: 'Again' });
    expect(twice.body.error.details).toEqual([expect.objectContaining({ code: 'BATCH_CLOSED' })]);
    await expect(database.pool('app').query("UPDATE liv.batch SET purpose = 'LAYING', version = version + 1 WHERE id = $1", [id('batch:BRG-01')])).rejects.toMatchObject({ code: 'HK004' });
  });

  it('hatches a flock into the brooder at nil cost by a BIRTH movement, and refuses a species with no flock product', async () => {
    const hatched = await post(storekeeper, '/batches', { batchNo: 'BRL-HATCH-01', speciesId: id('species:BROILER'), startedOn: toBusinessDate(clock.now()), initialHead: 50, purpose: 'GROWING', locationId: id('location:PEN-BR2') });
    expect(hatched.status, JSON.stringify(hatched.body)).toBe(201);
    expect(hatched.body).toMatchObject({ batchNo: 'BRL-HATCH-01', stockUnit: { identifier: 'BRL-HATCH-01', tracking: 'LOT' }, initialHead: 50, currentHead: 50, accumulatedCostPesewas: 0, location: { code: 'PEN-BR2' }, status: 'ACTIVE' });
    const birth = await admin().query<{ qty: string; value: string }>("SELECT qty_base::text AS qty, value_pesewas::text AS value FROM inv.stock_movement WHERE stock_unit_id = $1 AND movement_type = 'BIRTH'", [hatched.body.stockUnit.id]);
    expect(birth.rows).toEqual([{ qty: '50.000', value: '0' }]);
    const goats = await post(manager, '/batches', { batchNo: 'GOAT-GRP-1', speciesId: id('species:GOAT'), startedOn: toBusinessDate(clock.now()), initialHead: 5, purpose: 'GROWING', locationId: id('location:PEN-GR') });
    expect(goats.status).toBe(422);
    expect(goats.body.error.details).toEqual([expect.objectContaining({ code: 'NO_FLOCK_PRODUCT' })]);
    const taken = await post(manager, '/batches', { batchNo: 'BRL-HATCH-01', speciesId: id('species:BROILER'), startedOn: toBusinessDate(clock.now()), initialHead: 5, purpose: 'GROWING', locationId: id('location:PEN-BR2') });
    expect(taken.body.error.details).toEqual([expect.objectContaining({ code: 'BATCH_NO_TAKEN' })]);
  });

  it("changes a batch's purpose to LAYING, so feed to its flock is expensed, and lists the batches", async () => {
    await refresh();
    const batch = (await get(manager, `/batches/${id('batch:BRL-HATCH-01')}`)).body;
    const laying = await patch(manager, `/batches/${id('batch:BRL-HATCH-01')}`, { version: batch.version, purpose: 'LAYING' });
    expect(laying.status, JSON.stringify(laying.body)).toBe(200);
    expect(laying.body).toMatchObject({ purpose: 'LAYING', version: batch.version + 1 });
    const fed = await feed('PEN-BR2', 'FEED-BRL-GROWER', '5.000', toBusinessDate(clock.now()));
    expect(fed.allocations.map((a) => [a.stockUnit.identifier, a.treatment])).toEqual([['BRL-HATCH-01', 'EXPENSED']]);
    expect(await poolOf('BRL-HATCH-01')).toBe('0');
    const listed = await get(accountant, '/batches?status=ACTIVE');
    expect(listed.body.data.map((b: { batchNo: string }) => b.batchNo)).toEqual(expect.arrayContaining(['BRL-HATCH-01', 'BR-2026-1110']));
    expect(listed.body.data.map((b: { batchNo: string }) => b.batchNo)).not.toContain('BRG-01');
  });
});

describe('every remaining LIV write refuses the wrong role (ADR-0035)', () => {
  const writes = () => [
    ['PATCH', `/animals/${id('unit:GR-A')}`, { version: 1, breed: 'x' }],
    ['POST', `/animals/${id('unit:GR-A')}/move`, { toLocationId: id('location:PEN-GR') }],
    ['POST', '/batches', { batchNo: 'BRL-NO', speciesId: id('species:BROILER'), startedOn: '2026-11-01', initialHead: 5, purpose: 'GROWING', locationId: id('location:PEN-BR2') }],
    ['PATCH', `/batches/${id('batch:BRL-HATCH-01')}`, { version: 1, purpose: 'GROWING' }],
    ['POST', `/batches/${id('batch:BRL-HATCH-01')}/close`, { reason: 'x' }],
    ['POST', '/breeding-records', { damId: id('unit:GR-D'), matedOn: '2026-10-01' }],
    ['PATCH', `/breeding-records/${randomUUID()}`, { version: 1, status: 'CONFIRMED' }],
    ['POST', `/breeding-records/${randomUUID()}/record-birth`, { actualBirthOn: '2026-10-01', litterSize: 1, offspring: [] }],
    ['POST', `/breeding-records/${randomUUID()}/fail`, { reason: 'x' }],
  ] as const;
  const send = (session: TestSession, [method, path, body]: readonly [string, string, object]) => (method === 'PATCH' ? patch(session, path, body) : post(session, path, body));

  it('refuses the Cashier, Sales, Driver, Investor and Accountant every write', async () => {
    for (const [role, session] of [...wrong.entries(), ['ACCOUNTANT', accountant] as const]) {
      for (const write of writes()) {
        expect((await send(session, write)).status, `${role} ${write[0]} ${write[1]}`).toBe(403);
      }
    }
  });

  it('refuses the Storekeeper the batch purpose and close, which stay with the Manager and the Farm hand (FR-LIV-006)', async () => {
    for (const write of writes().slice(3, 5)) {
      expect((await send(storekeeper, write)).status, `STOREKEEPER ${write[0]} ${write[1]}`).toBe(403);
    }
  });

  it('lets the Farm hand read growth, batches and breeding, as the owner decided on 2026-11-15, and refuses the Cashier them', async () => {
    // Batches through the care door, without their cost (A-160); the full batch reads carry cost and refuse the role.
    for (const path of [`/livestock/growth?groupBy=PEN&from=${FROM}&to=${TO}`, '/care/batches', `/care/batches/${id('batch:BRL-HATCH-01')}`, '/breeding-records']) {
      expect((await get(farmHand, path)).status, path).toBe(200);
      expect((await get(wrong.get('CASHIER')!, path)).status, path).toBe(403);
    }
    for (const path of ['/batches', `/batches/${id('batch:BRL-HATCH-01')}`]) {
      expect((await get(farmHand, path)).status, path).toBe(403);
    }
    // The timeline is read with liv.animal.read and carries each movement's value, so the Farm hand is refused it.
    expect((await get(farmHand, `/animals/${id('unit:GR-A')}/timeline`)).status).toBe(403);
  });
});

describe('breeding and births (FR-LIV-010, FR-LIV-011)', () => {
  let mating: string;

  it('computes the expected birth from the goat gestation of 150 days and refuses a male, a dead and a non-breeding dam', async () => {
    const mated = await post(farmHand, '/breeding-records', { damId: id('unit:GR-D'), sireId: id('unit:GR-S'), matedOn: '2026-03-01' });
    expect(mated.status, JSON.stringify(mated.body)).toBe(201);
    expect(mated.body).toMatchObject({ dam: { tagNo: 'GR-D' }, sire: { tagNo: 'GR-S' }, matedOn: '2026-03-01', expectedBirthOn: '2026-07-28', status: 'MATED', offspring: [], version: 1 });
    mating = mated.body.id as string;
    const male = await post(farmHand, '/breeding-records', { damId: id('unit:GR-S'), matedOn: '2026-03-01' });
    expect(male.body.error.details).toEqual([expect.objectContaining({ code: 'DAM_NOT_FEMALE' })]);
    const broiler = await post(farmHand, '/breeding-records', { damId: id('unit:BRL-HATCH-01'), matedOn: '2026-03-01' });
    expect(broiler.status).toBe(422);
    const dead = (await admin().query<{ id: string }>("SELECT stock_unit_id AS id FROM liv.animal WHERE status <> 'ALIVE' AND sex = 'FEMALE' LIMIT 1")).rows[0];
    if (dead !== undefined) {
      expect((await post(manager, '/breeding-records', { damId: dead.id, matedOn: '2026-03-01' })).body.error.details).toEqual([expect.objectContaining({ code: 'DAM_NOT_ALIVE' })]);
    }
  });

  it('confirms the mating, then fixes the dam\'s sex', async () => {
    const confirmed = await patch(farmHand, `/breeding-records/${mating}`, { version: 1, status: 'CONFIRMED' });
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
    expect(confirmed.body).toMatchObject({ status: 'CONFIRMED', version: 2 });
    const back = await patch(farmHand, `/breeding-records/${mating}`, { version: 2, status: 'MATED' });
    expect(back.body.error.details).toEqual([expect.objectContaining({ code: 'STATUS_BACKWARDS' })]);
    const dam = await animal('GR-D');
    const resexed = await patch(manager, `/animals/${id('unit:GR-D')}`, { version: dam['version'], sex: 'MALE' });
    expect(resexed.status).toBe(422);
    expect(resexed.body.error.details).toEqual([expect.objectContaining({ code: 'SEX_FIXED_AS_DAM' })]);
    await expect(database.pool('app').query("UPDATE liv.animal SET sex = 'MALE', version = version + 1 WHERE stock_unit_id = $1", [id('unit:GR-D')])).rejects.toMatchObject({ code: 'HK004' });
  });

  it('registers 3 live kids of a litter of 4 at nil cost, linked to the dam, by BIRTH movements into her pen', async () => {
    const born = await post(farmHand, `/breeding-records/${mating}/record-birth`, {
      actualBirthOn: '2026-07-28',
      litterSize: 4,
      offspring: [
        { tagNo: 'GR-K1', sex: 'MALE', weightKg: '2.100', weightSource: 'SCALE' },
        { tagNo: 'GR-K2', sex: 'FEMALE' },
        { tagNo: 'GR-K3', sex: 'FEMALE' },
      ],
      notes: 'One kid stillborn',
    });
    expect(born.status, JSON.stringify(born.body)).toBe(200);
    expect(born.body).toMatchObject({ status: 'BORN', actualBirthOn: '2026-07-28', litterSize: 4, liveBirths: 3, notes: 'One kid stillborn', version: 3 });
    expect(born.body.offspring.map((o: { tagNo: string; sex: string }) => [o.tagNo, o.sex])).toEqual([
      ['GR-K1', 'MALE'],
      ['GR-K2', 'FEMALE'],
      ['GR-K3', 'FEMALE'],
    ]);
    await refresh();
    for (const tag of ['GR-K1', 'GR-K2', 'GR-K3']) {
      expect(await animal(tag)).toMatchObject({ source: 'BIRTH', status: 'ALIVE', dam: { tagNo: 'GR-D' }, sire: { tagNo: 'GR-S' }, accumulatedCostPesewas: 0, dateOfBirth: '2026-07-28', acquiredOn: '2026-07-28', currentLocation: { code: 'PEN-GR2' }, supplier: null });
    }
    expect((await animal('GR-K1'))['lastWeightKg']).toBe('2.100');
    const births = await admin().query<{ n: string; value: string }>(
      "SELECT count(*)::text AS n, coalesce(sum(value_pesewas), 0)::text AS value FROM inv.stock_movement WHERE source_document_id = $1 AND movement_type = 'BIRTH'",
      [mating],
    );
    expect(births.rows).toEqual([{ n: '3', value: '0' }]);
    const lineage = await admin().query<{ n: string }>("SELECT count(*)::text AS n FROM inv.stock_unit_lineage WHERE parent_unit_id = $1 AND link_type = 'BIRTH'", [id('unit:GR-D')]);
    expect(lineage.rows[0]!.n).toBe('3');
    expect((await admin().query<{ still: number }>('SELECT stillbirths AS still FROM liv.breeding_record WHERE id = $1', [mating])).rows[0]!.still).toBe(1);
    const timeline = await get(manager, `/animals/${id('unit:GR-D')}/timeline`);
    expect(timeline.body.data.map((e: { kind: string }) => e.kind)).toEqual(expect.arrayContaining(['MATED', 'GAVE_BIRTH']));
    expect((await get(manager, `/breeding-records?damId=${id('unit:GR-D')}`)).body.data).toHaveLength(1);
    expect((await post(farmHand, `/breeding-records/${mating}/record-birth`, { actualBirthOn: '2026-07-28', litterSize: 1, offspring: [] })).body.error.details).toEqual([expect.objectContaining({ code: 'RECORD_CLOSED' })]);
  });

  it('records a failed mating, and refuses a birth dated after the dam died', async () => {
    const mated = await post(farmHand, '/breeding-records', { damId: id('unit:GR-E'), sireId: id('unit:GR-S'), matedOn: dayOf(30) });
    expect(mated.status).toBe(201);
    const failed = await post(farmHand, `/breeding-records/${mated.body.id as string}/fail`, { reason: 'Came back on heat 21 days after mating' });
    expect(failed.status).toBe(200);
    expect(failed.body.status).toBe('FAILED');
    const again = await post(farmHand, '/breeding-records', { damId: id('unit:GR-E'), sireId: id('unit:GR-S'), matedOn: dayOf(20) });
    expect(again.status).toBe(201);
    const died = await post(farmHand, '/care/mortality-records', { kind: 'DEATH', stockUnitId: id('unit:GR-E'), reasonCode: 'UNKNOWN_CAUSE', foundAt: daysAgo(0.01).toISOString() });
    expect((await post(farmHand, `/care/mortality-records/${died.body.id as string}/submit`)).status).toBe(200);
    clock.advanceBy(2 * DAY);
    // Two days on, the session has lapsed; the Farm hand signs in again.
    farmHand = await login(api.server, farmHandUser);
    const late = await post(farmHand, `/breeding-records/${again.body.id as string}/record-birth`, { actualBirthOn: toBusinessDate(clock.now()), litterSize: 1, offspring: [{ tagNo: 'GR-K9', sex: 'MALE' }] });
    expect(late.status).toBe(422);
    expect(late.body.error.details).toEqual([expect.objectContaining({ code: 'DAM_NOT_ALIVE_ON_BIRTH' })]);
  });
});
