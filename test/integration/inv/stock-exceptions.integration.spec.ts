import { randomUUID } from 'node:crypto';
import { ManualClock, Quantity } from '@hakorem/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Stock } from '../../../src/modules/inv';
import { totpAt } from '../../../src/modules/iam/domain/totp';
import { runAsSystem } from '../../../src/platform/context/request-context';
import { UnitOfWork } from '../../../src/platform/database/unit-of-work';
import { DocumentRegistry } from '../../../src/platform/documents/document-registry';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { consoleGet, consolePost, createUser, enrolAndLogin, login, relaxRateLimits, SYSTEM_PRINCIPAL, testStartTime, type TestSession } from '../../support/iam';
import { startTestApp, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * Stock exceptions and the held transfer variance over the seeded farm (FR-INV-011, FR-INV-023, ADR-0048, ADR-0017,
 * ADR-0035, threat model abuse case 7): a shortfall on arrival is held in transit, never a loss at receipt, and is never
 * sold, reserved or moved by anything but its own resolution; a person resolves it once, by a write-off through the
 * adjustment path (at or above 50,000 pesewas it waits for a different person, the threshold copied onto the
 * adjustment) or as found; any other exception is resolved with its adjustment or with no correction; every write
 * refuses the wrong role.
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
const BEEF = 'MEAT-BEEF-15KG';
const LOT = 'LOT-BEEF-2026-1110';

async function stepUp(session: TestSession & { readonly secret: Buffer }): Promise<void> {
  clock.advanceBy(30_000);
  const response = await post(session, '/auth/step-up', { code: totpAt(session.secret, Math.floor(clock.now().getTime() / 1000)) });
  expect(response.status).toBe(200);
}

async function onHand(location: string): Promise<string> {
  const { rows } = await admin().query<{ qty: string }>(
    'SELECT COALESCE(sum(on_hand_qty), 0)::numeric(14,3)::text AS qty FROM inv.stock_balance WHERE location_id = $1 AND product_id = $2 AND stock_unit_id = $3',
    [id(`location:${location}`), id(`product:${BEEF}`), id(`unit:${LOT}`)],
  );
  return rows[0]!.qty;
}

async function stockValue(): Promise<bigint> {
  return BigInt((await admin().query<{ v: string }>('SELECT sum(value_pesewas)::text AS v FROM inv.cost_pool')).rows[0]!.v);
}

/** The beef lot's on hand everywhere from a fresh sum of its movements, against the balances the trigger keeps. */
async function handCount(): Promise<{ readonly ledger: string; readonly balances: string }> {
  const { rows } = await admin().query<{ ledger: string; balances: string }>(
    `SELECT (SELECT COALESCE(sum(CASE WHEN m.to_location_id = l.id THEN m.qty_base ELSE -m.qty_base END), 0)
               FROM inv.stock_movement m, mdm.location l
              WHERE m.stock_unit_id = $1 AND l.id IN (m.from_location_id, m.to_location_id) AND NOT l.is_virtual)::numeric(14,3)::text AS ledger,
            (SELECT COALESCE(sum(b.on_hand_qty), 0) FROM inv.stock_balance b JOIN mdm.location l ON l.id = b.location_id
              WHERE b.stock_unit_id = $1 AND NOT l.is_virtual)::numeric(14,3)::text AS balances`,
    [id(`unit:${LOT}`)],
  );
  return rows[0]!;
}

/** Dispatches `qty` kg of the beef lot from the cold room to the shop and receives `received` with reason DAMAGED. */
async function shortTransfer(qty: string, received: string): Promise<{ readonly transferId: string; readonly exceptionId: string }> {
  const created = await post(coldStorekeeper, '/stock-transfers', {
    fromLocationId: id('location:COLD'),
    toLocationId: id('location:SHOP'),
    lines: [{ productId: id(`product:${BEEF}`), stockUnitId: id(`unit:${LOT}`), qty }],
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  expect((await post(coldStorekeeper, `/stock-transfers/${created.body.id as string}/dispatch`)).status).toBe(200);
  const receipt = await post(shopStorekeeper, `/stock-transfers/${created.body.id as string}/receive`, {
    lines: [{ lineId: created.body.lines[0].id, qtyReceived: received, varianceReasonCode: 'DAMAGED' }],
  });
  expect(receipt.status, JSON.stringify(receipt.body)).toBe(200);
  const exception = (await admin().query<{ id: string }>("SELECT id FROM inv.stock_exception WHERE source_document_id = $1 AND kind = 'TRANSFER_VARIANCE'", [created.body.id])).rows[0]!;
  return { transferId: created.body.id as string, exceptionId: exception.id };
}

/** A movement posted through `Stock.postIn`, as another module would; answers the movement id or the error code. */
async function move(movementType: string, from: string, to: string, qty: string): Promise<string> {
  return runAsSystem({ principalId: SYSTEM_PRINCIPAL, displayName: 'Exception test' }, randomUUID(), () =>
    api.app.get(UnitOfWork).run({ isolation: 'serializable' }, async (tx) => {
      const documentId = randomUUID();
      await api.app.get(DocumentRegistry).register(tx, { id: documentId, docType: 'STOCK_ADJUSTMENT', ownerModule: 'inv', branchId: id('branch:DDW'), actorId: SYSTEM_PRINCIPAL });
      const posted = await api.app.get(Stock).postIn(tx, SYSTEM_PRINCIPAL, {
        movementType,
        productId: id(`product:${BEEF}`),
        stockUnitId: id(`unit:${LOT}`),
        branchId: id('branch:DDW'),
        fromLocationId: id(`location:${from}`),
        toLocationId: id(to),
        qty: Quantity.parse(qty),
        sourceDocumentId: documentId,
        occurredAt: clock.now(),
      });
      return posted.id;
    }),
  ).catch((error: unknown) => (error as { code?: string }).code ?? String(error));
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

describe('a shortfall on arrival is held in transit, not lost (ADR-0048)', () => {
  let held: { readonly transferId: string; readonly exceptionId: string };

  it('receiving 9.800 of 10.000 kg puts 9.800 in the shop, keeps 0.200 in transit at its value, posts no loss, and opens a TRANSFER_VARIANCE with no movement', async () => {
    const valueBefore = await stockValue();
    const shopBefore = await onHand('SHOP');
    held = await shortTransfer('10.000', '9.800');
    expect(await onHand('SHOP')).toBe((Number(shopBefore) + 9.8).toFixed(3));
    expect(await onHand('TRANSIT')).toBe('0.200');
    expect(await stockValue()).toBe(valueBefore);
    const losses = await admin().query("SELECT 1 FROM inv.stock_movement WHERE source_document_id = $1 AND movement_type = 'ADJUST_LOSS'", [held.transferId]);
    expect(losses.rowCount).toBe(0);
    const exception = await get(manager, `/stock/exceptions/${held.exceptionId}`);
    expect(exception.status, JSON.stringify(exception.body)).toBe(200);
    expect(exception.body).toMatchObject({
      kind: 'TRANSFER_VARIANCE',
      status: 'OPEN',
      movementId: null,
      qty: '0.200',
      location: { code: 'TRANSIT', kind: 'IN_TRANSIT' },
      stockUnit: { identifier: LOT },
      sourceDocument: { id: held.transferId, docType: 'STOCK_TRANSFER' },
      summary: 'Received 9.800 of 10.000 dispatched; 0.200 held in transit until written off or found',
      details: { reasonCode: 'DAMAGED', heldValuePesewas: 2_400 },
      resolutionKind: null,
    });
    // The hand count still reconciles: the whole lot (45.000 kg received) is on hand, 0.200 of it held in transit.
    expect(await handCount()).toEqual({ ledger: '45.000', balances: '45.000' });
  });

  it('held stock is never sold, reserved or moved out of transit by anything but its resolution, whoever writes', async () => {
    expect(await move('SALE_ISSUE', 'TRANSIT', 'virtual:CUSTOMER', '0.100')).toBe('STOCK_UNIT_NOT_AVAILABLE');
    expect(await move('TRANSFER_RECEIPT', 'TRANSIT', 'location:SHOP', '0.100')).toBe('INSUFFICIENT_STOCK');
    const reserved = (await database
      .pool('app')
      .query(
        `INSERT INTO inv.stock_reservation (id, product_id, stock_unit_id, location_id, qty, is_exclusive, holder_document_id, status, branch_id, created_by, updated_by)
         VALUES ($1, $2, $3, $4, 0.1, false, $5, 'ACTIVE', $6, $7, $7)`,
        [randomUUID(), id(`product:${BEEF}`), id(`unit:${LOT}`), id('location:TRANSIT'), held.transferId, id('branch:DDW'), SYSTEM_PRINCIPAL],
      )
      .catch((e: unknown) => e)) as { code?: string; constraint?: string };
    expect(reserved).toMatchObject({ code: 'HK010', constraint: 'ck_stock_reservation_place' });
    const dispatch = await post(manager, '/stock-transfers', {
      fromLocationId: id('location:TRANSIT'),
      toLocationId: id('location:SHOP'),
      lines: [{ productId: id(`product:${BEEF}`), stockUnitId: id(`unit:${LOT}`), qty: '0.200' }],
    });
    expect(dispatch.status).toBe(422);
    expect(await onHand('TRANSIT')).toBe('0.200');
  });

  it('the Accountant reads exceptions; the Storekeeper, Cashier, Sales and Driver are refused; only the Owner and Manager resolve, each refusal audited', async () => {
    expect((await get(accountant, `/stock/exceptions/${held.exceptionId}`)).status).toBe(200);
    expect((await get(accountant, '/stock/exceptions?status=OPEN')).body.data.map((e: { id: string }) => e.id)).toContain(held.exceptionId);
    for (const [role, session] of Object.entries({ shopStorekeeper, cashier, sales, driver })) {
      expect((await get(session, '/stock/exceptions')).status, `listStockExceptions as ${role}`).toBe(403);
      expect((await get(session, `/stock/exceptions/${held.exceptionId}`)).status, `getStockException as ${role}`).toBe(403);
    }
    const count = async () => (await admin().query<{ n: number }>("SELECT count(*)::int AS n FROM platform.audit_event WHERE action = 'AUTHORISATION_FAILURE'")).rows[0]!.n;
    const before = await count();
    for (const [role, session] of Object.entries({ accountant, coldStorekeeper, shopStorekeeper, cashier, sales, driver, farmHand })) {
      const refused = await post(session, `/stock/exceptions/${held.exceptionId}/resolve`, { resolutionKind: 'WRITE_OFF', note: 'Refused' });
      expect(refused.status, `resolveStockException as ${role}`).toBe(403);
      expect(refused.body.error.code).toBe('FORBIDDEN');
    }
    expect(await count()).toBe(before + 7);
    expect((await get(manager, `/stock/exceptions/${held.exceptionId}`)).body.status).toBe('OPEN');
  });

  it('a resolution needs its kind: none, no correction, or a document of its own are refused with STOCK_EXCEPTION_INVALID', async () => {
    const none = await post(manager, `/stock/exceptions/${held.exceptionId}/resolve`, { note: 'Just close it' });
    expect(none.status).toBe(422);
    expect(none.body.error).toMatchObject({ code: 'STOCK_EXCEPTION_INVALID', details: [{ field: '/resolutionKind', code: 'RESOLUTION_KIND_REQUIRED' }] });
    const noCorrection = await post(manager, `/stock/exceptions/${held.exceptionId}/resolve`, { resolutionKind: 'NO_CORRECTION', note: 'Just close it' });
    expect(noCorrection.body.error.details).toEqual([expect.objectContaining({ code: 'NOT_FOR_A_HELD_VARIANCE' })]);
    const found = await post(manager, `/stock/exceptions/${held.exceptionId}/resolve`, { resolutionKind: 'FOUND', note: 'Somewhere' });
    expect(found.body.error.details).toEqual([expect.objectContaining({ field: '/foundLocationId', code: 'FOUND_LOCATION_REQUIRED' })]);
  });

  it('writing off 0.200 kg (2,400 pesewas, under the threshold) posts the loss from transit through an adjustment and resolves the exception once', async () => {
    const valueBefore = await stockValue();
    const resolved = await post(manager, `/stock/exceptions/${held.exceptionId}/resolve`, { resolutionKind: 'WRITE_OFF', note: 'Drip loss in the van, weighed again' });
    expect(resolved.status, JSON.stringify(resolved.body)).toBe(200);
    expect(resolved.body).toMatchObject({
      status: 'RESOLVED',
      resolutionKind: 'WRITE_OFF',
      resolutionNote: 'Drip loss in the van, weighed again',
      resolvedBy: { displayName: 'Akosua Boateng' },
      resolutionDocument: { docType: 'STOCK_ADJUSTMENT' },
    });
    const adjustment = (await get(manager, `/stock-adjustments/${resolved.body.resolutionDocument.id as string}`)).body;
    expect(adjustment).toMatchObject({ status: 'POSTED', reasonCode: 'DAMAGED', location: { code: 'TRANSIT' }, exceptionId: held.exceptionId, totalValuePesewas: 2_400, lines: [{ direction: 'LOSS', qty: '0.200' }] });
    expect(await onHand('TRANSIT')).toBe('0.000');
    expect(valueBefore - (await stockValue())).toBe(2_400n);
    const again = await post(manager, `/stock/exceptions/${held.exceptionId}/resolve`, { resolutionKind: 'FOUND', foundLocationId: id('location:SHOP'), note: 'Found after all' });
    expect(again.status).toBe(422);
    expect(again.body.error.code).toBe('INVALID_STATE_TRANSITION');
    const app = database.pool('app');
    const rewritten = (await app.query("UPDATE inv.stock_exception SET resolution_kind = 'FOUND' WHERE id = $1", [held.exceptionId]).catch((e: unknown) => e)) as { constraint?: string };
    expect(rewritten.constraint).toBe('ck_stock_exception_change');
    const counted = await handCount();
    expect(counted.ledger).toBe(counted.balances);
  });

  it('an adjustment by hand cannot name a held variance, nor adjust in transit', async () => {
    const second = await shortTransfer('1.000', '0.900');
    const byHand = await post(manager, '/stock-adjustments', {
      locationId: id('location:SHOP'),
      reasonCode: 'DAMAGED',
      note: 'Trying to close it by hand',
      exceptionId: second.exceptionId,
      lines: [{ productId: id(`product:${BEEF}`), stockUnitId: id(`unit:${LOT}`), direction: 'LOSS', qty: '0.100' }],
    });
    expect(byHand.status).toBe(422);
    expect(byHand.body.error.details).toEqual([expect.objectContaining({ field: '/exceptionId', code: 'RESOLVED_THROUGH_THE_EXCEPTION' })]);
    const found = await post(manager, `/stock/exceptions/${second.exceptionId}/resolve`, { resolutionKind: 'FOUND', foundLocationId: id('location:SHOP'), note: 'Tray left in the van' });
    expect(found.status, JSON.stringify(found.body)).toBe(200);
  });
});

describe('a write-off at or above the threshold waits for a different person (ADR-0048, A-139)', () => {
  let held: { readonly transferId: string; readonly exceptionId: string };
  let approvalRequestId: string;
  let adjustmentId: string;

  it('writing off 5.000 kg (60,000 pesewas) answers 202, copies the 50,000 threshold onto the adjustment and moves nothing', async () => {
    held = await shortTransfer('6.000', '1.000');
    expect(await onHand('TRANSIT')).toBe('5.000');
    const pending = await post(manager, `/stock/exceptions/${held.exceptionId}/resolve`, { resolutionKind: 'WRITE_OFF', note: 'Five kilograms never arrived' });
    expect(pending.status, JSON.stringify(pending.body)).toBe(202);
    expect(pending.body).toMatchObject({ status: 'PENDING_APPROVAL', kind: 'STOCK_WRITE_OFF', subject: { docType: 'STOCK_ADJUSTMENT' } });
    approvalRequestId = pending.body.approvalRequestId as string;
    adjustmentId = pending.body.subject.id as string;
    const row = (await admin().query<{ status: string; total: string; threshold: string; exception_id: string }>(
      'SELECT status, total_value_pesewas::text AS total, approval_threshold_pesewas::text AS threshold, exception_id FROM inv.stock_adjustment WHERE id = $1',
      [adjustmentId],
    )).rows[0]!;
    expect(row).toEqual({ status: 'PENDING_APPROVAL', total: '60000', threshold: '50000', exception_id: held.exceptionId });
    expect(await onHand('TRANSIT')).toBe('5.000');
    expect((await get(manager, `/stock/exceptions/${held.exceptionId}`)).body.status).toBe('OPEN');
  });

  it('nothing else is decided meanwhile: found and a second write-off are refused with WRITE_OFF_PENDING', async () => {
    const found = await post(owner, `/stock/exceptions/${held.exceptionId}/resolve`, { resolutionKind: 'FOUND', foundLocationId: id('location:SHOP'), note: 'Found it' });
    expect(found.body.error).toMatchObject({ code: 'STOCK_EXCEPTION_INVALID', details: [{ code: 'WRITE_OFF_PENDING' }] });
    const twice = await post(owner, `/stock/exceptions/${held.exceptionId}/resolve`, { resolutionKind: 'WRITE_OFF', note: 'Again' });
    expect(twice.body.error.details).toEqual([expect.objectContaining({ code: 'WRITE_OFF_PENDING' })]);
  });

  it('the maker cannot approve it; the owner approves with step-up, the loss of 60,000 posts and the exception is resolved by the checker', async () => {
    await stepUp(manager);
    const self = await post(manager, `/iam/approvals/${approvalRequestId}/approve`, { reason: 'My own' });
    expect(self.body.error.code).toBe('MAKER_CANNOT_CHECK');
    const valueBefore = await stockValue();
    await stepUp(owner);
    const approved = await post(owner, `/iam/approvals/${approvalRequestId}/approve`, { reason: 'Driver statement on file' });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(valueBefore - (await stockValue())).toBe(60_000n);
    expect(await onHand('TRANSIT')).toBe('0.000');
    expect((await get(manager, `/stock/exceptions/${held.exceptionId}`)).body).toMatchObject({
      status: 'RESOLVED',
      resolutionKind: 'WRITE_OFF',
      resolutionDocument: { id: adjustmentId },
      resolutionNote: 'Five kilograms never arrived',
      resolvedBy: { displayName: 'Nana Ama Korsah' },
    });
  });

  it('a rejected write-off leaves the variance held and open, and it can then be recorded as found', async () => {
    const next = await shortTransfer('5.000', '0.500');
    const pending = await post(manager, `/stock/exceptions/${next.exceptionId}/resolve`, { resolutionKind: 'WRITE_OFF', note: 'Lost' });
    expect(pending.status).toBe(202);
    await stepUp(owner);
    expect((await post(owner, `/iam/approvals/${pending.body.approvalRequestId as string}/reject`, { reason: 'Search the van first' })).status).toBe(200);
    expect((await get(manager, `/stock/exceptions/${next.exceptionId}`)).body.status).toBe('OPEN');
    expect(await onHand('TRANSIT')).toBe('4.500');
    const shopBefore = await onHand('SHOP');
    const valueBefore = await stockValue();
    const found = await post(manager, `/stock/exceptions/${next.exceptionId}/resolve`, { resolutionKind: 'FOUND', foundLocationId: id('location:SHOP'), note: 'Crate under the van seat' });
    expect(found.status, JSON.stringify(found.body)).toBe(200);
    expect(found.body).toMatchObject({ status: 'RESOLVED', resolutionKind: 'FOUND', resolutionDocument: { id: next.transferId, docType: 'STOCK_TRANSFER' } });
    expect(await onHand('TRANSIT')).toBe('0.000');
    expect(await onHand('SHOP')).toBe((Number(shopBefore) + 4.5).toFixed(3));
    expect(await stockValue()).toBe(valueBefore);
    const receipt = (await admin().query<{ movement_type: string; qty_base: string }>('SELECT movement_type, qty_base::text FROM inv.stock_movement WHERE source_document_id = $1 ORDER BY recorded_at DESC LIMIT 1', [next.transferId])).rows[0];
    expect(receipt).toEqual({ movement_type: 'TRANSFER_RECEIPT', qty_base: '4.500' });
    const written = await post(manager, `/stock/exceptions/${next.exceptionId}/resolve`, { resolutionKind: 'WRITE_OFF', note: 'And write it off too' });
    expect(written.body.error.code).toBe('INVALID_STATE_TRANSITION');
    const counted = await handCount();
    expect(counted.ledger).toBe(counted.balances);
  });

  it('found is refused at a location that is not a stock location of the transfer', async () => {
    const next = await shortTransfer('1.000', '0.800');
    const virtual = await post(manager, `/stock/exceptions/${next.exceptionId}/resolve`, { resolutionKind: 'FOUND', foundLocationId: id('location:TRANSIT'), note: 'In transit' });
    expect(virtual.body.error.details).toEqual([expect.objectContaining({ field: '/foundLocationId', code: 'NOT_A_STOCK_LOCATION' })]);
  });
});

describe('any other exception is resolved once with a kind and a note (FR-INV-023)', () => {
  async function raise(): Promise<string> {
    const { rows } = await admin().query<{ id: string }>(
      `INSERT INTO inv.stock_exception (kind, branch_id, product_id, location_id, qty, details)
       VALUES ('NEGATIVE_STOCK', $1, $2, $3, 2, '{"movementType":"SALE_ISSUE_OFFLINE","onHandAfter":"-2.000"}') RETURNING id`,
      [id('branch:DDW'), id('product:EGG-CRATE-BIG'), id('location:SHOP')],
    );
    return rows[0]!.id;
  }

  it('with no correction, and with the posted adjustment that names it; an adjustment that does not name it is refused', async () => {
    const first = await raise();
    const plain = await post(manager, `/stock/exceptions/${first}/resolve`, { note: 'Counted: the offline sale was entered twice and voided' });
    expect(plain.status, JSON.stringify(plain.body)).toBe(200);
    expect(plain.body).toMatchObject({ status: 'RESOLVED', resolutionKind: 'NO_CORRECTION', resolutionDocument: null, summary: 'SALE_ISSUE_OFFLINE took on hand to -2.000; the uncovered quantity carried no cost' });

    const second = await raise();
    const unrelated = await post(shopStorekeeper, '/stock-adjustments', {
      locationId: id('location:SHOP'),
      reasonCode: 'DAMAGED',
      note: 'Unrelated',
      lines: [{ productId: id('product:EGG-CRATE-BIG'), stockUnitId: id('unit:EGG-BIG-2026-1110'), direction: 'LOSS', qty: '1.000' }],
    });
    await post(shopStorekeeper, `/stock-adjustments/${unrelated.body.id as string}/submit`);
    const refused = await post(manager, `/stock/exceptions/${second}/resolve`, { resolutionKind: 'ADJUSTED', resolutionDocumentId: unrelated.body.id, note: 'Settled' });
    expect(refused.body.error).toMatchObject({ code: 'STOCK_EXCEPTION_INVALID', details: [{ field: '/resolutionDocumentId', code: 'NOT_A_SETTLING_ADJUSTMENT' }] });
    const settling = await post(shopStorekeeper, '/stock-adjustments', {
      locationId: id('location:SHOP'),
      reasonCode: 'COUNT_ERROR',
      note: 'Recount after the offline sync',
      exceptionId: second,
      lines: [{ productId: id('product:EGG-CRATE-BIG'), stockUnitId: id('unit:EGG-BIG-2026-1110'), direction: 'GAIN', qty: '2.000' }],
    });
    expect(settling.status, JSON.stringify(settling.body)).toBe(201);
    await post(shopStorekeeper, `/stock-adjustments/${settling.body.id as string}/submit`);
    const adjusted = await post(manager, `/stock/exceptions/${second}/resolve`, { resolutionDocumentId: settling.body.id, note: 'Two crates found and booked' });
    expect(adjusted.status, JSON.stringify(adjusted.body)).toBe(200);
    expect(adjusted.body).toMatchObject({ resolutionKind: 'ADJUSTED', resolutionDocument: { id: settling.body.id, docType: 'STOCK_ADJUSTMENT' } });
    const listed = await get(manager, '/stock/exceptions?status=RESOLVED&kind=NEGATIVE_STOCK');
    expect(listed.body.data.map((e: { id: string }) => e.id).sort()).toEqual([first, second].sort());
  });

  it('a replay of the same resolution answers the first result and does nothing again', async () => {
    const exceptionId = await raise();
    const key = randomUUID();
    const first = await post(manager, `/stock/exceptions/${exceptionId}/resolve`, { note: 'Explained' }, key);
    const replay = await post(manager, `/stock/exceptions/${exceptionId}/resolve`, { note: 'Explained' }, key);
    expect(replay.status).toBe(first.status);
    expect(replay.body).toEqual(first.body);
  });
});
