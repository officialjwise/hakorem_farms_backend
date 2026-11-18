import { randomUUID } from 'node:crypto';
import { ManualClock, toBusinessDate } from '@hakorem/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { consoleGet, consolePatch, consolePost, createUser, enrolAndLogin, login, relaxRateLimits, testStartTime, type TestSession } from '../../support/iam';
import { startTestApp, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * CR-040 (the owner, 2026-11-17): a goods receipt line that names its purchase order line may leave out `valuePesewas`;
 * the server values it from the order line for the accepted quantity, `half_up(order price x qty ordered x accepted
 * base / qty ordered base)`, rounded once (ADR-0001), through PUR's answer to INV's `OrderLineValuation` port
 * (ADR-0086). A typed value always wins; a line with no order line still needs one. ADR-0075's issue arithmetic is
 * untouched: the receipt's value is what the delivery's pool is anchored at.
 */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let owner: TestSession;
let storekeeper: TestSession;
const ids = new Map<string, string>();

const id = (code: string) => ids.get(code)!;
const post = (session: TestSession, path: string, body: object = {}, key: string = randomUUID()) => consolePost(api.server, session, `/v1${path}`, key).send(body);
const get = (session: TestSession, path: string) => consoleGet(api.server, session, `/v1${path}`);
const admin = () => database.pool('admin');
const today = () => toBusinessDate(clock.now());
const AWUTU = 'supplier:Awutu Poultry Farm (SEED)';

/** An approved and sent order for `crates` crates of big eggs at `price` a crate; its order and line ids. */
async function ordered(crates: string, price: number): Promise<{ order: string; line: string }> {
  const created = await post(storekeeper, '/purchase-orders', {
    supplierId: id(AWUTU),
    deliverToLocationId: id('location:SHOP'),
    orderDate: today(),
    lines: [{ productId: id('product:EGG-0003'), uom: 'CRATE', qtyOrdered: crates, unitPricePesewas: price }],
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  expect((await post(storekeeper, `/purchase-orders/${created.body.id}/submit`)).status).toBe(200);
  expect((await post(owner, `/purchase-orders/${created.body.id}/send`, { channels: ['WHATSAPP'] })).status).toBe(200);
  return { order: created.body.id as string, line: created.body.lines[0].id as string };
}

function receipt(order: { order: string } | null, line: Record<string, unknown>) {
  return post(storekeeper, '/goods-receipts', {
    kind: 'PURCHASE',
    supplierId: id(AWUTU),
    locationId: id('location:SHOP'),
    ...(order === null ? {} : { purchaseOrderId: order.order }),
    receivedAt: new Date(clock.now().getTime() - 60_000).toISOString(),
    lines: [{ productId: id('product:EGG-0003'), batchNo: `EGG-${randomUUID().slice(0, 8)}`, expiresOn: toBusinessDate(new Date(clock.now().getTime() + 14 * 86_400_000)), ...line }],
  });
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
       UNION ALL SELECT 'product:' || sku, id FROM mdm.product
       UNION ALL SELECT 'supplier:' || name, id FROM mdm.supplier`,
    )
  ).rows) {
    ids.set(row.code, row.id);
  }
  const branchId = id('branch:DDW');
  owner = await enrolAndLogin(api.server, await createUser(database, { name: 'Kwabena Owusu', grants: [{ role: 'OWNER', branchId }] }), () => clock.now());
  storekeeper = await login(api.server, await createUser(database, { name: 'Kofi Mensah', grants: [{ role: 'STOREKEEPER', branchId, locationId: id('location:SHOP') }] }));
});

afterAll(async () => {
  await api?.close();
  await database.drop();
});

describe('a receipt line against an order line is valued by the server unless a value is typed (CR-040)', () => {
  it('values 23 accepted eggs of a crate at 4,751 at 3,642 (3,642.43 rounded half-up once), answers it, and posts the pool at exactly that', async () => {
    const order = await ordered('1.000', 4_751);
    const drafted = await receipt(order, { purchaseOrderLineId: order.line, qtyReceived: '23.000', qtyRejected: '7.000', rejectionReasonCode: 'CRACKED' });
    expect(drafted.status, JSON.stringify(drafted.body)).toBe(201);
    expect(drafted.body.lines[0]).toMatchObject({ qtyReceived: '23.000', valuePesewas: 3_642 });
    expect(drafted.body.totalValuePesewas).toBe(3_642);
    expect((await admin().query('SELECT value_pesewas::int AS v FROM inv.goods_receipt_line WHERE goods_receipt_id = $1', [drafted.body.id])).rows).toEqual([{ v: 3_642 }]);
    const posted = await post(storekeeper, `/goods-receipts/${drafted.body.id}/post`);
    expect(posted.status, JSON.stringify(posted.body)).toBe(200);
    const moved = await admin().query<{ v: number }>("SELECT value_pesewas::int AS v FROM inv.stock_movement WHERE source_document_id = $1 AND movement_type = 'RECEIPT_PURCHASE'", [drafted.body.id]);
    expect(moved.rows).toEqual([{ v: 3_642 }]);
  });

  it('rounds an exact half up: 15 eggs of a crate at 4,751 are 2,375.5, valued 2,376', async () => {
    const order = await ordered('1.000', 4_751);
    const drafted = await receipt(order, { purchaseOrderLineId: order.line, qtyReceived: '15.000' });
    expect(drafted.status, JSON.stringify(drafted.body)).toBe(201);
    expect(drafted.body.lines[0].valuePesewas).toBe(2_376);
  });

  it('values a line entered in crates through its base quantity: 2 crates of an order of 3 at 4,751 are 9,502', async () => {
    const order = await ordered('3.000', 4_751);
    const drafted = await receipt(order, { purchaseOrderLineId: order.line, uom: 'CRATE', qtyReceived: '2.000', qtyRejected: '1.000', rejectionReasonCode: 'BROKEN' });
    expect(drafted.status, JSON.stringify(drafted.body)).toBe(201);
    expect(drafted.body.lines[0]).toMatchObject({ uom: 'CRATE', qtyReceived: '2.000', qtyReceivedBase: '60.000', valuePesewas: 9_502 });
  });

  it('keeps a typed value, which always wins over the order line', async () => {
    const order = await ordered('1.000', 4_751);
    const drafted = await receipt(order, { purchaseOrderLineId: order.line, qtyReceived: '23.000', qtyRejected: '7.000', rejectionReasonCode: 'CRACKED', valuePesewas: 3_600 });
    expect(drafted.status, JSON.stringify(drafted.body)).toBe(201);
    expect(drafted.body.lines[0].valuePesewas).toBe(3_600);
  });

  it('values the lines again from the order when a draft is changed with no value typed', async () => {
    const order = await ordered('1.000', 4_751);
    const drafted = await receipt(order, { purchaseOrderLineId: order.line, qtyReceived: '23.000', qtyRejected: '7.000', rejectionReasonCode: 'CRACKED' });
    const patched = await consolePatch(api.server, storekeeper, `/v1/goods-receipts/${drafted.body.id}`).send({
      version: drafted.body.version,
      lines: [{ productId: id('product:EGG-0003'), purchaseOrderLineId: order.line, batchNo: 'EGG-PATCHED', expiresOn: toBusinessDate(new Date(clock.now().getTime() + 14 * 86_400_000)), qtyReceived: '29.000', qtyRejected: '1.000', rejectionReasonCode: 'CRACKED' }],
    });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    // 4,751 x 29 / 30 = 4,592.63, so 4,593.
    expect(patched.body.lines[0].valuePesewas).toBe(4_593);
  });

  it('still requires a value on a line that names no order line (400 VALIDATION_FAILED), and writes nothing', async () => {
    const before = Number((await admin().query<{ n: string }>('SELECT count(*)::text AS n FROM inv.goods_receipt')).rows[0]!.n);
    const refused = await receipt(null, { qtyReceived: '30.000' });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(refused.body.error.details).toEqual([expect.objectContaining({ field: '/lines/0/valuePesewas' })]);
    expect(Number((await admin().query<{ n: string }>('SELECT count(*)::text AS n FROM inv.goods_receipt')).rows[0]!.n)).toBe(before);
  });

  it('refuses an order line it cannot value: unknown, of another order, or of another product', async () => {
    const order = await ordered('1.000', 4_751);
    const other = await ordered('1.000', 4_800);
    const unknown = await receipt(order, { purchaseOrderLineId: randomUUID(), qtyReceived: '30.000' });
    expect(unknown.status).toBe(422);
    expect(unknown.body.error).toMatchObject({ code: 'GOODS_RECEIPT_INVALID', details: [expect.objectContaining({ field: '/lines/0/purchaseOrderLineId', code: 'ORDER_LINE_UNKNOWN' })] });
    const elsewhere = await receipt(order, { purchaseOrderLineId: other.line, qtyReceived: '30.000' });
    expect(elsewhere.body.error).toMatchObject({ code: 'GOODS_RECEIPT_INVALID', details: [expect.objectContaining({ field: '/lines/0/purchaseOrderLineId', code: 'ORDER_LINE_UNKNOWN' })] });
    const product = await post(storekeeper, '/goods-receipts', {
      kind: 'PURCHASE',
      supplierId: id(AWUTU),
      locationId: id('location:SHOP'),
      purchaseOrderId: order.order,
      receivedAt: new Date(clock.now().getTime() - 60_000).toISOString(),
      lines: [{ productId: id('product:EGG-0001'), purchaseOrderLineId: order.line, batchNo: 'EGG-OTHER', expiresOn: toBusinessDate(new Date(clock.now().getTime() + 14 * 86_400_000)), qtyReceived: '30.000' }],
    });
    expect(product.body.error).toMatchObject({ code: 'GOODS_RECEIPT_INVALID', details: [expect.objectContaining({ field: '/lines/0/purchaseOrderLineId', code: 'ORDER_LINE_OTHER_PRODUCT' })] });
    expect((await get(storekeeper, `/goods-receipts?purchaseOrderId=${order.order}`)).status).toBe(200);
  });
});
