import { randomUUID } from 'node:crypto';
import { ManualClock } from '@hakorem/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { contractSchema } from '../../support/contract-schemas';
import { consoleGet, consolePost, consolePut, createUser, enrolAndLogin, login, relaxRateLimits, testStartTime, type TestSession } from '../../support/iam';
import { startTestApp, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/** The B06 continued 3 operations answer in the shapes of contract/openapi.yaml 1.26.0, over the seeded farm. */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let manager: TestSession;
let approver: TestSession;
let farmHand: TestSession;
const ids = new Map<string, string>();
const id = (code: string) => ids.get(code)!;
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
  manager = await enrolAndLogin(api.server, await createUser(database, { name: 'Akosua Boateng', grants: [{ role: 'MANAGER', branchId: id('branch:DDW') }] }), () => clock.now());
  approver = await enrolAndLogin(api.server, await createUser(database, { name: 'Yaw Darko', grants: [{ role: 'MANAGER', branchId: id('branch:DDW') }] }), () => clock.now());
  farmHand = await login(api.server, await createUser(database, { name: 'Abena Quaye', grants: [{ role: 'FARM_HAND', branchId: id('branch:DDW') }] }));
});

afterAll(async () => {
  await api.close();
  await database.drop();
});

describe('B06 continued 3 operations answer in the contract shapes', () => {
  it('the care reads', async () => {
    expectShape('CareAnimalPage', (await consoleGet(api.server, farmHand, v1('/care/animals'))).body);
    expectShape('CareAnimal', (await consoleGet(api.server, farmHand, v1(`/care/animals/${id('unit:G-0142')}`))).body);
    expectShape('CareHealthEventPage', (await consoleGet(api.server, farmHand, v1('/care/health-events'))).body);
    expectShape('RationPage', (await consoleGet(api.server, farmHand, v1('/care/rations'))).body);
    expectShape('CareBatchPage', (await consoleGet(api.server, farmHand, v1('/care/batches'))).body);
  });

  it('packs, labels and a reversed order', async () => {
    const planned = await consolePost(api.server, manager, v1('/processing-orders')).send({
      locationId: id('location:PENS'),
      outputLocationId: id('location:COLD'),
      inputs: [{ stockUnitId: id('unit:G-0142'), weightKg: '30.000', weightSource: 'SCALE' }],
    });
    const orderId = planned.body.id as string;
    await consolePost(api.server, manager, v1(`/processing-orders/${orderId}/start`)).send({});
    const version = (await consoleGet(api.server, manager, v1(`/processing-orders/${orderId}`))).body.version as number;
    await consolePut(api.server, manager, v1(`/processing-orders/${orderId}/outputs`)).send({
      version,
      outputs: [
        { productId: id('product:MEAT-0007'), outputKind: 'MEAT', weightKg: '14.600', weightSource: 'SCALE' },
        { productId: id('product:MEAT-0008'), outputKind: 'WASTE', weightKg: '9.000', weightSource: 'MANUAL' },
      ],
    });
    expect((await consolePost(api.server, manager, v1(`/processing-orders/${orderId}/complete`)).send({})).status).toBe(200);
    const packed = await consolePost(api.server, manager, v1(`/processing-orders/${orderId}/packs`)).send({ outputLineNo: 1, packs: [{ weightKg: '14.600', weightSource: 'SCALE' }] });
    expect(packed.status).toBe(201);
    expectShape('PackList', packed.body);
    expectShape('PackPage', (await consoleGet(api.server, manager, v1(`/processing-orders/${orderId}/packs`))).body);
    const labels = await consolePost(api.server, manager, v1(`/processing-orders/${orderId}/labels`)).send({ packIds: [packed.body.packs[0].id] });
    expect(labels.status).toBe(200);
    expectShape('PackLabelSheet', labels.body);
    // At or above the adjustment threshold the reversal waits for a second approver (B06r, A-176).
    const asked = await consolePost(api.server, manager, v1(`/processing-orders/${orderId}/cancel`)).send({ reason: 'Wrong goat slaughtered' });
    expect(asked.status).toBe(202);
    expectShape('ApprovalPending', asked.body);
    const waiting = await consoleGet(api.server, manager, v1(`/processing-orders/${orderId}`));
    expectShape('ProcessingOrder', waiting.body);
    expect(waiting.body.pendingReversal).not.toBeNull();
    expect((await consolePost(api.server, approver, v1(`/iam/approvals/${asked.body.approvalRequestId as string}/approve`)).send({})).status).toBe(200);
    const reversed = await consoleGet(api.server, manager, v1(`/processing-orders/${orderId}`));
    expectShape('ProcessingOrder', reversed.body);
    expect(reversed.body.reversal).not.toBeNull();
  });
});
