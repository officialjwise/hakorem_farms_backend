import { randomUUID } from 'node:crypto';
import { createUuidV7Generator, ManualClock, toBusinessDate } from '@hakorem/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SalePosting, type SaleView } from '../../../src/modules/ord';
import { runWithRequestContext, type Actor } from '../../../src/platform/context/request-context';
import { UnitOfWork } from '../../../src/platform/database/unit-of-work';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { consoleGet, consolePost, createUser, enrolAndLogin, login, relaxRateLimits, testStartTime, type TestSession } from '../../support/iam';
import { SQLSTATE, sqlStateOf } from '../../support/sql-state';
import { startTestApp, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * Lines in crates (B09e continued, the owner's decision 3 of 2026-11-17): a goods receipt line and a stock transfer line
 * are entered in crates or in eggs, converted by the server through MasterDataRefs.toBaseIn and checked again by the
 * database through MDM's published mdm.uom_to_base, never with a factor of the line's own. The line keeps the unit it
 * was entered in; stock, the cost pool and the journal move in eggs, exactly as for the same delivery entered in eggs,
 * and a crate bought at GHS 47.50 still issues at exactly 4,750 (ADR-0075). Every write refuses the wrong role.
 */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let manager: TestSession;
let storekeeper: TestSession;
let cashier: TestSession;
let sales: SalePosting;
let uow: UnitOfWork;
let cashierActor: Actor;
let nextOrderId: () => string;
const ids = new Map<string, string>();
const till = { id: '019a8000-0000-7000-8000-00000000a7a2', code: 'T2' };

const id = (code: string) => ids.get(code)!;
const post = (session: TestSession, path: string, body: object = {}, key: string = randomUUID()) => consolePost(api.server, session, `/v1${path}`, key).send(body);
const get = (session: TestSession, path: string) => consoleGet(api.server, session, `/v1${path}`);
const admin = () => database.pool('admin');
const receivedAt = () => new Date(clock.now().getTime() - 3_600_000).toISOString();
const expiresOn = () => toBusinessDate(new Date(clock.now().getTime() + 14 * 86_400_000));

/** A delivery of big eggs from Awutu at the shop: one line, in crates or in eggs. */
function eggDelivery(line: Record<string, unknown>) {
  return {
    kind: 'PURCHASE',
    supplierId: id('supplier:Awutu Poultry Farm (SEED)'),
    locationId: id('location:SHOP'),
    deliveryNoteRef: `APF-${randomUUID().slice(0, 6)}`,
    receivedAt: receivedAt(),
    lines: [{ productId: id('product:EGG-0003'), batchNo: `EGG-${randomUUID().slice(0, 8)}`, expiresOn: expiresOn(), ...line }],
  };
}

async function postedReceipt(line: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const draft = await post(storekeeper, '/goods-receipts', { ...eggDelivery(line), ...extra });
  expect(draft.status, JSON.stringify(draft.body)).toBe(201);
  const posted = await post(storekeeper, `/goods-receipts/${draft.body.id as string}/post`);
  expect(posted.status, JSON.stringify(posted.body)).toBe(200);
  return posted.body;
}

/** What a posted receipt did to stock, the cost pool and the ledger, with no id in it, so two receipts compare. */
async function effectOf(receiptId: string) {
  const movements = (
    await admin().query<{ movement_type: string; qty_base: string; value_pesewas: string; stock_unit_id: string }>(
      'SELECT movement_type, qty_base::text, value_pesewas::text, stock_unit_id FROM inv.stock_movement WHERE source_document_id = $1 ORDER BY id',
      [receiptId],
    )
  ).rows;
  const unit = movements[0]!.stock_unit_id;
  const pool = (
    await admin().query<{ qty: string; value: string; anchor_qty: string; anchor_value: string }>(
      'SELECT qty::text, value_pesewas::text AS value, anchor_qty::text, anchor_value_pesewas::text AS anchor_value FROM inv.cost_pool WHERE stock_unit_id = $1',
      [unit],
    )
  ).rows;
  const journal = (
    await admin().query<{ code: string; side: string; amount: string }>(
      `SELECT a.code, l.side, l.amount_pesewas::text AS amount
         FROM fin.journal_entry e JOIN inv.stock_movement m ON m.id = e.event_subject_id
         JOIN fin.journal_line l ON l.journal_entry_id = e.id JOIN fin.account a ON a.id = l.account_id
        WHERE m.source_document_id = $1 ORDER BY a.code, l.side`,
      [receiptId],
    )
  ).rows;
  return { unit, effect: { movements: movements.map(({ stock_unit_id: _, ...m }) => m), pool, journal } };
}

function sellCrateOf(lot: string): Promise<SaleView> {
  const request = {
    orderId: nextOrderId(),
    channel: 'WHOLESALE' as const,
    branchId: id('branch:DDW'),
    fulfilmentMode: 'COUNTER' as const,
    taxInclusive: true,
    notes: 'A crate from a delivery entered in crates (test)',
    lines: [{ productId: id('product:EGG-0003'), stockUnitId: lot, fromLocationId: id('location:SHOP'), quantity: '1.000', uom: 'CRATE' }],
    tenders: [{ methodCode: 'CASH', amountPesewas: 6_000n, register: till }],
  };
  return runWithRequestContext({ correlationId: randomUUID(), ip: null, userAgent: 'crates test', actor: cashierActor }, () =>
    uow.run({ isolation: 'serializable', seriesLocks: sales.locksFor(id('branch:DDW')) }, (tx) => sales.postIn(tx, cashierActor, request)),
  );
}

async function issueValue(sale: SaleView): Promise<{ qty: string; value: string }> {
  const { rows } = await admin().query<{ qty: string; value: string }>('SELECT qty_base::text AS qty, value_pesewas::text AS value FROM inv.stock_movement WHERE id = $1', [sale.lines[0]!.stockMovementId]);
  return rows[0]!;
}

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  nextOrderId = createUuidV7Generator(clock);
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock });
  await runSeedUnits(database.pool('app'), api.app, seedUnits({ SEED_STAFF_PASSWORD: `Seed-${randomUUID()}` }));
  for (const row of (
    await admin().query<{ code: string; id: string }>(
      `SELECT 'branch:' || code AS code, id FROM mdm.branch
       UNION ALL SELECT 'location:' || l.code, l.id FROM mdm.location l JOIN mdm.branch b ON b.id = l.branch_id WHERE b.code = 'DDW'
       UNION ALL SELECT 'product:' || sku, id FROM mdm.product
       UNION ALL SELECT 'supplier:' || name, id FROM mdm.supplier`,
    )
  ).rows) {
    ids.set(row.code, row.id);
  }
  const branchId = id('branch:DDW');
  manager = await enrolAndLogin(api.server, await createUser(database, { name: 'Akosua Boateng', grants: [{ role: 'MANAGER', branchId }] }), () => clock.now());
  storekeeper = await login(api.server, await createUser(database, { name: 'Kofi Mensah', grants: [{ role: 'STOREKEEPER', branchId, locationId: id('location:SHOP') }] }));
  const cashierUser = await createUser(database, { name: 'Adwoa Darko', grants: [{ role: 'CASHIER', branchId, locationId: id('location:SHOP') }] });
  cashier = await login(api.server, cashierUser);
  cashierActor = { principalId: cashierUser.principalId, kind: 'USER', displayName: 'Adwoa Darko', realm: 'STAFF', sessionId: null, steppedUpAt: null };
  sales = api.app.get(SalePosting);
  uow = api.app.get(UnitOfWork);
});

afterAll(async () => {
  await api?.close();
  await database.drop();
});

describe('a goods receipt line in crates (decision 3)', () => {
  it('keeps 10 crates as entered and moves 300 eggs: the same stock, cost pool and journal as 300 eggs entered in eggs', async () => {
    const inCrates = await postedReceipt({ uom: 'CRATE', qtyReceived: '10.000', valuePesewas: 47_500 });
    expect(inCrates.lines[0]).toMatchObject({ uom: 'CRATE', qtyReceived: '10.000', qtyRejected: '0.000', baseUom: 'UNIT', qtyReceivedBase: '300.000', qtyRejectedBase: '0.000', valuePesewas: 47_500 });
    const inEggs = await postedReceipt({ qtyReceived: '300.000', valuePesewas: 47_500 });
    expect(inEggs.lines[0]).toMatchObject({ uom: 'UNIT', qtyReceived: '300.000', baseUom: 'UNIT', qtyReceivedBase: '300.000', valuePesewas: 47_500 });

    const crates = await effectOf(inCrates.id as string);
    const eggs = await effectOf(inEggs.id as string);
    expect(crates.effect).toEqual(eggs.effect);
    expect(crates.effect.movements).toEqual([{ movement_type: 'RECEIPT_PURCHASE', qty_base: '300.000', value_pesewas: '47500' }]);
    expect(crates.effect.pool).toEqual([{ qty: '300.000', value: '47500', anchor_qty: '300.000', anchor_value: '47500' }]);
    expect(crates.effect.journal.length).toBeGreaterThan(0);
    expect(crates.effect.journal.filter((l) => l.side === 'D').reduce((sum, l) => sum + BigInt(l.amount), 0n)).toBe(47_500n);

    // The cost of each issue stays the database's (ADR-0075): a crate from either delivery costs exactly 4,750.
    expect(await issueValue(await sellCrateOf(crates.unit))).toEqual({ qty: '30.000', value: '4750' });
    expect(await issueValue(await sellCrateOf(eggs.unit))).toEqual({ qty: '30.000', value: '4750' });
  });

  it('counts a rejected crate in crates and books it as 30 eggs rejected', async () => {
    const receipt = await postedReceipt({ uom: 'CRATE', qtyReceived: '9.000', qtyRejected: '1.000', rejectionReasonCode: 'CRACKED', valuePesewas: 42_750 });
    expect(receipt.lines[0]).toMatchObject({ uom: 'CRATE', qtyReceived: '9.000', qtyRejected: '1.000', qtyReceivedBase: '270.000', qtyRejectedBase: '30.000' });
    const { rows } = await admin().query('SELECT qty_received::text, qty_rejected::text, uom, qty_received_uom::text, qty_rejected_uom::text FROM inv.goods_receipt_line WHERE goods_receipt_id = $1', [receipt.id]);
    expect(rows).toEqual([{ qty_received: '270.000', qty_rejected: '30.000', uom: 'CRATE', qty_received_uom: '9.000', qty_rejected_uom: '1.000' }]);
  });

  it('refuses a unit the eggs are not bought by, and nothing is written', async () => {
    const before = (await admin().query<{ n: number }>('SELECT count(*)::int AS n FROM inv.goods_receipt')).rows[0]!.n;
    const refused = await post(storekeeper, '/goods-receipts', eggDelivery({ uom: 'BAG', qtyReceived: '1.000', valuePesewas: 4_750 }));
    expect(refused.status).toBe(422);
    expect(refused.body.error).toMatchObject({ code: 'GOODS_RECEIPT_INVALID', details: [{ field: '/lines/0/uom', code: 'NO_CONVERSION' }] });
    expect((await admin().query<{ n: number }>('SELECT count(*)::int AS n FROM inv.goods_receipt')).rows[0]!.n).toBe(before);
  });

  it('keeps the unit through a change of the draft, and the database refuses a line whose eggs are not its crates times 30', async () => {
    const draft = await post(storekeeper, '/goods-receipts', eggDelivery({ uom: 'CRATE', qtyReceived: '2.000', valuePesewas: 9_500 }));
    expect(draft.status).toBe(201);
    const lineId = draft.body.lines[0].id as string;
    const tamper = (sql: string) => sqlStateOf(database.pool('app').query(sql, [lineId]));
    expect(await tamper('UPDATE inv.goods_receipt_line SET qty_received = 59 WHERE id = $1')).toBe('HK010');
    expect(await tamper("UPDATE inv.goods_receipt_line SET uom = 'BAG' WHERE id = $1")).toBe('HK010');
    expect(await tamper('UPDATE inv.goods_receipt_line SET uom = NULL WHERE id = $1')).toBe(SQLSTATE.checkViolation);
    const shown = await get(storekeeper, `/goods-receipts/${draft.body.id as string}`);
    expect(shown.body.lines[0]).toMatchObject({ uom: 'CRATE', qtyReceived: '2.000', qtyReceivedBase: '60.000' });
  });

  it('matches a purchase order line bought in crates: 10 crates received against 10 ordered complete it', async () => {
    const order = await post(storekeeper, '/purchase-orders', {
      supplierId: id('supplier:Awutu Poultry Farm (SEED)'),
      deliverToLocationId: id('location:SHOP'),
      orderDate: toBusinessDate(clock.now()),
      lines: [{ productId: id('product:EGG-0003'), uom: 'CRATE', qtyOrdered: '10.000', unitPricePesewas: 4_750 }],
    });
    expect(order.status, JSON.stringify(order.body)).toBe(201);
    expect(order.body.lines[0]).toMatchObject({ uom: 'CRATE', qtyOrdered: '10.000', baseUom: 'UNIT', qtyOrderedBase: '300.000' });
    expect((await post(storekeeper, `/purchase-orders/${order.body.id as string}/submit`)).status).toBe(200);
    expect((await post(manager, `/purchase-orders/${order.body.id as string}/send`, { channels: ['WHATSAPP'] })).status).toBe(200);
    await postedReceipt({ uom: 'CRATE', qtyReceived: '10.000', valuePesewas: 47_500, purchaseOrderLineId: order.body.lines[0].id }, { purchaseOrderId: order.body.id });
    const after = await get(manager, `/purchase-orders/${order.body.id as string}`);
    expect(after.body.lines[0]).toMatchObject({ uom: 'CRATE', qtyOrdered: '10.000', qtyReceived: '300.000', qtyOutstanding: '0.000' });
    expect(after.body.status).toBe('RECEIVED');
  });
});

describe('a stock transfer line in crates (decision 3)', () => {
  let lot: string;
  beforeAll(async () => {
    const receipt = await postedReceipt({ uom: 'CRATE', qtyReceived: '5.000', valuePesewas: 23_750 });
    lot = receipt.lines[0].stockUnit.id as string;
  });

  it('keeps 2 crates as entered, dispatches 60 eggs, and takes the count on arrival in eggs: 58 received and 2 held as the variance', async () => {
    const draft = await post(manager, '/stock-transfers', { fromLocationId: id('location:SHOP'), toLocationId: id('location:VAN1'), lines: [{ productId: id('product:EGG-0003'), stockUnitId: lot, uom: 'CRATE', qty: '2.000' }] });
    expect(draft.status, JSON.stringify(draft.body)).toBe(201);
    expect(draft.body.lines[0]).toMatchObject({ uom: 'CRATE', qtyDispatched: '2.000', baseUom: 'UNIT', qtyDispatchedBase: '60.000', qtyReceived: null, varianceQty: null });
    expect((await post(manager, `/stock-transfers/${draft.body.id as string}/dispatch`)).status).toBe(200);
    const dispatched = (await admin().query<{ qty: string }>("SELECT qty_base::text AS qty FROM inv.stock_movement WHERE source_document_id = $1 AND movement_type = 'TRANSFER_DISPATCH'", [draft.body.id])).rows;
    expect(dispatched).toEqual([{ qty: '60.000' }]);
    const received = await post(manager, `/stock-transfers/${draft.body.id as string}/receive`, { lines: [{ lineId: draft.body.lines[0].id, uom: 'UNIT', qtyReceived: '58.000', varianceReasonCode: 'DAMAGED' }] });
    expect(received.status, JSON.stringify(received.body)).toBe(200);
    expect(received.body.lines[0]).toMatchObject({ uom: 'CRATE', qtyDispatched: '2.000', qtyDispatchedBase: '60.000', qtyReceived: '58.000', varianceQty: '2.000', varianceReasonCode: 'DAMAGED' });
    const arrived = (await admin().query<{ qty: string }>("SELECT qty_base::text AS qty FROM inv.stock_movement WHERE source_document_id = $1 AND movement_type = 'TRANSFER_RECEIPT'", [draft.body.id])).rows;
    expect(arrived).toEqual([{ qty: '58.000' }]);
  });

  it('takes the count on arrival in crates by the line\'s own unit: 1 crate received is 30 eggs', async () => {
    const draft = await post(manager, '/stock-transfers', { fromLocationId: id('location:SHOP'), toLocationId: id('location:VAN1'), lines: [{ productId: id('product:EGG-0003'), stockUnitId: lot, uom: 'CRATE', qty: '1.000' }] });
    expect((await post(manager, `/stock-transfers/${draft.body.id as string}/dispatch`)).status).toBe(200);
    const received = await post(manager, `/stock-transfers/${draft.body.id as string}/receive`, { lines: [{ lineId: draft.body.lines[0].id, uom: 'CRATE', qtyReceived: '1.000' }] });
    expect(received.status, JSON.stringify(received.body)).toBe(200);
    expect(received.body.lines[0]).toMatchObject({ uom: 'CRATE', qtyDispatched: '1.000', qtyReceived: '30.000', varianceQty: '0.000' });
  });

  it('refuses a unit the eggs are not moved by, and the database refuses a line whose eggs are not its crates times 30', async () => {
    const refused = await post(manager, '/stock-transfers', { fromLocationId: id('location:SHOP'), toLocationId: id('location:VAN1'), lines: [{ productId: id('product:EGG-0003'), stockUnitId: lot, uom: 'BAG', qty: '1.000' }] });
    expect(refused.status).toBe(422);
    expect(refused.body.error).toMatchObject({ code: 'STOCK_TRANSFER_INVALID', details: [{ field: '/lines/0/uom', code: 'NO_CONVERSION' }] });
    const draft = await post(manager, '/stock-transfers', { fromLocationId: id('location:SHOP'), toLocationId: id('location:VAN1'), lines: [{ productId: id('product:EGG-0003'), stockUnitId: lot, uom: 'CRATE', qty: '1.000' }] });
    expect(await sqlStateOf(database.pool('app').query('UPDATE inv.stock_transfer_line SET qty_dispatched = 31 WHERE id = $1', [draft.body.lines[0].id]))).toBe('HK010');
  });
});

describe('every write in crates refuses the wrong role (ADR-0035)', () => {
  it('the Cashier is refused a receipt and a transfer in crates with 403, and nothing is written', async () => {
    const receipts = (await admin().query<{ n: number }>('SELECT count(*)::int AS n FROM inv.goods_receipt')).rows[0]!.n;
    const transfers = (await admin().query<{ n: number }>('SELECT count(*)::int AS n FROM inv.stock_transfer')).rows[0]!.n;
    const receipt = await post(cashier, '/goods-receipts', eggDelivery({ uom: 'CRATE', qtyReceived: '1.000', valuePesewas: 4_750 }));
    expect(receipt.status).toBe(403);
    expect(receipt.body.error.code).toBe('FORBIDDEN');
    const transfer = await post(cashier, '/stock-transfers', { fromLocationId: id('location:SHOP'), toLocationId: id('location:VAN1'), lines: [{ productId: id('product:EGG-0003'), uom: 'CRATE', qty: '1.000' }] });
    expect(transfer.status).toBe(403);
    expect((await admin().query<{ n: number }>('SELECT count(*)::int AS n FROM inv.goods_receipt')).rows[0]!.n).toBe(receipts);
    expect((await admin().query<{ n: number }>('SELECT count(*)::int AS n FROM inv.stock_transfer')).rows[0]!.n).toBe(transfers);
  });

  it('the Cashier is refused receiving a transfer in crates with 403, and it stays dispatched', async () => {
    const receipt = await postedReceipt({ uom: 'CRATE', qtyReceived: '1.000', valuePesewas: 4_750 });
    const draft = await post(manager, '/stock-transfers', { fromLocationId: id('location:SHOP'), toLocationId: id('location:VAN1'), lines: [{ productId: id('product:EGG-0003'), stockUnitId: receipt.lines[0].stockUnit.id, uom: 'CRATE', qty: '1.000' }] });
    expect((await post(manager, `/stock-transfers/${draft.body.id as string}/dispatch`)).status).toBe(200);
    const refused = await post(cashier, `/stock-transfers/${draft.body.id as string}/receive`, { lines: [{ lineId: draft.body.lines[0].id, uom: 'CRATE', qtyReceived: '1.000' }] });
    expect(refused.status).toBe(403);
    expect((await get(manager, `/stock-transfers/${draft.body.id as string}`)).body.status).toBe('DISPATCHED');
  });
});
