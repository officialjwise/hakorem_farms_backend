import { randomUUID } from 'node:crypto';
import { createUuidV7Generator, ManualClock } from '@hakorem/kernel';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { stepUp, type TotpSession } from '../../support/fin';
import { consoleGet, consolePost, createBranch, createUser, enrolAndLogin, login, relaxRateLimits, testStartTime, type RoleCode, type TestSession } from '../../support/iam';
import { journalOf, trialBalanceSum } from '../../support/pay';
import { SQLSTATE, sqlStateOf } from '../../support/sql-state';
import { startTestApp, TEST_ORIGIN, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * A driver's cash on delivery handed in at a till shift (FR-DEL-010, CR-057, ADR-0077, ADR-0092; the owner, 2026-11-23:
 * "handed in once at a till shift, never typed in as loose cash; short shows as short"), the B11 continued 2 gate's
 * first part, over the seeded farm. Two crates of big eggs on cash on delivery (one crate each order), delivered by
 * Kwabena Asare with each crate's price collected exactly: he holds 2 x C. Adwoa Darko counts 1,000 pesewas short onto
 * her own open shift: the till takes 2C - 1,000, the driver's 1020 is cleared of 2C, 6900 takes the 1,000 short, and
 * the shift's close counts 2C - 1,000 beside its float. A third crate, handed in exact, posts no variance. Every figure
 * is read by SQL.
 */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let branchId: string;
let credential = '';
let shiftId = '';
let crate = 0;
const FLOAT = 20_000;
const nextId = () => createUuidV7Generator(clock)();
const ids = new Map<string, string>();
const id = (name: string) => ids.get(name)!;
const sessions = new Map<string, TestSession>();
const as = (name: string) => sessions.get(name)!;
const admin = () => database.pool('admin');
const post = (who: string, path: string, body: object, key = randomUUID()) => consolePost(api.server, as(who), `/v1${path}`, key).send(body);
const get = (who: string, path: string) => consoleGet(api.server, as(who), `/v1${path}`);
const one = async <T extends object>(sql: string, params: unknown[] = []) => (await admin().query<T & Record<string, unknown>>(sql, params)).rows[0]!;
const count = async (sql: string, params: unknown[] = []) => Number((await one<{ n: string }>(sql, params)).n);
const handIn = (who: string, shift: string, body: object, key: string = randomUUID(), device: string | null = credential) => {
  const call = consolePost(api.server, as(who), `/v1/shifts/${shift}/driver-cash-hand-ins`, key);
  if (device !== null) call.set('X-Device-Credential', device);
  return call.send(body);
};
/** Everything a hand-in writes, to show a refusal wrote none of it. */
const footprint = async () =>
  count(
    `SELECT ((SELECT count(*) FROM pay.payment) + (SELECT count(*) FROM del.driver_cash_reconciliation) + (SELECT count(*) FROM del.driver_cash_handed_in)
           + (SELECT count(*) FROM fin.journal_entry))::text AS n`,
  );
/** Debits less credits on an account, against one party when named. */
const balance = async (code: string, party: { kind: string; refId: string } | null = null) =>
  Number(
    (
      await one<{ n: string }>(
        `SELECT COALESCE(sum(CASE l.side WHEN 'D' THEN l.amount_pesewas ELSE -l.amount_pesewas END), 0)::text AS n
           FROM fin.journal_line l JOIN fin.account a ON a.id = l.account_id LEFT JOIN fin.subledger_party p ON p.id = l.subledger_party_id
          WHERE a.code = $1 AND ($2::text IS NULL OR (p.kind = $2 AND p.ref_id = $3::uuid))`,
        [code, party?.kind ?? null, party?.refId ?? null],
      )
    ).n,
  );

const dodowa = { recipientName: 'Ama Serwaa Ofori', recipientPhone: '0244512876', line1: 'Two houses after the Presby church', area: 'Dodowa', city: 'Dodowa', region: 'Greater Accra' };
const photo = (seed: number) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(1_020, seed)]);

/** A guest's order of one crate of big eggs on cash on delivery, picked, packed, dispatched to the driver and delivered with its price collected. */
async function deliveredCrate(seed: number): Promise<{ readonly orderId: string; readonly deliveryId: string; readonly gross: number }> {
  const created = await request(api.server).post('/v1/shop/carts').set('Origin', TEST_ORIGIN).set('Idempotency-Key', randomUUID());
  const cookie = (created.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('__Host-hk_guest='))!.split(';')[0]!;
  const cartId = created.body.id as string;
  const guest = (path: string, body: object) => request(api.server).post(`/v1${path}`).set('Origin', TEST_ORIGIN).set('Idempotency-Key', randomUUID()).set('Cookie', cookie).send(body);
  expect((await guest(`/shop/carts/${cartId}/lines`, { productId: id('EGG-0003'), quantity: '1.000' })).status).toBe(200);
  const started = await guest(`/shop/carts/${cartId}/checkout`, { contactName: 'Kofi Boateng', contactPhone: '0201234567', fulfilmentMode: 'DELIVERY', address: dodowa, paymentTerms: 'COD' });
  expect(started.status, JSON.stringify(started.body)).toBe(201);
  const placed = await guest(`/shop/checkouts/${started.body.id as string}/place`, { paymentMethod: 'COD' });
  expect(placed.status, JSON.stringify(placed.body)).toBe(201);
  const orderId = placed.body.orderId as string;
  const made = await post('storekeeper', `/orders/${orderId}/fulfilments`, { pickLocationId: id('location:SHOP') });
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  const lineId = (await get('manager', `/orders/${orderId}`)).body.lines[0].id as string;
  expect((await post('storekeeper', `/fulfilments/${made.body.id as string}/picks`, { picks: [{ id: nextId(), orderLineId: lineId, stockUnitId: id('lot:EGG-0003'), qty: '1.000' }] })).status).toBe(200);
  expect((await post('storekeeper', `/fulfilments/${made.body.id as string}/pack`, { packageCount: 1 })).status).toBe(200);
  const sent = await post('manager', `/fulfilments/${made.body.id as string}/dispatch`, { driverId: id('driver'), vehicleLocationId: id('location:VAN1') });
  expect(sent.status, JSON.stringify(sent.body)).toBe(200);
  const deliveryId = (await get('manager', `/deliveries?orderId=${orderId}`)).body.data[0].id as string;
  const gross = (await get('driver', `/driver/deliveries/${deliveryId}`)).body.codDuePesewas as number;
  const uploaded = await consolePost(api.server, as('driver'), '/v1/files').field('purpose', 'PROOF_OF_DELIVERY').attach('file', photo(seed), 'door.jpg');
  expect(uploaded.status, JSON.stringify(uploaded.body)).toBe(201);
  clock.advanceBy(60_000);
  const done = await post('driver', `/driver/deliveries/${deliveryId}/proof`, {
    id: nextId(),
    recipientName: 'Ama Serwaa Ofori',
    photoFileId: uploaded.body.id as string,
    codCollectedPesewas: gross,
    capturedAt: clock.now().toISOString(),
  });
  expect(done.status, JSON.stringify(done.body)).toBe(200);
  return { orderId, deliveryId, gross };
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
  api = await startTestApp(database, { clock, environment: { AUTH_ACCESS_TTL_SECONDS: '43200', AUTH_STAFF_REFRESH_IDLE_SECONDS: '172800' } });
  await runSeedUnits(database.pool('app'), api.app, seedUnits({ SEED_STAFF_PASSWORD: `Seed-${randomUUID()}` }));
  for (const row of (await admin().query<{ code: string; id: string }>('SELECT sku AS code, id FROM mdm.product')).rows) ids.set(row.code, row.id);
  for (const row of (await admin().query<{ code: string; id: string }>('SELECT code, id FROM mdm.payment_method')).rows) ids.set(`method:${row.code}`, row.id);
  branchId = (await admin().query<{ id: string }>("SELECT id FROM mdm.branch WHERE code = 'DDW'")).rows[0]!.id;
  for (const row of (await admin().query<{ code: string; id: string }>('SELECT l.code, l.id FROM mdm.location l WHERE l.branch_id = $1', [branchId])).rows) ids.set(`location:${row.code}`, row.id);
  ids.set('lot:EGG-0003', (await one<{ id: string }>("SELECT u.id FROM inv.stock_unit u JOIN mdm.product p ON p.id = u.product_id WHERE p.sku = 'EGG-0003' AND u.tracking = 'LOT'")).id);
  const staff: [string, string, RoleCode, boolean][] = [
    ['storekeeper', 'Yaw Boateng', 'STOREKEEPER', false],
    ['cashier', 'Adwoa Darko', 'CASHIER', true],
    ['otherCashier', 'Akosua Mensah', 'CASHIER', true],
    ['sales', 'Kojo Antwi', 'SALES', false],
    ['accountant', 'Esi Nyarko', 'ACCOUNTANT', false],
    ['driver', 'Kwabena Asare', 'DRIVER', false],
    ['otherDriver', 'Kwesi Appiah', 'DRIVER', false],
  ];
  for (const [key, name, role, atShop] of staff) {
    const user = await createUser(database, { name, grants: [{ role, branchId, ...(atShop ? { locationId: id('location:SHOP') } : {}) }] });
    ids.set(key, user.principalId);
    sessions.set(key, role === 'ACCOUNTANT' ? await enrolAndLogin(api.server, user, () => clock.now()) : await login(api.server, user));
  }
  const manager = await createUser(database, { name: 'Abena Owusu', grants: [{ role: 'MANAGER', branchId }] });
  ids.set('manager', manager.principalId);
  sessions.set('manager', await enrolAndLogin(api.server, manager, () => clock.now()));
  const elsewhere = await createBranch(database, 'TMA');
  sessions.set('otherManager', await enrolAndLogin(api.server, await createUser(database, { name: 'Efua Quaye', grants: [{ role: 'MANAGER', branchId: elsewhere.branchId }] }), () => clock.now()));

  const till = await post('manager', '/registers', { branchId, locationId: id('location:SHOP'), code: 'T2', name: 'Shop floor till' });
  expect(till.status, JSON.stringify(till.body)).toBe(201);
  ids.set('till', till.body.id as string);
  await stepUp(api.server, as('manager') as TotpSession, clock);
  const enrolled = await post('manager', `/registers/${id('till')}/devices`, { deviceLabel: 'Shop floor tablet' });
  expect(enrolled.status, JSON.stringify(enrolled.body)).toBe(201);
  credential = enrolled.body.deviceCredential as string;
  shiftId = nextId();
  const opened = await post('cashier', '/shifts', { id: shiftId, registerId: id('till'), openingFloatPesewas: FLOAT, openedAt: clock.now().toISOString() }, shiftId as ReturnType<typeof randomUUID>);
  expect(opened.status, JSON.stringify(opened.body)).toBe(201);
});

afterAll(async () => {
  await api?.close();
  await database?.drop();
});

describe('a driver hands in the cash collected on delivery at a till shift, once (CR-057, ADR-0092)', () => {
  let first: { readonly deliveryId: string; readonly gross: number };
  let second: { readonly deliveryId: string; readonly gross: number };
  let reconciliationId = '';
  let key = '';
  let answer: request.Response;

  beforeAll(async () => {
    first = await deliveredCrate(11);
    second = await deliveredCrate(12);
    crate = first.gross;
    expect(second.gross).toBe(crate);
    expect(crate).toBeGreaterThan(1_000);
  });

  it('shows the driver exactly the cash he holds, collection by collection, and nobody else\'s', async () => {
    const mine = await get('driver', '/driver/cash-summary');
    expect(mine.status, JSON.stringify(mine.body)).toBe(200);
    expect(mine.body).toMatchObject({ driver: { id: id('driver'), displayName: 'Kwabena Asare' }, expectedPesewas: 2 * crate, reconciled: false, currency: 'GHS' });
    expect(mine.body.collections.map((c: { amountPesewas: number; recipientName: string }) => [c.amountPesewas, c.recipientName])).toEqual([
      [crate, 'Ama Serwaa Ofori'],
      [crate, 'Ama Serwaa Ofori'],
    ]);
    expect(await balance('1020', { kind: 'DRIVER', refId: id('driver') })).toBe(2 * crate);
    expect((await get('otherDriver', '/driver/cash-summary')).body).toMatchObject({ expectedPesewas: 0, collections: [], reconciled: true });
    for (const who of ['cashier', 'storekeeper', 'sales', 'accountant']) expect((await get(who, '/driver/cash-summary')).status, who).toBe(403);
    expect((await get('driver', '/driver/cash-summary?date=2026-02-30')).status).toBe(400);
  });

  it('refuses every role but the till\'s own cashier on an enrolled device, and a driver with nothing held, writing nothing', async () => {
    const before = await footprint();
    const body = { driverId: id('driver'), declaredPesewas: 2 * crate };
    for (const who of ['driver', 'storekeeper', 'sales', 'accountant', 'otherManager']) expect((await handIn(who, shiftId, body)).status, who).toBe(403);
    expect((await handIn('otherCashier', shiftId, body)).status, 'another cashier\'s shift').toBe(403);
    expect((await handIn('manager', shiftId, body)).status, 'a manager is not the shift\'s cashier').toBe(403);
    expect((await handIn('cashier', shiftId, body, randomUUID(), null)).status).toBe(401);
    expect((await handIn('cashier', randomUUID(), body)).status).toBe(404);
    const nothing = await handIn('cashier', shiftId, { driverId: id('otherDriver'), declaredPesewas: 500 });
    expect([nothing.status, nothing.body.error?.code, nothing.body.error?.details?.[0]?.code]).toEqual([422, 'DRIVER_CASH_INVALID', 'NOTHING_HELD']);
    expect((await handIn('cashier', shiftId, { driverId: id('driver'), declaredPesewas: -1 })).status).toBe(400);
    expect((await handIn('cashier', shiftId, { driverId: id('driver'), declaredPesewas: 10, extra: true })).status).toBe(400);
    expect(await footprint()).toBe(before);
  });

  it('takes a short count as short: the till receives what was counted, the driver is cleared, 6900 takes the difference', async () => {
    key = randomUUID();
    answer = await handIn('cashier', shiftId, { driverId: id('driver'), declaredPesewas: 2 * crate - 1_000, note: 'Driver says one customer paid GHS 10.00 less' }, key);
    expect(answer.status, JSON.stringify(answer.body)).toBe(201);
    reconciliationId = answer.body.id as string;
    expect(answer.body).toMatchObject({
      status: 'POSTED',
      driver: { id: id('driver'), displayName: 'Kwabena Asare' },
      receivedBy: { id: id('cashier'), displayName: 'Adwoa Darko' },
      shiftId,
      expectedPesewas: 2 * crate,
      declaredPesewas: 2 * crate - 1_000,
      variancePesewas: 1_000,
      varianceDirection: 'SHORT',
      note: 'Driver says one customer paid GHS 10.00 less',
      currency: 'GHS',
      branchId,
    });
    expect(answer.body.collections.map((c: { amountPesewas: number }) => c.amountPesewas)).toEqual([crate, crate]);

    const till = await one<{ amount: string; shift: string; register: string; driver: string | null; from: string; customer: string | null; allocated: string; method: string; status: string }>(
      `SELECT amount_pesewas::text AS amount, shift_document_id AS shift, register_ref AS register, driver_id AS driver, received_from_driver_id AS from, customer_id AS customer,
              allocated_pesewas::text AS allocated, payment_method_id AS method, status
         FROM pay.payment WHERE id = $1`,
      [answer.body.tillPaymentId],
    );
    expect(till).toEqual({ amount: String(2 * crate - 1_000), shift: shiftId, register: id('till'), driver: null, from: id('driver'), customer: null, allocated: '0', method: id('method:COD'), status: 'CLEARED' });
    expect(await count('SELECT count(*)::text AS n FROM pay.payment_allocation WHERE payment_id = $1', [answer.body.tillPaymentId])).toBe(0);
    expect(await count("SELECT count(*)::text AS n FROM platform.outbox_message WHERE event_type = 'pay.PaymentCleared' AND subject_id = $1", [answer.body.tillPaymentId])).toBe(0);

    expect(await journalOf(database, reconciliationId, 'del.DriverCashRemitted')).toEqual([
      ['1000', 'D', 2 * crate - 1_000, 'T2'],
      ['1020', 'C', 2 * crate, 'Kwabena Asare'],
      ['6900', 'D', 1_000, null],
    ]);
    expect(await balance('1020', { kind: 'DRIVER', refId: id('driver') })).toBe(0);
    expect(await balance('1000', { kind: 'REGISTER', refId: id('till') })).toBe(FLOAT + 2 * crate - 1_000);
    expect(await trialBalanceSum(database)).toBe('0');

    const flagged = await one<{ payload: Record<string, unknown> }>("SELECT payload FROM platform.outbox_message WHERE event_type = 'del.DriverCashRemitted' AND subject_id = $1", [reconciliationId]);
    expect(flagged.payload).toMatchObject({ driverId: id('driver'), receivedBy: id('cashier'), expectedPesewas: 2 * crate, receivedPesewas: 2 * crate - 1_000, shortPesewas: 1_000, overPesewas: 0, varianceDirection: 'SHORT', abuseCases: [6, 43] });
    expect((await get('driver', '/driver/cash-summary')).body).toMatchObject({ expectedPesewas: 0, collections: [], reconciled: true });
  });

  it('hands each collection in exactly once: the same key answers the first, a second hand-in finds nothing held', async () => {
    const before = await footprint();
    const replay = await handIn('cashier', shiftId, { driverId: id('driver'), declaredPesewas: 2 * crate - 1_000, note: 'Driver says one customer paid GHS 10.00 less' }, key);
    expect([replay.status, replay.body]).toEqual([201, answer.body]);
    const again = await handIn('cashier', shiftId, { driverId: id('driver'), declaredPesewas: 2 * crate - 1_000 });
    expect([again.status, again.body.error?.details?.[0]?.code]).toEqual([422, 'NOTHING_HELD']);
    expect((await handIn('cashier', shiftId, { driverId: id('driver'), declaredPesewas: 1 }, key)).status).toBe(409);
    expect(await footprint()).toBe(before);
    expect(await count('SELECT count(*)::text AS n FROM del.driver_cash_handed_in')).toBe(2);
  });

  it('puts the driver variance report before the Manager and the Owner of the branch only', async () => {
    const report = await get('manager', '/driver-cash-reconciliations?varianceOnly=true');
    expect(report.status, JSON.stringify(report.body)).toBe(200);
    expect(report.body.data.map((r: { id: string; varianceDirection: string; variancePesewas: number }) => [r.id, r.varianceDirection, r.variancePesewas])).toEqual([[reconciliationId, 'SHORT', 1_000]]);
    expect((await get('manager', `/driver-cash-reconciliations?driverId=${id('otherDriver')}`)).body.data).toEqual([]);
    expect((await get('manager', `/driver-cash-reconciliations/${reconciliationId}`)).body).toEqual(answer.body);
    expect((await get('manager', `/driver-cash-reconciliations/${randomUUID()}`)).status).toBe(404);
    for (const who of ['cashier', 'driver', 'storekeeper', 'sales', 'accountant']) {
      expect((await get(who, '/driver-cash-reconciliations')).status, who).toBe(403);
      expect((await get(who, `/driver-cash-reconciliations/${reconciliationId}`)).status, who).toBe(403);
    }
    expect((await get('otherManager', `/driver-cash-reconciliations/${reconciliationId}`)).status).toBe(403);
    expect((await get('otherManager', '/driver-cash-reconciliations')).body.data).toEqual([]);
  });

  it('takes an exact count with no variance line', async () => {
    const third = await deliveredCrate(13);
    const exact = await handIn('cashier', shiftId, { driverId: id('driver'), declaredPesewas: third.gross });
    expect(exact.status, JSON.stringify(exact.body)).toBe(201);
    expect(exact.body).toMatchObject({ expectedPesewas: third.gross, declaredPesewas: third.gross, variancePesewas: 0, varianceDirection: 'EXACT' });
    expect(await journalOf(database, exact.body.id as string, 'del.DriverCashRemitted')).toEqual([
      ['1000', 'D', third.gross, 'T2'],
      ['1020', 'C', third.gross, 'Kwabena Asare'],
    ]);
    expect((await get('manager', '/driver-cash-reconciliations?varianceOnly=true')).body.data).toHaveLength(1);
    expect((await get('manager', '/driver-cash-reconciliations')).body.data).toHaveLength(2);
  });

  it('holds the rules in the database: the hand-in settles nothing, never changes, and each collection is handed in once', async () => {
    const app = database.pool('app');
    const tillPayment = answer.body.tillPaymentId as string;
    const document = (await one<{ id: string }>('SELECT billing_document_id AS id FROM del.delivery WHERE id = $1', [first.deliveryId])).id;
    expect(
      await sqlStateOf(
        app.query(`INSERT INTO pay.payment_allocation (id, payment_id, billing_document_id, amount_pesewas, direction, actor_id) VALUES ($1, $2, $3, 1, 'APPLY', $4)`, [randomUUID(), tillPayment, document, id('cashier')]),
      ),
    ).toBe('HK010');
    expect(await sqlStateOf(app.query("UPDATE pay.payment SET status = 'REVERSED' WHERE id = $1", [tillPayment]))).toBe('HK010');
    expect(await sqlStateOf(app.query('UPDATE pay.payment SET received_from_driver_id = NULL WHERE id = $1', [tillPayment]))).toBe('HK010');
    expect(await sqlStateOf(app.query('UPDATE del.driver_cash_reconciliation SET declared_pesewas = expected_pesewas WHERE id = $1', [reconciliationId]))).toBe(SQLSTATE.documentFrozen);
    expect(await sqlStateOf(app.query('DELETE FROM del.driver_cash_handed_in WHERE reconciliation_id = $1', [reconciliationId]))).toBe(SQLSTATE.insufficientPrivilege);
    expect(await sqlStateOf(admin().query('UPDATE del.driver_cash_handed_in SET amount_pesewas = 1 WHERE reconciliation_id = $1', [reconciliationId]))).toBe(SQLSTATE.ledgerImmutable);
    const proofId = (await one<{ id: string }>('SELECT id FROM del.proof_of_delivery WHERE delivery_id = $1', [first.deliveryId])).id;
    expect(await sqlStateOf(admin().query('INSERT INTO del.driver_cash_handed_in (reconciliation_id, proof_id, amount_pesewas, actor_id) VALUES ($1, $2, $3, $4)', [reconciliationId, proofId, crate, id('cashier')]))).toBe(
      SQLSTATE.uniqueViolation,
    );
    // A reconciliation with no collections behind it, each in its own transaction with its own document.
    const row = (receivedBy: string, declared: number, variance: number, direction: string) =>
      admin().query(
        `WITH doc AS (INSERT INTO platform.business_document (id, doc_type, owner_module, branch_id, actor_id) VALUES ($1, 'DRIVER_CASH_RECONCILIATION', 'del', $8, $7) RETURNING id)
         INSERT INTO del.driver_cash_reconciliation (id, driver_id, reconciliation_date, shift_document_id, expected_pesewas, declared_pesewas, variance_pesewas, variance_direction,
                                                     received_by, status, branch_id, created_by, updated_by, posted_at, posted_by)
         SELECT doc.id, $2, current_date, $3, 100, $4, $5, $6, $7, 'POSTED', $8, $7, $7, now(), $7 FROM doc`,
        [randomUUID(), id('driver'), shiftId, declared, variance, direction, receivedBy, branchId],
      );
    expect(await sqlStateOf(row(id('driver'), 0, 100, 'SHORT'))).toBe(SQLSTATE.checkViolation);
    expect(await sqlStateOf(row(id('cashier'), 0, 99, 'SHORT'))).toBe(SQLSTATE.checkViolation);
    expect(await sqlStateOf(row(id('cashier'), 0, 100, 'SHORT'))).toBe('HK010');
  });

  it('counts the hand-in at the shift\'s close and takes nothing once the shift stops taking cash', async () => {
    const third = (await one<{ amount: string }>("SELECT amount_pesewas::text AS amount FROM pay.payment WHERE received_from_driver_id = $1 ORDER BY id DESC LIMIT 1", [id('driver')])).amount;
    const expected = FLOAT + 2 * crate - 1_000 + Number(third);
    const declared = await post('cashier', `/shifts/${shiftId}/close`, { declared: [{ paymentMethodId: id('method:CASH'), declaredPesewas: expected }] });
    expect(declared.status, JSON.stringify(declared.body)).toBe(200);
    const fourth = await deliveredCrate(14);
    const before = await footprint();
    const closing = await handIn('cashier', shiftId, { driverId: id('driver'), declaredPesewas: fourth.gross });
    expect([closing.status, closing.body.error?.code]).toEqual([422, 'SHIFT_NOT_OPEN']);
    expect(await footprint()).toBe(before);
    await stepUp(api.server, as('manager') as TotpSession, clock);
    const signed = await post('manager', `/shifts/${shiftId}/approve-close`, { reason: 'Counted together' });
    expect(signed.status, JSON.stringify(signed.body)).toBe(200);
    expect(signed.body).toMatchObject({ status: 'CLOSED', expectedCashPesewas: expected, overShortDirection: 'EXACT' });
    expect(await balance('1000', { kind: 'REGISTER', refId: id('till') })).toBe(0);
    expect((await get('driver', '/driver/cash-summary')).body).toMatchObject({ expectedPesewas: fourth.gross, reconciled: false });
    expect(await trialBalanceSum(database)).toBe('0');
  });
});
