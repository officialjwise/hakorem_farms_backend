import { randomUUID } from 'node:crypto';
import { ManualClock, Quantity } from '@hakorem/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Stock, StockHolds } from '../../../src/modules/inv';
import { totpAt } from '../../../src/modules/iam/domain/totp';
import { runAsSystem } from '../../../src/platform/context/request-context';
import { UnitOfWork } from '../../../src/platform/database/unit-of-work';
import { DocumentRegistry } from '../../../src/platform/documents/document-registry';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { consoleGet, consolePost, createUser, enrolAndLogin, login, relaxRateLimits, SYSTEM_PRINCIPAL, testStartTime, type TestSession } from '../../support/iam';
import { sqlStateOf, SQLSTATE } from '../../support/sql-state';
import { startTestApp, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * Holds over the seeded farm (FR-INV-022, FR-INV-008, ADR-0019, ADR-0035, threat model abuse case 23): a manager
 * places a quarantine or investigation hold and it blocks sale and dispatch until a different person releases it,
 * once, with a reason from the HOLD_RELEASE list; a withdrawal hold placed through the `Holds` interface (as LIV will)
 * is never released by anyone, through the API or the database, and blocks until its end; every write refuses the
 * wrong role and the wrong location.
 */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
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
const get = (session: TestSession, path: string) => consoleGet(api.server, session, `/v1${path}`);
const admin = () => database.pool('admin');
const inContext = <T>(fn: () => Promise<T>): Promise<T> => runAsSystem({ principalId: SYSTEM_PRINCIPAL, displayName: 'Hold test' }, randomUUID(), fn);

const beefTransfer = () => ({
  fromLocationId: id('location:COLD'),
  toLocationId: id('location:SHOP'),
  lines: [{ productId: id('product:MEAT-BEEF-15KG'), stockUnitId: id('unit:LOT-BEEF-2026-1110'), qty: '1.000' }],
});

/** A sale of one unit through `Stock.postIn`, as point of sale will post it, at `occurredAt`. */
async function sell(sku: string, unit: string, from: string, qty: string, occurredAt: Date): Promise<string> {
  return inContext(() =>
    api.app.get(UnitOfWork).run({ isolation: 'serializable' }, async (tx) => {
      const documentId = randomUUID();
      await api.app.get(DocumentRegistry).register(tx, { id: documentId, docType: 'STOCK_ADJUSTMENT', ownerModule: 'inv', branchId: id('branch:DDW'), actorId: SYSTEM_PRINCIPAL });
      const posted = await api.app.get(Stock).postIn(tx, SYSTEM_PRINCIPAL, {
        movementType: 'SALE_ISSUE',
        productId: id(`product:${sku}`),
        stockUnitId: id(`unit:${unit}`),
        branchId: id('branch:DDW'),
        fromLocationId: id(`location:${from}`),
        toLocationId: id('virtual:CUSTOMER'),
        qty: Quantity.parse(qty),
        sourceDocumentId: documentId,
        occurredAt,
      });
      return posted.id;
    }),
  ).catch((error: unknown) => (error as { code?: string }).code ?? String(error));
}

async function stepUp(session: TestSession & { readonly secret: Buffer }): Promise<void> {
  clock.advanceBy(30_000);
  const response = await post(session, '/auth/step-up', { code: totpAt(session.secret, Math.floor(clock.now().getTime() / 1000)) });
  expect(response.status).toBe(200);
}

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
       UNION ALL SELECT 'virtual:' || l.kind, l.id FROM mdm.location l JOIN mdm.branch b ON b.id = l.branch_id WHERE b.code = 'DDW' AND l.kind = 'CUSTOMER'
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

describe('an investigation hold blocks a sale until a different person releases it (FR-INV-022)', () => {
  let holdId: string;

  it('the Accountant, Storekeeper, Cashier, Sales, Driver and Farm hand are refused both writes with 403, audited, and no hold is placed', async () => {
    const count = async () => (await admin().query<{ n: number }>("SELECT count(*)::int AS n FROM platform.audit_event WHERE action = 'AUTHORISATION_FAILURE'")).rows[0]!.n;
    const before = await count();
    const fakeHold = randomUUID();
    for (const [role, session] of Object.entries({ accountant, coldStorekeeper, cashier, sales, driver, farmHand })) {
      const placed = await post(session, '/stock/holds', { stockUnitId: id('unit:LOT-BEEF-2026-1110'), kind: 'INVESTIGATION', note: 'Refused' });
      expect(placed.status, `createStockHold as ${role}`).toBe(403);
      const released = await post(session, `/stock/holds/${fakeHold}/release`, { reasonCode: 'INVESTIGATION_CLOSED', note: 'Refused' });
      expect(released.status, `releaseStockHold as ${role}`).toBe(403);
    }
    expect((await count()) - before).toBe(12);
    expect((await admin().query<{ n: number }>('SELECT count(*)::int AS n FROM inv.stock_hold')).rows[0]!.n).toBe(0);
  });

  it('refuses a withdrawal hold placed over the API (400): it arises only from recording a treatment', async () => {
    const refused = await post(manager, '/stock/holds', { stockUnitId: id('unit:G-0142'), kind: 'WITHDRAWAL', note: 'Treated' });
    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('the manager places an investigation on the beef lot; dispatch and a sale are refused with STOCK_UNIT_ON_HOLD', async () => {
    const placed = await post(manager, '/stock/holds', { stockUnitId: id('unit:LOT-BEEF-2026-1110'), kind: 'INVESTIGATION', note: 'Customer reported an off smell from a pack of this lot' });
    expect(placed.status, JSON.stringify(placed.body)).toBe(201);
    expect(placed.body).toMatchObject({ kind: 'INVESTIGATION', endsAt: null, releasedAt: null, sourceDocument: { id: placed.body.id, docType: 'STOCK_HOLD' }, createdBy: { displayName: 'Akosua Boateng' } });
    holdId = placed.body.id as string;
    const transfer = await post(coldStorekeeper, '/stock-transfers', beefTransfer());
    const dispatched = await post(coldStorekeeper, `/stock-transfers/${transfer.body.id as string}/dispatch`);
    expect(dispatched.status).toBe(422);
    expect(dispatched.body.error.code).toBe('STOCK_UNIT_ON_HOLD');
    expect(await sell('MEAT-BEEF-15KG', 'LOT-BEEF-2026-1110', 'COLD', '1.000', clock.now())).toBe('STOCK_UNIT_ON_HOLD');
  });

  it('lists the hold where the lot is, and not where it is not', async () => {
    expect((await get(coldStorekeeper, '/stock/holds?active=true')).body.data.map((h: { id: string }) => h.id)).toEqual([holdId]);
    expect((await get(shopStorekeeper, '/stock/holds')).body.data).toEqual([]);
    expect((await get(accountant, `/stock/holds?kind=INVESTIGATION&stockUnitId=${id('unit:LOT-BEEF-2026-1110')}`)).body.data).toHaveLength(1);
    expect((await get(cashier, '/stock/holds')).status).toBe(403);
  });

  it('refuses the person who placed it, and a reason from another list; the owner releases it with a reason and a note, once', async () => {
    const self = await post(manager, `/stock/holds/${holdId}/release`, { reasonCode: 'INVESTIGATION_CLOSED', note: 'Smelled fine to me' });
    expect(self.status).toBe(422);
    expect(self.body.error).toMatchObject({ code: 'STOCK_HOLD_INVALID', details: [{ code: 'RELEASED_BY_PLACER' }] });
    const wrongList = await post(owner, `/stock/holds/${holdId}/release`, { reasonCode: 'DAMAGED', note: 'Wrong list' });
    expect(wrongList.body.error.details[0].code).toBe('REASON_NOT_ALLOWED');
    const released = await post(owner, `/stock/holds/${holdId}/release`, { reasonCode: 'INVESTIGATION_CLOSED', note: 'Lot inspected; the complaint was about another supplier' });
    expect(released.status).toBe(200);
    expect(released.body).toMatchObject({ releaseReasonCode: 'INVESTIGATION_CLOSED', releasedBy: { displayName: 'Nana Ama Korsah' } });
    const twice = await post(owner, `/stock/holds/${holdId}/release`, { reasonCode: 'INVESTIGATION_CLOSED', note: 'Again' });
    expect(twice.status).toBe(422);
    expect(twice.body.error.code).toBe('INVALID_STATE_TRANSITION');
    const { rows } = await admin().query<{ action: string }>("SELECT action FROM platform.audit_event WHERE entity_type = 'StockHold' AND entity_id = $1 ORDER BY occurred_at", [holdId]);
    expect(rows.map((r) => r.action)).toEqual(['PLACE', 'RELEASE']);
  });

  it('once released, the lot is sold and dispatched again', async () => {
    expect(await sell('MEAT-BEEF-15KG', 'LOT-BEEF-2026-1110', 'COLD', '1.000', clock.now())).toMatch(/^[0-9a-f-]{36}$/);
    const transfer = await post(coldStorekeeper, '/stock-transfers', beefTransfer());
    expect((await post(coldStorekeeper, `/stock-transfers/${transfer.body.id as string}/dispatch`)).status).toBe(200);
  });
});

describe('a withdrawal hold is never released early (FR-INV-022, ADR-0019)', () => {
  let holdId: string;
  const ends = () => new Date(clock.now().getTime() + 14 * 86_400_000);

  it('placed through the Holds interface in the caller\'s transaction, it blocks the goat\'s sale', async () => {
    holdId = await inContext(() =>
      api.app.get(UnitOfWork).run({ isolation: 'serializable' }, async (tx) => {
        const treatment = randomUUID();
        await api.app.get(DocumentRegistry).register(tx, { id: treatment, docType: 'STOCK_HOLD', ownerModule: 'inv', branchId: id('branch:DDW'), actorId: SYSTEM_PRINCIPAL });
        return api.app.get(StockHolds).placeIn(tx, SYSTEM_PRINCIPAL, { stockUnitId: id('unit:G-0142'), kind: 'WITHDRAWAL', startsAt: clock.now(), endsAt: ends(), sourceDocumentId: treatment, note: 'Oxytetracycline, 14 days' });
      }),
    );
    expect(await sell('LIV-GOAT', 'G-0142', 'PENS', '1.000', clock.now())).toBe('STOCK_UNIT_ON_HOLD');
  });

  it('nobody releases it: the owner is refused with WITHDRAWAL_CANNOT_BE_RELEASED, and the database refuses a direct release', async () => {
    await stepUp(owner);
    const refused = await post(owner, `/stock/holds/${holdId}/release`, { reasonCode: 'TEST_NEGATIVE', note: 'Buyer is waiting' });
    expect(refused.status).toBe(422);
    expect(refused.body.error.code).toBe('WITHDRAWAL_CANNOT_BE_RELEASED');
    const direct = admin().query("UPDATE inv.stock_hold SET released_at = now(), released_by = $2, release_reason_code = 'TEST_NEGATIVE', release_note = 'Forced' WHERE id = $1", [
      holdId,
      (await admin().query<{ id: string }>("SELECT id FROM iam.principal WHERE display_name = 'Nana Ama Korsah'")).rows[0]!.id,
    ]);
    expect(await sqlStateOf(direct)).toBe('HK010');
    expect((await get(manager, '/stock/holds?kind=WITHDRAWAL&active=true')).body.data[0]).toMatchObject({ id: holdId, releasedAt: null, sourceDocument: { docType: 'STOCK_HOLD' } });
  });

  it('it ends by time: a sale dated after its end posts', async () => {
    expect(await sell('LIV-GOAT', 'G-0142', 'PENS', '1.000', new Date(ends().getTime() + 60_000))).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('the database refuses a release by the person who placed a hold (ck_stock_hold_releaser) and one without its note', async () => {
    const placed = await post(manager, '/stock/holds', { stockUnitId: id('unit:LOT-GOAT-0001'), kind: 'QUARANTINE', note: 'Freezer door found open' });
    const self = admin().query(
      "UPDATE inv.stock_hold SET released_at = now(), released_by = created_by, release_reason_code = 'QUARANTINE_COMPLETE', release_note = 'Self' WHERE id = $1",
      [placed.body.id],
    );
    expect(await sqlStateOf(self)).toBe(SQLSTATE.checkViolation);
    const owners = (await admin().query<{ id: string }>("SELECT id FROM iam.principal WHERE display_name = 'Nana Ama Korsah'")).rows[0]!.id;
    const unnoted = admin().query("UPDATE inv.stock_hold SET released_at = now(), released_by = $2, release_reason_code = 'QUARANTINE_COMPLETE' WHERE id = $1", [placed.body.id, owners]);
    expect(await sqlStateOf(unnoted)).toBe(SQLSTATE.checkViolation);
  });
});

describe("a hold's window is read on the application's clock, not the database's (ADR-0067)", () => {
  const goat = () => id('unit:G-0144');
  let reorderRuleId: string;
  let endsAt: Date;
  let startsAt: Date;

  /** What every read says of the goat: the published views, the on-hand list, the unit and the unit list's hold filter. */
  async function reads(): Promise<{ available: string; reorderHeld: string; listed: unknown; unitHolds: number; onHoldFilter: boolean }> {
    const views = await inContext(() =>
      api.app.get(UnitOfWork).run({ isolation: 'read committed' }, async (tx) => ({
        available: (await tx.query<{ q: string }>('SELECT available_qty::text AS q FROM inv.pub_stock_on_hand WHERE stock_unit_id = $1 AND on_hand_qty > 0', [goat()])).rows[0]!.q,
        reorderHeld: (await tx.query<{ q: string }>('SELECT held_qty::text AS q FROM inv.pub_reorder_level WHERE reorder_rule_id = $1', [reorderRuleId])).rows[0]!.q,
      })),
    );
    const onHand = await get(manager, `/stock/on-hand?stockUnitId=${goat()}`);
    expect(onHand.status, JSON.stringify(onHand.body)).toBe(200);
    const unit = await get(manager, `/stock-units/${goat()}`);
    const held = await get(manager, `/stock-units?onHold=true&productId=${id('product:LIV-GOAT')}`);
    return {
      ...views,
      listed: onHand.body.data.map((r: { availableQty: string; holds: string[] }) => ({ availableQty: r.availableQty, holds: r.holds })),
      unitHolds: (unit.body.activeHolds as unknown[]).length,
      onHoldFilter: (held.body.data as Array<{ id: string }>).some((u) => u.id === goat()),
    };
  }

  /** A reservation of the goat written straight into the table as hk_app in a unit of work, then rolled back. */
  async function reserve(): Promise<string> {
    const rolledBack = new Error('rolled back on purpose');
    return inContext(() =>
      api.app.get(UnitOfWork).run({ isolation: 'serializable' }, async (tx) => {
        const holder = randomUUID();
        await api.app.get(DocumentRegistry).register(tx, { id: holder, docType: 'STOCK_HOLD', ownerModule: 'inv', branchId: id('branch:DDW'), actorId: SYSTEM_PRINCIPAL });
        await tx.query(
          `INSERT INTO inv.stock_reservation (id, product_id, stock_unit_id, location_id, qty, is_exclusive, holder_document_id, status, branch_id, created_by, updated_by)
           VALUES ($1, $2, $3, $4, 1, true, $5, 'ACTIVE', $6, $7, $7)`,
          [randomUUID(), id('product:LIV-GOAT'), goat(), id('location:PENS'), holder, id('branch:DDW'), SYSTEM_PRINCIPAL],
        );
        throw rolledBack;
      }),
    ).catch((error: unknown) => (error === rolledBack ? 'RESERVED' : ((error as { constraint?: string }).constraint ?? String(error))));
  }

  it('places a quarantine on G-0144 that ends two minutes on (inside the life of an access token), under a reorder rule over the goats at the pens', async () => {
    reorderRuleId = randomUUID();
    await admin().query(
      `INSERT INTO inv.reorder_rule (id, product_id, branch_id, location_id, min_qty, reorder_point_qty, max_qty, created_by, updated_by)
       VALUES ($1, $2, $3, $4, 0, 0, 10, $5, $5)`,
      [reorderRuleId, id('product:LIV-GOAT'), id('branch:DDW'), id('location:PENS'), SYSTEM_PRINCIPAL],
    );
    endsAt = new Date(clock.now().getTime() + 2 * 60_000);
    const placed = await post(manager, '/stock/holds', { stockUnitId: goat(), kind: 'QUARANTINE', endsAt: endsAt.toISOString(), note: 'Coughing; kept apart for observation' });
    expect(placed.status, JSON.stringify(placed.body)).toBe(201);
  });

  it('one second before its end by the application clock, the goat is held in every read and a reservation is refused', async () => {
    clock.set(new Date(endsAt.getTime() - 1_000));
    expect(await reads()).toEqual({ available: '0.000', reorderHeld: '1.000', listed: [{ availableQty: '0.000', holds: ['QUARANTINE'] }], unitHolds: 1, onHoldFilter: true });
    expect(await reserve()).toBe('ck_stock_reservation_held');
  });

  it('at its end by the application clock, whatever the database clock says, the goat is free in every read and may be reserved', async () => {
    clock.set(endsAt);
    expect(await reads()).toEqual({ available: '1.000', reorderHeld: '0.000', listed: [{ availableQty: '1.000', holds: [] }], unitHolds: 0, onHoldFilter: false });
    expect(await reserve()).toBe('RESERVED');
  });

  it('a withdrawal hold that starts later is not in force one second before its start by the application clock, and is at its start', async () => {
    startsAt = new Date(clock.now().getTime() + 2 * 60_000);
    await inContext(() =>
      api.app.get(UnitOfWork).run({ isolation: 'serializable' }, async (tx) => {
        const treatment = randomUUID();
        await api.app.get(DocumentRegistry).register(tx, { id: treatment, docType: 'STOCK_HOLD', ownerModule: 'inv', branchId: id('branch:DDW'), actorId: SYSTEM_PRINCIPAL });
        return api.app.get(StockHolds).placeIn(tx, SYSTEM_PRINCIPAL, { stockUnitId: goat(), kind: 'WITHDRAWAL', startsAt, endsAt: new Date(startsAt.getTime() + 7 * 86_400_000), sourceDocumentId: treatment, note: 'Penicillin, 7 days' });
      }),
    );
    clock.set(new Date(startsAt.getTime() - 1_000));
    expect(await reads()).toEqual({ available: '1.000', reorderHeld: '0.000', listed: [{ availableQty: '1.000', holds: [] }], unitHolds: 0, onHoldFilter: false });
    expect(await reserve()).toBe('RESERVED');
    clock.set(startsAt);
    expect(await reads()).toEqual({ available: '0.000', reorderHeld: '1.000', listed: [{ availableQty: '0.000', holds: ['WITHDRAWAL'] }], unitHolds: 1, onHoldFilter: true });
    expect(await reserve()).toBe('ck_stock_reservation_held');
  });
});
