import { randomUUID } from 'node:crypto';
import { ManualClock } from '@hakorem/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { contractSchema } from '../../support/contract-schemas';
import { consoleGet, consolePost, createUser, enrolAndLogin, login, relaxRateLimits, testStartTime, type TestSession } from '../../support/iam';
import { startTestApp, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/** B11: a pick list, its picks, a question to the customer and its answer answer in the shapes of 2.25.0. */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
const sessions = new Map<string, TestSession>();
const ids = new Map<string, string>();
const post = (who: string, path: string, body: object) => consolePost(api.server, sessions.get(who)!, `/v1${path}`).send(body);

function expectShape(schema: string, body: unknown): void {
  const validate = contractSchema(schema);
  expect(validate(body), `${schema}: ${JSON.stringify(validate.errors)}`).toBe(true);
}

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock, environment: { AUTH_ACCESS_TTL_SECONDS: '43200' } });
  await runSeedUnits(database.pool('app'), api.app, seedUnits({ SEED_STAFF_PASSWORD: `Seed-${randomUUID()}` }));
  const admin = database.pool('admin');
  const branchId = (await admin.query<{ id: string }>("SELECT id FROM mdm.branch WHERE code = 'DDW'")).rows[0]!.id;
  ids.set('eggs', (await admin.query<{ id: string }>("SELECT id FROM mdm.product WHERE sku = 'EGG-0003'")).rows[0]!.id);
  ids.set('lot', (await admin.query<{ id: string }>("SELECT u.id FROM inv.stock_unit u JOIN mdm.product p ON p.id = u.product_id WHERE p.sku = 'EGG-0003' AND u.tracking = 'LOT'")).rows[0]!.id);
  ids.set('shop', (await admin.query<{ id: string }>("SELECT id FROM mdm.location WHERE branch_id = $1 AND code = 'SHOP'", [branchId])).rows[0]!.id);
  ids.set('tema', (await admin.query<{ id: string }>("SELECT id FROM mdm.customer WHERE name = 'Tema Cold Store Ltd (SEED)'")).rows[0]!.id);
  sessions.set('sales', await login(api.server, await createUser(database, { name: 'Esi Appiah', grants: [{ role: 'SALES', branchId }] })));
  sessions.set('storekeeper', await login(api.server, await createUser(database, { name: 'Yaw Boateng', grants: [{ role: 'STOREKEEPER', branchId }] })));
  sessions.set('manager', await enrolAndLogin(api.server, await createUser(database, { name: 'Abena Owusu', grants: [{ role: 'MANAGER', branchId }] }), () => clock.now()));
});

afterAll(async () => {
  await api?.close();
  await database?.drop();
});

describe('picking, a short pick and the customer’s answer (2.25.0)', () => {
  it('answers createFulfilment, recordPicks, proposeShortPick, recordCustomerConsent, packFulfilment and listFulfilments in their contract shapes', async () => {
    const order = await post('sales', '/orders', { channel: 'WHOLESALE', customerId: ids.get('tema')!, fulfilmentMode: 'COLLECTION', paymentTerms: 'COD', lines: [{ productId: ids.get('eggs')!, quantity: '2.000', uom: 'CRATE' }] });
    expect((await post('sales', `/orders/${order.body.id as string}/confirm`, {})).status).toBe(200);
    const orderId = order.body.id as string;
    const lineId = order.body.lines[0].id as string;
    const made = await post('storekeeper', `/orders/${orderId}/fulfilments`, { pickLocationId: ids.get('shop')! });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    expectShape('Fulfilment', made.body);
    const picked = await post('storekeeper', `/fulfilments/${made.body.id as string}/picks`, { picks: [{ id: randomUUID(), orderLineId: lineId, stockUnitId: ids.get('lot')!, qty: '1.000' }] });
    expect(picked.status).toBe(200);
    expectShape('Fulfilment', picked.body);
    const asked = await post('storekeeper', `/orders/${orderId}/short-picks`, { lineId, quantity: '1.000', note: 'One crate cracked' });
    expect(asked.status).toBe(200);
    expectShape('SalesOrder', asked.body);
    expect(asked.body.pendingConsent.kind).toBe('SHORT_PICK');
    const refused = await post('storekeeper', `/fulfilments/${made.body.id as string}/pack`, { packageCount: 1 });
    expect(refused.status).toBe(422);
    expectShape('Error', refused.body);
    const answered = await post('manager', `/orders/${orderId}/consent`, { kind: 'SHORT_PICK', accepted: true, method: 'PHONE', note: 'Agreed on the phone' });
    expect(answered.status).toBe(200);
    expectShape('SalesOrder', answered.body);
    const packed = await post('storekeeper', `/fulfilments/${made.body.id as string}/pack`, { packageCount: 1 });
    expect(packed.status).toBe(200);
    expectShape('Fulfilment', packed.body);
    const listed = await consoleGet(api.server, sessions.get('storekeeper')!, `/v1/fulfilments?orderId=${orderId}`);
    expect(listed.body.data).toHaveLength(1);
    expectShape('FulfilmentPage', listed.body);
    expectShape('SalesOrder', (await consoleGet(api.server, sessions.get('manager')!, `/v1/orders/${orderId}`)).body);
  });
});
