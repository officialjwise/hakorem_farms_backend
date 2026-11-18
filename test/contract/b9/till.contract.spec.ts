import { randomUUID } from 'node:crypto';
import { createUuidV7Generator, ManualClock } from '@hakorem/kernel';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { totpAt } from '../../../src/modules/iam/domain/totp';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { contractSchema } from '../../support/contract-schemas';
import { syncBatch, tillSale } from '../../support/offline';
import { consoleGet, consolePatch, consolePost, createUser, enrolAndLogin, login, relaxRateLimits, testStartTime, type TestSession, type TestUser } from '../../support/iam';
import { setTillPin, tillVerifier } from '../../support/till-pin';
import { startTestApp, TEST_ORIGIN, type TestApp } from '../../support/test-app';
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
let owner: TestSession & { readonly secret: Buffer };
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
  // A drop's witness confirms it with their till PIN (B09b continued 3): the manager's PIN is version 1.
  expect((await setTillPin(api.server, manager, await tillVerifier('554031'))).status).toBe(200);
  cashier = await login(api.server, await createUser(database, { name: 'Adwoa Darko', grants: [{ role: 'CASHIER', branchId, locationId: id('location:SHOP') }] }));
  owner = await enrolAndLogin(api.server, await createUser(database, { name: 'Esi Mensah', grants: [{ role: 'OWNER', branchId }] }), () => clock.now());
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
    const dropped = await post(cashier, `/shifts/${shiftId}/cash-movements`, { id: movementId, kind: 'CASH_DROP', amountPesewas: 5_000, reasonCode: 'SAFE_DROP', witnessId: managerUser.principalId, witnessPinVersion: 1, occurredAt: clock.now().toISOString() }, movementId);
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

describe('B09b continued device operations answer in the contract shapes', () => {
  it('a device enrolled, listed and revoked, and the refusals', async () => {
    const till = await post(manager, '/registers', { branchId: id('branch:DDW'), locationId: id('location:SHOP'), code: 'D1', name: 'Device till' });
    expect(till.status).toBe(201);
    clock.advanceBy(30_000);
    expect((await post(manager, '/auth/step-up', { code: totpAt(manager.secret, Math.floor(clock.now().getTime() / 1000)) })).status).toBe(200);
    const key = randomUUID();
    const enrolled = await post(manager, `/registers/${till.body.id as string}/devices`, { deviceLabel: 'Itel tablet, market' }, key);
    expect(enrolled.status).toBe(201);
    expectShape('DeviceEnrolled', enrolled.body);
    const replay = await post(manager, `/registers/${till.body.id as string}/devices`, { deviceLabel: 'Itel tablet, market' }, key);
    expect(replay.status).toBe(409);
    expectShape('Error', replay.body);
    expectShape('DeviceEnrolmentPage', (await get(manager, `/registers/${till.body.id as string}/devices`)).body);
    expectShape('Register', (await get(manager, `/registers?branchId=${id('branch:DDW')}`)).body.data[0]);
    // A counter sale from the enrolled device on the cashier's own open shift.
    const shift = createUuidV7Generator(clock)();
    expect((await post(cashier, '/shifts', { id: shift, registerId: till.body.id, openingFloatPesewas: 0, openedAt: clock.now().toISOString() }, shift)).status).toBe(201);
    const yam = (await database.pool('admin').query<{ id: string }>("SELECT id FROM mdm.product WHERE sku = 'PRD-0005'")).rows[0]!.id;
    const saleId = createUuidV7Generator(clock)();
    const sold = await consolePost(api.server, cashier, '/v1/pos/sales', saleId)
      .set('X-Device-Credential', enrolled.body.deviceCredential as string)
      .send({ id: saleId, shiftId: shift, lines: [{ productId: yam, quantity: '1.000', agreedUnitPricePesewas: 2_000 }], tenders: [{ paymentMethodId: id('method:CASH'), amountPesewas: 2_000, tenderedPesewas: 5_000 }], occurredAt: clock.now().toISOString() });
    expect(sold.status, JSON.stringify(sold.body)).toBe(201);
    expectShape('CounterSaleResult', sold.body);
    const refusedSale = await consolePost(api.server, cashier, '/v1/pos/sales', saleId).send({ id: saleId, shiftId: shift, lines: [], tenders: [], occurredAt: clock.now().toISOString() });
    expectShape('Error', refusedSale.body);
    // The till PIN (2.16.0): the cashier's status, the verifiers the enrolled till holds, a reported try, the witnesses.
    const pin = await setTillPin(api.server, cashier, await tillVerifier('730164'));
    expect(pin.status, JSON.stringify(pin.body)).toBe(200);
    expectShape('TillPinStatus', pin.body);
    const weak = await setTillPin(api.server, cashier, await tillVerifier('730164', { iterations: 599_999 }));
    expect(weak.status).toBe(422);
    expectShape('Error', weak.body);
    const issued = await consoleGet(api.server, cashier, `/v1/registers/${till.body.id as string}/pin-verifiers`).set('X-Device-Credential', enrolled.body.deviceCredential as string);
    expect(issued.status, JSON.stringify(issued.body)).toBe(200);
    expectShape('TillPinVerifierList', issued.body);
    const reported = await consolePost(api.server, cashier, `/v1/registers/${till.body.id as string}/pin-events`)
      .set('X-Device-Credential', enrolled.body.deviceCredential as string)
      .send({ events: [{ id: createUuidV7Generator(clock)(), principalId: pin.body.principal.id as string, pinVersion: 1, outcome: 'FAILED', purpose: 'UNLOCK', occurredAt: clock.now().toISOString() }] });
    expect(reported.status, JSON.stringify(reported.body)).toBe(200);
    expectShape('TillPinReportResult', reported.body);
    const witnesses = await get(cashier, `/shifts/${shift}/witnesses`);
    expect(witnesses.status, JSON.stringify(witnesses.body)).toBe(200);
    expectShape('ShiftWitnessList', witnesses.body);
    const revoked = await post(manager, `/devices/${enrolled.body.device.id as string}/revoke`, { reason: 'Screen broken' });
    expect(revoked.status).toBe(200);
    expectShape('DeviceEnrolment', revoked.body);
    const again = await post(manager, `/devices/${enrolled.body.device.id as string}/revoke`, { reason: 'Screen broken' });
    expect(again.status).toBe(422);
    expectShape('Error', again.body);
    const refused = await post(cashier, `/registers/${till.body.id as string}/devices`, { deviceLabel: 'Mine' });
    expect(refused.status).toBe(403);
    expectShape('Error', refused.body);
  });
});

describe('B09b continued 1b: the force close and the later count answer in the contract shapes', () => {
  it('a shift force-closed by the manager, its drawer counted by the owner, and the refusals', async () => {
    const till = await post(manager, '/registers', { branchId: id('branch:DDW'), locationId: id('location:SHOP'), code: 'F1', name: 'Force close till' });
    expect(till.status).toBe(201);
    const kofi = await login(api.server, await createUser(database, { name: 'Kofi Boadu', grants: [{ role: 'CASHIER', branchId: id('branch:DDW'), locationId: id('location:SHOP') }] }));
    const shift = createUuidV7Generator(clock)();
    expect((await post(kofi, '/shifts', { id: shift, registerId: till.body.id, openingFloatPesewas: 10_000, openedAt: clock.now().toISOString() }, shift)).status).toBe(201);
    clock.advanceBy(30_000);
    expect((await post(manager, '/auth/step-up', { code: totpAt(manager.secret, Math.floor(clock.now().getTime() / 1000)) })).status).toBe(200);
    const forced = await post(manager, `/shifts/${shift}/force-close`, { reason: 'Tablet will not power on' });
    expect(forced.status, JSON.stringify(forced.body)).toBe(200);
    expectShape('Shift', forced.body);
    const twice = await post(manager, `/shifts/${shift}/force-close`, { reason: 'Again' });
    expect(twice.status).toBe(422);
    expectShape('Error', twice.body);
    const own = await post(manager, `/shifts/${shift}/late-count`, { declaredCashPesewas: 10_000, reason: 'Counted' });
    expect(own.status).toBe(422);
    expectShape('Error', own.body);
    expect((await post(owner, '/auth/step-up', { code: totpAt(owner.secret, Math.floor(clock.now().getTime() / 1000)) })).status).toBe(200);
    const counted = await post(owner, `/shifts/${shift}/late-count`, { declaredCashPesewas: 9_900, reason: 'Counted the next morning' });
    expect(counted.status, JSON.stringify(counted.body)).toBe(200);
    expectShape('Shift', counted.body);
    expectShape('ShiftReport', (await get(owner, `/shifts/${shift}/z-report`)).body);
    const refused = await post(kofi, `/shifts/${shift}/late-count`, { declaredCashPesewas: 9_900, reason: 'Mine' });
    expect(refused.status).toBe(403);
    expectShape('Error', refused.body);
  });
});

describe('B09b continued 1c: held sales answer in the contract shapes', () => {
  it('a sale held on the cashier own shift, listed, recalled once re-priced, and the refusals', async () => {
    const till = await post(manager, '/registers', { branchId: id('branch:DDW'), locationId: id('location:SHOP'), code: 'K1', name: 'Hold till' });
    expect(till.status).toBe(201);
    // A TOTP code is used once: the next one, thirty seconds on.
    clock.advanceBy(30_000);
    expect((await post(manager, '/auth/step-up', { code: totpAt(manager.secret, Math.floor(clock.now().getTime() / 1000)) })).status).toBe(200);
    const enrolled = await post(manager, `/registers/${till.body.id as string}/devices`, { deviceLabel: 'Hold tablet' });
    expect(enrolled.status).toBe(201);
    const yaa = await login(api.server, await createUser(database, { name: 'Yaa Ofori', grants: [{ role: 'CASHIER', branchId: id('branch:DDW'), locationId: id('location:SHOP') }] }));
    const nextId = createUuidV7Generator(clock);
    const shift = nextId();
    expect((await post(yaa, '/shifts', { id: shift, registerId: till.body.id, openingFloatPesewas: 10_000, openedAt: clock.now().toISOString() }, shift)).status).toBe(201);
    const yam = (await database.pool('admin').query<{ id: string }>("SELECT id FROM mdm.product WHERE sku = 'PRD-0005'")).rows[0]!.id;
    const held = await consolePost(api.server, yaa, `/v1/registers/${till.body.id as string}/held-sales`, randomUUID())
      .set('X-Device-Credential', enrolled.body.deviceCredential as string)
      .send({ id: nextId(), label: 'Back in ten minutes', payload: { lines: [{ productId: yam, quantity: '2.000' }] } });
    expect(held.status, JSON.stringify(held.body)).toBe(201);
    expectShape('HeldSale', held.body);
    const listed = await get(yaa, `/registers/${till.body.id as string}/held-sales`);
    expect(listed.status).toBe(200);
    expectShape('HeldSalePage', listed.body);
    const recall = () =>
      request(api.server)
        .delete(`/v1/held-sales/${held.body.id as string}`)
        .set('Cookie', yaa.jar.header())
        .set('X-CSRF-Token', yaa.csrfToken)
        .set('Origin', TEST_ORIGIN)
        .set('Idempotency-Key', randomUUID())
        .set('X-Device-Credential', enrolled.body.deviceCredential as string);
    const recalled = await recall();
    expect(recalled.status, JSON.stringify(recalled.body)).toBe(200);
    expectShape('HeldSale', recalled.body);
    const again = await recall();
    expect(again.status).toBe(404);
    expectShape('Error', again.body);
    const refused = await consolePost(api.server, cashier, `/v1/registers/${till.body.id as string}/held-sales`, randomUUID())
      .set('X-Device-Credential', enrolled.body.deviceCredential as string)
      .send({ id: nextId(), payload: { lines: [{ productId: yam, quantity: '1.000' }] } });
    expect(refused.status).toBe(403);
    expectShape('Error', refused.body);
  });
});

describe('B09b continued 2: the offline pack and a line in its own unit answer in the contract shapes', () => {
  it('the pack read from an enrolled device, a crate and a single egg sold, and the refusals', async () => {
    const till = await post(manager, '/registers', { branchId: id('branch:DDW'), locationId: id('location:SHOP'), code: 'O1', name: 'Pack till' });
    expect(till.status).toBe(201);
    clock.advanceBy(30_000);
    expect((await post(manager, '/auth/step-up', { code: totpAt(manager.secret, Math.floor(clock.now().getTime() / 1000)) })).status).toBe(200);
    const enrolled = await post(manager, `/registers/${till.body.id as string}/devices`, { deviceLabel: 'Pack tablet' });
    expect(enrolled.status).toBe(201);
    const efua = await login(api.server, await createUser(database, { name: 'Efua Mensah', grants: [{ role: 'CASHIER', branchId: id('branch:DDW'), locationId: id('location:SHOP') }] }));
    const pack = await get(efua, `/registers/${till.body.id as string}/offline-pack`).set('X-Device-Credential', enrolled.body.deviceCredential as string);
    expect(pack.status, JSON.stringify(pack.body)).toBe(200);
    expectShape('OfflinePack', pack.body);
    const noDevice = await get(efua, `/registers/${till.body.id as string}/offline-pack`);
    expect(noDevice.status).toBe(401);
    expectShape('Error', noDevice.body);
    const nextId = createUuidV7Generator(clock);
    const shift = nextId();
    expect((await post(efua, '/shifts', { id: shift, registerId: till.body.id, openingFloatPesewas: 0, openedAt: clock.now().toISOString() }, shift)).status).toBe(201);
    const eggs = (await database.pool('admin').query<{ id: string }>("SELECT id FROM mdm.product WHERE sku = 'EGG-0003'")).rows[0]!.id;
    const sell = (lines: object[], amount: number) => {
      const saleId = nextId();
      return consolePost(api.server, efua, '/v1/pos/sales', saleId)
        .set('X-Device-Credential', enrolled.body.deviceCredential as string)
        .send({ id: saleId, shiftId: shift, lines, tenders: [{ paymentMethodId: id('method:CASH'), amountPesewas: amount }], occurredAt: clock.now().toISOString() });
    };
    const sold = await sell([{ productId: eggs, quantity: '1.000', uom: 'CRATE', agreedUnitPricePesewas: 6_000 }, { productId: eggs, quantity: '2.000', uom: 'EGG', agreedUnitPricePesewas: 220 }], 6_440);
    expect(sold.status, JSON.stringify(sold.body)).toBe(201);
    expectShape('CounterSaleResult', sold.body);
    const refused = await sell([{ productId: eggs, quantity: '1.000', uom: 'TRAY', agreedUnitPricePesewas: 6_000 }], 6_000);
    expect(refused.status).toBe(400);
    expectShape('Error', refused.body);
  });
});

describe('B09b continued 2b: offline sync answers in the contract shapes', () => {
  it('a queued sale applied, the same sent again, a tampered one refused, a receipt marked synced, and the refusals', async () => {
    const till = await post(manager, '/registers', { branchId: id('branch:DDW'), locationId: id('location:SHOP'), code: 'Q1', name: 'Sync till' });
    expect(till.status).toBe(201);
    clock.advanceBy(30_000);
    expect((await post(manager, '/auth/step-up', { code: totpAt(manager.secret, Math.floor(clock.now().getTime() / 1000)) })).status).toBe(200);
    const enrolled = await post(manager, `/registers/${till.body.id as string}/devices`, { deviceLabel: 'Sync tablet' });
    expect(enrolled.status).toBe(201);
    const kojo = await login(api.server, await createUser(database, { name: 'Kojo Antwi', grants: [{ role: 'CASHIER', branchId: id('branch:DDW'), locationId: id('location:SHOP') }] }));
    const nextId = createUuidV7Generator(clock);
    const shift = nextId();
    const opened = await post(kojo, '/shifts', { id: shift, registerId: till.body.id, openingFloatPesewas: 0, openedAt: clock.now().toISOString() }, shift);
    expect(opened.status).toBe(201);
    const eggs = (await database.pool('admin').query<{ id: string }>("SELECT id FROM mdm.product WHERE sku = 'EGG-0003'")).rows[0]!.id;
    clock.advanceBy(60_000);
    const queued = tillSale({ till: 'Q1', shiftSeq: opened.body.shiftSeq as number, counter: 1, at: clock.now(), lines: [{ productId: eggs, quantity: '1.000', uom: 'CRATE', agreedUnitPricePesewas: 6_000 }], tenders: [{ paymentMethodId: id('method:CASH'), amountPesewas: 6_000 }] });
    const tampered = { ...tillSale({ till: 'Q1', shiftSeq: opened.body.shiftSeq as number, counter: 2, at: clock.now(), lines: [{ productId: eggs, quantity: '2.000', uom: 'EGG', agreedUnitPricePesewas: 220 }], tenders: [{ paymentMethodId: id('method:CASH'), amountPesewas: 440 }] }), tenders: [{ paymentMethodId: id('method:CASH'), amountPesewas: 220 }] };
    clock.advanceBy(240_000);
    const body = { deviceId: enrolled.body.device.id, shiftId: shift, sales: [queued, tampered] };
    const synced = await syncBatch(api.server, kojo, enrolled.body.deviceCredential as string, body);
    expect(synced.status, JSON.stringify(synced.body)).toBe(200);
    expectShape('OfflineSyncResult', synced.body);
    expect((synced.body.results as { outcome: string }[]).map((r) => r.outcome)).toEqual(['APPLIED', 'REJECTED_INTEGRITY']);
    const again = await syncBatch(api.server, kojo, enrolled.body.deviceCredential as string, body);
    expectShape('OfflineSyncResult', again.body);
    expect(again.body.results[0].outcome).toBe('DUPLICATE');
    const order = await get(manager, `/orders/${queued.id}`);
    const receipt = await get(manager, `/billing-documents/${order.body.billingDocument.id as string}`);
    expect(receipt.status, JSON.stringify(receipt.body)).toBe(200);
    expectShape('BillingDocument', receipt.body);
    expect(receipt.body.syncedFromOffline).toBe(true);
    const noDevice = await syncBatch(api.server, kojo, null, body);
    expect(noDevice.status).toBe(401);
    expectShape('Error', noDevice.body);
    const tooMany = await syncBatch(api.server, kojo, enrolled.body.deviceCredential as string, { ...body, sales: Array.from({ length: 501 }, () => queued) });
    expect(tooMany.status).toBe(400);
    expectShape('Error', tooMany.body);
  });
});
