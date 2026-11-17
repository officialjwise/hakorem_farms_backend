import { randomUUID } from 'node:crypto';
import { createUuidV7Generator, ManualClock } from '@hakorem/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { totpAt } from '../../../src/modules/iam/domain/totp';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { contractSchema } from '../../support/contract-schemas';
import { consoleGet, consolePatch, consolePost, createUser, enrolAndLogin, login, relaxRateLimits, testStartTime, type TestSession, type TestUser } from '../../support/iam';
import { startTestApp, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * The till's twelve operations (B9b, 2.5.0) answer in the contract's shapes: `Register`, `RegisterPage`, `Shift`,
 * `ShiftPage`, `CashMovement`, `CashMovementPage` and `ShiftReport`, and their refusals in the error envelope.
 */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let manager: TestSession & { readonly secret: Buffer };
let managerUser: TestUser;
let cashier: TestSession;
const ids = new Map<string, string>();
const id = (code: string) => ids.get(code)!;
const post = (session: TestSession, path: string, body: object = {}, key: string = randomUUID()) => consolePost(api.server, session, `/v1${path}`, key).send(body);
const get = (session: TestSession, path: string) => consoleGet(api.server, session, `/v1${path}`);

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
       UNION ALL SELECT 'method:' || code, id FROM mdm.payment_method`,
    )
  ).rows) {
    ids.set(row.code, row.id);
  }
  const branchId = id('branch:DDW');
  managerUser = await createUser(database, { name: 'Kwabena Owusu', grants: [{ role: 'MANAGER', branchId }] });
  manager = await enrolAndLogin(api.server, managerUser, () => clock.now());
  cashier = await login(api.server, await createUser(database, { name: 'Adwoa Darko', grants: [{ role: 'CASHIER', branchId, locationId: id('location:SHOP') }] }));
});

afterAll(async () => {
  await api?.close();
  await database.drop();
});

describe('B9b till operations answer in the contract shapes', () => {
  it('a till set up, a shift opened, cash dropped, read, declared and signed off, and the refusals', async () => {
    const nextId = createUuidV7Generator(clock);
    const created = await post(manager, '/registers', { branchId: id('branch:DDW'), locationId: id('location:SHOP'), code: 'T1', name: 'Shop till 1' });
    expect(created.status).toBe(201);
    expectShape('Register', created.body);
    expectShape('RegisterPage', (await get(manager, '/registers')).body);
    const renamed = await consolePatch(api.server, manager, `/v1/registers/${created.body.id}`).send({ version: created.body.version, name: 'Front till' });
    expect(renamed.status).toBe(200);
    expectShape('Register', renamed.body);

    const shiftId = nextId();
    const opened = await post(cashier, '/shifts', { id: shiftId, registerId: created.body.id, openingFloatPesewas: 20_000, openedAt: clock.now().toISOString() }, shiftId);
    expect(opened.status).toBe(201);
    expectShape('Shift', opened.body);
    const twice = await post(cashier, '/shifts', { id: nextId(), registerId: created.body.id, openingFloatPesewas: 0, openedAt: clock.now().toISOString() });
    expect(twice.status).toBe(422);
    expectShape('Error', twice.body);

    const movementId = nextId();
    const dropped = await post(cashier, `/shifts/${shiftId}/cash-movements`, { id: movementId, kind: 'CASH_DROP', amountPesewas: 5_000, reasonCode: 'SAFE_DROP', witnessId: managerUser.principalId, occurredAt: clock.now().toISOString() }, movementId);
    expect(dropped.status).toBe(201);
    expectShape('CashMovement', dropped.body);
    const refused = await post(cashier, `/shifts/${shiftId}/cash-movements`, { id: nextId(), kind: 'CASH_DROP', amountPesewas: 5_000, occurredAt: clock.now().toISOString() });
    expect(refused.status).toBe(422);
    expectShape('Error', refused.body);
    expectShape('CashMovementPage', (await get(cashier, `/shifts/${shiftId}/cash-movements`)).body);
    expectShape('ShiftPage', (await get(cashier, '/shifts')).body);
    expectShape('ShiftReport', (await get(cashier, `/shifts/${shiftId}/x-report`)).body);

    const declared = await post(cashier, `/shifts/${shiftId}/close`, { declared: [{ paymentMethodId: id('method:CASH'), declaredPesewas: 15_000 }] });
    expect(declared.status).toBe(200);
    expectShape('Shift', declared.body);
    clock.advanceBy(30_000);
    expect((await post(manager, '/auth/step-up', { code: totpAt(manager.secret, Math.floor(clock.now().getTime() / 1000)) })).status).toBe(200);
    const signed = await post(manager, `/shifts/${shiftId}/approve-close`, { reason: 'Counted with the cashier' });
    expect(signed.status).toBe(200);
    expectShape('Shift', signed.body);
    expectShape('Shift', (await get(manager, `/shifts/${shiftId}`)).body);
    expectShape('ShiftReport', (await get(manager, `/shifts/${shiftId}/z-report`)).body);
  });
});
