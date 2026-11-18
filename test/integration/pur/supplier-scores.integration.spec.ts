import { randomUUID } from 'node:crypto';
import { ManualClock, toBusinessDate } from '@hakorem/kernel';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { totpAt } from '../../../src/modules/iam/domain/totp';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { CookieJar, consoleGet, consolePost, createUser, enrolAndLogin, login, relaxRateLimits, testStartTime, type TestSession, type TestUser } from '../../support/iam';
import { startTestApp, TEST_ORIGIN, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * Supplier scores over the seeded farm (FR-PUR-014, A-173): two suppliers registered for the test, so no seeded fact
 * reaches them, buy broilers in one calendar month; their scores are checked against a hand calculation, component by
 * component, and the weights are the settings. Every read refuses the wrong role.
 */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
type TotpSession = TestSession & { readonly secret: Buffer };
const users = new Map<string, TestUser>();
const sessions = new Map<string, TotpSession | TestSession>();
const ids = new Map<string, string>();

const id = (code: string) => ids.get(code)!;
const session = (name: string) => sessions.get(name)!;
const totp = (name: string) => sessions.get(name) as TotpSession;
const post = (who: string, path: string, body: object = {}, key: string = randomUUID()) => consolePost(api.server, session(who), `/v1${path}`, key).send(body);
const get = (who: string, path: string) => consoleGet(api.server, session(who), `/v1${path}`);
const today = () => toBusinessDate(clock.now());

/** A second sign-in after the clock moved past the session's idle lifetime: password, then a TOTP code where enrolled. */
async function signInAgain(name: string): Promise<void> {
  const user = users.get(name)!;
  const previous = sessions.get(name)!;
  if (!('secret' in previous)) {
    sessions.set(name, await login(api.server, user));
    return;
  }
  const first = await request(api.server).post('/v1/auth/staff/login').set('Origin', TEST_ORIGIN).send({ identifier: user.identifier, password: user.password });
  expect(first.body.status).toBe('TOTP_REQUIRED');
  const verified = await request(api.server)
    .post('/v1/auth/totp/verify')
    .set('Origin', TEST_ORIGIN)
    .send({ challengeToken: first.body.challengeToken, code: totpAt(previous.secret, Math.floor(clock.now().getTime() / 1000)) });
  expect(verified.status).toBe(200);
  const jar = new CookieJar();
  jar.store(verified.headers['set-cookie']);
  const current = await request(api.server).get('/v1/auth/session').set('Cookie', jar.header());
  sessions.set(name, { jar, csrfToken: current.body.csrfToken as string, sessionId: current.body.sessionId as string, secret: previous.secret });
}

async function nextDay(): Promise<void> {
  clock.advanceBy(86_400_000 + 60_000);
  for (const name of sessions.keys()) await signInAgain(name);
}

async function approve(checker: string, approvalRequestId: string) {
  clock.advanceBy(30_000);
  expect((await post(checker, '/auth/step-up', { code: totpAt(totp(checker).secret, Math.floor(clock.now().getTime() / 1000)) })).status).toBe(200);
  return post(checker, `/iam/approvals/${approvalRequestId}/approve`, { reason: 'Counted at the pens' });
}

async function sentOrder(supplierId: string, qty: string, unitPricePesewas: number): Promise<{ id: string; lineId: string }> {
  const created = await post('storekeeper', '/purchase-orders', {
    supplierId,
    deliverToLocationId: id('location:PENS'),
    orderDate: today(),
    expectedOn: today(),
    lines: [{ productId: id('product:LIV-0001'), qtyOrdered: qty, unitPricePesewas }],
  });
  expect(created.status).toBe(201);
  expect((await post('storekeeper', `/purchase-orders/${created.body.id}/submit`)).status).toBe(200);
  expect((await post('manager', `/purchase-orders/${created.body.id}/send`, { channels: ['WHATSAPP'] })).status).toBe(200);
  return { id: created.body.id, lineId: created.body.lines[0].id };
}

async function receive(supplierId: string, order: { id: string; lineId: string }, qty: string, qtyRejected?: string): Promise<string> {
  const draft = await post('storekeeper', '/goods-receipts', {
    kind: 'PURCHASE',
    supplierId,
    locationId: id('location:PENS'),
    purchaseOrderId: order.id,
    deliveryNoteRef: `DN-${randomUUID().slice(0, 6)}`,
    receivedAt: new Date(clock.now().getTime() - 60_000).toISOString(),
    lines: [
      {
        productId: id('product:LIV-0001'),
        purchaseOrderLineId: order.lineId,
        qtyReceived: qty,
        ...(qtyRejected === undefined ? {} : { qtyRejected, rejectionReasonCode: 'QUALITY_REJECTED', rejectionNote: 'Birds rejected at the door (test)' }),
        valuePesewas: 5_000 * Number.parseInt(qty, 10),
        batchNo: `BR-${randomUUID().slice(0, 8)}`,
      },
    ],
  });
  expect(draft.status).toBe(201);
  expect((await post('storekeeper', `/goods-receipts/${draft.body.id}/post`)).status).toBe(200);
  return (await database.pool('admin').query<{ stock_unit_id: string }>('SELECT stock_unit_id FROM inv.stock_movement WHERE source_document_id = $1 LIMIT 1', [draft.body.id])).rows[0]!.stock_unit_id;
}

async function approvedInvoice(supplierId: string, order: { id: string; lineId: string }, qty: string, unitPricePesewas: number): Promise<string> {
  const created = await post('accountant', '/supplier-invoices', {
    kind: 'INVOICE',
    supplierId,
    supplierInvoiceNo: `INV-${randomUUID().slice(0, 8)}`,
    invoiceDate: today(),
    purchaseOrderId: order.id,
    lines: [{ description: 'Broilers, live, 6 weeks', purchaseOrderLineId: order.lineId, qty, unitPricePesewas, taxCategoryId: id('tax:LIVE_ANIMALS') }],
  });
  expect(created.status).toBe(201);
  expect((await post('accountant', `/supplier-invoices/${created.body.id}/match`)).body.matchStatus).toBe('MATCHED');
  expect((await post('owner', `/supplier-invoices/${created.body.id}/approve`)).status).toBe(200);
  return created.body.id as string;
}

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock });
  await runSeedUnits(database.pool('app'), api.app, seedUnits({ SEED_STAFF_PASSWORD: `Seed-${randomUUID()}` }));
  for (const row of (
    await database.pool('admin').query<{ code: string; id: string }>(
      `SELECT 'branch:' || code AS code, id FROM mdm.branch
       UNION ALL SELECT 'location:' || l.code, l.id FROM mdm.location l JOIN mdm.branch b ON b.id = l.branch_id WHERE b.code = 'DDW'
       UNION ALL SELECT 'product:' || sku, id FROM mdm.product
       UNION ALL SELECT 'tax:' || code, id FROM mdm.tax_category`,
    )
  ).rows) {
    ids.set(row.code, row.id);
  }
  const branchId = id('branch:DDW');
  const people: [string, string, 'MANAGER' | 'OWNER' | 'ACCOUNTANT' | 'STOREKEEPER' | 'CASHIER' | 'FARM_HAND', boolean, string | undefined][] = [
    ['manager', 'Akosua Boateng', 'MANAGER', true, undefined],
    ['owner', 'Kwabena Owusu', 'OWNER', true, undefined],
    ['accountant', 'Yaw Agyeman', 'ACCOUNTANT', true, undefined],
    ['storekeeper', 'Kwesi Ofori', 'STOREKEEPER', false, 'PENS'],
    ['cashier', 'Adwoa Darko', 'CASHIER', false, 'SHOP'],
    ['farmHand', 'Abdul-Rahman Iddrisu', 'FARM_HAND', false, 'PENS'],
  ];
  for (const [name, displayName, role, privileged, location] of people) {
    const user = await createUser(database, { name: displayName, grants: [{ role, branchId, ...(location === undefined ? {} : { locationId: id(`location:${location}`) }) }] });
    users.set(name, user);
    sessions.set(name, privileged ? await enrolAndLogin(api.server, user, () => clock.now()) : await login(api.server, user));
  }
  // The scored month must hold today and tomorrow: on the last day of a month, start on the next one.
  if (toBusinessDate(new Date(clock.now().getTime() + 86_400_000 + 60_000)).slice(0, 7) !== today().slice(0, 7)) await nextDay();
  for (const name of ['Akuse Broiler Growers', 'Somanya Poultry Ltd']) {
    const created = await post('manager', '/suppliers', { name });
    expect(created.status).toBe(201);
    ids.set(`supplier:${name}`, created.body.id);
  }
});

afterAll(async () => {
  await api.close();
  await database.drop();
});

describe('supplier scores (FR-PUR-014: the gate)', () => {
  it('refuses the scores to the Storekeeper, Cashier and Farm hand, and a period that is not the first of a month', async () => {
    for (const name of ['storekeeper', 'cashier', 'farmHand']) {
      expect((await get(name, `/supplier-scores?periodStart=${today().slice(0, 7)}-01`)).status).toBe(403);
    }
    expect((await get('manager', `/supplier-scores?periodStart=${today().slice(0, 7)}-02`)).status).toBe(400);
  });

  it('scores Akuse 93.00 and Somanya 75.00 for a month of their facts, each component counted by hand', async () => {
    const periodStart = `${today().slice(0, 7)}-01`;
    const akuse = id('supplier:Akuse Broiler Growers');
    const somanya = id('supplier:Somanya Poultry Ltd');
    // Akuse: 20 broilers at 6,000, promised and received today; one of the 20 accepted is sent back on a credit note.
    const akuseOrder = await sentOrder(akuse, '20.000', 6_000);
    const lot = await receive(akuse, akuseOrder, '20.000');
    const akuseInvoice = await approvedInvoice(akuse, akuseOrder, '20.000', 6_000);
    const credit = await post('accountant', '/supplier-invoices', {
      kind: 'CREDIT_NOTE',
      supplierId: akuse,
      supplierInvoiceNo: `CN-${randomUUID().slice(0, 8)}`,
      invoiceDate: today(),
      originalInvoiceId: akuseInvoice,
      returnReasonCode: 'RETURN_QUALITY',
      lines: [
        { description: 'One broiler returned lame', purchaseOrderLineId: akuseOrder.lineId, qty: '1.000', unitPricePesewas: 6_000, taxCategoryId: id('tax:LIVE_ANIMALS'), returnFromLocationId: id('location:PENS'), returnStockUnitId: lot },
      ],
    });
    expect(credit.status).toBe(201);
    const submitted = await post('accountant', `/supplier-invoices/${credit.body.id}/submit`);
    expect((await approve('owner', submitted.body.approvalRequestId)).status).toBe(200);
    // Somanya: 40 broilers at 4,500, promised today, received tomorrow: late.
    const somanyaOrder = await sentOrder(somanya, '40.000', 4_500);
    await nextDay();
    expect(`${today().slice(0, 7)}-01`).toBe(periodStart);
    await receive(somanya, somanyaOrder, '38.000', '2.000');
    await approvedInvoice(somanya, somanyaOrder, '38.000', 4_500);

    const page = await get('manager', `/supplier-scores?periodStart=${periodStart}`);
    expect(page.status).toBe(200);
    const byId = new Map((page.body.data as { supplier: { id: string } }[]).map((s) => [s.supplier.id, s] as const));
    // By hand. The farm paid 120,000 + 171,000 = 291,000 for 58 birds on approved invoices: 291,000 / 58 a bird.
    // Akuse: 120,000 for 20 against 20 x 291,000 / 58 = 100,344.83: 19.5876... percent over, so price 80.41 (rounded once).
    // Lead time 1 of 1 on time: 100. Quality 20 of 20: 100. Rejection 100 less 1 of 20 sent back: 95.
    // Score (30 x 80.4123... + 25 x 100 + 25 x 100 + 20 x 95) / 100 = 93.12.
    expect(byId.get(akuse)).toMatchObject({
      periodStart,
      ordersCount: 1,
      onTimePercent: '100.00',
      rejectionPercent: '0.00',
      priceVariancePercent: '19.59',
      returnedPercent: '5.00',
      components: { price: '80.41', leadTime: '100.00', quality: '100.00', rejection: '95.00' },
      weights: { price: 30, leadTime: 25, quality: 25, rejection: 20 },
      score: '93.12',
    });
    // Somanya: 171,000 for 38 against 38 x 291,000 / 58 = 190,655.17: under the average, so price 100. Late: lead time 0.
    // Quality 38 of 40: 95. Nothing sent back: rejection 100. (30 x 100 + 0 + 25 x 95 + 20 x 100) / 100 = 73.75.
    expect(byId.get(somanya)).toMatchObject({
      ordersCount: 1,
      onTimePercent: '0.00',
      rejectionPercent: '5.00',
      priceVariancePercent: '0.00',
      returnedPercent: '0.00',
      components: { price: '100.00', leadTime: '0.00', quality: '95.00', rejection: '100.00' },
      score: '73.75',
    });
    const one = await get('accountant', `/supplier-scores?periodStart=${periodStart}&supplierId=${somanya}`);
    expect(one.body.data.map((s: { score: string }) => s.score)).toEqual(['73.75']);
  });

  it('weighs by the settings: with the price weight set to 0 by the Owner, Akuse scores (25 x 100 + 25 x 100 + 20 x 95) / 70 = 98.57', async () => {
    clock.advanceBy(30_000);
    expect((await post('owner', '/auth/step-up', { code: totpAt(totp('owner').secret, Math.floor(clock.now().getTime() / 1000)) })).status).toBe(200);
    const set = await request(api.server)
      .put('/v1/admin/settings/pur.supplier_score.price_weight')
      .set('Cookie', session('owner').jar.header())
      .set('X-CSRF-Token', session('owner').csrfToken)
      .set('Origin', TEST_ORIGIN)
      .set('Idempotency-Key', randomUUID())
      .send({ value: 0, version: 0 });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    clock.advanceBy(60_000);
    const page = await get('manager', `/supplier-scores?periodStart=${today().slice(0, 7)}-01&supplierId=${id('supplier:Akuse Broiler Growers')}`);
    expect(page.body.data[0]).toMatchObject({ weights: { price: 0, leadTime: 25, quality: 25, rejection: 20 }, score: '98.57' });
  });
});
