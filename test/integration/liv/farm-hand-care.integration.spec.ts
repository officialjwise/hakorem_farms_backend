import { randomUUID } from 'node:crypto';
import { ManualClock, toBusinessDate } from '@hakorem/kernel';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PLANNED_PATH, PUBLISHED_PATH, readYaml } from '../../../scripts/contract/generate';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { contractSchema } from '../../support/contract-schemas';
import { consoleGet, consolePost, createUser, enrolAndLogin, login, relaxRateLimits, testStartTime, type TestSession } from '../../support/iam';
import { startTestApp, TEST_ORIGIN, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * The owner's Farm hand decision (2026-11-15, A-158 as decided, A-160, ADR-0052), over the real API on the seeded farm:
 * the Vet or Farm hand reads the animal register, the rations, the batches and above all the health events with their
 * withdrawal holds, so that a treated animal is never sent to slaughter or sale; and never a cost. One test walks every
 * LIV and PRC operation of the published contract that the role's grants reach and asserts that no response schema, no
 * example and no live answer carries a cost or a pesewa field; the operations whose full answer carries cost refuse the
 * role, which works through the cost-free care operations instead.
 */
type Json = { [key: string]: unknown };
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let manager: TestSession;
let farmHand: TestSession;
const ids = new Map<string, string>();
const id = (code: string) => ids.get(code)!;
const v1 = (path: string) => `/v1${path}`;
const COST = /pesewas|cost/i;
const DAY = 86_400_000;

function send(session: TestSession, method: string, path: string, body?: object): Promise<Response> {
  if (method === 'GET') return consoleGet(api.server, session, v1(path));
  if (method === 'POST') return consolePost(api.server, session, v1(path)).send(body ?? {});
  const verb = method === 'PUT' ? request(api.server).put(v1(path)) : request(api.server).patch(v1(path));
  return verb
    .set('Cookie', session.jar.header())
    .set('X-CSRF-Token', session.csrfToken)
    .set('Origin', TEST_ORIGIN)
    .set('Idempotency-Key', randomUUID())
    .send(body ?? {});
}

async function refresh(): Promise<void> {
  for (const row of (
    await database.pool('admin').query<{ code: string; id: string }>(
      `SELECT 'branch:' || code AS code, id FROM mdm.branch
       UNION ALL SELECT 'location:' || l.code, l.id FROM mdm.location l JOIN mdm.branch b ON b.id = l.branch_id WHERE b.code = 'DDW'
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

/** Every key path under a value whose name says cost or pesewas. */
function costKeys(value: unknown, path = '$'): string[] {
  if (Array.isArray(value)) return value.flatMap((item, index) => costKeys(item, `${path}[${index}]`));
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value).flatMap(([key, inner]) => [...(COST.test(key) ? [`${path}.${key}`] : []), ...costKeys(inner, `${path}.${key}`)]);
}

/** Every property a response schema can carry, through every reference, whose name says cost or pesewas. */
function schemaCostFields(schemas: Json, schema: unknown, seen = new Set<string>(), path = ''): string[] {
  if (typeof schema !== 'object' || schema === null) return [];
  const s = schema as Json;
  if (typeof s['$ref'] === 'string') {
    const name = s['$ref'].split('/').pop()!;
    if (seen.has(name)) return [];
    seen.add(name);
    return schemaCostFields(schemas, schemas[name], seen, `${path}>${name}`);
  }
  const out: string[] = [];
  for (const key of ['allOf', 'oneOf', 'anyOf']) for (const part of (s[key] as unknown[] | undefined) ?? []) out.push(...schemaCostFields(schemas, part, seen, path));
  if (s['items'] !== undefined) out.push(...schemaCostFields(schemas, s['items'], seen, `${path}[]`));
  for (const [key, inner] of Object.entries((s['properties'] as Json | undefined) ?? {})) {
    if (COST.test(key)) out.push(`${path}.${key}`);
    out.push(...schemaCostFields(schemas, inner, seen, `${path}.${key}`));
  }
  return out;
}

interface ContractOperation {
  readonly operationId: string;
  readonly method: string;
  readonly path: string;
  readonly permission: string | null;
  readonly answerPermission: string | null;
  readonly successes: ReadonlyArray<{ readonly status: string; readonly schema: unknown; readonly example: unknown }>;
}

function livAndPrcOperations(): ContractOperation[] {
  const document = readYaml(PUBLISHED_PATH) as Json;
  const found: ContractOperation[] = [];
  for (const [path, item] of Object.entries(document['paths'] as Json)) {
    for (const [method, raw] of Object.entries(item as Json)) {
      const operation = raw as Json;
      const tags = (operation['tags'] as string[] | undefined) ?? [];
      if (!tags.includes('liv') && !tags.includes('prc')) continue;
      const successes = Object.entries((operation['responses'] as Json | undefined) ?? {})
        .filter(([status]) => status.startsWith('2'))
        .map(([status, response]) => {
          const content = ((response as Json)['content'] as Json | undefined)?.['application/json'] as Json | undefined;
          return { status, schema: content?.['schema'], example: content?.['example'] };
        });
      found.push({
        operationId: operation['operationId'] as string,
        method: method.toUpperCase(),
        path,
        permission: (operation['x-permission'] as string | undefined) ?? null,
        answerPermission: (operation['x-answer-permission'] as string | undefined) ?? null,
        successes,
      });
    }
  }
  return found;
}

let rationId: string;
let breedingId: string;
let failingId: string;
let mortalityId: string;
let confirmationId: string;
let healthEventId: string;
let hatchVersion = 1;

/** A live call for each operation the Farm hand reaches, on the seeded farm and the animals received below. */
const calls: Record<string, () => Promise<Response>> = {
  listWeightRecords: () => send(farmHand, 'GET', `/weight-records?stockUnitId=${id('unit:CARE-G1')}`),
  recordWeights: () =>
    send(farmHand, 'POST', '/weight-records', { records: [{ id: randomUUID(), stockUnitId: id('unit:CARE-G1'), weightKg: '21.400', weightSource: 'SCALE', headWeighed: 1, measuredAt: clock.now().toISOString() }] }),
  listGrowth: () => send(farmHand, 'GET', `/livestock/growth?groupBy=PEN&from=${toBusinessDate(new Date(clock.now().getTime() - 30 * DAY))}&to=${toBusinessDate(clock.now())}`),
  listBreedingRecords: () => send(farmHand, 'GET', '/breeding-records'),
  createBreedingRecord: async () => {
    const created = await send(farmHand, 'POST', '/breeding-records', { damId: id('unit:CARE-D1'), sireId: id('unit:CARE-S1'), matedOn: toBusinessDate(new Date(clock.now().getTime() - 150 * DAY)) });
    breedingId = created.body.id as string;
    return created;
  },
  getBreedingRecord: () => send(farmHand, 'GET', `/breeding-records/${breedingId}`),
  updateBreedingRecord: () => send(farmHand, 'PATCH', `/breeding-records/${breedingId}`, { version: 1, status: 'CONFIRMED' }),
  recordBirth: () =>
    send(farmHand, 'POST', `/breeding-records/${breedingId}/record-birth`, {
      actualBirthOn: toBusinessDate(clock.now()),
      litterSize: 1,
      offspring: [{ tagNo: 'CARE-K1', sex: 'FEMALE', weightKg: '2.050', weightSource: 'SCALE' }],
    }),
  failBreedingRecord: async () => {
    const created = await send(farmHand, 'POST', '/breeding-records', { damId: id('unit:CARE-D2'), sireId: id('unit:CARE-S1'), matedOn: toBusinessDate(new Date(clock.now().getTime() - 20 * DAY)) });
    failingId = created.body.id as string;
    return send(farmHand, 'POST', `/breeding-records/${failingId}/fail`, { reason: 'Came back on heat at three weeks' });
  },
  listCareAnimals: () => send(farmHand, 'GET', '/care/animals'),
  getCareAnimal: () => send(farmHand, 'GET', `/care/animals/${id('unit:CARE-G1')}`),
  getCareAnimalByTag: () => send(farmHand, 'GET', '/care/animal-tags/CARE-G1'),
  updateCareAnimal: async () => {
    const goat = await send(farmHand, 'GET', `/care/animals/${id('unit:CARE-G2')}`);
    return send(farmHand, 'PATCH', `/care/animals/${id('unit:CARE-G2')}`, { version: goat.body.version, breed: 'Sahelian cross' });
  },
  moveCareAnimal: () => send(farmHand, 'POST', `/care/animals/${id('unit:CARE-G2')}/move`, { toLocationId: id('location:PEN-CARE2'), note: 'Separated for finishing' }),
  listCareHealthEvents: () => send(farmHand, 'GET', `/care/health-events?stockUnitId=${id('unit:CARE-G1')}`),
  getCareHealthEvent: () => send(farmHand, 'GET', `/care/health-events/${healthEventId}`),
  recordCareHealthEvent: () =>
    send(farmHand, 'POST', '/care/health-events', { kind: 'DEWORMING', stockUnitId: id('unit:CARE-G2'), productId: id('product:MED-ALBENDAZOLE'), qtyUsed: '0.010', occurredAt: clock.now().toISOString() }),
  listCareRations: () => send(farmHand, 'GET', '/care/rations'),
  recordCareFeedConsumption: () =>
    send(farmHand, 'POST', '/care/feed-consumption', { locationId: id('location:PEN-CARE'), feedProductId: id('product:FEED-GOAT-CONC'), qty: '2.000', consumedOn: toBusinessDate(clock.now()), rationId }),
  listCareBatches: () => send(farmHand, 'GET', '/care/batches'),
  getCareBatch: () => send(farmHand, 'GET', `/care/batches/${id('batch:CARE-BRL')}`),
  createCareBatch: async () => {
    const hatched = await send(farmHand, 'POST', '/care/batches', {
      batchNo: 'CARE-HATCH',
      speciesId: id('species:BROILER'),
      startedOn: toBusinessDate(clock.now()),
      initialHead: 12,
      purpose: 'GROWING',
      locationId: id('location:PEN-CARE-BR'),
    });
    await refresh();
    return hatched;
  },
  updateCareBatch: async () => {
    const updated = await send(farmHand, 'PATCH', `/care/batches/${id('batch:CARE-HATCH')}`, { version: hatchVersion, purpose: 'LAYING' });
    hatchVersion = (updated.body.version as number | undefined) ?? hatchVersion;
    return updated;
  },
  reportCareMortality: async () => {
    const reported = await send(farmHand, 'POST', '/care/mortality-records', { kind: 'DEATH', stockUnitId: id('unit:CARE-HATCH'), head: 12, reasonCode: 'UNKNOWN_CAUSE', foundAt: clock.now().toISOString() });
    mortalityId = reported.body.id as string;
    return reported;
  },
  submitCareMortalityRecord: async () => {
    // The Farm hand never writes stock off alone (owner, 2026-11-15; B06r): below the threshold a supervisor confirms.
    const submitted = await send(farmHand, 'POST', `/care/mortality-records/${mortalityId}/submit`);
    confirmationId = submitted.body.approvalRequestId as string;
    return submitted;
  },
  closeCareBatch: async () => {
    const confirmed = await send(manager, 'POST', `/iam/approvals/${confirmationId}/approve`, { reason: 'Saw the hatch at the house' });
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
    return send(farmHand, 'POST', `/care/batches/${id('batch:CARE-HATCH')}/close`, { reason: 'Whole hatch lost in the first week' });
  },
};

/** The order the walk calls them in: each write after the reads it would change, each read after what it reads. */
const ORDER = Object.keys(calls);

async function receive(locationCode: string, lines: object[]): Promise<void> {
  const created = await send(manager, 'POST', '/goods-receipts', {
    kind: 'PURCHASE',
    supplierId: id('supplier:Kpone Livestock Traders (SEED)'),
    locationId: id(`location:${locationCode}`),
    deliveryNoteRef: `CARE-${randomUUID().slice(0, 8)}`,
    receivedAt: new Date(clock.now().getTime() - 40 * DAY).toISOString(),
    lines,
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const posted = await send(manager, 'POST', `/goods-receipts/${created.body.id as string}/post`);
  expect(posted.status, JSON.stringify(posted.body)).toBe(200);
  await refresh();
}

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock });
  await runSeedUnits(database.pool('app'), api.app, seedUnits({ SEED_STAFF_PASSWORD: `Seed-${randomUUID()}` }));
  await refresh();
  const branchId = id('branch:DDW');
  manager = await enrolAndLogin(api.server, await createUser(database, { name: 'Akosua Boateng', grants: [{ role: 'MANAGER', branchId }] }), () => clock.now());
  farmHand = await login(api.server, await createUser(database, { name: 'Abena Quaye', grants: [{ role: 'FARM_HAND', branchId }] }));
  for (const [code, name] of [
    ['PEN-CARE', 'Goat pen 4'],
    ['PEN-CARE2', 'Goat pen 5'],
    ['PEN-CARE-BR', 'Broiler house 4'],
  ] as const) {
    expect((await send(manager, 'POST', '/locations', { branchId, code, name, kind: 'PEN' })).status).toBe(201);
  }
  await refresh();
  await receive('PEN-CARE', [
    {
      productId: id('product:LIV-GOAT'),
      qtyReceived: '5.000',
      valuePesewas: 200_000,
      animals: [
        { tagNo: 'CARE-G1', sex: 'MALE', breed: 'West African Dwarf', purpose: 'GROWING' },
        { tagNo: 'CARE-G2', sex: 'MALE', breed: 'West African Dwarf', purpose: 'GROWING' },
        { tagNo: 'CARE-D1', sex: 'FEMALE', breed: 'West African Dwarf', purpose: 'BREEDING' },
        { tagNo: 'CARE-D2', sex: 'FEMALE', breed: 'West African Dwarf', purpose: 'BREEDING' },
        { tagNo: 'CARE-S1', sex: 'MALE', breed: 'West African Dwarf', purpose: 'BREEDING' },
      ],
    },
  ]);
  await receive('PEN-CARE-BR', [{ productId: id('product:LIV-BROILER'), qtyReceived: '30.000', valuePesewas: 60_000, batchNo: 'CARE-BRL' }]);
  const rations = await send(manager, 'GET', `/rations?speciesId=${id('species:GOAT')}`);
  rationId = (rations.body.data as Array<{ id: string }>)[0]!.id;
});

afterAll(async () => {
  await api.close();
  await database.drop();
});

describe('the Farm hand reads animal work without cost (owner, 2026-11-15; A-160)', () => {
  it('reads a treated goat\'s withdrawal hold and its end, in the register and in the health event, with no cost', async () => {
    const treatedAt = new Date(clock.now().getTime() - DAY);
    const treated = await send(manager, 'POST', '/health-events', {
      kind: 'TREATMENT',
      stockUnitId: id('unit:CARE-G1'),
      productId: id('product:MED-ALBENDAZOLE'),
      qtyUsed: '0.010',
      withdrawalDays: 28,
      costPesewas: 2_500,
      occurredAt: treatedAt.toISOString(),
    });
    expect(treated.status, JSON.stringify(treated.body)).toBe(201);
    healthEventId = treated.body.id as string;
    const endsAt = new Date(treatedAt.getTime() + 28 * DAY).toISOString();
    expect(treated.body.withdrawalEndsAt).toBe(endsAt);

    const event = await send(farmHand, 'GET', `/care/health-events/${healthEventId}`);
    expect(event.status, JSON.stringify(event.body)).toBe(200);
    expect(event.body).toMatchObject({ id: healthEventId, kind: 'TREATMENT', withdrawalDays: 28, withdrawalEndsAt: endsAt, stockUnit: { identifier: 'CARE-G1' } });
    expect(event.body.holdsPlaced).toBe(1);
    expect(costKeys(event.body)).toEqual([]);

    const goat = await send(farmHand, 'GET', `/care/animals/${id('unit:CARE-G1')}`);
    expect(goat.status, JSON.stringify(goat.body)).toBe(200);
    expect(goat.body).toMatchObject({ tagNo: 'CARE-G1', status: 'ALIVE', withdrawalUntil: endsAt, sellable: false });
    expect(costKeys(goat.body)).toEqual([]);

    const listed = await send(farmHand, 'GET', `/care/health-events?stockUnitId=${id('unit:CARE-G1')}`);
    expect(listed.body.data).toEqual([expect.objectContaining({ id: healthEventId, withdrawalEndsAt: endsAt })]);
    expect(costKeys(listed.body)).toEqual([]);

    // The full answers, which carry the cost, refuse the role; the manager still sees the cost there.
    expect((await send(farmHand, 'GET', `/health-events/${healthEventId}`)).status).toBe(403);
    expect((await send(farmHand, 'GET', `/animals/${id('unit:CARE-G1')}`)).status).toBe(403);
    expect((await send(manager, 'GET', `/health-events/${healthEventId}`)).body.costPesewas).toBeGreaterThan(0);
  });

  it('walks every LIV and PRC operation the role\'s grants reach: no response schema, example or live answer carries a cost or pesewa field', async () => {
    const granted = new Set(
      (await database.pool('admin').query<{ code: string }>("SELECT rp.permission_code AS code FROM iam.role_permission rp JOIN iam.role r ON r.id = rp.role_id WHERE r.code = 'FARM_HAND'")).rows.map(
        (r) => r.code,
      ),
    );
    const document = readYaml(PUBLISHED_PATH) as Json;
    const schemas = (document['components'] as Json)['schemas'] as Json;
    const operations = livAndPrcOperations();
    expect(operations.length).toBeGreaterThan(40);

    const reached = operations.filter((o) => o.permission !== null && granted.has(o.permission) && (o.answerPermission === null || granted.has(o.answerPermission)));
    const statically = reached.flatMap((o) =>
      o.successes.flatMap((s) => [...schemaCostFields(schemas, s.schema).map((f) => `${o.operationId} ${s.status} schema ${f}`), ...costKeys(s.example).map((k) => `${o.operationId} ${s.status} example ${k}`)]),
    );
    expect(statically).toEqual([]);
    expect(reached.map((o) => o.operationId).sort()).toEqual(Object.keys(calls).sort());

    // Each one answers live without cost, in the shape the contract publishes for it.
    const byId = new Map(reached.map((o) => [o.operationId, o]));
    for (const operationId of ORDER) {
      const response = await calls[operationId]!();
      expect(response.status, `${operationId}: ${JSON.stringify(response.body)}`).toBeLessThan(300);
      expect(costKeys(response.body), operationId).toEqual([]);
      const declared = byId.get(operationId)!.successes.find((s) => s.status === String(response.status));
      const ref = (declared?.schema as Json | undefined)?.['$ref'];
      expect(typeof ref, `${operationId} answers ${response.status}, which its contract declares with a schema`).toBe('string');
      const validate = contractSchema((ref as string).split('/').pop()!);
      expect(validate(response.body), `${operationId}: ${JSON.stringify(validate.errors)}`).toBe(true);
    }

    // An operation the role holds the permission for but whose full answer carries cost refuses it (403), before it
    // does anything: the care operation is the door.
    const refused = operations.filter((o) => o.permission !== null && granted.has(o.permission) && o.answerPermission !== null && !granted.has(o.answerPermission));
    expect(refused.map((o) => o.operationId).sort()).toEqual(
      ['closeBatch', 'createBatch', 'moveAnimal', 'recordFeedConsumption', 'recordHealthEvent', 'reportMortality', 'submitMortalityRecord', 'updateAnimal', 'updateBatch'].sort(),
    );
    const bodies: Record<string, [string, object]> = {
      updateAnimal: [`/animals/${id('unit:CARE-G1')}`, { version: 1, breed: 'Sahelian cross' }],
      moveAnimal: [`/animals/${id('unit:CARE-G1')}/move`, { toLocationId: id('location:PEN-CARE2') }],
      createBatch: ['/batches', { batchNo: 'CARE-NO', speciesId: id('species:BROILER'), startedOn: toBusinessDate(clock.now()), initialHead: 5, purpose: 'GROWING', locationId: id('location:PEN-CARE-BR') }],
      updateBatch: [`/batches/${id('batch:CARE-BRL')}`, { version: 1, purpose: 'LAYING' }],
      closeBatch: [`/batches/${id('batch:CARE-BRL')}/close`, { reason: 'Sold out' }],
      recordHealthEvent: ['/health-events', { kind: 'DEWORMING', stockUnitId: id('unit:CARE-G1'), productId: id('product:MED-ALBENDAZOLE'), qtyUsed: '0.010', occurredAt: clock.now().toISOString() }],
      recordFeedConsumption: ['/feed-consumption', { locationId: id('location:PEN-CARE'), feedProductId: id('product:FEED-GOAT-CONC'), qty: '1.000', consumedOn: toBusinessDate(clock.now()) }],
      reportMortality: ['/mortality-records', { kind: 'DEATH', stockUnitId: id('unit:CARE-BRL'), head: 1, reasonCode: 'UNKNOWN_CAUSE', foundAt: clock.now().toISOString() }],
      submitMortalityRecord: [`/mortality-records/${mortalityId}/submit`, {}],
    };
    for (const operation of refused) {
      const [path, body] = bodies[operation.operationId]!;
      const response = await send(farmHand, operation.method, path, body);
      expect(response.status, `${operation.operationId}: ${JSON.stringify(response.body)}`).toBe(403);
      expect(response.body.error.code).toBe('FORBIDDEN');
    }

    // Every other LIV and PRC operation is refused: death records, the cost reads, rations management, and all of PRC.
    // An operation still only planned has no route yet, so there is nothing to refuse.
    const planned = new Set(
      Object.values((readYaml(PLANNED_PATH) as Json)['paths'] as Json).flatMap((item) => Object.values(item as Json).map((operation) => (operation as Json)['operationId'] as string)),
    );
    const unreached = operations.filter((o) => (o.permission === null || !granted.has(o.permission)) && !planned.has(o.operationId));
    expect(unreached.filter((o) => o.operationId.startsWith('listMortality') || o.operationId === 'getMortalityRecord').length).toBe(2);
    for (const operation of unreached.filter((o) => o.method === 'GET')) {
      const path = operation.path.replace('{id}', randomUUID());
      expect((await send(farmHand, 'GET', path)).status, operation.operationId).toBe(403);
    }
  });
});
