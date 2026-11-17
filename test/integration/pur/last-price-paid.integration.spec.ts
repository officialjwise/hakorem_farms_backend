import { randomUUID } from 'node:crypto';
import { ManualClock, toBusinessDate } from '@hakorem/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { consoleGet, consolePatch, consolePost, createUser, enrolAndLogin, login, relaxRateLimits, testStartTime, type TestSession } from '../../support/iam';
import { startTestApp, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * The last price paid (B09e continued 2, the owner's decision 7 of 2026-11-17): a purchase order line that names no
 * price takes the unit price of the latest invoice line of that supplier, product and unit that was approved for
 * payment (APPROVED or PAID, A-270): a draft, a matched invoice not yet approved, a cancelled one and a credit note never
 * count. Two suppliers sell the same crate of big eggs at different prices, so a default from the wrong supplier, or
 * from an invoice not approved, fails. A price the buyer enters always wins. Every write refuses the wrong role.
 */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let manager: TestSession;
let accountant: TestSession;
let storekeeper: TestSession;
let cashier: TestSession;
const ids = new Map<string, string>();

const id = (code: string) => ids.get(code)!;
const AWUTU = 'supplier:Awutu Poultry Farm (SEED)';
const KPONE = 'supplier:Kpone Livestock Traders (SEED)';
const post = (session: TestSession, path: string, body: object = {}, key: string = randomUUID()) => consolePost(api.server, session, `/v1${path}`, key).send(body);
const get = (session: TestSession, path: string) => consoleGet(api.server, session, `/v1${path}`);
const admin = () => database.pool('admin');
const today = () => toBusinessDate(clock.now());

function orderBody(supplier: string, line: Record<string, unknown>) {
  return {
    supplierId: id(supplier),
    deliverToLocationId: id('location:SHOP'),
    orderDate: today(),
    lines: [{ productId: id('product:EGG-0003'), uom: 'CRATE', qtyOrdered: '2.000', ...line }],
  };
}

/** Two crates bought, received and invoiced at `pricePesewas` a crate; the invoice approved unless `approve` is false. */
async function bought(supplier: string, pricePesewas: number, approve = true): Promise<string> {
  const created = await post(storekeeper, '/purchase-orders', orderBody(supplier, { unitPricePesewas: pricePesewas }));
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  expect((await post(storekeeper, `/purchase-orders/${created.body.id}/submit`)).status).toBe(200);
  expect((await post(manager, `/purchase-orders/${created.body.id}/send`, { channels: ['WHATSAPP'] })).status).toBe(200);
  const lineId = created.body.lines[0].id as string;
  const receipt = await post(storekeeper, '/goods-receipts', {
    kind: 'PURCHASE',
    supplierId: id(supplier),
    locationId: id('location:SHOP'),
    purchaseOrderId: created.body.id,
    receivedAt: new Date(clock.now().getTime() - 60_000).toISOString(),
    lines: [{ productId: id('product:EGG-0003'), purchaseOrderLineId: lineId, uom: 'CRATE', qtyReceived: '2.000', valuePesewas: 2 * pricePesewas, batchNo: `EGG-${randomUUID().slice(0, 8)}`, expiresOn: toBusinessDate(new Date(clock.now().getTime() + 14 * 86_400_000)) }],
  });
  expect(receipt.status, JSON.stringify(receipt.body)).toBe(201);
  expect((await post(storekeeper, `/goods-receipts/${receipt.body.id}/post`)).status).toBe(200);
  const invoice = await post(accountant, '/supplier-invoices', {
    kind: 'INVOICE',
    supplierId: id(supplier),
    supplierInvoiceNo: `INV-${randomUUID().slice(0, 8)}`,
    invoiceDate: today(),
    purchaseOrderId: created.body.id,
    lines: [{ description: 'Big eggs, crate of 30', purchaseOrderLineId: lineId, qty: '2.000', unitPricePesewas: pricePesewas, taxCategoryId: id('tax:EGG-0003') }],
  });
  expect(invoice.status, JSON.stringify(invoice.body)).toBe(201);
  expect((await post(accountant, `/supplier-invoices/${invoice.body.id}/match`)).status).toBe(200);
  if (approve) expect((await post(accountant, `/supplier-invoices/${invoice.body.id}/approve`)).status).toBe(200);
  clock.advanceBy(60_000);
  return invoice.body.id as string;
}

/** A Manager and an Accountant with TOTP, a Storekeeper at the shop and a Cashier there, signed in now. */
async function signIn(names: readonly [string, string, string, string]): Promise<void> {
  const branchId = id('branch:DDW');
  manager = await enrolAndLogin(api.server, await createUser(database, { name: names[0], grants: [{ role: 'MANAGER', branchId }] }), () => clock.now());
  accountant = await enrolAndLogin(api.server, await createUser(database, { name: names[1], grants: [{ role: 'ACCOUNTANT', branchId }] }), () => clock.now());
  storekeeper = await login(api.server, await createUser(database, { name: names[2], grants: [{ role: 'STOREKEEPER', branchId, locationId: id('location:SHOP') }] }));
  cashier = await login(api.server, await createUser(database, { name: names[3], grants: [{ role: 'CASHIER', branchId, locationId: id('location:SHOP') }] }));
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
       UNION ALL SELECT 'tax:' || sku, tax_category_id FROM mdm.product
       UNION ALL SELECT 'supplier:' || name, id FROM mdm.supplier`,
    )
  ).rows) {
    ids.set(row.code, row.id);
  }
  await signIn(['Akosua Boateng', 'Yaw Agyeman', 'Kofi Mensah', 'Adwoa Darko']);

  // Day one: Awutu at 4,751 then 4,800 a crate, both approved; Kpone at 5,000, approved last. Day two, so that either
  // would win on its later invoice date if it counted: Awutu matched at 9,999 but never approved, and Awutu at 6,100
  // cancelled after approval. The day two staff are new sign-ins (the day one sessions have gone idle).
  await bought(AWUTU, 4_751);
  await bought(AWUTU, 4_800);
  await bought(KPONE, 5_000);
  clock.advanceBy(86_400_000);
  await signIn(['Ama Asante', 'Kojo Antwi', 'Yaw Boakye', 'Efua Quaye']);
  await bought(AWUTU, 9_999, false);
  const cancelled = await bought(AWUTU, 6_100);
  expect((await post(accountant, `/supplier-invoices/${cancelled}/cancel`, { reason: 'Entered against the wrong delivery (test)' })).status).toBe(200);
});

afterAll(async () => {
  await api?.close();
  await database.drop();
});

describe('a purchase order line defaults to the last price paid (decision 7, A-270)', () => {
  it('prices an Awutu crate at 4,800, its latest approved invoice, not Kpone 5,000, the unapproved 9,999 or the cancelled 6,100', async () => {
    const created = await post(storekeeper, '/purchase-orders', orderBody(AWUTU, { qtyOrdered: '3.000' }));
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.lines[0]).toMatchObject({ uom: 'CRATE', qtyOrdered: '3.000', unitPricePesewas: 4_800, lineNetPesewas: 14_400 });
  });

  it('prices a Kpone crate at 5,000, its own last price', async () => {
    const created = await post(storekeeper, '/purchase-orders', orderBody(KPONE, {}));
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.lines[0]).toMatchObject({ unitPricePesewas: 5_000, lineNetPesewas: 10_000 });
  });

  it('keeps a price the buyer enters', async () => {
    const created = await post(storekeeper, '/purchase-orders', orderBody(AWUTU, { unitPricePesewas: 4_700 }));
    expect(created.body.lines[0]).toMatchObject({ unitPricePesewas: 4_700, lineNetPesewas: 9_400 });
  });

  it('defaults on a draft changed by updatePurchaseOrder too', async () => {
    const created = await post(storekeeper, '/purchase-orders', orderBody(AWUTU, { unitPricePesewas: 4_700 }));
    const changed = await consolePatch(api.server, storekeeper, `/v1/purchase-orders/${created.body.id}`, randomUUID()).send({ version: created.body.version, lines: orderBody(AWUTU, { qtyOrdered: '1.000' }).lines });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    expect(changed.body.lines[0]).toMatchObject({ unitPricePesewas: 4_800, lineNetPesewas: 4_800 });
  });

  it('refuses a line with no price when nothing was paid for it: another unit, or a product never bought from the supplier', async () => {
    const before = (await admin().query<{ n: number }>('SELECT count(*)::int AS n FROM pur.purchase_order')).rows[0]!.n;
    const inEggs = await post(storekeeper, '/purchase-orders', orderBody(AWUTU, { uom: 'UNIT', qtyOrdered: '60.000' }));
    expect(inEggs.status).toBe(422);
    expect(inEggs.body.error).toMatchObject({ code: 'PURCHASE_ORDER_INVALID', details: [{ field: '/lines/0/unitPricePesewas', code: 'PRICE_REQUIRED' }] });
    const neverBought = await post(storekeeper, '/purchase-orders', { ...orderBody(KPONE, {}), lines: [{ productId: id('product:EGG-0001'), uom: 'CRATE', qtyOrdered: '1.000' }] });
    expect(neverBought.status).toBe(422);
    expect(neverBought.body.error).toMatchObject({ code: 'PURCHASE_ORDER_INVALID', details: [{ field: '/lines/0/unitPricePesewas', code: 'PRICE_REQUIRED' }] });
    expect((await admin().query<{ n: number }>('SELECT count(*)::int AS n FROM pur.purchase_order')).rows[0]!.n).toBe(before);
  });

  it('refuses the Cashier a purchase order priced by default, with 403, and nothing is written', async () => {
    const before = (await admin().query<{ n: number }>('SELECT count(*)::int AS n FROM pur.purchase_order')).rows[0]!.n;
    const refused = await post(cashier, '/purchase-orders', orderBody(AWUTU, {}));
    expect(refused.status).toBe(403);
    expect((await admin().query<{ n: number }>('SELECT count(*)::int AS n FROM pur.purchase_order')).rows[0]!.n).toBe(before);
    expect((await get(cashier, '/purchase-orders')).status).toBe(403);
  });
});
