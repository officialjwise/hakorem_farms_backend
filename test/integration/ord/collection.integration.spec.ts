import { randomUUID } from 'node:crypto';
import { createUuidV7Generator, ManualClock } from '@hakorem/kernel';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { PAYSTACK_MTN_TEST_PHONE, paystackEnvironment, startFakePaystack, type FakePaystack } from '../../support/fake-paystack';
import { stepUp, type TotpSession } from '../../support/fin';
import { consoleGet, consolePost, createBranch, createUser, enrolAndLogin, login, relaxRateLimits, testStartTime, type RoleCode, type TestSession } from '../../support/iam';
import { runSweep, trialBalanceSum } from '../../support/pay';
import { startTestApp, TEST_ORIGIN, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * A collection order handed over and paid at the till (FR-ORD-011, B11 continued 7, the gate's third part), and a
 * delivered or handed-over order completed once its document is settled later (BL-097), over the seeded farm. A guest's
 * online collection order is paid ahead at its estimate; picked heavier, what is left is paid at the till against the
 * guest's receipt (the parent session's leave of 2026-11-24, A-366 (d)). Hand figures from the seeded prices: beef
 * MEAT-0005 online 3,213 a kg in 15 kg packs (two packs estimated 96,390; picked 15.200 and 15.600 kg, 98,960, so 2,570
 * left); goat meat MEAT-0007 a pack estimated at 15.000 kg, picked at 15.800 kg.
 */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let fake: FakePaystack;
let branchId: string;
let credential = '';
let shiftId = '';
const nextId = () => createUuidV7Generator(clock)();
const ids = new Map<string, string>();
const id = (name: string) => ids.get(name)!;
const sessions = new Map<string, TestSession>();
const as = (name: string) => sessions.get(name)!;
const admin = () => database.pool('admin');

const guestWrite = (path: string, guest: { cookie: string }, body?: object) => {
  const req = request(api.server).post(`/v1${path}`).set('Origin', TEST_ORIGIN).set('Idempotency-Key', randomUUID()).set('Cookie', guest.cookie);
  return body === undefined ? req : req.send(body);
};

/** A guest's collection order of these lines, paid ahead by mobile money at its estimate. */
async function collectionOrder(lines: ReadonlyArray<[string, string]>): Promise<string> {
  const created = await request(api.server).post('/v1/shop/carts').set('Origin', TEST_ORIGIN).set('Idempotency-Key', randomUUID());
  const cookie = (created.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('__Host-hk_guest='))!;
  const guest = { cartId: created.body.id as string, cookie: cookie.split(';')[0]! };
  for (const [sku, quantity] of lines) expect((await guestWrite(`/shop/carts/${guest.cartId}/lines`, guest, { productId: id(sku), quantity })).status).toBe(200);
  const started = await guestWrite(`/shop/carts/${guest.cartId}/checkout`, guest, { contactName: 'Kofi Boateng', contactPhone: '0201234567', fulfilmentMode: 'COLLECTION', paymentTerms: 'PREPAID' });
  expect(started.status, JSON.stringify(started.body)).toBe(201);
  const placed = await guestWrite(`/shop/checkouts/${started.body.id as string}/place`, guest, { paymentMethod: 'MOBILE_MONEY', payerPhone: PAYSTACK_MTN_TEST_PHONE, network: 'MTN' });
  expect(placed.status, JSON.stringify(placed.body)).toBe(201);
  clock.advanceBy(31_000);
  await runSweep(api);
  return placed.body.orderId as string;
}

const post = (who: string, path: string, body: object, key: string = randomUUID()) => consolePost(api.server, as(who), `/v1${path}`, key).send(body);
const get = (who: string, path: string) => consoleGet(api.server, as(who), `/v1${path}`);
const order = async (orderId: string) => (await get('manager', `/orders/${orderId}`)).body;
const one = async <T extends object>(sql: string, params: unknown[]) => (await admin().query<T & Record<string, unknown>>(sql, params)).rows[0]!;
const count = async (sql: string, params: unknown[]) => Number((await one<{ n: string }>(sql, params)).n);
const pick = (orderLineId: string, unit: string, qty: string, weightKg?: string) => ({ id: nextId(), orderLineId, stockUnitId: id(unit), qty, ...(weightKg === undefined ? {} : { weightKg, weightSource: 'SCALE' }) });
const pay = (who: string, body: object, key: string = randomUUID()) => consolePost(api.server, as(who), `/v1/shifts/${shiftId}/invoice-payments`, key).set('X-Device-Credential', credential).send(body);
const errors = () => JSON.stringify(api.logLines().filter((l) => JSON.stringify(l).includes('rror')).slice(-2)).slice(0, 3000);
const movements = async (orderId: string) =>
  (
    await admin().query<{ type: string; from: string; to: string; qty: string }>(
      `SELECT m.movement_type AS type, f.code AS from, t.code AS to, m.qty_base::text AS qty
         FROM inv.stock_movement m JOIN mdm.location f ON f.id = m.from_location_id JOIN mdm.location t ON t.id = m.to_location_id
        WHERE m.source_document_id = $1 ORDER BY m.qty_base`,
      [orderId],
    )
  ).rows.map((r) => [r.type, r.from, r.to, r.qty]);

/** An order picked and packed in the cold room with these picks of its one line: answers the pick list. */
async function packed(orderId: string, picks: (lineId: string) => object[], location = 'COLD'): Promise<string> {
  const made = await post('storekeeper', `/orders/${orderId}/fulfilments`, { pickLocationId: id(`location:${location}`) });
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  const lineId = (await order(orderId)).lines[0].id as string;
  expect((await post('storekeeper', `/fulfilments/${made.body.id as string}/picks`, { picks: picks(lineId) })).status).toBe(200);
  const sealed = await post('storekeeper', `/fulfilments/${made.body.id as string}/pack`, { packageCount: 1 });
  expect(sealed.status, JSON.stringify(sealed.body)).toBe(200);
  return made.body.id as string;
}

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  await relaxRateLimits(database);
  for (const key of ['rate_limit.public.per_address_1m', 'rate_limit.checkout.per_address_10m']) {
    await database.pool('app').query(
      `INSERT INTO platform.setting (id, key, value, value_type, valid_from, description, created_by, updated_by)
       VALUES ($1, $2, '100000', 'INTEGER', now() - interval '1 day', 'Raised for a test file', '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001')`,
      [randomUUID(), key],
    );
  }
  fake = await startFakePaystack(() => clock.now());
  api = await startTestApp(database, { clock, environment: { ...paystackEnvironment(fake), AUTH_ACCESS_TTL_SECONDS: '43200' } });
  await runSeedUnits(database.pool('app'), api.app, seedUnits({ SEED_STAFF_PASSWORD: `Seed-${randomUUID()}` }));
  for (const row of (await admin().query<{ code: string; id: string }>('SELECT sku AS code, id FROM mdm.product')).rows) ids.set(row.code, row.id);
  branchId = (await admin().query<{ id: string }>("SELECT id FROM mdm.branch WHERE code = 'DDW'")).rows[0]!.id;
  for (const row of (await admin().query<{ code: string; id: string }>('SELECT l.code, l.id FROM mdm.location l WHERE l.branch_id = $1', [branchId])).rows) ids.set(`location:${row.code}`, row.id);
  for (const row of (await admin().query<{ sku: string; id: string }>("SELECT p.sku, u.id FROM inv.stock_unit u JOIN mdm.product p ON p.id = u.product_id WHERE p.sku IN ('MEAT-0005', 'MEAT-0007', 'EGG-0003') AND u.tracking = 'LOT'")).rows) ids.set(`lot:${row.sku}`, row.id);
  const staff: [string, string, RoleCode][] = [
    ['storekeeper', 'Yaw Boateng', 'STOREKEEPER'],
    ['sales', 'Kojo Antwi', 'SALES'],
    ['driver', 'Kwabena Asare', 'DRIVER'],
  ];
  for (const [key, name, role] of staff) sessions.set(key, await login(api.server, await createUser(database, { name, grants: [{ role, branchId }] })));
  sessions.set('cashier', await login(api.server, await createUser(database, { name: 'Adwoa Darko', grants: [{ role: 'CASHIER', branchId, locationId: id('location:SHOP') }] })));
  sessions.set('accountant', await enrolAndLogin(api.server, await createUser(database, { name: 'Esi Mensah', grants: [{ role: 'ACCOUNTANT', branchId }] }), () => clock.now()));
  sessions.set('manager', await enrolAndLogin(api.server, await createUser(database, { name: 'Abena Owusu', grants: [{ role: 'MANAGER', branchId }] }), () => clock.now()));
  const elsewhere = await createBranch(database, 'TMA');
  sessions.set('otherManager', await enrolAndLogin(api.server, await createUser(database, { name: 'Efua Quaye', grants: [{ role: 'MANAGER', branchId: elsewhere.branchId }] }), () => clock.now()));
  const till = await post('manager', '/registers', { branchId, locationId: id('location:SHOP'), code: 'T2', name: 'Collection counter till' });
  expect(till.status, JSON.stringify(till.body)).toBe(201);
  await stepUp(api.server, as('manager') as TotpSession, clock);
  const enrolled = await post('manager', `/registers/${till.body.id as string}/devices`, { deviceLabel: 'Collection counter tablet' });
  expect(enrolled.status, JSON.stringify(enrolled.body)).toBe(201);
  credential = enrolled.body.deviceCredential as string;
  shiftId = nextId();
  const opened = await post('cashier', '/shifts', { id: shiftId, registerId: till.body.id as string, openingFloatPesewas: 20_000, openedAt: clock.now().toISOString() }, shiftId);
  expect(opened.status, JSON.stringify(opened.body)).toBe(201);
});

afterAll(async () => {
  await api?.close();
  await fake?.close();
  await database?.drop();
});

describe('a guest collection order weighed heavier is handed over and paid at the till (FR-ORD-011, BL-097)', () => {
  let orderA: string;
  let listA: string;
  let receiptA: string;

  beforeAll(async () => {
    orderA = await collectionOrder([['MEAT-0005', '2.000']]);
    expect(await order(orderA)).toMatchObject({ fulfilmentMode: 'COLLECTION', estimatedTotalPesewas: 96_390, deliveryFeePesewas: 0, paymentStatus: 'DEPOSIT_HELD' });
    listA = await packed(orderA, (line) => [pick(line, 'lot:MEAT-0005', '1.000', '15.200'), pick(line, 'lot:MEAT-0005', '1.000', '15.600')]);
  });

  it('refuses every role but the Manager and the Owner, and another branch, writing nothing', async () => {
    for (const who of ['storekeeper', 'sales', 'cashier', 'driver', 'accountant', 'otherManager']) {
      const refused = await post(who, `/fulfilments/${listA}/collect`, {});
      expect(refused.status, who).toBe(403);
    }
    expect((await request(api.server).post(`/v1/fulfilments/${listA}/collect`).set('Origin', TEST_ORIGIN).set('Idempotency-Key', randomUUID()).send({})).status).toBe(401);
    expect(await count("SELECT count(*)::text AS n FROM bil.billing_document WHERE order_document_id = $1 AND kind <> 'PROFORMA'", [orderA])).toBe(0);
    expect((await order(orderA)).status).toBe('PACKED');
  });

  it('hands it over: the receipt for 98,960 on 30.800 kg, the 96,390 paid allocated, 2,570 left, the packs issued from the cold room', async () => {
    const key = randomUUID();
    const first = await post('manager', `/fulfilments/${listA}/collect`, {}, key);
    expect(first.status, JSON.stringify(first.body) + errors()).toBe(200);
    expect(first.body).toMatchObject({ id: listA, status: 'COLLECTED', weighedTotalPesewas: 98_960 });
    const o = await order(orderA);
    expect(o).toMatchObject({ status: 'READY_FOR_COLLECTION', finalTotalPesewas: 98_960, paidPesewas: 96_390, outstandingPesewas: 2_570, paymentStatus: 'PART_PAID', billingDocument: { docType: 'RECEIPT' } });
    receiptA = o.billingDocument.id as string;
    expect(await movements(orderA)).toEqual([
      ['SALE_ISSUE', 'COLD', 'V-CUSTOMER', '15.200'],
      ['SALE_ISSUE', 'COLD', 'V-CUSTOMER', '15.600'],
    ]);
    expect(await count("SELECT count(*)::text AS n FROM inv.stock_reservation WHERE holder_document_id = $1 AND status = 'ACTIVE'", [orderA])).toBe(0);
    expect(await count('SELECT count(*)::text AS n FROM del.delivery WHERE order_document_id = $1', [orderA])).toBe(0);
    const payload = (await one<{ payload: Record<string, unknown> }>("SELECT payload FROM platform.outbox_message WHERE event_type = 'ord.OrderCollected' AND subject_id = $1", [orderA])).payload;
    expect(payload).toMatchObject({ finalTotalPesewas: 98_960, allocatedPesewas: 96_390, refundRequestedPesewas: 0, dueAtTillPesewas: 2_570, completed: false });
    const again = await post('manager', `/fulfilments/${listA}/collect`, {}, key);
    expect([again.status, again.body]).toEqual([200, first.body]);
    const twice = await post('manager', `/fulfilments/${listA}/collect`, {});
    expect([twice.status, twice.body.error.code]).toEqual([422, 'INVALID_STATE_TRANSITION']);
    expect(await trialBalanceSum(database)).toBe('0');
  });

  it("takes what is left at the till against the guest's receipt: never more, never two payments together beyond it", async () => {
    expect((await pay('accountant', { billingDocumentId: receiptA, amountPesewas: 2_570 })).status).toBe(403);
    const over = await pay('cashier', { billingDocumentId: receiptA, amountPesewas: 2_571 });
    expect([over.status, over.body.error?.details?.[0]?.code]).toEqual([422, 'AMOUNT_EXCEEDS_OUTSTANDING']);
    // Two payments of 1,570 at once: 3,140 is more than the 2,570 left, so exactly one is taken.
    const [x, y] = await Promise.all([pay('cashier', { billingDocumentId: receiptA, amountPesewas: 1_570 }), pay('cashier', { billingDocumentId: receiptA, amountPesewas: 1_570 })]);
    expect([x.status, y.status].sort()).toEqual([201, 422]);
    expect([x, y].find((r) => r.status === 201)!.body).toMatchObject({ amountPesewas: 1_570, outstandingPesewas: 1_000 });
    const between = await order(orderA);
    expect({ status: between.status, outstandingPesewas: between.outstandingPesewas, paymentStatus: between.paymentStatus }, JSON.stringify([x.body, y.body])).toEqual({ status: 'READY_FOR_COLLECTION', outstandingPesewas: 1_000, paymentStatus: 'PART_PAID' });
    const rest = await pay('cashier', { billingDocumentId: receiptA, amountPesewas: 1_000, tenderedPesewas: 2_000 });
    expect([rest.status, rest.body.changeDuePesewas, rest.body.outstandingPesewas], JSON.stringify(rest.body) + errors()).toEqual([201, 1_000, 0]);
    expect(await order(orderA)).toMatchObject({ status: 'COMPLETED', paymentStatus: 'PAID', outstandingPesewas: 0 });
    const settled = await pay('cashier', { billingDocumentId: receiptA, amountPesewas: 1 });
    expect([settled.status, settled.body.error.details[0].code]).toEqual([422, 'NOT_AN_INVOICE']);
    expect(await count("SELECT count(*)::text AS n FROM pay.payment WHERE shift_document_id = $1 AND method_kind = 'CASH'", [shiftId])).toBe(2);
    expect(await count("SELECT count(*)::text AS n FROM ord.order_status_history WHERE sales_order_id = $1 AND to_status = 'COMPLETED'", [orderA])).toBe(1);
    expect(await trialBalanceSum(database)).toBe('0');
  });
});

describe('a guest pays the whole of what is left at once, and a collection paid in full completes at the hand-over', () => {
  it('completes a goat pack weighed at 15.800 kg once the guest pays the whole difference at the till', async () => {
    const orderB = await collectionOrder([['MEAT-0007', '1.000']]);
    const estimate = Number((await order(orderB)).estimatedTotalPesewas);
    const listB = await packed(orderB, (line) => [pick(line, 'lot:MEAT-0007', '1.000', '15.800')]);
    expect((await post('manager', `/fulfilments/${listB}/collect`, {})).status).toBe(200);
    const o = await order(orderB);
    const due = Number(o.finalTotalPesewas) - estimate;
    expect(due).toBeGreaterThan(0);
    expect(o).toMatchObject({ status: 'READY_FOR_COLLECTION', outstandingPesewas: due });
    const paid = await pay('cashier', { billingDocumentId: o.billingDocument.id, amountPesewas: due });
    expect([paid.status, paid.body.outstandingPesewas]).toEqual([201, 0]);
    expect((await order(orderB)).status).toBe('COMPLETED');
  });

  it('completes at the hand-over a crate of eggs paid ahead in full: nothing left to pay, nothing refunded', async () => {
    const orderC = await collectionOrder([['EGG-0003', '1.000']]);
    const listC = await packed(orderC, (line) => [pick(line, 'lot:EGG-0003', '1.000')], 'SHOP');
    const collected = await post('manager', `/fulfilments/${listC}/collect`, {});
    expect(collected.status, JSON.stringify(collected.body) + errors()).toBe(200);
    const o = await order(orderC);
    expect(o).toMatchObject({ status: 'COMPLETED', outstandingPesewas: 0, paymentStatus: 'PAID', finalTotalPesewas: o.estimatedTotalPesewas });
    expect(await count('SELECT count(*)::text AS n FROM pay.refund r JOIN pay.payment p ON p.id = r.original_payment_id WHERE p.order_document_id = $1', [orderC])).toBe(0);
    expect(await movements(orderC)).toEqual([['SALE_ISSUE', 'SHOP', 'V-CUSTOMER', '30.000']]);
  });

});
