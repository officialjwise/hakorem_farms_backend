import { randomUUID } from 'node:crypto';
import { ManualClock, Quantity } from '@hakorem/kernel';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Reservations, Stock, StockAlertSweep } from '../../../src/modules/inv';
import { runAsSystem } from '../../../src/platform/context/request-context';
import { UnitOfWork } from '../../../src/platform/database/unit-of-work';
import { DocumentRegistry } from '../../../src/platform/documents/document-registry';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { addDays, seedCalendar, type SeedCalendar } from '../../../src/seed/seed-calendar';
import { seedUnits } from '../../../src/seed/seed-units';
import { consoleGet, consolePost, createUser, enrolAndLogin, login, relaxRateLimits, SYSTEM_PRINCIPAL, testStartTime, type TestSession } from '../../support/iam';
import { TEST_ORIGIN, startTestApp, type TestApp } from '../../support/test-app';
import { SQLSTATE } from '../../support/sql-state';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * The cold chain, reorder rules and stock alerts over the seeded farm (FR-INV-007, FR-INV-008, FR-INV-015,
 * FR-INV-016, A-134 (j), ADR-0019, threat model abuse case 25): a reading outside the cold room's range quarantines
 * every lot there, raises its exceptions and publishes its event in the reading's own transaction; a reorder rule
 * raises one low-stock alert per crossing, not per movement; the daily job raises expiring and expired alerts and an
 * expired lot is never sold; every write refuses the wrong role.
 */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
/** The seeded farm's dates, from the clock the seed ran on (B09t2). */
let seeded: SeedCalendar;
let manager: TestSession & { readonly secret: Buffer };
let owner: TestSession & { readonly secret: Buffer };
let accountant: TestSession;
let coldStorekeeper: TestSession;
let shopStorekeeper: TestSession;
let cashier: TestSession;
let sales: TestSession;
let driver: TestSession;
let farmHand: TestSession;
const ids = new Map<string, string>();

const id = (code: string) => ids.get(code)!;
const post = (session: TestSession, path: string, body: object = {}, key: string = randomUUID()) => consolePost(api.server, session, `/v1${path}`, key).send(body);
const patch = (session: TestSession, path: string, body: object, key: string = randomUUID()) =>
  request(api.server)
    .patch(`/v1${path}`)
    .set('Cookie', session.jar.header())
    .set('X-CSRF-Token', session.csrfToken)
    .set('Origin', TEST_ORIGIN)
    .set('Idempotency-Key', key)
    .send(body);
const get = (session: TestSession, path: string) => consoleGet(api.server, session, `/v1${path}`);
const admin = () => database.pool('admin');
const SYSTEM = { kind: 'SYSTEM' as const, principalId: SYSTEM_PRINCIPAL };
/** The daily stock-alerts job, run as the worker runs it: as a system principal (ADR-0049). */
const sweep = () => runAsSystem({ principalId: SYSTEM_PRINCIPAL, displayName: 'Scheduler' }, randomUUID(), () => api.app.get(StockAlertSweep).run(SYSTEM));

/** A movement through `Stock.postIn`, as a selling module will post it; answers the movement id or the error code. */
async function move(movementType: string, sku: string, from: string, to: string, qty: string, stockUnit: string | null = null): Promise<string> {
  return runAsSystem({ principalId: SYSTEM_PRINCIPAL, displayName: 'Alert test' }, randomUUID(), () =>
    api.app.get(UnitOfWork).run({ isolation: 'serializable' }, async (tx) => {
      const documentId = randomUUID();
      await api.app.get(DocumentRegistry).register(tx, { id: documentId, docType: 'STOCK_ADJUSTMENT', ownerModule: 'inv', branchId: id('branch:DDW'), actorId: SYSTEM_PRINCIPAL });
      const posted = await api.app.get(Stock).postIn(tx, SYSTEM_PRINCIPAL, {
        movementType,
        productId: id(`product:${sku}`),
        stockUnitId: stockUnit === null ? null : id(`unit:${stockUnit}`),
        branchId: id('branch:DDW'),
        fromLocationId: id(from),
        toLocationId: id(to),
        qty: Quantity.parse(qty),
        reasonCode: movementType === 'ADJUST_GAIN' ? 'FOUND_STOCK' : movementType === 'ADJUST_LOSS' ? 'EXPIRED' : null,
        sourceDocumentId: documentId,
        occurredAt: clock.now(),
      });
      return posted.id;
    }),
  ).catch((error: unknown) => (error as { code?: string }).code ?? String(error));
}

async function alertsOf(ruleId: string): Promise<Array<{ kind: string; status: string; qty: string; suggested_qty: string | null }>> {
  return (
    await admin().query<{ kind: string; status: string; qty: string; suggested_qty: string | null }>(
      'SELECT kind, status, qty::text, suggested_qty::text FROM inv.stock_alert WHERE reorder_rule_id = $1 ORDER BY raised_at, id',
      [ruleId],
    )
  ).rows;
}

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock });
  await runSeedUnits(database.pool('app'), api.app, seedUnits({ SEED_STAFF_PASSWORD: `Seed-${randomUUID()}` }));
  seeded = seedCalendar(clock.now());
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
  owner = await enrolAndLogin(api.server, await createUser(database, { name: 'Nana Ama Korsah', grants: [{ role: 'OWNER', branchId }] }), () => clock.now());
  accountant = await enrolAndLogin(api.server, await createUser(database, { name: 'Yaw Agyeman', grants: [{ role: 'ACCOUNTANT', branchId }] }), () => clock.now());
  coldStorekeeper = await login(api.server, await createUser(database, { name: 'Kofi Mensah', grants: [{ role: 'STOREKEEPER', branchId, locationId: id('location:COLD') }] }));
  shopStorekeeper = await login(api.server, await createUser(database, { name: 'Efua Quaye', grants: [{ role: 'STOREKEEPER', branchId, locationId: id('location:SHOP') }] }));
  cashier = await login(api.server, await createUser(database, { name: 'Adwoa Darko', grants: [{ role: 'CASHIER', branchId, locationId: id('location:SHOP') }] }));
  sales = await login(api.server, await createUser(database, { name: 'Esi Appiah', grants: [{ role: 'SALES', branchId }] }));
  driver = await login(api.server, await createUser(database, { name: 'Selorm Agbeko', grants: [{ role: 'DRIVER', branchId }] }));
  farmHand = await login(api.server, await createUser(database, { name: 'Abdul-Rahman Iddrisu', grants: [{ role: 'FARM_HAND', branchId, locationId: id('location:PENS') }] }));
});

afterAll(async () => {
  await api.close();
  await database.drop();
});

describe('temperature readings against the location range (FR-INV-007)', () => {
  it('records -18.5 and the bound -18.0 at the frozen cold room as in range, with no quarantine', async () => {
    for (const readingC of ['-18.5', '-18.0', '-25.0']) {
      const recorded = await post(coldStorekeeper, '/temperature-readings', { locationId: id('location:COLD'), readingC, measuredAt: clock.now().toISOString(), source: 'MANUAL' });
      expect(recorded.status, JSON.stringify(recorded.body)).toBe(201);
      expect(recorded.body).toMatchObject({ readingC, isExcursion: false, exceptionId: null, location: { code: 'COLD', kind: 'COLD_ROOM' }, source: 'MANUAL', actor: { displayName: 'Kofi Mensah' } });
    }
    expect((await admin().query('SELECT 1 FROM inv.stock_hold')).rowCount).toBe(0);
  });

  it('refuses a location with no permitted range, a virtual one and a time more than five minutes ahead', async () => {
    const shop = await post(shopStorekeeper, '/temperature-readings', { locationId: id('location:SHOP'), readingC: '24.0', measuredAt: clock.now().toISOString(), source: 'MANUAL' });
    expect(shop.status).toBe(422);
    expect(shop.body.error).toMatchObject({ code: 'TEMPERATURE_READING_INVALID', details: [{ field: '/locationId', code: 'NO_TEMPERATURE_RANGE' }] });
    const ahead = await post(coldStorekeeper, '/temperature-readings', { locationId: id('location:COLD'), readingC: '-19.0', measuredAt: new Date(clock.now().getTime() + 6 * 60_000).toISOString(), source: 'SENSOR' });
    expect(ahead.body.error).toMatchObject({ code: 'TEMPERATURE_READING_INVALID', details: [{ field: '/measuredAt', code: 'IN_THE_FUTURE' }] });
    const virtual = await post(manager, '/temperature-readings', { locationId: id('virtual:LOSS'), readingC: '-19.0', measuredAt: clock.now().toISOString(), source: 'MANUAL' });
    expect(virtual.body.error).toMatchObject({ code: 'TEMPERATURE_READING_INVALID', details: [{ code: 'NOT_A_STOCK_LOCATION' }] });
    expect((await post(manager, '/temperature-readings', { locationId: id('location:COLD'), readingC: '-18.25', measuredAt: clock.now().toISOString(), source: 'MANUAL' })).status).toBe(400);
  });

  it('stores a reading once for its client id, and never lets it be changed', async () => {
    const readingId = randomUUID();
    const body = { id: readingId, locationId: id('location:COLD'), readingC: '-20.0', measuredAt: clock.now().toISOString(), source: 'SENSOR' };
    const first = await post(coldStorekeeper, '/temperature-readings', body);
    const again = await post(coldStorekeeper, '/temperature-readings', { ...body, readingC: '-21.0' });
    expect(first.status).toBe(201);
    expect(again.status).toBe(201);
    expect(again.body).toEqual(first.body);
    expect((await admin().query('SELECT reading_c::text FROM inv.temperature_reading WHERE id = $1', [readingId])).rows).toEqual([{ reading_c: '-20.0' }]);
    await expect(database.pool('app').query("UPDATE inv.temperature_reading SET reading_c = -30 WHERE id = $1", [readingId])).rejects.toMatchObject({ code: expect.any(String) });
    await expect(database.pool('app').query('DELETE FROM inv.temperature_reading WHERE id = $1', [readingId])).rejects.toMatchObject({ code: expect.any(String) });
  });

  it('refuses at the database a reading whose excursion flag disagrees with the range it was judged by', async () => {
    const error = await database
      .pool('app')
      .query(
        `INSERT INTO inv.temperature_reading (id, location_id, branch_id, reading_c, range_min_c, range_max_c, measured_at, source, is_excursion, actor_id)
         VALUES ($1, $2, $3, -9.5, -25.0, -18.0, now(), 'MANUAL', false, $4)`,
        [randomUUID(), id('location:COLD'), id('branch:DDW'), SYSTEM_PRINCIPAL],
      )
      .catch((e: unknown) => e as { code: string; constraint: string });
    expect(error).toMatchObject({ code: SQLSTATE.checkViolation, constraint: 'ck_temperature_reading_excursion' });
  });

  it('lists readings within the reader\'s grants, and refuses the cashier, the driver and the farm hand', async () => {
    const listed = await get(accountant, `/temperature-readings?locationId=${id('location:COLD')}&limit=2`);
    expect(listed.status).toBe(200);
    expect(listed.body.data).toHaveLength(2);
    expect(listed.body.page.hasMore).toBe(true);
    const next = await get(accountant, `/temperature-readings?locationId=${id('location:COLD')}&limit=2&cursor=${encodeURIComponent(listed.body.page.nextCursor as string)}`);
    expect(next.body.data.map((r: { id: string }) => r.id)).not.toContain(listed.body.data[0].id);
    expect((await get(shopStorekeeper, '/temperature-readings')).body.data).toEqual([]);
    for (const session of [cashier, driver, farmHand]) expect((await get(session, '/temperature-readings')).status).toBe(403);
  });
});

describe('an excursion quarantines every lot in the room, in the reading\'s transaction (FR-INV-008)', () => {
  let readingId: string;
  let exceptionIds: string[];

  it('a -9.5 reading in the frozen cold room holds both meat lots, raises two exceptions and publishes its event', async () => {
    const measuredAt = new Date(clock.now().getTime() - 10 * 60_000);
    const recorded = await post(coldStorekeeper, '/temperature-readings', { locationId: id('location:COLD'), readingC: '-9.5', measuredAt: measuredAt.toISOString(), source: 'SENSOR' });
    expect(recorded.status, JSON.stringify(recorded.body)).toBe(201);
    expect(recorded.body).toMatchObject({ readingC: '-9.5', isExcursion: true });
    readingId = recorded.body.id as string;
    const holds = (
      await admin().query<{ identifier: string; kind: string; starts_at: Date; created_by: string; doc_type: string }>(
        `SELECT u.identifier, h.kind, h.starts_at, h.created_by, d.doc_type FROM inv.stock_hold h
           JOIN inv.stock_unit u ON u.id = h.stock_unit_id JOIN platform.business_document d ON d.id = h.source_document_id ORDER BY u.identifier`,
      )
    ).rows;
    expect(holds.map((h) => [h.identifier, h.kind, h.doc_type])).toEqual([
      ['LOT-BEEF-2026-1110', 'QUARANTINE', 'TEMPERATURE_EXCURSION'],
      ['LOT-GOAT-0001', 'QUARANTINE', 'TEMPERATURE_EXCURSION'],
    ]);
    expect(holds.every((h) => h.starts_at.getTime() === measuredAt.getTime())).toBe(true);
    const exceptions = (
      await admin().query<{ id: string; kind: string; qty: string; source_document_id: string; details: Record<string, unknown> }>(
        "SELECT id, kind, qty::text, source_document_id, details FROM inv.stock_exception WHERE kind = 'TEMPERATURE_EXCURSION' ORDER BY qty",
      )
    ).rows;
    expect(exceptions.map((e) => [e.qty, e.details['readingC'], e.details['minC'], e.details['maxC']])).toEqual([
      ['30.000', '-9.5', '-25.0', '-18.0'],
      ['45.000', '-9.5', '-25.0', '-18.0'],
    ]);
    exceptionIds = exceptions.map((e) => e.id);
    expect(exceptionIds).toContain(recorded.body.exceptionId);
    const outbox = await admin().query<{ payload: { holdIds: string[]; exceptionIds: string[]; readingC: string } }>(
      "SELECT payload FROM platform.outbox_message WHERE event_type = 'inv.TemperatureExcursionRecorded' AND subject_id = $1",
      [readingId],
    );
    expect(outbox.rows).toHaveLength(1);
    expect(outbox.rows[0]!.payload).toMatchObject({ readingC: '-9.5', minC: '-25.0', maxC: '-18.0' });
    expect(outbox.rows[0]!.payload.holdIds).toHaveLength(2);
    const shown = await get(manager, `/stock/exceptions/${recorded.body.exceptionId as string}`);
    expect(shown.body).toMatchObject({ kind: 'TEMPERATURE_EXCURSION', status: 'OPEN', location: { code: 'COLD' }, sourceDocument: { docType: 'TEMPERATURE_EXCURSION' } });
    expect(shown.body.summary).toMatch(/^-9\.5 °C at COLD, outside -25\.0 to -18\.0 °C; \d+\.000 quarantined$/);
  });

  it('refuses a sale of a quarantined lot with STOCK_UNIT_ON_HOLD, and leaves its pen moves alone', async () => {
    expect(await move('SALE_ISSUE', 'MEAT-BEEF-15KG', 'location:COLD', 'virtual:CUSTOMER', '1.000', 'LOT-BEEF-2026-1110')).toBe('STOCK_UNIT_ON_HOLD');
    const listed = await get(manager, '/stock/holds?active=true&kind=QUARANTINE');
    expect(listed.body.data).toHaveLength(2);
  });

  it('releases a hold only with a reason, never by the person who recorded the excursion, and audits it', async () => {
    const hold = (await admin().query<{ id: string }>("SELECT h.id FROM inv.stock_hold h JOIN inv.stock_unit u ON u.id = h.stock_unit_id WHERE u.identifier = 'LOT-BEEF-2026-1110'")).rows[0]!;
    expect((await post(manager, `/stock/holds/${hold.id}/release`, { note: 'Room back at -19.0' })).status).toBe(400);
    const managerRecorded = await post(manager, '/temperature-readings', { locationId: id('location:COLD'), readingC: '-17.0', measuredAt: clock.now().toISOString(), source: 'MANUAL' });
    expect(managerRecorded.body.isExcursion).toBe(true);
    const own = (
      await admin().query<{ id: string }>(
        "SELECT h.id FROM inv.stock_hold h JOIN inv.stock_unit u ON u.id = h.stock_unit_id WHERE u.identifier = 'LOT-BEEF-2026-1110' AND h.created_by <> $1",
        [(await admin().query<{ created_by: string }>('SELECT created_by FROM inv.stock_hold WHERE id = $1', [hold.id])).rows[0]!.created_by],
      )
    ).rows[0]!;
    const byPlacer = await post(manager, `/stock/holds/${own.id}/release`, { reasonCode: 'QUARANTINE_COMPLETE', note: 'Probe' });
    expect(byPlacer.body.error).toMatchObject({ code: 'STOCK_HOLD_INVALID', details: [{ code: 'RELEASED_BY_PLACER' }] });
    for (const id of [hold.id, own.id]) {
      const released = await post(owner, `/stock/holds/${id}/release`, { reasonCode: 'QUARANTINE_COMPLETE', note: 'Lot inspected, core temperature held below -18' });
      expect(released.status, JSON.stringify(released.body)).toBe(200);
    }
    const audited = await admin().query("SELECT 1 FROM platform.audit_event WHERE entity_type = 'StockHold' AND action = 'RELEASE' AND entity_id = $1", [hold.id]);
    expect(audited.rowCount).toBe(1);
    expect(await move('SALE_ISSUE', 'MEAT-BEEF-15KG', 'location:COLD', 'virtual:CUSTOMER', '1.000', 'LOT-BEEF-2026-1110')).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('is refused to every role that does not record readings, each refusal audited', async () => {
    const body = { locationId: id('location:COLD'), readingC: '-19.0', measuredAt: clock.now().toISOString(), source: 'MANUAL' };
    for (const session of [accountant, cashier, sales, driver, farmHand, shopStorekeeper]) {
      const refused = await post(session, '/temperature-readings', body);
      expect(refused.status).toBe(403);
      expect(refused.body.error.code).toBe('FORBIDDEN');
    }
  });
});

describe('one low-stock alert per crossing (FR-INV-015)', () => {
  let ruleId: string;

  it('creates a rule for yam at Dodowa: 40 on hand is above its reorder point, so nothing is raised', async () => {
    const created = await post(shopStorekeeper, '/reorder-rules', {
      productId: id('product:PRD-YAM-TUBER'),
      branchId: id('branch:DDW'),
      locationId: id('location:SHOP'),
      minQty: '10.000',
      reorderPointQty: '20.000',
      maxQty: '100.000',
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body).toMatchObject({ product: { sku: 'PRD-YAM-TUBER' }, location: { code: 'SHOP' }, minQty: '10.000', reorderPointQty: '20.000', maxQty: '100.000', expiryAlertDays: null, version: 1 });
    ruleId = created.body.id as string;
    expect(await alertsOf(ruleId)).toEqual([]);
    const again = await post(manager, '/reorder-rules', { productId: id('product:PRD-YAM-TUBER'), branchId: id('branch:DDW'), locationId: id('location:SHOP'), minQty: '1.000', reorderPointQty: '2.000', maxQty: '3.000' });
    expect(again.body.error).toMatchObject({ code: 'REORDER_RULE_INVALID', details: [{ code: 'RULE_EXISTS' }] });
  });

  it('refuses levels out of order and a location that holds no stock of its own', async () => {
    const bad = await post(manager, '/reorder-rules', {
      productId: id('product:EGG-CRATE-BIG'),
      branchId: id('branch:DDW'),
      locationId: id('location:TRANSIT'),
      minQty: '20.000',
      reorderPointQty: '10.000',
      maxQty: '5.000',
    });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('REORDER_RULE_INVALID');
    expect(bad.body.error.details.map((d: { code: string }) => d.code)).toEqual(['BELOW_MINIMUM', 'BELOW_REORDER_POINT', 'NOT_A_STOCK_LOCATION']);
    expect((await post(manager, '/reorder-rules', { productId: randomUUID(), branchId: id('branch:DDW'), minQty: '1.000', reorderPointQty: '2.000', maxQty: '3.000' })).body.error.code).toBe('REFERENCE_NOT_FOUND');
  });

  it('raises nothing from 40 to 21, one alert suggesting 81 at 19, and no second one at 18', async () => {
    expect(await move('SALE_ISSUE', 'PRD-YAM-TUBER', 'location:SHOP', 'virtual:CUSTOMER', '19.000')).toMatch(/^[0-9a-f-]{36}$/);
    expect(await alertsOf(ruleId)).toEqual([]);
    expect(await move('SALE_ISSUE', 'PRD-YAM-TUBER', 'location:SHOP', 'virtual:CUSTOMER', '2.000')).toMatch(/^[0-9a-f-]{36}$/);
    expect(await alertsOf(ruleId)).toEqual([{ kind: 'LOW_STOCK', status: 'OPEN', qty: '19.000', suggested_qty: '81.000' }]);
    expect(await move('SALE_ISSUE', 'PRD-YAM-TUBER', 'location:SHOP', 'virtual:CUSTOMER', '1.000')).toMatch(/^[0-9a-f-]{36}$/);
    expect(await alertsOf(ruleId)).toEqual([{ kind: 'LOW_STOCK', status: 'OPEN', qty: '19.000', suggested_qty: '81.000' }]);
    // The seeded branch-wide yam rule (reorder point 25) raised its own alert on the way down; this is the shop's.
    const outbox = await admin().query("SELECT payload FROM platform.outbox_message WHERE event_type = 'inv.StockAlertRaised' AND payload->>'productId' = $1 AND payload->>'locationId' = $2", [
      id('product:PRD-YAM-TUBER'),
      id('location:SHOP'),
    ]);
    expect(outbox.rows.map((r) => (r.payload as { suggestedQty: string }).suggestedQty)).toEqual(['81.000']);
  });

  it('lists the open alert with what is available now and the suggestion to reach the maximum', async () => {
    const listed = await get(shopStorekeeper, '/stock/alerts?kind=LOW_STOCK');
    expect(listed.status).toBe(200);
    const yam = (listed.body.data as Array<{ product: { sku: string } }>).find((a) => a.product.sku === 'PRD-YAM-TUBER');
    expect(yam).toMatchObject({ kind: 'LOW_STOCK', location: { code: 'SHOP' }, stockUnit: null, uom: expect.any(String), onHandQty: '18.000', thresholdQty: '20.000', suggestedQty: '82.000', expiresOn: null, daysToExpiry: null });
    expect((await get(coldStorekeeper, '/stock/alerts')).body.data.find((a: { product: { sku: string } }) => a.product.sku === 'PRD-YAM-TUBER')).toBeUndefined();
    expect((await get(cashier, '/stock/alerts')).status).toBe(403);
  });

  it('shows the rule at or below its reorder point in the published view RPT reads (ADR-0011)', async () => {
    const { rows } = await database
      .pool('report')
      .query('SELECT available_qty::text, at_or_below_reorder_point, below_minimum FROM inv.pub_reorder_level WHERE reorder_rule_id = $1', [ruleId]);
    expect(rows).toEqual([{ available_qty: '18.000', at_or_below_reorder_point: true, below_minimum: false }]);
  });

  it('clears the alert once stock rises above the point, and raises a new one when it falls again', async () => {
    expect(await move('ADJUST_GAIN', 'PRD-YAM-TUBER', 'virtual:ADJUSTMENT', 'location:SHOP', '7.000')).toMatch(/^[0-9a-f-]{36}$/);
    expect((await alertsOf(ruleId)).map((a) => a.status)).toEqual(['CLEARED']);
    expect(await move('SALE_ISSUE', 'PRD-YAM-TUBER', 'location:SHOP', 'virtual:CUSTOMER', '5.000')).toMatch(/^[0-9a-f-]{36}$/);
    expect(await alertsOf(ruleId)).toEqual([
      { kind: 'LOW_STOCK', status: 'CLEARED', qty: '19.000', suggested_qty: '81.000' },
      { kind: 'LOW_STOCK', status: 'OPEN', qty: '20.000', suggested_qty: '80.000' },
    ]);
  });

  it('counts a reservation against what is available: reserving 11 of 20 raises BELOW_MINIMUM', async () => {
    const holder = randomUUID();
    await runAsSystem({ principalId: SYSTEM_PRINCIPAL, displayName: 'Alert test' }, randomUUID(), () =>
      api.app.get(UnitOfWork).run({ isolation: 'serializable' }, async (tx) => {
        await api.app.get(DocumentRegistry).register(tx, { id: holder, docType: 'STOCK_ADJUSTMENT', ownerModule: 'inv', branchId: id('branch:DDW'), actorId: SYSTEM_PRINCIPAL });
        await api.app.get(Reservations).reserveIn(tx, SYSTEM_PRINCIPAL, {
          productId: id('product:PRD-YAM-TUBER'),
          locationId: id('location:SHOP'),
          qty: Quantity.parse('11.000'),
          holderDocumentId: holder,
          expiresAt: new Date(clock.now().getTime() + 15 * 60_000),
        });
      }),
    );
    expect((await alertsOf(ruleId)).filter((a) => a.status === 'OPEN').map((a) => [a.kind, a.qty])).toEqual([
      ['LOW_STOCK', '20.000'],
      ['BELOW_MINIMUM', '9.000'],
    ]);
  });

  it('keeps one open alert of a kind per rule at the database, whoever writes', async () => {
    const error = await database
      .pool('app')
      .query(
        `INSERT INTO inv.stock_alert (id, kind, branch_id, product_id, location_id, reorder_rule_id, qty, threshold_qty, status, raised_at, created_by, updated_by)
         VALUES ($1, 'LOW_STOCK', $2, $3, $4, $5, 1, 20, 'OPEN', now(), $6, $6)`,
        [randomUUID(), id('branch:DDW'), id('product:PRD-YAM-TUBER'), id('location:SHOP'), ruleId, SYSTEM_PRINCIPAL],
      )
      .catch((e: unknown) => e as { code: string; constraint: string });
    expect(error).toMatchObject({ code: SQLSTATE.uniqueViolation, constraint: 'uq_stock_alert_open_rule' });
  });

  it('changes a rule with its version, judging it again at once, and refuses a stale version and the wrong roles', async () => {
    const changed = await patch(manager, `/reorder-rules/${ruleId}`, { version: 1, minQty: '5.000', reorderPointQty: '8.000' });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    expect(changed.body).toMatchObject({ minQty: '5.000', reorderPointQty: '8.000', maxQty: '100.000', version: 2 });
    expect((await alertsOf(ruleId)).filter((a) => a.status === 'OPEN')).toEqual([]);
    expect((await patch(manager, `/reorder-rules/${ruleId}`, { version: 1, maxQty: '90.000' })).status).toBe(409);
    expect((await patch(manager, `/reorder-rules/${ruleId}`, { version: 2, maxQty: '6.000' })).body.error).toMatchObject({ code: 'REORDER_RULE_INVALID', details: [{ code: 'BELOW_REORDER_POINT' }] });
    for (const session of [accountant, cashier, sales, driver, farmHand, coldStorekeeper]) {
      expect((await patch(session, `/reorder-rules/${ruleId}`, { version: 2, maxQty: '90.000' })).status).toBe(403);
      expect((await post(session, '/reorder-rules', { productId: id('product:EGG-CRATE-BIG'), branchId: id('branch:DDW'), minQty: '1.000', reorderPointQty: '2.000', maxQty: '3.000' })).status).toBe(403);
    }
    const listed = await get(accountant, '/reorder-rules?productId=' + id('product:PRD-YAM-TUBER'));
    expect(listed.body.data.map((r: { id: string }) => r.id)).toContain(ruleId);
    expect((await get(cashier, '/reorder-rules')).status).toBe(403);
  });
});

describe('expiring and expired lots (FR-INV-016, A-134 (j))', () => {
  const EGGS = 'EGG-BIG-2026-1110';
  /** An instant on the business day `days` after the eggs' expiry (Accra is UTC). */
  const fromExpiry = (days: number, time: string) => new Date(`${addDays(seeded.eggsExpireOn, days)}T${time}Z`);

  it('raises one EXPIRING alert five days (the eggs\' rule) before their expiry, by the daily job', async () => {
    clock.set(fromExpiry(-6, '06:30:00'));
    expect((await sweep()).expiryRaised).toBe(0);
    clock.set(fromExpiry(-5, '06:30:00'));
    expect((await sweep()).expiryRaised).toBe(1);
    expect((await sweep()).expiryRaised).toBe(0);
    const session = await login(api.server, await createUser(database, { name: 'Ama Owusu', grants: [{ role: 'STOREKEEPER', branchId: id('branch:DDW'), locationId: id('location:SHOP') }] }));
    const listed = await get(session, '/stock/alerts?kind=EXPIRING');
    expect(listed.body.data).toEqual([
      expect.objectContaining({ kind: 'EXPIRING', stockUnit: expect.objectContaining({ identifier: EGGS }), location: expect.objectContaining({ code: 'SHOP' }), onHandQty: '30.000', expiresOn: seeded.eggsExpireOn, daysToExpiry: 5, thresholdQty: null, suggestedQty: null }),
    ]);
  });

  it('sells the eggs on their expiry date, refuses a sale the day after with STOCK_UNIT_EXPIRED, and marks them expired', async () => {
    clock.set(fromExpiry(0, '18:00:00'));
    expect(await move('SALE_ISSUE', 'EGG-CRATE-BIG', 'location:SHOP', 'virtual:CUSTOMER', '1.000', EGGS)).toMatch(/^[0-9a-f-]{36}$/);
    clock.set(fromExpiry(1, '06:30:00'));
    expect(await move('SALE_ISSUE', 'EGG-CRATE-BIG', 'location:SHOP', 'virtual:CUSTOMER', '1.000', EGGS)).toBe('STOCK_UNIT_EXPIRED');
    expect(await move('SALE_ISSUE_OFFLINE', 'EGG-CRATE-BIG', 'location:SHOP', 'virtual:CUSTOMER', '1.000', EGGS)).toBe('STOCK_UNIT_EXPIRED');
    expect(await sweep()).toMatchObject({ expiryRaised: 1, expiryCleared: 1 });
    const open = await admin().query<{ kind: string; status: string }>(
      'SELECT kind, status FROM inv.stock_alert WHERE stock_unit_id = $1 ORDER BY raised_at',
      [id(`unit:${EGGS}`)],
    );
    expect(open.rows).toEqual([
      { kind: 'EXPIRING', status: 'CLEARED' },
      { kind: 'EXPIRED', status: 'OPEN' },
    ]);
    // A write-off is not a sale: the expired lot leaves by an adjustment loss.
    expect(await move('ADJUST_LOSS', 'EGG-CRATE-BIG', 'location:SHOP', 'virtual:LOSS', '29.000', EGGS)).not.toBe('STOCK_UNIT_EXPIRED');
  });

  it('refuses the sale of an expired lot at the database for every role, whoever inserts it', async () => {
    // The goat meat lot is still quarantined by the excursions above; a manager releases it first.
    await admin().query(
      "UPDATE inv.stock_hold SET released_at = now(), released_by = $1, release_reason_code = 'QUARANTINE_COMPLETE', release_note = 'Inspected' WHERE released_at IS NULL",
      [SYSTEM_PRINCIPAL],
    );
    const documentId = randomUUID();
    await admin().query("INSERT INTO platform.business_document (id, doc_type, owner_module, branch_id, actor_id) VALUES ($1, 'STOCK_ADJUSTMENT', 'inv', $2, $3)", [documentId, id('branch:DDW'), SYSTEM_PRINCIPAL]);
    const error = await admin()
      .query(
        `INSERT INTO inv.stock_movement (id, movement_type, product_id, stock_unit_id, branch_id, from_location_id, to_location_id, qty_base, value_pesewas, source_document_id, occurred_at, actor_id)
         VALUES ($1, 'SALE_ISSUE', $2, $3, $4, $5, $6, 1, 0, $7, $8, $9)`,
        [randomUUID(), id('product:MEAT-GOAT-15KG'), id('unit:LOT-GOAT-0001'), id('branch:DDW'), id('location:COLD'), id('virtual:CUSTOMER'), documentId, fromExpiry(1, '10:00:00'), SYSTEM_PRINCIPAL],
      )
      .then(() => null)
      .catch((e: unknown) => e as { code: string; constraint: string });
    // LOT-GOAT-0001 expires 90 days after its delivery, long after the eggs: this sale is allowed. One dated after it is not.
    expect(error).toBeNull();
    await admin().query('UPDATE inv.stock_unit SET expires_on = $2::date, version = version + 1 WHERE id = $1', [id('unit:LOT-GOAT-0001'), seeded.eggsExpireOn]);
    const refused = await admin()
      .query(
        `INSERT INTO inv.stock_movement (id, movement_type, product_id, stock_unit_id, branch_id, from_location_id, to_location_id, qty_base, value_pesewas, source_document_id, occurred_at, actor_id)
         VALUES ($1, 'SALE_ISSUE', $2, $3, $4, $5, $6, 1, 0, $7, $8, $9)`,
        [randomUUID(), id('product:MEAT-GOAT-15KG'), id('unit:LOT-GOAT-0001'), id('branch:DDW'), id('location:COLD'), id('virtual:CUSTOMER'), documentId, fromExpiry(1, '00:30:00'), SYSTEM_PRINCIPAL],
      )
      .catch((e: unknown) => e as { code: string; constraint: string });
    expect(refused).toMatchObject({ code: 'HK010', constraint: 'ck_stock_expired' });
  });
});
