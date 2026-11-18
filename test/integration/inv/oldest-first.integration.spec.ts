import { randomUUID } from 'node:crypto';
import { createUuidV7Generator, ManualClock, toBusinessDate } from '@hakorem/kernel';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { StockQueries } from '../../../src/modules/inv';
import { SalePosting, type SaleView } from '../../../src/modules/ord';
import { runWithRequestContext, type Actor } from '../../../src/platform/context/request-context';
import { UnitOfWork } from '../../../src/platform/database/unit-of-work';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { consoleGet, consolePost, createUser, enrolAndLogin, login, relaxRateLimits, SYSTEM_PRINCIPAL, testStartTime, type TestSession } from '../../support/iam';
import { sqlStateOf } from '../../support/sql-state';
import { startTestApp, TEST_ORIGIN, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';
import { openTestShift, tillOf } from '../../support/till';

/**
 * Oldest first (B09e continued, the owner's decision 4 of 2026-11-17): every bought lot has a received date, its goods
 * receipt's, kept on the stock unit; and stock sells by expiry, then by received date, wherever the server picks a lot:
 * promisable stock, an order's reservations, a storefront checkout, and a sale that names no lot. Four deliveries of
 * small eggs at the shop, one crate each, whose dates disagree on purpose:
 *   OLD    received 6 days ago, expires in 20 days: the oldest delivery, but the last to expire
 *   MID    received 3 days ago, expires in 10 days
 *   LATE   received 1 day ago,  expires in 10 days
 *   EARLY  received 4 days ago,  expires in 10 days, registered last (the highest unit id of the four)
 * Oldest first is EARLY, MID, LATE, OLD: three lots tie on expiry and their received dates, not their ids, order them;
 * the oldest delivery sells last because it expires last.
 */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let storekeeper: TestSession;
let sales: TestSession;
let manager: TestSession;
let cashierActor: Actor;
let nextOrderId: () => string;
const ids = new Map<string, string>();
const lots = new Map<string, string>();
const receivedAts = new Map<string, string>();
const till = { id: '019a8000-0000-7000-8000-00000000a7a3', code: 'T3' };
const DAY = 86_400_000;

const id = (code: string) => ids.get(code)!;
const lot = (name: string) => lots.get(name)!;
const nameOf = (unitId: string | null) => [...lots.entries()].find(([, v]) => v === unitId)?.[0] ?? unitId;
const post = (session: TestSession, path: string, body: object = {}, key: string = randomUUID()) => consolePost(api.server, session, `/v1${path}`, key).send(body);
const get = (session: TestSession, path: string) => consoleGet(api.server, session, `/v1${path}`);
const admin = () => database.pool('admin');

async function deliver(name: string, receivedDaysAgo: number, expiresInDays: number): Promise<void> {
  const receivedAt = new Date(clock.now().getTime() - receivedDaysAgo * DAY).toISOString();
  const draft = await post(storekeeper, '/goods-receipts', {
    kind: 'PURCHASE',
    supplierId: id('supplier:Awutu Poultry Farm (SEED)'),
    locationId: id('location:SHOP'),
    deliveryNoteRef: `APF-${name}`,
    receivedAt,
    lines: [{ productId: id('product:EGG-0002'), uom: 'CRATE', qtyReceived: '1.000', valuePesewas: 3_600, batchNo: `EGG-SMALL-${name}`, expiresOn: toBusinessDate(new Date(clock.now().getTime() + expiresInDays * DAY)) }],
  });
  expect(draft.status, JSON.stringify(draft.body)).toBe(201);
  const posted = await post(storekeeper, `/goods-receipts/${draft.body.id as string}/post`);
  expect(posted.status, JSON.stringify(posted.body)).toBe(200);
  lots.set(name, posted.body.lines[0].stockUnit.id as string);
  receivedAts.set(name, receivedAt);
}

/** Which lots a document holds, by name, in the order they were reserved. */
async function heldBy(holderId: string): Promise<Array<{ lot: string | null; qty: string }>> {
  const { rows } = await admin().query<{ stock_unit_id: string | null; qty: string }>(
    "SELECT stock_unit_id, qty::text AS qty FROM inv.stock_reservation WHERE holder_document_id = $1 AND status = 'ACTIVE' ORDER BY created_at, id",
    [holderId],
  );
  return rows.map((r) => ({ lot: nameOf(r.stock_unit_id), qty: r.qty }));
}

function sellWithNoLot(quantity: string, uom: string, cashPesewas: bigint): Promise<SaleView> {
  const request = {
    orderId: nextOrderId(),
    channel: 'WHOLESALE' as const,
    branchId: id('branch:DDW'),
    fulfilmentMode: 'COUNTER' as const,
    taxInclusive: true,
    notes: 'Small eggs, no lot named (test)',
    lines: [{ productId: id('product:EGG-0002'), fromLocationId: id('location:SHOP'), quantity, uom }],
    tenders: [{ methodCode: 'CASH', amountPesewas: cashPesewas, register: till }],
  };
  return runWithRequestContext({ correlationId: randomUUID(), ip: null, userAgent: 'oldest first test', actor: cashierActor }, () =>
    api.app.get(UnitOfWork).run({ isolation: 'serializable', seriesLocks: api.app.get(SalePosting).locksFor(id('branch:DDW')) }, async (tx) => api.app.get(SalePosting).postIn(tx, cashierActor, { shiftDocumentId: await openTestShift(tx, cashierActor.principalId, request.branchId, tillOf(request)), ...request })),
  );
}

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  nextOrderId = createUuidV7Generator(clock);
  await relaxRateLimits(database);
  for (const key of ['rate_limit.public.per_address_1m', 'rate_limit.checkout.per_address_10m']) {
    await database.pool('app').query(
      `INSERT INTO platform.setting (id, key, value, value_type, valid_from, description, created_by, updated_by)
       VALUES ($1, $2, '100000', 'INTEGER', now() - interval '1 day', 'Raised for a test file', $3, $3)`,
      [randomUUID(), key, SYSTEM_PRINCIPAL],
    );
  }
  api = await startTestApp(database, { clock });
  await runSeedUnits(database.pool('app'), api.app, seedUnits({ SEED_STAFF_PASSWORD: `Seed-${randomUUID()}` }));
  for (const row of (
    await admin().query<{ code: string; id: string }>(
      `SELECT 'branch:' || code AS code, id FROM mdm.branch
       UNION ALL SELECT 'location:' || l.code, l.id FROM mdm.location l JOIN mdm.branch b ON b.id = l.branch_id WHERE b.code = 'DDW'
       UNION ALL SELECT 'product:' || sku, id FROM mdm.product
       UNION ALL SELECT 'supplier:' || name, id FROM mdm.supplier
       UNION ALL SELECT 'customer:' || name, id FROM mdm.customer`,
    )
  ).rows) {
    ids.set(row.code, row.id);
  }
  const branchId = id('branch:DDW');
  storekeeper = await login(api.server, await createUser(database, { name: 'Kofi Mensah', grants: [{ role: 'STOREKEEPER', branchId, locationId: id('location:SHOP') }] }));
  sales = await login(api.server, await createUser(database, { name: 'Kojo Antwi', grants: [{ role: 'SALES', branchId }] }));
  manager = await enrolAndLogin(api.server, await createUser(database, { name: 'Ama Owusu', grants: [{ role: 'MANAGER', branchId }] }), () => clock.now());
  const cashier = await createUser(database, { name: 'Adwoa Darko', grants: [{ role: 'CASHIER', branchId, locationId: id('location:SHOP') }] });
  cashierActor = { principalId: cashier.principalId, kind: 'USER', displayName: 'Adwoa Darko', realm: 'STAFF', sessionId: null, steppedUpAt: null };
  // Registered in this order, so the unit ids run OLD, MID, LATE, EARLY.
  await deliver('OLD', 6, 20);
  await deliver('MID', 3, 10);
  await deliver('LATE', 1, 10);
  await deliver('EARLY', 4, 10);
});

afterAll(async () => {
  await api?.close();
  await database?.drop();
});

describe('a received date on every bought lot', () => {
  it('keeps the goods receipt\'s received_at on each lot it registers, and answers it on the stock unit', async () => {
    for (const name of ['OLD', 'MID', 'LATE', 'EARLY']) {
      const unit = await get(manager, `/stock-units/${lot(name)}`);
      expect(unit.status).toBe(200);
      expect(unit.body.receivedAt, name).toBe(receivedAts.get(name));
    }
  });

  it('gives the seeded farm\'s bought lots their receipt\'s date too', async () => {
    const { rows } = await admin().query<{ missing: number }>(
      `SELECT count(*)::int AS missing FROM inv.stock_unit u JOIN inv.goods_receipt r ON r.id = u.source_document_id
        WHERE u.received_at IS DISTINCT FROM r.received_at`,
    );
    expect(rows[0]!.missing).toBe(0);
  });

  it('refuses, in the database, a purchase receipt of a lot that has no received date', async () => {
    const app = database.pool('app');
    const unitId = randomUUID();
    const documentId = randomUUID();
    await app.query("INSERT INTO platform.business_document (id, doc_type, owner_module, branch_id, actor_id) VALUES ($1, 'GOODS_RECEIPT', 'inv', $2, $3)", [documentId, id('branch:DDW'), SYSTEM_PRINCIPAL]);
    await app.query(
      `INSERT INTO inv.stock_unit (id, product_id, tracking, branch_id, identifier, status, source_document_id, created_by, updated_by)
       VALUES ($1, $2, 'LOT', $3, 'EGG-SMALL-UNDATED', 'ACTIVE', $4, $5, $5)`,
      [unitId, id('product:EGG-0002'), id('branch:DDW'), documentId, SYSTEM_PRINCIPAL],
    );
    const supplier = (await admin().query<{ id: string }>("SELECT id FROM mdm.location WHERE branch_id = $1 AND kind = 'SUPPLIER'", [id('branch:DDW')])).rows[0]!.id;
    const refused = sqlStateOf(
      app.query(
        `INSERT INTO inv.stock_movement (id, movement_type, product_id, stock_unit_id, branch_id, from_location_id, to_location_id, qty_base, value_pesewas, cost_element, source_document_id, occurred_at, actor_id)
         VALUES ($1, 'RECEIPT_PURCHASE', $2, $3, $4, $5, $6, 30, 3600, 'PURCHASE', $7, $8, $9)`,
        [randomUUID(), id('product:EGG-0002'), unitId, id('branch:DDW'), supplier, id('location:SHOP'), documentId, clock.now(), SYSTEM_PRINCIPAL],
      ),
    );
    expect(await refused).toBe('HK010');
    expect(await sqlStateOf(app.query('UPDATE inv.stock_unit SET received_at = $2 WHERE id = $1', [lot('OLD'), clock.now()]))).toBe('HK010');
  });
});

describe('oldest first, wherever the server picks a lot (decision 4)', () => {
  it('promises the lots by expiry, then by received date: EARLY, MID, LATE, then OLD', async () => {
    const promisable = await api.app.get(UnitOfWork).run({ isolation: 'read committed' }, (tx) => api.app.get(StockQueries).promisableIn(tx, id('branch:DDW'), [id('product:EGG-0002')]));
    expect(promisable.map((p) => [nameOf(p.stockUnitId), p.availableQty.toDecimalString()])).toEqual([
      ['EARLY', '30.000'],
      ['MID', '30.000'],
      ['LATE', '30.000'],
      ['OLD', '30.000'],
    ]);
  });

  it('reserves an order\'s crate from EARLY, the earliest-received of the three that expire first', async () => {
    const placed = await post(sales, '/orders', { channel: 'WHOLESALE', customerId: id('customer:Tema Cold Store Ltd (SEED)'), fulfilmentMode: 'COLLECTION', paymentTerms: 'COD', lines: [{ productId: id('product:EGG-0002'), quantity: '1.000', uom: 'CRATE' }] });
    expect(placed.status, JSON.stringify(placed.body)).toBe(201);
    const confirmed = await post(manager, `/orders/${placed.body.id as string}/confirm`);
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
    expect(await heldBy(placed.body.id as string)).toEqual([{ lot: 'EARLY', qty: '30.000' }]);
  });

  it('reserves a storefront checkout\'s crate from MID, received before LATE though registered before it too', async () => {
    const cart = await request(api.server).post('/v1/shop/carts').set('Origin', TEST_ORIGIN).set('Idempotency-Key', randomUUID());
    expect(cart.status).toBe(201);
    const cookie = (cart.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('__Host-hk_guest='))!.split(';')[0]!;
    const write = (path: string, body: object) => request(api.server).post(`/v1${path}`).set('Origin', TEST_ORIGIN).set('Idempotency-Key', randomUUID()).set('Cookie', cookie).send(body);
    expect((await write(`/shop/carts/${cart.body.id as string}/lines`, { productId: id('product:EGG-0002'), quantity: '1.000' })).status).toBe(200);
    const checkout = await write(`/shop/carts/${cart.body.id as string}/checkout`, { contactName: 'Ama Serwaa Ofori', contactPhone: '+233244512876', fulfilmentMode: 'COLLECTION', paymentTerms: 'PREPAID' });
    expect(checkout.status, JSON.stringify(checkout.body)).toBe(201);
    expect(await heldBy(checkout.body.id as string)).toEqual([{ lot: 'MID', qty: '30.000' }]);
  });

  it('sells a crate that names no lot from LATE, which expires before OLD though OLD was received first', async () => {
    const sale = await sellWithNoLot('1.000', 'CRATE', 4_500n);
    expect(sale.lines[0]).toMatchObject({ stockUnitId: lot('LATE'), qtyOrdered: '1.000', uom: 'CRATE' });
    const issue = (await admin().query<{ stock_unit_id: string; qty: string }>('SELECT stock_unit_id, qty_base::text AS qty FROM inv.stock_movement WHERE id = $1', [sale.lines[0]!.stockMovementId])).rows;
    expect(issue).toEqual([{ stock_unit_id: lot('LATE'), qty: '30.000' }]);
  });

  it('sells single eggs that name no lot from OLD, the only lot left unheld, and refuses a crate no single lot can cover', async () => {
    const sale = await sellWithNoLot('3.000', 'EGG', 510n);
    expect(sale.lines[0]).toMatchObject({ stockUnitId: lot('OLD'), qtyOrdered: '3.000', uom: 'EGG' });
    await expect(sellWithNoLot('1.000', 'CRATE', 4_500n)).rejects.toMatchObject({ code: 'SALE_INVALID' });
  });
});
