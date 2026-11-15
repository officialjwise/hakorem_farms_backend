import { randomUUID } from 'node:crypto';
import { ManualClock } from '@hakorem/kernel';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { contractSchema } from '../../support/contract-schemas';
import { consoleGet, consolePost, createUser, enrolAndLogin, relaxRateLimits, testStartTime, type TestSession } from '../../support/iam';
import { startTestApp, TEST_ORIGIN, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/** The B07 continued supplier register and requisition operations answer in the shapes of contract/openapi.yaml 1.29.0. */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let manager: TestSession;
let accountant: TestSession;
let owner: TestSession;
const ids = new Map<string, string>();
const v1 = (path: string) => `/v1${path}`;
const post = (session: TestSession, path: string, body: object = {}) => consolePost(api.server, session, v1(path)).send(body);
const get = (session: TestSession, path: string) => consoleGet(api.server, session, v1(path));

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
       UNION ALL SELECT 'supplier:' || name, id FROM mdm.supplier`,
    )
  ).rows) {
    ids.set(row.code, row.id);
  }
  const branchId = ids.get('branch:DDW')!;
  manager = await enrolAndLogin(api.server, await createUser(database, { name: 'Akosua Boateng', grants: [{ role: 'MANAGER', branchId }] }), () => clock.now());
  accountant = await enrolAndLogin(api.server, await createUser(database, { name: 'Yaw Agyeman', grants: [{ role: 'ACCOUNTANT', branchId }] }), () => clock.now());
  owner = await enrolAndLogin(api.server, await createUser(database, { name: 'Kwabena Owusu', grants: [{ role: 'OWNER', branchId }] }), () => clock.now());
});

afterAll(async () => {
  await api.close();
  await database.drop();
});

describe('B07 continued operations answer in the contract shapes', () => {
  it('a profile, its payout details in full, a payout change answered 202, a setting change, and the documents page', async () => {
    const kpone = ids.get('supplier:Kpone Livestock Traders (SEED)')!;
    const profile = await get(accountant, `/suppliers/${kpone}/profile`);
    expectShape('SupplierProfile', profile.body);
    expect(profile.body).toMatchObject({ paymentTermsDays: 14, payoutDetailsMasked: null });
    const full = await get(accountant, `/suppliers/${kpone}/payout-details`);
    expect(full.status).toBe(200);
    expectShape('SupplierPayoutDetails', full.body);
    const pending = await request(api.server)
      .put(v1(`/suppliers/${kpone}/profile`))
      .set('Cookie', owner.jar.header())
      .set('X-CSRF-Token', owner.csrfToken)
      .set('Origin', TEST_ORIGIN)
      .set('Idempotency-Key', randomUUID())
      .send({ version: profile.body.version, payoutDetails: { method: 'MOBILE_MONEY', momoNetwork: 'TELECEL', momoNumber: '+233200000212' } });
    expect(pending.status).toBe(202);
    expectShape('ApprovalPending', pending.body);
    expectShape('SupplierPayoutDetails', (await get(accountant, `/suppliers/${kpone}/payout-details`)).body);
    expectShape('SupplierDocumentPage', (await get(manager, `/suppliers/${kpone}/documents`)).body);
    const setting = await request(api.server)
      .put(v1('/admin/settings/pur.purchase_order.approval_limit_pesewas'))
      .set('Cookie', owner.jar.header())
      .set('X-CSRF-Token', owner.csrfToken)
      .set('Origin', TEST_ORIGIN)
      .set('Idempotency-Key', randomUUID())
      .send({ value: 250_000, version: 0 });
    expect(setting.status).toBe(200);
    expectShape('Setting', setting.body);
  });

  it('the seeded requisition, a new one, its conversion into an order, and a refusal in the error envelope', async () => {
    const page = await get(manager, '/purchase-requisitions');
    expectShape('PurchaseRequisitionPage', page.body);
    expect(page.body.data.map((r: { status: string; lines: { qty: string; uom: string }[] }) => [r.status, r.lines[0]!.qty, r.lines[0]!.uom])).toEqual([['SUBMITTED', '100.000', 'KG']]);
    const seeded = page.body.data[0];
    const order = await post(manager, `/purchase-requisitions/${seeded.id}/convert`, {
      supplierId: ids.get('supplier:Awutu Poultry Farm (SEED)'),
      deliverToLocationId: ids.get('location:STORE'),
      lines: [{ lineId: seeded.lines[0].id, unitPricePesewas: 900 }],
    });
    expect(order.status).toBe(201);
    expectShape('PurchaseOrder', order.body);
    expect(order.body.grossPesewas).toBe(90_000);
    expectShape('PurchaseRequisition', (await get(manager, `/purchase-requisitions/${seeded.id}`)).body);
    const refused = await post(manager, '/purchase-requisitions', { locationId: ids.get('location:STORE'), lines: [] });
    expect(refused.status).toBe(422);
    expectShape('Error', refused.body);
    expect(refused.body.error).toMatchObject({ code: 'PURCHASE_REQUISITION_INVALID', details: [{ field: '/lines', code: 'NO_LINES' }] });
  });
});
