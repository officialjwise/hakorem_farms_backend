import { randomUUID } from 'node:crypto';
import { createUuidV7Generator, ManualClock, toBusinessDate } from '@hakorem/kernel';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Billing, type IssueRequest } from '../../../src/modules/bil';
import { Storefront } from '../../../src/modules/mdm';
import { QuoteExpiry } from '../../../src/modules/quo';
import { runAsSystem, runWithRequestContext, type Actor } from '../../../src/platform/context/request-context';
import { UnitOfWork } from '../../../src/platform/database/unit-of-work';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { consoleGet, consolePost, consolePut, createUser, enrolAndLogin, login, relaxRateLimits, SYSTEM_PRINCIPAL, testStartTime, type TestSession, type TestUser } from '../../support/iam';
import { startTestApp, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * B11u, the UAT scenario 2 corrections (the owner's decisions of 2026-11-23), over the seeded farm, every figure exact
 * and read back from the tables that hold it. The seeded goats (LIV-0004) are G-0142 (24.350 kg), G-0143 (22.800),
 * G-0144 (26.100) and G-0145 (19.750), all of band GOAT-M (18 to 28 kg), at a cost of 60,000 each; the QUOTE channel
 * lists a GOAT-M goat at 65,000 (floor 40,000), a crate of big eggs at 6,000 and a yam at 2,000 (floor 1,500).
 * 1. A quoted line books its list price to sales and the difference to 4210, above or below; none at list.
 * 2. A quote holds its count at issue, capped at what is free, of its band; released when it expires, is replaced or
 *    withdrawn; handed to the order at conversion with no gap, under a concurrent rival.
 * 3. The estimate taxes its delivery fee as the invoice does: the same totals to the pesewa.
 * 4. A quote of animals converts with no tags; the picker names them.
 * And A-328 (c) (the buyer sees min(asked, available now)) and A-329 (b) (a withdrawn quote is its own outcome).
 */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let branchId: string;
const sessions = new Map<string, TestSession>();
const users = new Map<string, TestUser>();
const ids = new Map<string, string>();
const id = (name: string) => ids.get(name)!;
const admin = () => database.pool('admin');
const as = (who: string) => sessions.get(who)!;
const nextId = () => createUuidV7Generator(clock)();
const post = (who: string, path: string, body: object = {}, key: string = randomUUID()) => consolePost(api.server, as(who), `/v1${path}`, key).send(body);
const put = (who: string, path: string, body: object = {}) => consolePut(api.server, as(who), `/v1${path}`, randomUUID()).send(body);
const get = (who: string, path: string) => consoleGet(api.server, as(who), `/v1${path}`);
const publicGet = (path: string) => request(api.server).get(`/v1${path}`);
const one = async (sql: string, values: unknown[] = []) => (await admin().query(sql, values)).rows[0]!;
const actorOf = (who: string): Actor => ({ principalId: users.get(who)!.principalId, kind: 'USER', displayName: who, realm: 'STAFF', sessionId: null, steppedUpAt: null });
const validFor = (days: number) => new Date(Math.floor(clock.now().getTime() / 86_400_000) * 86_400_000 + days * 86_400_000 + 86_399_000).toISOString();

const goats = (heads: string, unitPricePesewas: number, band = 'GOAT-M') => ({ productId: id('goat'), weightBandId: id(`band:${band}`), description: `Goats of ${band} for a funeral`, quantity: heads, priceBasis: 'PER_HEAD', unitPricePesewas });
const crates = (n: string, unitPricePesewas = 6_000) => ({ productId: id('eggs'), description: 'Big eggs by the crate', quantity: n, uom: 'CRATE', priceBasis: 'PER_UNIT', unitPricePesewas });
const yams = (n: string, unitPricePesewas: number) => ({ productId: id('yam'), description: 'Yam by the tuber', quantity: n, priceBasis: 'PER_UNIT', unitPricePesewas });

async function issued(lines: object[], extra: object = {}, who = 'sales') {
  const made = await post(who, '/quotes', { contactName: 'Emmanuel Tetteh', contactPhone: '+233244512876', validUntil: validFor(7), taxInclusive: false, terms: 'Half the price as deposit (TEST)', lines, ...extra });
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  const done = await post(who, `/quote-versions/${made.body.currentVersion.id as string}/issue`, { channels: ['SMS'] });
  expect(done.status, JSON.stringify(done.body)).toBe(200);
  return { quoteId: made.body.id as string, version: done.body, token: done.body.acceptanceLinkToken as string };
}
async function accepted(lines: object[], extra: object = {}) {
  const q = await issued(lines, extra);
  const r = await post('sales', `/quotes/${q.quoteId}/record-acceptance`, { method: 'IN_PERSON', acceptedName: 'Emmanuel Tetteh', note: 'Signed the printed quote (TEST)' });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return q;
}
/** The active reservations a document holds, from INV's table: the animals by tag, and the quantity. */
async function heldBy(holderId: string): Promise<{ qty: string; tags: string[]; expiring: number }> {
  const r = await admin().query<{ qty: string; tag: string | null; expires: Date | null }>(
    `SELECT r.qty::text AS qty, u.identifier AS tag, r.expires_at AS expires FROM inv.stock_reservation r LEFT JOIN inv.stock_unit u ON u.id = r.stock_unit_id
      WHERE r.holder_document_id = $1 AND r.status = 'ACTIVE' ORDER BY u.identifier`,
    [holderId],
  );
  const sum = r.rows.reduce((a, x) => a + Math.round(Number(x.qty) * 1000), 0);
  return { qty: (sum / 1000).toFixed(3), tags: r.rows.flatMap((x) => (x.tag === null ? [] : [x.tag])), expiring: r.rows.filter((x) => x.expires !== null).length };
}
async function cancel(quoteId: string, reason = 'The buyer went elsewhere (TEST)') {
  const r = await post('sales', `/quotes/${quoteId}/cancel`, { reason });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
}
/** The journal of a billing document, account by account, and whether it balances. */
async function journalOf(documentId: string): Promise<{ lines: string[]; balanced: boolean }> {
  const r = await admin().query<{ code: string; side: string; amount: string }>(
    `SELECT a.code, l.side, l.amount_pesewas::text AS amount FROM fin.journal_entry e JOIN fin.journal_line l ON l.journal_entry_id = e.id JOIN fin.account a ON a.id = l.account_id
      WHERE e.source_document_id = $1 ORDER BY a.code, l.side`,
    [documentId],
  );
  const debits = r.rows.filter((x) => x.side === 'D').reduce((a, x) => a + BigInt(x.amount), 0n);
  const credits = r.rows.filter((x) => x.side === 'C').reduce((a, x) => a + BigInt(x.amount), 0n);
  return { lines: r.rows.map((x) => `${x.code}:${x.side}:${x.amount}`), balanced: debits === credits && debits > 0n };
}
/** An accepted quote converted, confirmed, picked, packed and handed over: the order and its document. */
async function collected(quoteId: string, location: string, picksOf: (lines: { id: string }[]) => object[], convert: object = {}) {
  const order = await post('sales', `/quotes/${quoteId}/convert`, { fulfilmentMode: 'COLLECTION', paymentTerms: 'COD', ...convert });
  expect(order.status, JSON.stringify(order.body)).toBe(201);
  const orderId = order.body.id as string;
  const confirmed = await post('sales', `/orders/${orderId}/confirm`);
  expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
  const list = await post('storekeeper', `/orders/${orderId}/fulfilments`, { pickLocationId: id(`location:${location}`) });
  expect(list.status, JSON.stringify(list.body)).toBe(201);
  const picked = await post('storekeeper', `/fulfilments/${list.body.id as string}/picks`, { picks: picksOf(order.body.lines) });
  expect(picked.status, JSON.stringify(picked.body)).toBe(200);
  expect((await post('storekeeper', `/fulfilments/${list.body.id as string}/pack`, { packageCount: 1 })).status).toBe(200);
  const handed = await post('manager', `/fulfilments/${list.body.id as string}/collect`, {});
  expect(handed.status, JSON.stringify(handed.body)).toBe(200);
  const view = (await get('manager', `/orders/${orderId}`)).body;
  return { orderId, order: view, documentId: view.billingDocument.id as string };
}
const pick = (orderLineId: string, qty: string, unit?: string) => ({ id: nextId(), orderLineId, qty, ...(unit === undefined ? {} : { stockUnitId: id(unit) }) });

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock, environment: { AUTH_ACCESS_TTL_SECONDS: '43200' } });
  await runSeedUnits(database.pool('app'), api.app, seedUnits({ SEED_STAFF_PASSWORD: `Seed-${randomUUID()}` }));
  branchId = (await one("SELECT id FROM mdm.branch WHERE code = 'DDW'"))['id'] as string;
  for (const [name, sku] of [['goat', 'LIV-0004'], ['eggs', 'EGG-0003'], ['yam', 'PRD-0005']] as const) ids.set(name, (await one('SELECT id FROM mdm.product WHERE sku = $1', [sku]))['id'] as string);
  for (const tag of ['G-0142', 'G-0143', 'G-0144', 'G-0145']) ids.set(tag, (await one('SELECT id FROM inv.stock_unit WHERE identifier = $1', [tag]))['id'] as string);
  ids.set('lot:EGG-0003', (await one("SELECT u.id FROM inv.stock_unit u WHERE u.product_id = $1 AND u.tracking = 'LOT'", [id('eggs')]))['id'] as string);
  for (const band of ['GOAT-S', 'GOAT-M']) ids.set(`band:${band}`, (await one('SELECT id FROM mdm.weight_band WHERE code = $1', [band]))['id'] as string);
  for (const row of (await admin().query<{ code: string; id: string }>('SELECT code, id FROM mdm.location WHERE branch_id = $1', [branchId])).rows) ids.set(`location:${row.code}`, row.id);
  const people: [string, string, string, boolean][] = [
    ['sales', 'Kojo Antwi', 'SALES', false],
    ['sales2', 'Esi Appiah', 'SALES', false],
    ['manager', 'Kwabena Owusu', 'MANAGER', true],
    ['storekeeper', 'Yaw Boateng', 'STOREKEEPER', false],
  ];
  for (const [who, name, role, privileged] of people) {
    const user = await createUser(database, { name, grants: [{ role: role as 'SALES', branchId }] });
    users.set(who, user);
    sessions.set(who, privileged ? await enrolAndLogin(api.server, user, () => clock.now()) : await login(api.server, user));
  }
});

afterAll(async () => {
  await api?.close();
  await database?.drop();
});

describe('item 2: a quote holds its count at issue, capped at what is free, and the hold ends with the quote (the owner, 2026-11-23)', () => {
  it('holds 3 goats for 3, the last 1 for 2 (subject to stock), none of GOAT-S for a GOAT-S line, each to the validity and never below zero', async () => {
    // A GOAT-S line holds no GOAT-M goat (B11u, A-351): every seeded goat weighs in GOAT-M, and all four are free.
    const small = await issued([goats('1.000', 70_000, 'GOAT-S')]);
    expect([small.version.subjectToStock, small.version.lines[0].availableQuantity, small.version.lines[0].heldQuantity, (await heldBy(small.quoteId)).qty]).toEqual([true, '0.000', '0.000', '0.000']);
    const three = await issued([goats('3.000', 95_000)]);
    expect([three.version.subjectToStock, three.version.lines[0].availableQuantity, three.version.lines[0].heldQuantity]).toEqual([false, '4.000', '3.000']);
    expect(await heldBy(three.quoteId)).toEqual({ qty: '3.000', tags: ['G-0142', 'G-0143', 'G-0144'], expiring: 3 });
    const two = await issued([goats('2.000', 95_000)], { validUntil: new Date(clock.now().getTime() + 120_000).toISOString() });
    expect([two.version.subjectToStock, two.version.lines[0].availableQuantity, two.version.lines[0].heldQuantity]).toEqual([true, '1.000', '1.000']);
    expect(await heldBy(two.quoteId)).toEqual({ qty: '1.000', tags: ['G-0145'], expiring: 1 });
    // Each issue publishes what it holds against what it asked, for the exception report (abuse case 64).
    const issuedHolds = (await one("SELECT payload FROM platform.outbox_message WHERE event_type = 'quo.QuoteIssued' AND subject_id = $1", [two.quoteId]))['payload'] as { holds: { productId: string; askedQty: string; heldQty: string }[] };
    expect(issuedHolds.holds.map((h) => [h.productId, h.askedQty, h.heldQty])).toEqual([[id('goat'), '2.000', '1.000']]);
    // Nothing is held twice and nothing is held beyond on hand: the four goats are each reserved once.
    expect((await one("SELECT count(*)::int AS n, count(DISTINCT stock_unit_id)::int AS d FROM inv.stock_reservation WHERE product_id = $1 AND status = 'ACTIVE'", [id('goat')]))).toEqual({ n: 4, d: 4 });

    // Replaced: version 2 of 2 goats releases version 1's three in the issuing transaction and holds two.
    const revised = await post('sales', `/quotes/${three.quoteId}/versions`, { changeNote: 'Reduced to two goats' });
    expect(revised.status, JSON.stringify(revised.body)).toBe(201);
    const edited = await put('sales', `/quote-versions/${revised.body.id as string}`, { version: revised.body.version ?? 1, lines: [goats('2.000', 95_000)] });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    const second = await post('sales', `/quote-versions/${revised.body.id as string}/issue`, { channels: ['SMS'] });
    expect([second.status, second.body.lines?.[0]?.heldQuantity], JSON.stringify(second.body)).toEqual([200, '2.000']);
    expect(await heldBy(three.quoteId)).toEqual({ qty: '2.000', tags: ['G-0142', 'G-0143'], expiring: 2 });
    const ended = await admin().query<{ status: string; n: number }>("SELECT status, count(*)::int AS n FROM inv.stock_reservation WHERE holder_document_id = $1 GROUP BY status ORDER BY status", [three.quoteId]);
    expect(ended.rows).toEqual([{ status: 'ACTIVE', n: 2 }, { status: 'RELEASED', n: 3 }]);

    // Expired, by the application clock: the job gives the goat back.
    clock.advanceBy(180_000);
    const expired = await runAsSystem({ principalId: SYSTEM_PRINCIPAL, displayName: 'Scheduler' }, randomUUID(), () => api.app.get(QuoteExpiry).run({ kind: 'SYSTEM', principalId: SYSTEM_PRINCIPAL }));
    expect(expired).toEqual([two.quoteId]);
    expect(await heldBy(two.quoteId)).toEqual({ qty: '0.000', tags: [], expiring: 0 });

    // Withdrawn: the hold ends with the quote, in the transaction that withdraws it.
    await cancel(three.quoteId);
    await cancel(small.quoteId);
    expect(await heldBy(three.quoteId)).toEqual({ qty: '0.000', tags: [], expiring: 0 });
    expect((await one("SELECT count(*)::int AS n FROM inv.stock_reservation WHERE product_id = $1 AND status = 'ACTIVE'", [id('goat')]))['n']).toBe(0);
  });

  it('keeps an accepted quote’s hold until the order takes it (A-310 (b)), and hands it over with no gap while a rival quote asks for every goat', async () => {
    const q = await accepted([goats('2.000', 95_000)]);
    const before = await heldBy(q.quoteId);
    expect(before).toEqual({ qty: '2.000', tags: ['G-0142', 'G-0143'], expiring: 0 });
    // The conversion and a rival quote for all four goats at once, each serializable: the rival never takes the two.
    const rival = await post('sales2', '/quotes', { contactName: 'Akua Mensah', contactPhone: '+233244998877', validUntil: validFor(7), taxInclusive: false, lines: [goats('4.000', 90_000)] });
    expect(rival.status).toBe(201);
    const [converted, rivalIssued] = await Promise.all([
      post('sales', `/quotes/${q.quoteId}/convert`, { fulfilmentMode: 'COLLECTION', paymentTerms: 'COD' }),
      post('sales2', `/quote-versions/${rival.body.currentVersion.id as string}/issue`, { channels: ['SMS'] }),
    ]);
    expect([converted.status, rivalIssued.status], JSON.stringify([converted.body, rivalIssued.body])).toEqual([201, 200]);
    expect(await heldBy(converted.body.id as string)).toEqual({ qty: '2.000', tags: ['G-0142', 'G-0143'], expiring: 0 });
    expect(await heldBy(rival.body.id as string)).toEqual({ qty: '2.000', tags: ['G-0144', 'G-0145'], expiring: 2 });
    expect([rivalIssued.body.subjectToStock, rivalIssued.body.lines[0].heldQuantity]).toEqual([true, '2.000']);
    // The hand-over is one transaction: each of the quote's reservations ended RELEASED and the order's made under the
    // same locks; the rival, issued at the same time, never held either goat, at any status.
    const rivals = await admin().query<{ tag: string }>('SELECT u.identifier AS tag FROM inv.stock_reservation r JOIN inv.stock_unit u ON u.id = r.stock_unit_id WHERE r.holder_document_id = $1 ORDER BY u.identifier', [rival.body.id]);
    expect(rivals.rows.map((r) => r.tag)).toEqual(['G-0144', 'G-0145']);
    const ended = await admin().query<{ tag: string; status: string }>('SELECT u.identifier AS tag, r.status FROM inv.stock_reservation r JOIN inv.stock_unit u ON u.id = r.stock_unit_id WHERE r.holder_document_id = $1 ORDER BY u.identifier', [q.quoteId]);
    // Ended twice each: at acceptance (taken again with no expiry, A-310 (b)) and at the hand-over.
    expect(ended.rows.map((r) => [r.tag, r.status])).toEqual([
      ['G-0142', 'RELEASED'],
      ['G-0142', 'RELEASED'],
      ['G-0143', 'RELEASED'],
      ['G-0143', 'RELEASED'],
    ]);
    // Released for tests that follow.
    expect((await post('sales', `/orders/${converted.body.id as string}/cancel`, { reasonCode: 'CUSTOMER_CANCELLED' })).status).toBe(200);
    await cancel(rival.body.id as string);
  });
});

describe('item 3: the estimate taxes its delivery fee by the invoice’s rule, so the quote and the invoice agree to the pesewa (the owner, 2026-11-23)', () => {
  /** The invoice of these lines and fee, issued as dispatch issues it (a DELIVERY_FEE line of the delivery category), then rolled back. */
  async function invoiceTotals(lines: { productId: string; quantity: string; uom?: string; unitPricePesewas: number }[], feePesewas: bigint, taxInclusive: boolean) {
    const uow = api.app.get(UnitOfWork);
    const billing = api.app.get(Billing);
    const storefront = api.app.get(Storefront);
    let totals: { net: number; tax: number; gross: number } | null = null;
    await runWithRequestContext({ correlationId: randomUUID(), ip: null, userAgent: 'B11u test', actor: actorOf('manager') }, () =>
      uow
        .run({ isolation: 'serializable', seriesLocks: billing.seriesLocksFor('INVOICE', branchId) }, async (tx) => {
          const taxCategoryId = await storefront.deliveryTaxCategoryIdIn(tx);
          const issue: IssueRequest = {
            kind: 'RECEIPT',
            branchId,
            taxInclusive,
            lines: [
              ...lines.map((l) => ({ lineKind: 'PRODUCT' as const, productId: l.productId, quantity: l.quantity, ...(l.uom === undefined ? {} : { uom: l.uom }), unitPricePesewas: BigInt(l.unitPricePesewas) })),
              { lineKind: 'DELIVERY_FEE' as const, description: 'Delivery', quantity: '1.000', unitPricePesewas: feePesewas, taxCategoryId },
            ],
          };
          const doc = await billing.issueIn(tx, actorOf('manager'), issue);
          totals = { net: Number(doc.netPesewas), tax: Number(doc.taxPesewas), gross: Number(doc.grossPesewas) };
          throw new Error('ROLL BACK');
        })
        .catch((e: Error) => {
          if (e.message !== 'ROLL BACK') throw e;
        }),
    );
    return totals!;
  }

  it("prices UAT scenario 2's version 1 tax-exclusive: 20 goats at 95,000 and a fee of 6,000 with 1,200 of tax, net 1,906,000, gross 1,907,200, as the invoice", async () => {
    const q = await issued([goats('20.000', 95_000)], { deliveryFeePesewas: 6_000 });
    const v = q.version;
    expect([v.netPesewas, v.taxPesewas, v.grossPesewas, v.marginOverPricePercent]).toEqual([1_906_000, 1_200, 1_907_200, expect.any(String)]);
    expect(await invoiceTotals([{ productId: id('goat'), quantity: '20.000', unitPricePesewas: 95_000 }], 6_000n, false)).toEqual({ net: 1_906_000, tax: 1_200, gross: 1_907_200 });
    await cancel(q.quoteId);
  });

  it('takes the tax out of a tax-inclusive fee of 6,003 levy by levy, 1,000, where 20 percent of the whole, or the fee untaxed, would differ', async () => {
    const q = await issued([crates('3.000')], { deliveryFeePesewas: 6_003, taxInclusive: true });
    const v = q.version;
    // allocate(6,003 over 1,000 : 150 : 25 : 25): net 5,003, VAT 750, NHIL 125, GETFund 125. Rounding the whole
    // 20 percent at once would give 1,000.5 -> 1,001; the fee untaxed (before 2.43.0) gives 0; taxed on top, 1,200.
    expect([v.netPesewas, v.taxPesewas, v.grossPesewas]).toEqual([23_003, 1_000, 24_003]);
    expect(await invoiceTotals([{ productId: id('eggs'), quantity: '3.000', uom: 'CRATE', unitPricePesewas: 6_000 }], 6_003n, true)).toEqual({ net: 23_003, tax: 1_000, gross: 24_003 });
    // The buyer's view and the stored version carry the same figures.
    const shown = await publicGet(`/shop/quotes/${q.token}`);
    expect([shown.body.netPesewas, shown.body.taxPesewas, shown.body.grossPesewas]).toEqual([23_003, 1_000, 24_003]);
    await cancel(q.quoteId);
  });
});

describe('item 4: a quote of animals converts with no tags, and the picker names them (the owner, 2026-11-23)', () => {
  it('converts 2 goats into two lines with no animal, holding the quote’s two, refuses a pick of no animal, of another’s or of one twice, and names the two picked at the hand-over', async () => {
    const q = await accepted([goats('2.000', 95_000)]);
    expect((await heldBy(q.quoteId)).tags).toEqual(['G-0142', 'G-0143']);
    const other = await issued([goats('1.000', 95_000)]);
    expect((await heldBy(other.quoteId)).tags).toEqual(['G-0144']);
    const order = await post('sales', `/quotes/${q.quoteId}/convert`, { fulfilmentMode: 'COLLECTION', paymentTerms: 'COD' });
    expect(order.status, JSON.stringify(order.body)).toBe(201);
    const orderId = order.body.id as string;
    const lineIds = (order.body.lines as { id: string; stockUnit: unknown }[]).map((l) => l.id);
    expect((order.body.lines as { stockUnit: unknown; qtyOrdered: string; priceSource: string }[]).map((l) => [l.stockUnit, l.qtyOrdered, l.priceSource])).toEqual([
      [null, '1.000', 'QUOTE'],
      [null, '1.000', 'QUOTE'],
    ]);
    expect(await heldBy(orderId)).toEqual({ qty: '2.000', tags: ['G-0142', 'G-0143'], expiring: 0 });
    expect((await post('sales', `/orders/${orderId}/confirm`)).status).toBe(200);
    expect((await heldBy(orderId)).qty).toBe('2.000');
    const list = await post('storekeeper', `/orders/${orderId}/fulfilments`, { pickLocationId: id('location:PENS') });
    expect(list.status, JSON.stringify(list.body)).toBe(201);
    const picks = (body: object[]) => post('storekeeper', `/fulfilments/${list.body.id as string}/picks`, { picks: body });
    const refusal = async (body: object[]) => {
      const r = await picks(body);
      return [r.status, (r.body.error?.details ?? []).map((d: { code: string }) => d.code)];
    };
    expect(await refusal([pick(lineIds[0]!, '1.000')])).toEqual([422, ['STOCK_UNIT_REQUIRED']]);
    expect(await refusal([pick(lineIds[0]!, '1.000', 'G-0144')])).toEqual([422, ['STOCK_SHORT']]);
    expect(await refusal([pick(lineIds[0]!, '1.000', 'G-0142'), pick(lineIds[1]!, '1.000', 'G-0142')])).toEqual([422, ['STOCK_SHORT', 'STOCK_SHORT']]);
    // G-0145 is free: the picker may name it in place of a held goat.
    const named = await picks([pick(lineIds[0]!, '1.000', 'G-0143'), pick(lineIds[1]!, '1.000', 'G-0145')]);
    expect(named.status, JSON.stringify(named.body)).toBe(200);
    expect((await post('storekeeper', `/fulfilments/${list.body.id as string}/pack`, { packageCount: 1 })).status).toBe(200);
    const handed = await post('manager', `/fulfilments/${list.body.id as string}/collect`, {});
    expect(handed.status, JSON.stringify(handed.body)).toBe(200);
    const lines = await admin().query<{ line_no: number; tag: string; status: string }>(
      'SELECT l.line_no, u.identifier AS tag, l.line_status AS status FROM ord.sales_order_line l JOIN inv.stock_unit u ON u.id = l.stock_unit_id WHERE l.sales_order_id = $1 ORDER BY l.line_no',
      [orderId],
    );
    expect(lines.rows.map((r) => [r.tag, r.status])).toEqual([
      ['G-0143', 'FULFILLED'],
      ['G-0145', 'FULFILLED'],
    ]);
    const issuedTags = await admin().query<{ tag: string }>("SELECT u.identifier AS tag FROM inv.stock_movement m JOIN inv.stock_unit u ON u.id = m.stock_unit_id WHERE m.movement_type = 'SALE_ISSUE' AND u.product_id = $1 ORDER BY u.identifier", [id('goat')]);
    expect(issuedTags.rows.map((r) => r.tag)).toEqual(['G-0143', 'G-0145']);
    // The order's promises end with the hand-over; G-0142, held but not picked, is free again.
    expect(await heldBy(orderId)).toEqual({ qty: '0.000', tags: [], expiring: 0 });
    // The database: a named animal is never changed, and a line of animals is named before it is fulfilled.
    const named0 = (await one('SELECT id FROM ord.sales_order_line WHERE sales_order_id = $1 AND line_no = 1', [orderId]))['id'] as string;
    await expect(admin().query('UPDATE ord.sales_order_line SET stock_unit_id = $2 WHERE id = $1', [named0, id('G-0142')])).rejects.toMatchObject({ code: 'HK004' });
    await cancel(other.quoteId);
  });

  it('refuses, by direct SQL, an unnamed line of animals that is fulfilled, or that is not a quote’s', async () => {
    const q = await accepted([goats('1.000', 95_000)]);
    const order = await post('sales', `/quotes/${q.quoteId}/convert`, { fulfilmentMode: 'COLLECTION', paymentTerms: 'COD' });
    expect(order.status, JSON.stringify(order.body)).toBe(201);
    const line = order.body.lines[0].id as string;
    await expect(admin().query("UPDATE ord.sales_order_line SET line_status = 'FULFILLED' WHERE id = $1", [line])).rejects.toMatchObject({ code: 'HK010' });
    await expect(admin().query("UPDATE ord.sales_order_line SET price_source = 'MANUAL_APPROVED' WHERE id = $1", [line])).rejects.toMatchObject({ code: 'HK010' });
    expect((await post('sales', `/orders/${order.body.id as string}/cancel`, { reasonCode: 'CUSTOMER_CANCELLED' })).status).toBe(200);
  });
});

describe('item 1: a quoted line posts its list price to sales and the difference to 4210, above or below list (the owner, 2026-11-23)', () => {
  it('posts a goat quoted at 75,000 against its recorded list of 65,000: sales 65,000, 4210 credited 10,000; the customer pays 75,000', async () => {
    const q = await accepted([goats('1.000', 75_000)]);
    expect([q.version.lines[0].resolvedUnitPricePesewas, q.version.lines[0].unitPricePesewas]).toEqual([65_000, 75_000]);
    const { order, documentId } = await collected(q.quoteId, 'PENS', (lines) => [pick(lines[0]!.id, '1.000', 'G-0142')]);
    expect(order.lines.map((l: Record<string, unknown>) => [l['resolvedUnitPricePesewas'], l['agreedUnitPricePesewas'], l['variancePesewas'], l['varianceDirection'], l['varianceReasonCode']])).toEqual([[65_000, 75_000, 10_000, 'ABOVE', 'QUOTED_PRICE']]);
    const doc = (await get('manager', `/billing-documents/${documentId}`)).body;
    expect([doc.netPesewas, doc.taxPesewas, doc.grossPesewas]).toEqual([75_000, 0, 75_000]);
    expect(await journalOf(documentId)).toEqual({ lines: ['1200:D:75000', '4000:C:65000', '4210:C:10000'], balanced: true });
  });

  it('posts 3 yams quoted at 1,800 against a list of 2,000: sales 6,000, 4210 debited 600; the customer pays 5,400', async () => {
    const q = await accepted([yams('3.000', 1_800)]);
    const { order, documentId } = await collected(q.quoteId, 'SHOP', (lines) => [pick(lines[0]!.id, '3.000')]);
    expect(order.lines.map((l: Record<string, unknown>) => [l['resolvedUnitPricePesewas'], l['agreedUnitPricePesewas'], l['variancePesewas'], l['varianceDirection']])).toEqual([[2_000, 1_800, 600, 'BELOW']]);
    const doc = (await get('manager', `/billing-documents/${documentId}`)).body;
    expect([doc.netPesewas, doc.taxPesewas, doc.grossPesewas]).toEqual([5_400, 0, 5_400]);
    expect(await journalOf(documentId)).toEqual({ lines: ['1200:D:5400', '4020:C:6000', '4210:D:600'], balanced: true });
  });

  it('posts 2 crates quoted at list, 6,000 each, with no 4210 line and no variance', async () => {
    const q = await accepted([crates('2.000')]);
    const { order, documentId } = await collected(q.quoteId, 'SHOP', (lines) => [pick(lines[0]!.id, '2.000', 'lot:EGG-0003')]);
    expect(order.lines.map((l: Record<string, unknown>) => [l['resolvedUnitPricePesewas'], l['agreedUnitPricePesewas'], l['variancePesewas'], l['varianceDirection'], l['varianceReasonCode']])).toEqual([[6_000, 6_000, 0, null, null]]);
    expect(await journalOf(documentId)).toEqual({ lines: ['1200:D:12000', '4020:C:12000'], balanced: true });
  });

  it('keeps QUOTED_PRICE out of every seller’s hands: its own domain, not a price override reason', async () => {
    const reasons = await get('manager', '/reason-codes?domain=PRICE_OVERRIDE&limit=100');
    expect(reasons.status).toBe(200);
    expect(reasons.body.data.map((r: { code: string }) => r.code)).not.toContain('QUOTED_PRICE');
    expect((await get('manager', '/reason-codes?domain=QUOTED_PRICE')).body.data.map((r: { code: string; requiresNote: boolean }) => [r.code, r.requiresNote])).toEqual([['QUOTED_PRICE', false]]);
  });
});

describe('A-328 (c): the buyer sees how much of their own quantity is available now, never the farm’s stock (the owner, 2026-11-23)', () => {
  it('shows 2 crates as 60 eggs with 800 there, the goats held and free for a quote short of goats, and nothing once the quote has expired', async () => {
    const eggs = await issued([crates('2.000')]);
    const shown = await publicGet(`/shop/quotes/${eggs.token}`);
    expect([shown.status, shown.body.lines[0].availableNowQuantity, shown.body.lines[0].availableNowUom]).toEqual([200, '60.000', 'EGG']);
    const there = Number(eggs.version.lines[0].availableQuantity);
    expect(there).toBeGreaterThan(60);
    expect(JSON.stringify(shown.body)).not.toContain(`"${there.toFixed(3)}"`);
    // One goat is left (G-0144); asked for five, the buyer sees the one held for them, and their quote is subject to stock.
    const short = await issued([goats('5.000', 95_000)], { validUntil: new Date(clock.now().getTime() + 60_000).toISOString() });
    const goatsShown = await publicGet(`/shop/quotes/${short.token}`);
    expect([goatsShown.body.subjectToStock, goatsShown.body.lines[0].availableNowQuantity, goatsShown.body.lines[0].availableNowUom]).toEqual([true, '1.000', 'HEAD']);
    // Staff see what was there and held at issue, as before.
    expect([short.version.lines[0].availableQuantity, short.version.lines[0].heldQuantity]).toEqual(['1.000', '1.000']);
    clock.advanceBy(120_000);
    await runAsSystem({ principalId: SYSTEM_PRINCIPAL, displayName: 'Scheduler' }, randomUUID(), () => api.app.get(QuoteExpiry).run({ kind: 'SYSTEM', principalId: SYSTEM_PRINCIPAL }));
    expect((await heldBy(short.quoteId)).qty).toBe('0.000');
    await cancel(eggs.quoteId);
  });
});

describe('A-329 (b): a withdrawn quote is its own outcome, with its reason, outside the win and loss rate (the owner, 2026-11-23)', () => {
  it("gives Esi Appiah's 1 accepted and 1 declined 50.00 with and without her withdrawn quote, lists it as withdrawn, and publishes its reason", async () => {
    const day = toBusinessDate(clock.now());
    const path = `/quotes/pipeline?from=${day}&to=${day}&groupBy=SALESPERSON`;
    const won = await issued([crates('1.000')], {}, 'sales2');
    expect((await post('sales2', `/quotes/${won.quoteId}/record-acceptance`, { method: 'PHONE_CONFIRMED', acceptedName: 'Akua Mensah', note: 'By phone (TEST)' })).status).toBe(200);
    const lost = await issued([crates('1.000')], {}, 'sales2');
    expect((await post('sales2', `/quotes/${lost.quoteId}/decline`, { reason: 'Price too high (TEST)' })).status).toBe(200);
    const esi = async () => (await get('manager', path)).body.data.find((r: { group: { label: string } }) => r.group.label === 'Esi Appiah');
    const without = await esi();
    const withdrawnQuote = await issued([crates('4.000')], {}, 'sales2');
    const refused = await post('sales2', `/quotes/${withdrawnQuote.quoteId}/cancel`, {});
    expect(refused.status).toBe(400);
    expect((await post('sales2', `/quotes/${withdrawnQuote.quoteId}/cancel`, { reason: 'Buyer bought elsewhere before we confirmed (TEST)' })).status).toBe(200);
    const withIt = await esi();
    expect([without.winRatePercent, withIt.winRatePercent, without.withdrawn, withIt.withdrawn, withIt.withdrawnValuePesewas]).toEqual(['50.00', '50.00', without.withdrawn, without.withdrawn + 1, without.withdrawnValuePesewas + 24_000]);
    expect([withIt.issued, withIt.accepted, withIt.declined]).toEqual([without.issued, without.accepted, without.declined]);
    const event = (await one("SELECT payload FROM platform.outbox_message WHERE event_type = 'quo.QuoteWithdrawn' AND subject_id = $1", [withdrawnQuote.quoteId]))['payload'] as Record<string, unknown>;
    expect(event).toMatchObject({ reason: 'Buyer bought elsewhere before we confirmed (TEST)', withdrawnBy: users.get('sales2')!.principalId, fromStatus: 'ISSUED', wasIssued: true, grossPesewas: 24_000, heldReleasedQty: '120.000', abuseCase: 65 });
    expect((await get('manager', `/quotes/${withdrawnQuote.quoteId}`)).body).toMatchObject({ status: 'CANCELLED', cancelReason: 'Buyer bought elsewhere before we confirmed (TEST)' });
  });
});
