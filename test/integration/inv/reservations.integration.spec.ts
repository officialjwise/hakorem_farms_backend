import { randomUUID } from 'node:crypto';
import { ManualClock, Quantity } from '@hakorem/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ReservationExpiry, reservationLockKey, Reservations, Stock, StockHolds } from '../../../src/modules/inv';
import { runAsSystem } from '../../../src/platform/context/request-context';
import { UnitOfWork } from '../../../src/platform/database/unit-of-work';
import { DocumentRegistry } from '../../../src/platform/documents/document-registry';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { consoleGet, consolePost, createUser, enrolAndLogin, login, relaxRateLimits, SYSTEM_PRINCIPAL, testStartTime, type TestSession } from '../../support/iam';
import { startTestApp, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * Reservations, their expiry, availability and the stock unit list over the seeded farm (FR-INV-005, FR-INV-021,
 * FR-INV-025, ADR-0005, ADR-0019, ADR-0035): one active reservation per animal and reserved never above on hand, under
 * concurrency; a reservation is consumed whole by the movement that names it; the expiry job gives back exactly what
 * it reserved, once, and publishes `inv.ReservationExpired` through the outbox; availability is on hand less reserved
 * less held; every read and write refuses the wrong role.
 */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let manager: TestSession;
let accountant: TestSession;
let coldStorekeeper: TestSession;
let cashier: TestSession;
let sales: TestSession;
let driver: TestSession;
let farmHand: TestSession;
const ids = new Map<string, string>();

const id = (code: string) => ids.get(code)!;
const post = (session: TestSession, path: string, body: object = {}, key: string = randomUUID()) => consolePost(api.server, session, `/v1${path}`, key).send(body);
const get = (session: TestSession, path: string) => consoleGet(api.server, session, `/v1${path}`);
const admin = () => database.pool('admin');
const system = { principalId: SYSTEM_PRINCIPAL, displayName: 'Reservation test' };

/** Runs `work` in a serializable transaction as a module in the same process would; answers its result or the error code. */
function inTransaction<T>(work: (tx: Parameters<Parameters<UnitOfWork['run']>[1]>[0]) => Promise<T>, seriesLocks: readonly string[] = []): Promise<T | string> {
  return runAsSystem(system, randomUUID(), () => api.app.get(UnitOfWork).run({ isolation: 'serializable', seriesLocks }, work)).catch(
    (error: unknown) => (error as { code?: string }).code ?? String(error),
  );
}

/** A holder document: checkouts, orders and quotes arrive with SHP, ORD and QUO, so a stand-in is registered here. */
async function holder(): Promise<string> {
  const documentId = randomUUID();
  await inTransaction((tx) => api.app.get(DocumentRegistry).register(tx, { id: documentId, docType: 'STOCK_ADJUSTMENT', ownerModule: 'inv', branchId: id('branch:DDW'), actorId: SYSTEM_PRINCIPAL }));
  return documentId;
}

/** Reserves as a selling module will: naming the balance's lock, so concurrent reservations queue (FR-INV-025). */
function reserve(sku: string, unit: string | null, location: string, qty: string, holderId: string, expiresAt: Date | null): Promise<string> {
  const request = {
    productId: id(`product:${sku}`),
    stockUnitId: unit === null ? null : id(`unit:${unit}`),
    locationId: id(`location:${location}`),
    qty: Quantity.parse(qty),
    holderDocumentId: holderId,
    expiresAt,
  };
  return inTransaction((tx) => api.app.get(Reservations).reserveIn(tx, SYSTEM_PRINCIPAL, request), [reservationLockKey(request.productId, request.stockUnitId, request.locationId)]);
}

async function reserved(sku: string, location: string): Promise<string> {
  const { rows } = await admin().query<{ qty: string }>(
    'SELECT COALESCE(sum(reserved_qty), 0)::numeric(14,3)::text AS qty FROM inv.stock_balance WHERE product_id = $1 AND location_id = $2',
    [id(`product:${sku}`), id(`location:${location}`)],
  );
  return rows[0]!.qty;
}

async function activeSum(sku: string, location: string): Promise<string> {
  const { rows } = await admin().query<{ qty: string }>(
    "SELECT COALESCE(sum(qty), 0)::numeric(14,3)::text AS qty FROM inv.stock_reservation WHERE status = 'ACTIVE' AND product_id = $1 AND location_id = $2",
    [id(`product:${sku}`), id(`location:${location}`)],
  );
  return rows[0]!.qty;
}

const inMinutes = (minutes: number) => new Date(clock.now().getTime() + minutes * 60_000);

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock });
  await runSeedUnits(database.pool('app'), api.app, seedUnits({ SEED_STAFF_PASSWORD: `Seed-${randomUUID()}` }));
  for (const row of (
    await admin().query<{ code: string; id: string }>(
      `SELECT 'branch:' || code AS code, id FROM mdm.branch
       UNION ALL SELECT 'location:' || l.code, l.id FROM mdm.location l JOIN mdm.branch b ON b.id = l.branch_id WHERE b.code = 'DDW'
       UNION ALL SELECT 'virtual:' || l.kind, l.id FROM mdm.location l JOIN mdm.branch b ON b.id = l.branch_id WHERE b.code = 'DDW' AND l.is_virtual
       UNION ALL SELECT 'product:' || sku, id FROM mdm.product
       UNION ALL SELECT 'unit:' || identifier, id FROM inv.stock_unit`,
    )
  ).rows) {
    ids.set(row.code, row.id);
  }
  const branchId = id('branch:DDW');
  manager = await enrolAndLogin(api.server, await createUser(database, { name: 'Akosua Boateng', grants: [{ role: 'MANAGER', branchId }] }), () => clock.now());
  accountant = await enrolAndLogin(api.server, await createUser(database, { name: 'Yaw Agyeman', grants: [{ role: 'ACCOUNTANT', branchId }] }), () => clock.now());
  coldStorekeeper = await login(api.server, await createUser(database, { name: 'Kofi Mensah', grants: [{ role: 'STOREKEEPER', branchId, locationId: id('location:COLD') }] }));
  cashier = await login(api.server, await createUser(database, { name: 'Adwoa Darko', grants: [{ role: 'CASHIER', branchId, locationId: id('location:SHOP') }] }));
  sales = await login(api.server, await createUser(database, { name: 'Esi Appiah', grants: [{ role: 'SALES', branchId }] }));
  driver = await login(api.server, await createUser(database, { name: 'Selorm Agbeko', grants: [{ role: 'DRIVER', branchId }] }));
  farmHand = await login(api.server, await createUser(database, { name: 'Abdul-Rahman Iddrisu', grants: [{ role: 'FARM_HAND', branchId, locationId: id('location:PENS') }] }));
});

afterAll(async () => {
  await api.close();
  await database.drop();
});

describe('one active reservation per animal, and reserved never above on hand (FR-INV-021, FR-INV-025)', () => {
  let goatReservation: string;

  it('reserving goat G-0142 for checkout C1 succeeds; for C2 it is refused with STOCK_UNIT_RESERVED', async () => {
    const c1 = await holder();
    goatReservation = await reserve('LIV-0004', 'G-0142', 'PENS', '1.000', c1, inMinutes(15));
    expect(goatReservation).toMatch(/^[0-9a-f-]{36}$/);
    expect(await reserve('LIV-0004', 'G-0142', 'PENS', '1.000', await holder(), inMinutes(15))).toBe('STOCK_UNIT_RESERVED');
    const unit = (await get(manager, `/stock-units/${id('unit:G-0142')}`)).body;
    expect(unit.activeReservation).toMatchObject({ id: goatReservation, holderDocument: { id: c1 } });
  });

  it('ten concurrent reservations of one goat give exactly one', async () => {
    const outcomes = await Promise.all(Array.from({ length: 10 }, async () => reserve('LIV-0004', 'G-0143', 'PENS', '1.000', await holder(), inMinutes(15))));
    expect(outcomes.filter((o) => o === 'STOCK_UNIT_RESERVED' || o === 'INSUFFICIENT_STOCK')).toHaveLength(9);
    expect(outcomes.filter((o) => /^[0-9a-f-]{36}$/.test(o))).toHaveLength(1);
    const { rows } = await admin().query<{ n: number }>("SELECT count(*)::int AS n FROM inv.stock_reservation WHERE stock_unit_id = $1 AND status = 'ACTIVE'", [id('unit:G-0143')]);
    expect(rows[0]!.n).toBe(1);
  });

  it('reserving 41 of 40 yams is refused with INSUFFICIENT_STOCK; 50 concurrent reservations of one crate of eggs from 30 give exactly 30', async () => {
    expect(await reserve('PRD-0005', null, 'SHOP', '41.000', await holder(), inMinutes(15))).toBe('INSUFFICIENT_STOCK');
    const outcomes = await Promise.all(Array.from({ length: 50 }, async () => reserve('EGG-0003', 'EGG-BIG-2026-1110', 'SHOP', '1.000', await holder(), inMinutes(15))));
    expect(outcomes.filter((o) => /^[0-9a-f-]{36}$/.test(o))).toHaveLength(30);
    expect(outcomes.filter((o) => o === 'INSUFFICIENT_STOCK')).toHaveLength(20);
    expect(await reserved('EGG-0003', 'SHOP')).toBe('30.000');
    expect(await activeSum('EGG-0003', 'SHOP')).toBe('30.000');
  });

  it('a sale that does not name a reservation cannot dip below what is reserved; the reserved goat is sold by consuming its reservation whole', async () => {
    const sale = async (unit: string, reservationId: string | null) => {
      const documentId = await holder();
      return inTransaction(async (tx) => {
        const posted = reservationId === null
          ? await api.app.get(Stock).postIn(tx, SYSTEM_PRINCIPAL, { movementType: 'SALE_ISSUE', productId: id('product:LIV-0004'), stockUnitId: id(`unit:${unit}`), branchId: id('branch:DDW'), fromLocationId: id('location:PENS'), toLocationId: id('virtual:CUSTOMER'), qty: Quantity.parse('1.000'), sourceDocumentId: documentId, occurredAt: clock.now() })
          : await api.app.get(Reservations).consumeIn(tx, SYSTEM_PRINCIPAL, reservationId, { movementType: 'SALE_ISSUE', toLocationId: id('virtual:CUSTOMER'), sourceDocumentId: documentId, occurredAt: clock.now() });
        return posted.id;
      });
    };
    expect(await sale('G-0142', null)).toBe('STOCK_UNIT_RESERVED');
    const movementId = await sale('G-0142', goatReservation);
    expect(movementId).toMatch(/^[0-9a-f-]{36}$/);
    const { rows } = await admin().query<{ status: string; reservation_id: string }>(
      'SELECT r.status, m.reservation_id FROM inv.stock_reservation r JOIN inv.stock_movement m ON m.reservation_id = r.id WHERE r.id = $1',
      [goatReservation],
    );
    expect(rows).toEqual([{ status: 'CONSUMED', reservation_id: goatReservation }]);
    expect(await reserved('LIV-0004', 'PENS')).toBe(await activeSum('LIV-0004', 'PENS'));
  });

  it('a unit under a hold, and stock in transit, are never reserved', async () => {
    const treatment = await holder();
    expect(
      await inTransaction((tx) =>
        api.app.get(StockHolds).placeIn(tx, SYSTEM_PRINCIPAL, { stockUnitId: id('unit:G-0144'), kind: 'WITHDRAWAL', startsAt: new Date(Date.now() - 60_000), endsAt: new Date(Date.now() + 86_400_000), sourceDocumentId: treatment }),
      ),
    ).toMatch(/^[0-9a-f-]{36}$/);
    expect(await reserve('LIV-0004', 'G-0144', 'PENS', '1.000', await holder(), null)).toBe('STOCK_UNIT_ON_HOLD');
    expect(await reserve('MEAT-0005', 'LOT-BEEF-2026-1110', 'TRANSIT', '1.000', await holder(), null)).toBe('STOCK_UNIT_NOT_AVAILABLE');
  });
});

describe('reservations over HTTP: listed, and released once by a manager with a reason (FR-INV-021)', () => {
  let reservationId: string;

  it('the Cashier, Sales, Driver and Farm hand cannot list; only the Owner and Manager release; refusals are audited', async () => {
    reservationId = await reserve('PRD-0005', null, 'SHOP', '1.000', await holder(), null);
    for (const [role, session] of Object.entries({ cashier, sales, driver, farmHand })) {
      expect((await get(session, '/stock/reservations')).status, `listStockReservations as ${role}`).toBe(403);
    }
    const count = async () => (await admin().query<{ n: number }>("SELECT count(*)::int AS n FROM platform.audit_event WHERE action = 'AUTHORISATION_FAILURE'")).rows[0]!.n;
    const before = await count();
    for (const [role, session] of Object.entries({ accountant, coldStorekeeper, cashier, sales, driver, farmHand })) {
      const refused = await post(session, `/stock/reservations/${reservationId}/release`, { reason: 'Refused' });
      expect(refused.status, `releaseStockReservation as ${role}`).toBe(403);
    }
    expect(await count()).toBe(before + 6);
    expect((await get(accountant, `/stock/reservations?status=ACTIVE&productId=${id('product:PRD-0005')}`)).body.data.map((r: { id: string }) => r.id)).toContain(reservationId);
  });

  it('the manager releases it with a reason, giving back what it reserved and publishing inv.ReservationReleased; a second release is refused', async () => {
    const before = Number(await reserved('PRD-0005', 'SHOP'));
    const released = await post(manager, `/stock/reservations/${reservationId}/release`, { reason: 'Customer will not collect; quote withdrawn' });
    expect(released.status, JSON.stringify(released.body)).toBe(200);
    expect(released.body).toMatchObject({ id: reservationId, status: 'RELEASED', qty: '1.000', location: { code: 'SHOP' }, product: { sku: 'PRD-0005' } });
    expect(await reserved('PRD-0005', 'SHOP')).toBe((before - 1).toFixed(3));
    const events = await admin().query("SELECT 1 FROM platform.outbox_message WHERE event_type = 'inv.ReservationReleased' AND subject_id = $1", [reservationId]);
    expect(events.rowCount).toBe(1);
    const again = await post(manager, `/stock/reservations/${reservationId}/release`, { reason: 'Again' });
    expect(again.status).toBe(422);
    expect(again.body.error.code).toBe('INVALID_STATE_TRANSITION');
  });

  it('the cold room storekeeper sees only reservations at the cold room', async () => {
    const listed = (await get(coldStorekeeper, '/stock/reservations')).body.data as Array<{ location: { code: string } }>;
    expect(listed.every((r) => r.location.code === 'COLD')).toBe(true);
  });
});

describe('availability is on hand less reserved less held, and the stock unit list (FR-INV-005, FR-INV-021)', () => {
  it('goats in the pens: 3 on hand (G-0142 sold), 1 reserved, 1 held, so 1 available, low', async () => {
    const response = await get(manager, `/stock/availability?branchId=${id('branch:DDW')}&productId=${id('product:LIV-0004')}&locationId=${id('location:PENS')}`);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.data).toEqual([{ productId: id('product:LIV-0004'), uom: 'HEAD', onHandQty: '3.000', reservedQty: '1.000', heldQty: '1.000', availableQty: '1.000', availability: 'LOW_STOCK' }]);
  });

  it('eggs fully reserved are out of stock; a product with no stock answers a zero line; in-transit stock is left out', async () => {
    const response = await get(manager, `/stock/availability?branchId=${id('branch:DDW')}&productId=${id('product:EGG-0003')}&productId=${id('product:MEAT-0006')}`);
    const lines = new Map((response.body.data as Array<{ productId: string }>).map((l) => [l.productId, l]));
    expect(lines.get(id('product:EGG-0003'))).toMatchObject({ onHandQty: '30.000', reservedQty: '30.000', availableQty: '0.000', availability: 'OUT_OF_STOCK' });
    expect(lines.get(id('product:MEAT-0006'))).toMatchObject({ onHandQty: '0.000', availableQty: '0.000', availability: 'OUT_OF_STOCK' });
  });

  it('availability needs inv.stock.read: the Cashier, Sales, Driver and Farm hand are refused', async () => {
    for (const [role, session] of Object.entries({ cashier, sales, driver, farmHand })) {
      expect((await get(session, `/stock/availability?branchId=${id('branch:DDW')}`)).status, `listStockAvailability as ${role}`).toBe(403);
      expect((await get(session, '/stock-units')).status, `listStockUnits as ${role}`).toBe(403);
    }
  });

  it('lists the goats by tag, the ones on hold, and a cold room storekeeper sees only the lots with stock there', async () => {
    const goats = (await get(manager, `/stock-units?tracking=SERIAL&productId=${id('product:LIV-0004')}&q=g-014`)).body;
    expect(goats.data.map((u: { identifier: string }) => u.identifier)).toEqual(expect.arrayContaining(['G-0142', 'G-0143', 'G-0144', 'G-0145']));
    expect(goats.data.find((u: { identifier: string }) => u.identifier === 'G-0142')).toMatchObject({ status: 'SOLD' });
    const held = (await get(manager, '/stock-units?onHold=true')).body.data;
    expect(held.map((u: { identifier: string }) => u.identifier)).toEqual(['G-0144']);
    expect(held[0].activeHolds).toEqual([expect.objectContaining({ kind: 'WITHDRAWAL' })]);
    const cold = (await get(coldStorekeeper, '/stock-units')).body.data as Array<{ tracking: string; identifier: string }>;
    expect(cold.length).toBeGreaterThan(0);
    expect(cold.every((u) => u.tracking === 'LOT')).toBe(true);
    expect(cold.map((u) => u.identifier)).toContain('LOT-BEEF-2026-1110');
    const page = await get(manager, '/stock-units?limit=2');
    expect(page.body.page.hasMore).toBe(true);
    const next = await get(manager, `/stock-units?limit=2&cursor=${encodeURIComponent(page.body.page.nextCursor as string)}`);
    expect(next.body.data[0].id > page.body.data[1].id).toBe(true);
  });
});

describe('the expiry job gives back exactly what it reserved, once (FR-INV-021, ADR-0019)', () => {
  it('16 minutes later two concurrent runs expire each lapsed reservation once, publish one inv.ReservationExpired each, and leave the rest', async () => {
    const lapsing: string[] = [];
    for (let n = 0; n < 6; n++) lapsing.push(await reserve('PRD-0005', null, 'SHOP', '3.500', await holder(), inMinutes(15)));
    const lasting = await reserve('PRD-0005', null, 'SHOP', '2.000', await holder(), inMinutes(60));
    const open = await reserve('PRD-0005', null, 'SHOP', '1.000', await holder(), null);
    expect(await reserved('PRD-0005', 'SHOP')).toBe('24.000');
    clock.advanceBy(16 * 60_000);
    const expiry = api.app.get(ReservationExpiry);
    const run = () => runAsSystem(system, randomUUID(), () => expiry.run({ kind: 'SYSTEM', principalId: SYSTEM_PRINCIPAL }));
    const [first, second] = await Promise.all([run(), run()]);
    // Both runs together end every lapsed reservation once: these six, and the 15-minute ones of the tests above.
    const ended = [...first, ...second];
    expect(new Set(ended).size).toBe(ended.length);
    expect(ended).toEqual(expect.arrayContaining(lapsing));
    expect(ended).not.toContain(lasting);
    expect(ended).not.toContain(open);
    expect((await admin().query("SELECT 1 FROM inv.stock_reservation WHERE status = 'ACTIVE' AND expires_at <= $1", [clock.now()])).rowCount).toBe(0);
    expect(await reserved('EGG-0003', 'SHOP')).toBe('0.000');
    expect(await reserved('PRD-0005', 'SHOP')).toBe('3.000');
    expect(await activeSum('PRD-0005', 'SHOP')).toBe('3.000');
    const { rows } = await admin().query<{ id: string; status: string }>('SELECT id, status FROM inv.stock_reservation WHERE id = ANY($1::uuid[]) ORDER BY id', [[...lapsing, lasting, open]]);
    expect(rows.filter((r) => r.status === 'EXPIRED').map((r) => r.id).sort()).toEqual([...lapsing].sort());
    expect(rows.filter((r) => r.status === 'ACTIVE').map((r) => r.id).sort()).toEqual([lasting, open].sort());
    const events = (await admin().query<{ subject_id: string; qty: string }>(
      "SELECT subject_id, payload->>'qty' AS qty FROM platform.outbox_message WHERE event_type = 'inv.ReservationExpired' AND subject_id = ANY($1::uuid[])",
      [lapsing],
    )).rows;
    expect(events.map((e) => e.subject_id).sort()).toEqual([...lapsing].sort());
    expect(new Set(events.map((e) => e.qty))).toEqual(new Set(['3.500']));
    expect(await run()).toEqual([]);
  });

  it('a run interleaved with new reservations and releases leaves reserved equal to the sum of what is active', async () => {
    const lapsing: string[] = [];
    for (let n = 0; n < 4; n++) lapsing.push(await reserve('PRD-0005', null, 'SHOP', '1.250', await holder(), inMinutes(1)));
    clock.advanceBy(2 * 60_000);
    const expiry = api.app.get(ReservationExpiry);
    const outcomes = await Promise.all([
      runAsSystem(system, randomUUID(), () => expiry.run({ kind: 'SYSTEM', principalId: SYSTEM_PRINCIPAL })),
      ...Array.from({ length: 5 }, async () => reserve('PRD-0005', null, 'SHOP', '0.500', await holder(), inMinutes(30))),
    ]);
    expect(outcomes[0]).toHaveLength(4);
    expect(await reserved('PRD-0005', 'SHOP')).toBe(await activeSum('PRD-0005', 'SHOP'));
    expect(await reserved('PRD-0005', 'SHOP')).toBe('5.500');
  });

  it('never waits behind a reservation another session holds: it expires the rest and leaves that one for the next run', async () => {
    // FOR UPDATE SKIP LOCKED (ADR-0019): the job must not stall behind a checkout that has the row open. Deterministic:
    // one due reservation is locked from another session for the whole run.
    const lockedId = await reserve('PRD-0005', null, 'SHOP', '0.750', await holder(), inMinutes(1));
    const freeId = await reserve('PRD-0005', null, 'SHOP', '0.250', await holder(), inMinutes(1));
    clock.advanceBy(2 * 60_000);
    const expiry = api.app.get(ReservationExpiry);
    const run = () => runAsSystem(system, randomUUID(), () => expiry.run({ kind: 'SYSTEM', principalId: SYSTEM_PRINCIPAL }));
    const locker = await admin().connect();
    try {
      await locker.query('BEGIN');
      await locker.query('SELECT id FROM inv.stock_reservation WHERE id = $1 FOR UPDATE', [lockedId]);
      const stalled = Symbol('stalled');
      const first = await Promise.race([run(), new Promise<typeof stalled>((resolve) => setTimeout(() => resolve(stalled), 5_000))]);
      expect(first).not.toBe(stalled);
      expect(first).toContain(freeId);
      expect(first).not.toContain(lockedId);
    } finally {
      await locker.query('ROLLBACK');
      locker.release();
    }
    expect(await run()).toEqual([lockedId]);
    expect(await reserved('PRD-0005', 'SHOP')).toBe(await activeSum('PRD-0005', 'SHOP'));
  });

  it('the database itself refuses to end a reservation twice or to change what it promised, whatever the application does', async () => {
    // ck_stock_reservation_change (migration 0044): the application refuses a second release first, so this rule is
    // proved here directly, as the application role, without the service in front of it.
    const ended = await reserve('PRD-0005', null, 'SHOP', '0.500', await holder(), null);
    const live = await reserve('PRD-0005', null, 'SHOP', '0.500', await holder(), null);
    const app = database.pool('app');
    await app.query("UPDATE inv.stock_reservation SET status = 'RELEASED', released_reason = 'Customer left', version = version + 1, updated_by = $2 WHERE id = $1", [ended, SYSTEM_PRINCIPAL]);
    const before = await reserved('PRD-0005', 'SHOP');
    const refusal = (sql: string, params: unknown[]) =>
      app.query(sql, params).then(
        () => undefined,
        (error: { code?: string; constraint?: string }) => ({ code: error.code, constraint: error.constraint }),
      );
    const rule = { code: 'HK010', constraint: 'ck_stock_reservation_change' };
    expect(await refusal("UPDATE inv.stock_reservation SET status = 'EXPIRED', released_reason = 'Again', version = version + 1, updated_by = $2 WHERE id = $1", [ended, SYSTEM_PRINCIPAL])).toEqual(rule);
    expect(await refusal("UPDATE inv.stock_reservation SET status = 'RELEASED', released_reason = 'Twice', version = version + 1, updated_by = $2 WHERE id = $1", [ended, SYSTEM_PRINCIPAL])).toEqual(rule);
    expect(await refusal('UPDATE inv.stock_reservation SET qty = 5, version = version + 1, updated_by = $2 WHERE id = $1', [live, SYSTEM_PRINCIPAL])).toEqual(rule);
    expect(await reserved('PRD-0005', 'SHOP')).toBe(before);
    expect(await reserved('PRD-0005', 'SHOP')).toBe(await activeSum('PRD-0005', 'SHOP'));
  });
});
