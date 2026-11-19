import { randomUUID } from 'node:crypto';
import { ManualClock, toBusinessDate } from '@hakorem/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { StandingOrders } from '../../../src/modules/whl';
import { runAsSystem, type Actor } from '../../../src/platform/context/request-context';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { contractSchema } from '../../support/contract-schemas';
import { consoleGet, consolePatch, consolePost, createUser, enrolAndLogin, relaxRateLimits, SYSTEM_PRINCIPAL, testStartTime, type TestSession } from '../../support/iam';
import { issueInvoice } from '../../support/pay';
import { startTestApp, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/** WHL's standing orders and the bad-debt write-off (B10 continued 3) answer in the shapes of contract/openapi.yaml 2.18.0. */
let database: TestDatabase;
let api: TestApp;
let accountant: TestSession;
let accountantActor: Actor;
let manager: TestSession;
let clock: ManualClock;
let branchId: string;

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
  branchId = (await database.pool('admin').query<{ id: string }>("SELECT id FROM mdm.branch WHERE code = 'DDW'")).rows[0]!.id;
  const user = await createUser(database, { name: 'Yaw Agyeman', grants: [{ role: 'ACCOUNTANT', branchId }] });
  accountant = await enrolAndLogin(api.server, user, () => clock.now());
  accountantActor = { principalId: user.principalId, kind: 'USER', displayName: 'Yaw Agyeman', realm: 'STAFF', sessionId: null, steppedUpAt: null };
  manager = await enrolAndLogin(api.server, await createUser(database, { name: 'Akosua Boateng', grants: [{ role: 'MANAGER', branchId }] }), () => clock.now());
});

afterAll(async () => {
  await api.close();
  await database.drop();
});

describe('the standing order and write-off operations answer in the contract shapes', () => {
  it('a standing order made, read, listed, changed, paused, resumed and run, a refusal, and a write-off asked for', async () => {
    const customerId = randomUUID();
    await database.pool('app').query(
      "INSERT INTO mdm.customer (id, customer_no, kind, name, tier_id, status, created_by, updated_by) VALUES ($1, 'C-40001', 'BUSINESS', 'Contract Kitchen (TEST)', '01900000-0000-7000-8000-000000000302', 'ACTIVE', $2, $2)",
      [customerId, SYSTEM_PRINCIPAL],
    );
    expect((await consolePost(api.server, manager, '/v1/business-accounts', randomUUID()).send({ customerId, branchId, creditLimitPesewas: 0, paymentTermsDays: 30 })).status).toBe(201);
    const yam = (await database.pool('admin').query<{ id: string }>("SELECT id FROM mdm.product WHERE sku = 'PRD-0005'")).rows[0]!.id;
    const today = toBusinessDate(clock.now());
    const weekday = ((new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
    const made = await consolePost(api.server, manager, '/v1/standing-orders', randomUUID()).send({ customerId, frequency: 'WEEKLY', weekdays: [weekday], startsOn: today, lines: [{ productId: yam, quantity: '2.000' }] });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    expectShape('StandingOrder', made.body);
    const id = made.body.id as string;
    expectShape('StandingOrder', (await consoleGet(api.server, accountant, `/v1/standing-orders/${id}`)).body);
    expectShape('StandingOrderPage', (await consoleGet(api.server, accountant, '/v1/standing-orders')).body);
    const changed = await consolePatch(api.server, manager, `/v1/standing-orders/${id}`).send({ version: made.body.version, lines: [{ productId: yam, quantity: '3.000' }] });
    expectShape('StandingOrder', changed.body);
    await runAsSystem({ principalId: SYSTEM_PRINCIPAL, displayName: 'Scheduler' }, randomUUID(), () => api.app.get(StandingOrders).run({ kind: 'SYSTEM', principalId: SYSTEM_PRINCIPAL }));
    const runs = await consoleGet(api.server, accountant, `/v1/standing-orders/${id}/runs`);
    expectShape('StandingOrderRunPage', runs.body);
    expect(runs.body.data.map((r: { outcome: string }) => r.outcome)).toEqual(['HELD_FOR_CREDIT']);
    const paused = await consolePost(api.server, manager, `/v1/standing-orders/${id}/pause`, randomUUID()).send({ reason: 'Closed for renovation' });
    expect(paused.status).toBe(200);
    expectShape('StandingOrder', paused.body);
    expectShape('StandingOrder', (await consolePost(api.server, manager, `/v1/standing-orders/${id}/resume`, randomUUID()).send({ reason: 'Reopened' })).body);
    const refused = await consolePost(api.server, manager, '/v1/standing-orders', randomUUID()).send({ customerId, frequency: 'MONTHLY', startsOn: today, lines: [{ productId: yam, quantity: '1.000' }] });
    expect([refused.status, refused.body.error.code]).toEqual([422, 'STANDING_ORDER_INVALID']);
    expectShape('Error', refused.body);

    const owed = await issueInvoice(api, accountantActor, clock, { branchId, customerId, productId: yam }, 41_000n);
    const asked = await consolePost(api.server, accountant, '/v1/receivables/write-offs', randomUUID()).send({ billingDocumentId: owed.id, amountPesewas: 41_000, reason: 'Church treasurer relocated; two years overdue' });
    expect(asked.status, JSON.stringify(asked.body)).toBe(202);
    expectShape('ApprovalPending', asked.body);
    const tooMuch = await consolePost(api.server, accountant, '/v1/receivables/write-offs', randomUUID()).send({ billingDocumentId: owed.id, amountPesewas: 41_001, reason: 'x' });
    expect([tooMuch.status, tooMuch.body.error.code]).toEqual([422, 'BAD_DEBT_WRITE_OFF_INVALID']);
    expectShape('Error', tooMuch.body);
  });
});
