import { randomUUID } from 'node:crypto';
import { createUuidV7Generator, ManualClock } from '@hakorem/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SalePosting } from '../../../src/modules/ord';
import { runWithRequestContext, type Actor } from '../../../src/platform/context/request-context';
import { UnitOfWork } from '../../../src/platform/database/unit-of-work';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { contractSchema } from '../../support/contract-schemas';
import { stepUp, type TotpSession } from '../../support/fin';
import { consoleGet, consolePost, createUser, enrolAndLogin, login, relaxRateLimits, testStartTime, type TestSession } from '../../support/iam';
import { startTestApp, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/** The return operations (B09a continued 2d) answer in the shapes of contract/openapi.yaml, refusals included. */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let cashier: TestSession;
let cashierId: string;
let storekeeper: TestSession;
let owner: TestSession;
let branchId: string;
let yam: string;
let shop: string;

function expectShape(schema: string, body: unknown): void {
  const validate = contractSchema(schema);
  expect(validate(body), `${schema}: ${JSON.stringify(validate.errors)}`).toBe(true);
}

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock, environment: { AUTH_ACCESS_TTL_SECONDS: '172800' } });
  await runSeedUnits(database.pool('app'), api.app, seedUnits({ SEED_STAFF_PASSWORD: `Seed-${randomUUID()}` }));
  const admin = database.pool('admin');
  branchId = (await admin.query<{ id: string }>("SELECT id FROM mdm.branch WHERE code = 'DDW'")).rows[0]!.id;
  yam = (await admin.query<{ id: string }>("SELECT id FROM mdm.product WHERE sku = 'PRD-YAM-TUBER'")).rows[0]!.id;
  shop = (await admin.query<{ id: string }>("SELECT id FROM mdm.location WHERE branch_id = $1 AND code = 'SHOP'", [branchId])).rows[0]!.id;
  const cashierUser = await createUser(database, { name: 'Adwoa Darko', grants: [{ role: 'CASHIER', branchId }] });
  cashierId = cashierUser.principalId;
  cashier = await login(api.server, cashierUser);
  storekeeper = await login(api.server, await createUser(database, { name: 'Yaw Asante', grants: [{ role: 'STOREKEEPER', branchId }] }));
  owner = await enrolAndLogin(api.server, await createUser(database, { name: 'Kwabena Owusu', grants: [{ role: 'OWNER', branchId }] }), () => clock.now());
});

afterAll(async () => {
  await api?.close();
  await database?.drop();
});

describe('B09a continued 2d return operations answer in the contract shapes', () => {
  it('a return made, read, submitted and approved, and every refusal', async () => {
    const actor: Actor = { principalId: cashierId, kind: 'USER', displayName: 'Adwoa Darko', realm: 'STAFF', sessionId: null, steppedUpAt: null };
    const sales = api.app.get(SalePosting);
    const sale = await runWithRequestContext({ correlationId: randomUUID(), ip: null, userAgent: 'contract', actor }, () =>
      api.app.get(UnitOfWork).run({ isolation: 'serializable', seriesLocks: sales.locksFor(branchId) }, (tx) =>
        sales.postIn(tx, actor, {
          orderId: createUuidV7Generator(clock)(),
          channel: 'WHOLESALE',
          branchId,
          fulfilmentMode: 'COUNTER',
          taxInclusive: true,
          lines: [{ productId: yam, fromLocationId: shop, quantity: '2.000' }],
          tenders: [{ methodCode: 'CASH', amountPesewas: 4_000n, register: { id: '019a8000-0000-7000-8000-0000000e0001', code: 'K1' } }],
        }),
      ),
    );
    const body = { orderId: sale.id, kind: 'RETURN', reasonCode: 'RETURN_UNWANTED', refundDestination: 'ORIGINAL_METHOD', lines: [{ orderLineId: sale.lines[0]!.id, qty: '1.000', disposition: 'RESTOCK' }] };
    const created = await consolePost(api.server, cashier, '/v1/returns').send(body);
    expect(created.status).toBe(201);
    expectShape('OrderReturn', created.body);
    expectShape('OrderReturn', (await consoleGet(api.server, cashier, `/v1/returns/${created.body.id as string}`)).body);
    const submitted = await consolePost(api.server, cashier, `/v1/returns/${created.body.id as string}/submit`).send();
    expect(submitted.status).toBe(202);
    expectShape('ApprovalPending', submitted.body);
    await stepUp(api.server, owner as TotpSession, clock);
    expect((await consolePost(api.server, owner, `/v1/iam/approvals/${submitted.body.approvalRequestId as string}/approve`).send({ reason: 'Seen it come back' })).status).toBe(200);
    const completed = await consoleGet(api.server, cashier, `/v1/returns/${created.body.id as string}`);
    expect(completed.body.status).toBe('COMPLETED');
    expectShape('OrderReturn', completed.body);

    const refusals = [
      await consolePost(api.server, cashier, '/v1/returns').send({ ...body, lines: [{ ...body.lines[0], qty: '2.000' }] }),
      await consolePost(api.server, cashier, `/v1/returns/${created.body.id as string}/submit`).send(),
      await consolePost(api.server, storekeeper, '/v1/returns').send(body),
      await consoleGet(api.server, cashier, `/v1/returns/${randomUUID()}`),
      await consolePost(api.server, cashier, '/v1/returns').send({ ...body, lines: [{ ...body.lines[0], qty: '1' }] }),
    ];
    expect(refusals.map((r) => [r.status, r.body.error.code])).toEqual([
      [422, 'ORDER_INVALID'],
      [422, 'INVALID_STATE_TRANSITION'],
      [403, 'FORBIDDEN'],
      [404, 'NOT_FOUND'],
      [400, 'VALIDATION_FAILED'],
    ]);
    for (const refusal of refusals) expectShape('Error', refusal.body);
  });
});
