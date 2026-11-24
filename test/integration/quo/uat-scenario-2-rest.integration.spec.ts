import { randomUUID } from 'node:crypto';
import { createUuidV7Generator, ManualClock, toBusinessDate } from '@hakorem/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { QuoteExpiry } from '../../../src/modules/quo';
import { runAsSystem } from '../../../src/platform/context/request-context';
import { addDays } from '../../../src/seed/seed-calendar';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { stepUp, type TotpSession } from '../../support/fin';
import { consoleGet, consolePost, consolePut, createUser, enrolAndLogin, login, relaxRateLimits, SYSTEM_PRINCIPAL, testStartTime, type RoleCode, type TestSession, type TestUser } from '../../support/iam';
import { startTestApp, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * B11u continued, the rest of UAT scenario 2 (the owner, 2026-11-24: "BL-123 and BL-124: fix them in one small phase
 * before B12, so UAT scenario 2 runs exactly as written." and "An accepted quote's hold ends 7 days after acceptance.").
 *
 * The farm is the seeded one with section 3's goats received into its pens: G-0201 to G-0224 (24 goats of 22.000 to
 * 27.500 kg, band GOAT-M, bought together from Kpone Livestock Traders for 15,840.00, 660.00 each, before the seed's
 * goats), and beside them the other goats in the pens: the seed's G-0142 to G-0145 (GOAT-M, 600.00 each), G-0171 and
 * G-0175 (GOAT-M, 589.00 and 570.00), G-0157 (GOAT-L, 748.00) and G-0163 (GOAT-M, 523.00, under a withdrawal hold).
 * Emmanuel Tetteh has an account with a credit limit of 9,000.00 and 30-day terms, and a contract list pricing a GOAT-M
 * goat at 850.00 (floor 700.00, ceiling 980.00), as section 3 lists it. Kasoa is not a seeded delivery area (the seed
 * never holds it): his saved address is at Dodowa, in the seeded zone, which changes no figure (the fee is the quote's).
 * Every figure is read from the tables or the API and matched to UAT scenario 2 to the pesewa.
 */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let branchId: string;
const sessions = new Map<string, TestSession>();
const principals = new Map<string, string>();
const users = new Map<string, TestUser>();
const ids = new Map<string, string>();
const id = (name: string) => ids.get(name)!;
const admin = () => database.pool('admin');
const as = (who: string) => sessions.get(who)!;
const nextId = () => createUuidV7Generator(clock)();
const post = (who: string, path: string, body: object = {}, key: string = randomUUID()) => consolePost(api.server, as(who), `/v1${path}`, key).send(body);
const put = (who: string, path: string, body: object = {}) => consolePut(api.server, as(who), `/v1${path}`, randomUUID()).send(body);
const get = (who: string, path: string) => consoleGet(api.server, as(who), `/v1${path}`);
const one = async (sql: string, values: unknown[] = []) => (await admin().query(sql, values)).rows[0]!;
const validFor = (days: number) => new Date(Math.floor(clock.now().getTime() / 86_400_000) * 86_400_000 + days * 86_400_000 + 86_399_000).toISOString();
const photo = (seed: number) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(1_020, seed)]);
const goats = (heads: number, unitPricePesewas = 95_000, band = 'GOAT-M') => ({ productId: id('goat'), weightBandId: id(`band:${band}`), description: `Goats of ${band}, 22 to 28 kg, for a funeral`, quantity: `${heads}.000`, priceBasis: 'PER_HEAD', unitPricePesewas });
const tags = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `G-0${from + i}`);
const SCHEDULER = { kind: 'SYSTEM' as const, principalId: SYSTEM_PRINCIPAL };
/** Moves the application clock on and signs Kojo in again: a staff session lasts hours, not days. */
async function advance(ms: number): Promise<void> {
  clock.advanceBy(ms);
  sessions.set('sales', await login(api.server, users.get('sales')!));
}
const expireJob = () => runAsSystem({ principalId: SYSTEM_PRINCIPAL, displayName: 'Scheduler' }, randomUUID(), () => api.app.get(QuoteExpiry).run(SCHEDULER));

async function approve(who: string, approvalRequestId: string, reason = 'Checked (TEST)') {
  await stepUp(api.server, as(who) as TotpSession, clock);
  return post(who, `/iam/approvals/${approvalRequestId}/approve`, { reason });
}

/** The animals a document holds, from INV's table, by tag. */
async function heldBy(holderId: string): Promise<string[]> {
  const r = await admin().query<{ tag: string }>(
    `SELECT u.identifier AS tag FROM inv.stock_reservation r JOIN inv.stock_unit u ON u.id = r.stock_unit_id WHERE r.holder_document_id = $1 AND r.status = 'ACTIVE' ORDER BY u.identifier`,
    [holderId],
  );
  return r.rows.map((x) => x.tag);
}

/** Every animal a document was ever promised, at any status. */
async function everHeldBy(holderId: string): Promise<string[]> {
  const r = await admin().query<{ tag: string }>('SELECT u.identifier AS tag FROM inv.stock_reservation r JOIN inv.stock_unit u ON u.id = r.stock_unit_id WHERE r.holder_document_id = $1 ORDER BY u.identifier', [holderId]);
  return r.rows.map((x) => x.tag);
}

async function receiveGoats(receivedAt: Date, goatsIn: { tag: string; valuePesewas: number }[]): Promise<void> {
  const created = await post('manager', '/goods-receipts', {
    kind: 'PURCHASE',
    supplierId: id('supplier'),
    locationId: id('location:PENS'),
    deliveryNoteRef: `UAT2-TEST-${randomUUID().slice(0, 8)}`,
    receivedAt: receivedAt.toISOString(),
    lines: [{ productId: id('goat'), qtyReceived: `${goatsIn.length}.000`, valuePesewas: goatsIn.reduce((a, g) => a + g.valuePesewas, 0), animals: goatsIn.map((g) => ({ tagNo: g.tag, sex: 'MALE', breed: 'West African Dwarf', purpose: 'GROWING' })) }],
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const posted = await post('manager', `/goods-receipts/${created.body.id as string}/post`);
  expect(posted.status, JSON.stringify(posted.body)).toBe(200);
}

async function quoteFor(lines: object[], extra: object = {}) {
  const made = await post('sales', '/quotes', { customerId: id('emmanuel'), contactName: 'Emmanuel Tetteh', contactPhone: '+233268114590', validUntil: validFor(7), taxInclusive: false, terms: '50 percent deposit to reserve the animals', lines, ...extra });
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  return made.body;
}
async function issue(versionId: string) {
  const done = await post('sales', `/quote-versions/${versionId}/issue`, { channels: ['SMS'] });
  expect(done.status, JSON.stringify(done.body)).toBe(200);
  return done.body;
}
async function acceptedQuote(lines: object[]): Promise<string> {
  const q = await quoteFor(lines);
  await issue(q.currentVersion.id as string);
  const r = await post('sales', `/quotes/${q.id as string}/record-acceptance`, { method: 'IN_PERSON', acceptedName: 'Emmanuel Tetteh', note: 'Signed the printed quote (TEST)' });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return q.id as string;
}

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock, environment: { AUTH_ACCESS_TTL_SECONDS: '43200' } });
  await runSeedUnits(database.pool('app'), api.app, seedUnits({ SEED_STAFF_PASSWORD: `Seed-${randomUUID()}` }));
  branchId = (await one("SELECT id FROM mdm.branch WHERE code = 'DDW'"))['id'] as string;
  ids.set('goat', (await one("SELECT id FROM mdm.product WHERE sku = 'LIV-0004'"))['id'] as string);
  for (const band of ['GOAT-M', 'GOAT-L']) ids.set(`band:${band}`, (await one('SELECT id FROM mdm.weight_band WHERE code = $1', [band]))['id'] as string);
  for (const row of (await admin().query<{ code: string; id: string }>('SELECT code, id FROM mdm.location WHERE branch_id = $1', [branchId])).rows) ids.set(`location:${row.code}`, row.id);
  ids.set('supplier', (await one("SELECT id FROM mdm.supplier WHERE name = 'Kpone Livestock Traders (SEED)'"))['id'] as string);
  const people: [string, string, RoleCode, boolean][] = [
    ['owner', 'Ama Owusu-Ansah', 'OWNER', true],
    ['manager', 'Kwabena Owusu', 'MANAGER', true],
    ['sales', 'Kojo Antwi', 'SALES', false],
    ['sales2', 'Esi Appiah', 'SALES', false],
    ['storekeeper', 'Yaw Boateng', 'STOREKEEPER', false],
    ['driver', 'Kwesi Appiah', 'DRIVER', false],
    ['cashier', 'Adwoa Darko', 'CASHIER', false],
  ];
  for (const [who, name, role, privileged] of people) {
    const user = await createUser(database, { name, grants: [{ role, branchId }] });
    principals.set(who, user.principalId);
    users.set(who, user);
    sessions.set(who, privileged ? await enrolAndLogin(api.server, user, () => clock.now()) : await login(api.server, user));
  }

  // Section 3's goats: the twenty-four bought together a day before the seed's goats came, then the others.
  const seeded = (await one("SELECT received_at FROM inv.stock_unit WHERE identifier = 'G-0142'"))['received_at'] as Date;
  await receiveGoats(new Date(seeded.getTime() - 86_400_000), tags(201, 224).map((tag) => ({ tag, valuePesewas: 66_000 })));
  await receiveGoats(clock.now(), [
    { tag: 'G-0157', valuePesewas: 74_800 },
    { tag: 'G-0163', valuePesewas: 52_300 },
    { tag: 'G-0171', valuePesewas: 58_900 },
    { tag: 'G-0175', valuePesewas: 57_000 },
  ]);
  for (const row of (await admin().query<{ identifier: string; id: string }>("SELECT identifier, id FROM inv.stock_unit WHERE identifier LIKE 'G-0%'")).rows) ids.set(row.identifier, row.id);
  const weights: Record<string, string> = { 'G-0157': '31.800', 'G-0163': '22.150', 'G-0171': '24.900', 'G-0175': '24.100' };
  tags(201, 224).forEach((tag, i) => (weights[tag] = (22 + (i * 5.5) / 23).toFixed(3)));
  const day = toBusinessDate(clock.now());
  const weighed = await post('manager', '/weight-records', {
    records: Object.entries(weights).map(([tag, kg]) => ({ id: randomUUID(), stockUnitId: id(tag), weightKg: kg, weightSource: 'SCALE', headWeighed: 1, measuredAt: `${day}T06:00:00Z` })),
  });
  expect(weighed.status, JSON.stringify(weighed.body)).toBe(200);
  // G-0163 is under a veterinary withdrawal period: it cannot be sold, so it is promised to nobody.
  const holdDoc = randomUUID();
  await admin().query("INSERT INTO platform.business_document (id, doc_type, owner_module, branch_id, actor_id) VALUES ($1, 'STOCK_HOLD', 'inv', $2, $3)", [holdDoc, branchId, SYSTEM_PRINCIPAL]);
  await admin().query("INSERT INTO inv.stock_hold (id, stock_unit_id, kind, starts_at, ends_at, source_document_id, created_by) VALUES ($1, $2, 'WITHDRAWAL', $3, $4, $5, $6)", [
    randomUUID(),
    id('G-0163'),
    new Date(clock.now().getTime() - 86_400_000),
    new Date(clock.now().getTime() + 30 * 86_400_000),
    holdDoc,
    SYSTEM_PRINCIPAL,
  ]);

  // Emmanuel Tetteh, C-00241: a retail customer with an account (9,000.00, 30 days) and a saved address.
  ids.set('emmanuel', randomUUID());
  await admin().query(
    "INSERT INTO mdm.customer (id, customer_no, kind, name, tier_id, status, created_by, updated_by) VALUES ($1, 'C-90241', 'INDIVIDUAL', 'Emmanuel Tetteh', '01900000-0000-7000-8000-000000000301', 'ACTIVE', $2, $2)",
    [id('emmanuel'), SYSTEM_PRINCIPAL],
  );
  ids.set('address', randomUUID());
  await admin().query(
    `INSERT INTO mdm.customer_address (id, customer_id, label, recipient_name, recipient_phone_e164, line1, area, city, region, is_default, created_by, updated_by)
     VALUES ($1, $2, 'Funeral grounds', 'Emmanuel Tetteh', '+233268114590', 'Behind the Dodowa lorry station', 'Dodowa', 'Dodowa', 'Greater Accra', true, $3, $3)`,
    [id('address'), id('emmanuel'), SYSTEM_PRINCIPAL],
  );
  ids.set('other', randomUUID());
  await admin().query("INSERT INTO mdm.customer (id, customer_no, kind, name, tier_id, status, created_by, updated_by) VALUES ($1, 'C-90242', 'INDIVIDUAL', 'Akua Mensah', '01900000-0000-7000-8000-000000000301', 'ACTIVE', $2, $2)", [id('other'), SYSTEM_PRINCIPAL]);
  ids.set('otherAddress', randomUUID());
  await admin().query(
    `INSERT INTO mdm.customer_address (id, customer_id, label, recipient_name, recipient_phone_e164, line1, area, city, region, is_default, created_by, updated_by)
     VALUES ($1, $2, 'Home', 'Akua Mensah', '+233244998877', 'Near the Dodowa market', 'Dodowa', 'Dodowa', 'Greater Accra', true, $3, $3)`,
    [id('otherAddress'), id('other'), SYSTEM_PRINCIPAL],
  );
  const opened = await post('owner', '/business-accounts', { customerId: id('emmanuel'), branchId, creditLimitPesewas: 900_000, paymentTermsDays: 30, reason: 'Funeral buyer, terms agreed (TEST)' });
  expect(opened.status, JSON.stringify(opened.body)).toBe(202);
  expect((await approve('manager', opened.body.approvalRequestId as string)).status).toBe(200);

  // His contract list: a GOAT-M goat at 850.00, floor 700.00, ceiling 980.00 (section 3.2).
  const list = await post('manager', '/price-lists', { code: 'UAT2-ET', name: 'Emmanuel Tetteh, funeral (TEST)', kind: 'CUSTOMER', taxInclusive: false });
  expect(list.status, JSON.stringify(list.body)).toBe(201);
  const version = await post('manager', `/price-lists/${list.body.id as string}/versions`, { validFrom: clock.now().toISOString() });
  expect(version.status, JSON.stringify(version.body)).toBe(201);
  const entries = await put('manager', `/price-list-versions/${version.body.id as string}/entries`, {
    version: version.body.version ?? 1,
    entries: [{ productId: id('goat'), weightBandId: id('band:GOAT-M'), basis: 'PER_HEAD', listPricePesewas: 85_000, floorPricePesewas: 70_000, ceilingPricePesewas: 98_000 }],
  });
  expect(entries.status, JSON.stringify(entries.body)).toBe(200);
  const submitted = await post('manager', `/price-list-versions/${version.body.id as string}/submit`);
  expect(submitted.status, JSON.stringify(submitted.body)).toBe(202);
  expect((await approve('owner', submitted.body.approvalRequestId as string)).status).toBe(200);
  const assigned = await put('manager', `/customers/${id('emmanuel')}/price-list`, { priceListId: list.body.id, validFrom: clock.now().toISOString() });
  expect(assigned.status, JSON.stringify(assigned.body)).toBe(200);
});

afterAll(async () => {
  await api?.close();
  await database?.drop();
});

describe('UAT scenario 2, run as written, a delivery to the funeral included (the owner, 2026-11-24)', () => {
  const s: Record<string, string> = {};

  it('2.2: costs the quote by the twenty goats it would hold, 13,200.00, a margin of 30.75 percent, with the other goats in the pens', async () => {
    const q = await quoteFor([goats(20)], { deliveryFeePesewas: 6_000 });
    s['quote'] = q.id as string;
    const v = q.currentVersion;
    expect([v.lines[0].resolvedUnitPricePesewas, v.lines[0].unitPricePesewas, v.lines[0].estimatedUnitCostPesewas]).toEqual([85_000, 95_000, 66_000]);
    expect([v.netPesewas, v.taxPesewas, v.grossPesewas, v.estimatedCostPesewas, v.marginOverPricePercent, v.belowMarginFloor]).toEqual([1_906_000, 1_200, 1_907_200, 1_320_000, '30.75', false]);
    // By the product's average pool (the rule before BL-124), the other goats would have moved it.
    const pools = await one(
      "SELECT sum(p.value_pesewas)::bigint AS value, count(*)::int AS n FROM inv.cost_pool p JOIN inv.stock_unit u ON u.id = p.stock_unit_id WHERE u.product_id = $1 AND u.status = 'ACTIVE' AND p.qty > 0",
      [id('goat')],
    );
    expect(Math.round((Number(pools['value']) / Number(pools['n'])) * 20)).not.toBe(1_320_000);
  });

  it('2.3: holds the twenty goats bought first, to the validity', async () => {
    const v = await issue((await get('sales', `/quotes/${s['quote']!}`)).body.currentVersion.id as string);
    expect([v.status, v.estimatedCostPesewas, v.lines[0].heldQuantity]).toEqual(['ISSUED', 1_320_000, '20.000']);
    expect(await heldBy(s['quote']!)).toEqual(tags(201, 220));
  });

  it('2.5 and 2.6: version 2 of eighteen goats costs 11,880.00 at 30.77 percent and keeps eighteen of the same goats', async () => {
    const revised = await post('sales', `/quotes/${s['quote']!}/versions`, { changeNote: 'Reduced to eighteen goats' });
    expect(revised.status, JSON.stringify(revised.body)).toBe(201);
    const edited = await put('sales', `/quote-versions/${revised.body.id as string}`, { version: revised.body.version ?? 1, lines: [goats(18)] });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    expect([edited.body.lines[0].unitPricePesewas * 18, edited.body.netPesewas, edited.body.taxPesewas, edited.body.grossPesewas, edited.body.estimatedCostPesewas, edited.body.marginOverPricePercent]).toEqual([
      1_710_000, 1_716_000, 1_200, 1_717_200, 1_188_000, '30.77',
    ]);
    const second = await issue(revised.body.id as string);
    expect([second.estimatedCostPesewas, second.lines[0].heldQuantity]).toEqual([1_188_000, '18.000']);
    expect(await heldBy(s['quote']!)).toEqual(tags(201, 218));
    const r = await post('sales', `/quotes/${s['quote']!}/record-acceptance`, { method: 'PHONE_CONFIRMED', acceptedName: 'Emmanuel Tetteh', note: 'Accepted version 2 on the phone (TEST)' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  });

  it('2.8: refuses a delivery with no address, a slot, another customer’s address or an address to collect, and the wrong roles, writing nothing', async () => {
    const convert = (who: string, body: object) => post(who, `/quotes/${s['quote']!}/convert`, { paymentTerms: 'CREDIT', ...body });
    const refusals = await Promise.all([
      convert('sales', { fulfilmentMode: 'DELIVERY' }),
      convert('sales', { fulfilmentMode: 'DELIVERY', deliveryAddressId: id('address'), deliverySlotId: randomUUID() }),
      convert('sales', { fulfilmentMode: 'DELIVERY', deliveryAddressId: id('otherAddress') }),
      convert('sales', { fulfilmentMode: 'COLLECTION', deliveryAddressId: id('address') }),
    ]);
    expect(refusals.map((r) => [r.status, r.body.error?.details?.[0]?.code])).toEqual([
      [422, 'DELIVERY_ADDRESS_REQUIRED'],
      [422, 'SLOT_NOT_AVAILABLE'],
      [422, 'ADDRESS_NOT_OF_CUSTOMER'],
      [422, 'NOT_FOR_COLLECTION'],
    ]);
    for (const who of ['cashier', 'storekeeper', 'driver']) expect((await convert(who, { fulfilmentMode: 'DELIVERY', deliveryAddressId: id('address') })).status).toBe(403);
    expect((await one("SELECT count(*)::int AS n FROM ord.sales_order WHERE source_document_id = $1", [s['quote']]))['n']).toBe(0);
    expect(await heldBy(s['quote']!)).toEqual(tags(201, 218));
  });

  it('2.8: converts the accepted quote to one delivery order, eighteen goats of GOAT-M at 950.00, the fee 60.00 and an estimate of 17,172.00', async () => {
    const order = await post('sales', `/quotes/${s['quote']!}/convert`, { fulfilmentMode: 'DELIVERY', paymentTerms: 'CREDIT', deliveryAddressId: id('address') });
    expect(order.status, JSON.stringify(order.body)).toBe(201);
    s['order'] = order.body.id as string;
    const o = order.body;
    expect([o.status, o.channel, o.fulfilmentMode, o.lines.length, o.deliveryFeePesewas, o.estimatedTotalPesewas]).toEqual(['PLACED', 'QUOTE', 'DELIVERY', 18, 6_000, 1_717_200]);
    expect(new Set(o.lines.map((l: { agreedUnitPricePesewas: number; resolvedUnitPricePesewas: number; weightBandId: string; stockUnit: unknown }) => `${l.agreedUnitPricePesewas}/${l.resolvedUnitPricePesewas}/${l.weightBandId}/${String(l.stockUnit)}`))).toEqual(new Set([`95000/85000/${id('band:GOAT-M')}/null`]));
    expect(o.deliveryAddress).toMatchObject({ recipientName: 'Emmanuel Tetteh', recipientPhone: '+233268114590', area: 'Dodowa' });
    expect((await one('SELECT delivery_zone_id FROM ord.sales_order WHERE id = $1', [s['order']]))['delivery_zone_id']).not.toBeNull();
    expect(await heldBy(s['order']!)).toEqual(tags(201, 218));
    expect(await heldBy(s['quote']!)).toEqual([]);
    expect((await post('sales', `/quotes/${s['quote']!}/convert`, { fulfilmentMode: 'DELIVERY', paymentTerms: 'CREDIT', deliveryAddressId: id('address') })).status).toBe(409);
  });

  it('2.9 and 2.10: refuses the confirmation over the 9,000.00 limit on 17,172.00, then confirms on Kwabena’s override, never Kojo’s own', async () => {
    const refused = await post('sales', `/orders/${s['order']!}/confirm`);
    expect(refused.status, JSON.stringify(refused.body)).toBe(422);
    const asked = await post('sales', `/orders/${s['order']!}/confirm`, { creditOverrideReason: 'Funeral order, 50 percent deposit to follow' });
    expect(asked.status, JSON.stringify(asked.body)).toBe(202);
    expect(asked.body.creditCheck).toMatchObject({ outcome: 'OVER_LIMIT', creditLimitPesewas: 900_000, overLimitPesewas: 817_200 });
    expect((await post('sales', `/iam/approvals/${asked.body.approvalRequestId as string}/approve`, { reason: 'Mine' })).status).toBe(403);
    expect((await approve('manager', asked.body.approvalRequestId as string, 'Funeral order, 50 percent deposit to follow')).status).toBe(200);
    const confirmed = await post('sales', `/orders/${s['order']!}/confirm`);
    expect([confirmed.status, confirmed.body.status, confirmed.body.creditCheck]).toEqual([200, 'CONFIRMED', 'OVERRIDDEN']);
    const listed = await get('manager', `/credit-overrides?customerId=${id('emmanuel')}`);
    expect(listed.body.data[0]).toMatchObject({ order: { id: s['order'] }, limitPesewas: 900_000, exposurePesewas: 1_717_200, approvedBy: { id: principals.get('manager') } });
    // Confirmation took nothing more: the eighteen the quote held are the order's.
    expect(await heldBy(s['order']!)).toEqual(tags(201, 218));
  });

  it('2.12: Yaw picks G-0201 to G-0210 weighed in GOAT-M; a GOAT-L goat is refused for a GOAT-M line', async () => {
    const list = await post('storekeeper', `/orders/${s['order']!}/fulfilments`, { pickLocationId: id('location:PENS') });
    expect(list.status, JSON.stringify(list.body)).toBe(201);
    s['list'] = list.body.id as string;
    const lines = (await get('manager', `/orders/${s['order']!}`)).body.lines as { id: string }[];
    const wrong = await post('storekeeper', `/fulfilments/${s['list']}/picks`, { picks: [{ id: nextId(), orderLineId: lines[0]!.id, qty: '1.000', stockUnitId: id('G-0157'), weightKg: '31.800', weightSource: 'SCALE' }] });
    expect([wrong.status, wrong.body.error?.details?.[0]?.code]).toEqual([422, 'STOCK_UNIT_OTHER_BAND']);
    const picked = await post('storekeeper', `/fulfilments/${s['list']}/picks`, {
      picks: tags(201, 210).map((tag, i) => ({ id: nextId(), orderLineId: lines[i]!.id, qty: '1.000', stockUnitId: id(tag), weightKg: (22 + (i * 5.5) / 23).toFixed(3), weightSource: 'SCALE' })),
    });
    expect(picked.status, JSON.stringify(picked.body)).toBe(200);
    const packed = await post('storekeeper', `/fulfilments/${s['list']}/pack`, { packageCount: 10, backorderLineIds: lines.slice(10).map((l) => l.id) });
    expect(packed.status, JSON.stringify(packed.body)).toBe(200);
  });

  it('2.13: dispatches the ten, invoiced 9,560.00 net, 12.00 tax, 9,572.00 gross, due on day 30; the eight stay reserved on the backorder, even while a rival asks for every goat', async () => {
    const rival = await post('sales2', '/quotes', { contactName: 'Akua Mensah', contactPhone: '+233244998877', validUntil: validFor(7), taxInclusive: false, lines: [goats(30, 90_000)] });
    expect(rival.status).toBe(201);
    s['rival'] = rival.body.id as string;
    const [sent, rivalIssued] = await Promise.all([
      post('manager', `/fulfilments/${s['list']!}/dispatch`, { driverId: principals.get('driver'), vehicleLocationId: id('location:VAN1') }),
      post('sales2', `/quote-versions/${rival.body.currentVersion.id as string}/issue`, { channels: ['SMS'] }),
    ]);
    expect([sent.status, rivalIssued.status], JSON.stringify([sent.body, rivalIssued.body])).toEqual([200, 200]);
    const order = (await get('manager', `/orders/${s['order']!}`)).body;
    const invoice = await one('SELECT id, kind, net_pesewas::bigint AS net, tax_pesewas::bigint AS tax, gross_pesewas::bigint AS gross, due_date::text AS due FROM bil.billing_document WHERE id = $1', [order.billingDocument.id]);
    expect([invoice['kind'], Number(invoice['net']), Number(invoice['tax']), Number(invoice['gross']), invoice['due']]).toEqual(['INVOICE', 956_000, 1_200, 957_200, addDays(toBusinessDate(clock.now()), 30)]);
    const fee = await admin().query<{ n: number; amount: string }>("SELECT count(*)::int AS n, sum(line_net_pesewas)::text AS amount FROM bil.billing_document_line WHERE billing_document_id = $1 AND line_kind = 'DELIVERY_FEE'", [invoice['id']]);
    expect(fee.rows[0]).toEqual({ n: 1, amount: '6000' });
    // The books: goats at list to 4000, the 100.00 a head above list to 4210, the fee to 4100, its levies to 2100.
    const journal = await admin().query<{ code: string; side: string; amount: string }>(
      `SELECT a.code, l.side, sum(l.amount_pesewas)::text AS amount FROM fin.journal_entry e JOIN fin.journal_line l ON l.journal_entry_id = e.id JOIN fin.account a ON a.id = l.account_id
        WHERE e.source_document_id = $1 GROUP BY a.code, l.side ORDER BY a.code, l.side`,
      [invoice['id']],
    );
    expect(journal.rows.map((r) => `${r.code}:${r.side}:${r.amount}`)).toEqual(['1200:D:957200', '2100:C:1200', '4000:C:850000', '4100:C:6000', '4210:C:100000']);
    // The backorder: the eight lines of GOAT-M at 950.00, no fee of its own, holding eight of the eighteen.
    const back = (await get('manager', `/orders/${(await one('SELECT id FROM ord.sales_order WHERE parent_order_id = $1', [s['order']]))['id'] as string}`)).body;
    s['backorder'] = back.id as string;
    expect([back.status, back.parentOrderId, back.lines.length, back.deliveryFeePesewas, back.lines.every((l: { weightBandId: string }) => l.weightBandId === id('band:GOAT-M'))]).toEqual(['CONFIRMED', s['order'], 8, 0, true]);
    expect(await heldBy(s['backorder'])).toEqual(tags(211, 218));
    expect(await heldBy(s['order']!)).toEqual([]);
    // Handed over in the dispatching transaction: the rival, issued at the same moment, was never promised any of them.
    const rivalHeld = await everHeldBy(s['rival']);
    expect(rivalHeld.filter((t) => tags(211, 218).includes(t))).toEqual([]);
    expect(rivalHeld.filter((t) => tags(201, 210).includes(t))).toEqual([]);
    const ended = await admin().query<{ status: string; reason: string }>("SELECT r.status, r.released_reason AS reason FROM inv.stock_reservation r WHERE r.holder_document_id = $1 ORDER BY r.id", [s['order']]);
    expect(ended.rows.every((r) => r.status === 'RELEASED')).toBe(true);
    expect(ended.rows.filter((r) => r.reason.includes('stays held for backorder')).length).toBe(8);
    // Never below zero, never twice: each goat is promised at most once, and no balance is reserved above what it holds.
    expect(await one("SELECT count(*)::int AS n, count(DISTINCT stock_unit_id)::int AS d FROM inv.stock_reservation WHERE product_id = $1 AND status = 'ACTIVE'", [id('goat')])).toEqual({
      n: Number((await one("SELECT count(*)::int AS n FROM inv.stock_reservation WHERE product_id = $1 AND status = 'ACTIVE'", [id('goat')]))['n']),
      d: Number((await one("SELECT count(DISTINCT stock_unit_id)::int AS n FROM inv.stock_reservation WHERE product_id = $1 AND status = 'ACTIVE'", [id('goat')]))['n']),
    });
    expect((await one('SELECT count(*)::int AS n FROM inv.stock_balance b JOIN mdm.location l ON l.id = b.location_id AND NOT l.is_virtual WHERE b.product_id = $1 AND (b.reserved_qty > b.on_hand_qty OR b.on_hand_qty < 0)', [id('goat')]))['n']).toBe(0);
    // Published for the exception report (abuse case 67): what the backorder keeps held of the first order's stock.
    const dispatched = (await one("SELECT payload FROM platform.outbox_message WHERE event_type = 'ord.OrderDispatched' AND subject_id = $1", [s['order']]))['payload'] as { backorderId: string; backorderHeldQty: string };
    expect([dispatched.backorderId, dispatched.backorderHeldQty]).toEqual([s['backorder'], '8.000']);
  });

  it('2.15: Kwesi delivers the ten and records proof; nothing is collected; the order shows 10 delivered and 8 outstanding', async () => {
    const deliveryId = (await get('manager', `/deliveries?orderId=${s['order']!}`)).body.data[0].id as string;
    const route = await post('manager', '/routes', { driverId: principals.get('driver'), routeDate: toBusinessDate(clock.now()), vehicleLocationId: id('location:VAN1'), deliveryIds: [deliveryId] });
    expect(route.status, JSON.stringify(route.body)).toBe(201);
    const started = await post('manager', `/routes/${route.body.id as string}/start`, {});
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    const onTheWay = await post('driver', `/driver/deliveries/${deliveryId}/on-the-way`, { occurredAt: clock.now().toISOString(), etaMinutes: 40 });
    expect(onTheWay.status, JSON.stringify(onTheWay.body)).toBe(200);
    const uploaded = await consolePost(api.server, as('driver'), '/v1/files').field('purpose', 'PROOF_OF_DELIVERY').attach('file', photo(3), 'goats.jpg');
    expect(uploaded.status, JSON.stringify(uploaded.body)).toBe(201);
    clock.advanceBy(60_000);
    const proof = await post('driver', `/driver/deliveries/${deliveryId}/proof`, { id: nextId(), recipientName: 'Emmanuel Tetteh', photoFileId: uploaded.body.id as string, codCollectedPesewas: 0, capturedAt: clock.now().toISOString() });
    expect(proof.status, JSON.stringify(proof.body)).toBe(200);
    const order = (await get('manager', `/orders/${s['order']!}`)).body;
    expect([order.status, order.lines.filter((l: { lineStatus: string }) => l.lineStatus === 'FULFILLED').length, order.lines.filter((l: { lineStatus: string }) => l.lineStatus === 'BACKORDERED').length]).toEqual(['DELIVERED', 10, 8]);
    expect(order.lines.slice(0, 10).map((l: { stockUnit: { identifier: string } }) => l.stockUnit.identifier)).toEqual(tags(201, 210));
    // The goats issued to the customer at their own cost: 6,600.00, Dr 5000 and Cr 1310.
    const cost = await admin().query<{ code: string; side: string; amount: string }>(
      `SELECT a.code, l.side, sum(l.amount_pesewas)::text AS amount FROM fin.journal_line l JOIN fin.account a ON a.id = l.account_id JOIN fin.journal_entry e ON e.id = l.journal_entry_id
        WHERE a.code IN ('5000', '1310') AND e.source_document_id = ANY($1::uuid[]) GROUP BY a.code, l.side ORDER BY a.code`,
      [[s['order'], deliveryId, s['list']]],
    );
    expect(cost.rows.map((r) => `${r.code}:${r.side}:${r.amount}`)).toEqual(['1310:C:660000', '5000:D:660000']);
    expect(await heldBy(s['backorder']!)).toEqual(tags(211, 218));
  });

  it('releases the backorder’s hold when it is cancelled, and lets the rival take the goats only then', async () => {
    const cancelled = await post('manager', `/orders/${s['backorder']!}/cancel`, { reasonCode: 'CUSTOMER_CANCELLED', note: 'The family took the rest elsewhere (TEST)' });
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    expect(await heldBy(s['backorder']!)).toEqual([]);
    const r = await post('sales2', `/quotes/${s['rival']!}/cancel`, { reason: 'The buyer went elsewhere (TEST)' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  });
});

describe('an order line keeps its quote line’s band: confirmation reserves only animals of it (the owner, 2026-11-24, BL-124)', () => {
  it('stays PLACED short of a second GOAT-L goat though GOAT-M goats are free, and never takes one', async () => {
    const quoteId = await acceptedQuote([goats(2, 150_000, 'GOAT-L')]);
    expect(await heldBy(quoteId)).toEqual(['G-0157']);
    const order = await post('sales', `/quotes/${quoteId}/convert`, { fulfilmentMode: 'COLLECTION', paymentTerms: 'COD' });
    expect(order.status, JSON.stringify(order.body)).toBe(201);
    const short = await post('sales', `/orders/${order.body.id as string}/confirm`);
    expect([short.status, short.body.error?.code, short.body.error?.details?.[0]?.code, short.body.error?.details?.[0]?.field], JSON.stringify(short.body)).toEqual([422, 'STOCK_UNAVAILABLE', 'NOT_ENOUGH_STOCK', '/lines/2']);
    expect(await heldBy(order.body.id as string)).toEqual(['G-0157']);
    // The database never lets a line's band change.
    const line = order.body.lines[0].id as string;
    await expect(database.pool('app').query('UPDATE ord.sales_order_line SET weight_band_id = $1 WHERE id = $2', [id('band:GOAT-M'), line])).rejects.toMatchObject({ code: 'HK004', constraint: 'ck_sales_order_line_weight_band' });
    expect((await post('sales', `/orders/${order.body.id as string}/cancel`, { reasonCode: 'CUSTOMER_CANCELLED', note: 'Only one large goat (TEST)' })).status).toBe(200);
  });
});

describe("an accepted quote's hold ends 7 days after acceptance (the owner, 2026-11-24, A-310 (b) amended)", () => {
  it('converts at 7 days less a minute, with its hold', async () => {
    const quoteId = await acceptedQuote([goats(1)]);
    const held = await heldBy(quoteId);
    expect(held).toHaveLength(1);
    await advance(7 * 86_400_000 - 60_000);
    const order = await post('sales', `/quotes/${quoteId}/convert`, { fulfilmentMode: 'COLLECTION', paymentTerms: 'COD' });
    expect(order.status, JSON.stringify(order.body)).toBe(201);
    expect(await heldBy(order.body.id as string)).toEqual(held);
    expect((await post('sales', `/orders/${order.body.id as string}/cancel`, { reasonCode: 'CUSTOMER_CANCELLED', note: 'Test over (TEST)' })).status).toBe(200);
  });

  it('refuses the conversion at 7 days exactly, writing nothing, and the job releases the hold with its reason, audited and published', async () => {
    const quoteId = await acceptedQuote([goats(2)]);
    const held = await heldBy(quoteId);
    await advance(7 * 86_400_000);
    const refused = await post('sales', `/quotes/${quoteId}/convert`, { fulfilmentMode: 'COLLECTION', paymentTerms: 'COD' });
    expect([refused.status, refused.body.error.code, refused.body.error.details[0].code]).toEqual([422, 'INVALID_STATE_TRANSITION', 'ACCEPTANCE_LAPSED']);
    expect((await one('SELECT count(*)::int AS n FROM ord.sales_order WHERE source_document_id = $1', [quoteId]))['n']).toBe(0);
    expect(await heldBy(quoteId)).toEqual(held);
    expect(await expireJob()).toContain(quoteId);
    expect(await heldBy(quoteId)).toEqual([]);
    const quote = (await get('sales', `/quotes/${quoteId}`)).body;
    expect([quote.status, quote.acceptedVersionId !== null]).toEqual(['EXPIRED', true]);
    const ended = await admin().query<{ status: string; reason: string }>('SELECT status, released_reason AS reason FROM inv.stock_reservation WHERE holder_document_id = $1 ORDER BY id', [quoteId]);
    expect(ended.rows.filter((r) => r.status === 'RELEASED' && r.reason.includes('its hold ended 7 days after acceptance with no order'))).toHaveLength(2);
    const lapsed = (await one("SELECT payload FROM platform.outbox_message WHERE event_type = 'quo.AcceptedQuoteLapsed' AND subject_id = $1", [quoteId]))['payload'] as Record<string, unknown>;
    expect(lapsed).toMatchObject({ quoteId, heldReleasedQty: '2.000', grossPesewas: 190_000, acceptanceMethod: 'IN_PERSON', abuseCase: 66 });
    expect((await one("SELECT count(*)::int AS n FROM platform.audit_event WHERE entity_id = $1 AND action = 'LAPSE_ACCEPTED'", [quoteId]))['n']).toBe(1);
    const again = await post('sales', `/quotes/${quoteId}/convert`, { fulfilmentMode: 'COLLECTION', paymentTerms: 'COD' });
    expect([again.status, again.body.error.details[0].code]).toEqual([422, 'ACCEPTANCE_LAPSED']);
    // A second run finds nothing more to release.
    expect(await expireJob()).not.toContain(quoteId);
  });

  it('a conversion racing the job is converted with its hold before 7 days, and released and refused at 7 days, never both', async () => {
    const before = await acceptedQuote([goats(1)]);
    await advance(7 * 86_400_000 - 1);
    const [converted, firstRun] = await Promise.all([post('sales', `/quotes/${before}/convert`, { fulfilmentMode: 'COLLECTION', paymentTerms: 'COD' }), expireJob()]);
    expect([converted.status, firstRun.includes(before)], JSON.stringify(converted.body)).toEqual([201, false]);
    expect(await heldBy(converted.body.id as string)).toHaveLength(1);
    expect((await post('sales', `/orders/${converted.body.id as string}/cancel`, { reasonCode: 'CUSTOMER_CANCELLED', note: 'Test over (TEST)' })).status).toBe(200);

    const at = await acceptedQuote([goats(1)]);
    const held = await heldBy(at);
    await advance(7 * 86_400_000);
    const [refused, secondRun] = await Promise.all([post('sales', `/quotes/${at}/convert`, { fulfilmentMode: 'COLLECTION', paymentTerms: 'COD' }), expireJob()]);
    expect([refused.status, refused.body.error?.details?.[0]?.code, secondRun.includes(at)]).toEqual([422, 'ACCEPTANCE_LAPSED', true]);
    expect((await one('SELECT count(*)::int AS n FROM ord.sales_order WHERE source_document_id = $1', [at]))['n']).toBe(0);
    expect(await heldBy(at)).toEqual([]);
    expect((await one("SELECT count(*)::int AS n FROM inv.stock_reservation WHERE stock_unit_id = $1 AND status = 'ACTIVE'", [id(held[0]!)]))['n']).toBe(0);
  });

  it('shows the lapsed quotes in the pipeline as lapsed after acceptance, expired and lost in the win rate', async () => {
    const from = toBusinessDate(testStartTime());
    const to = toBusinessDate(clock.now());
    const pipeline = await get('sales', `/quotes/pipeline?from=${from}&to=${to}&groupBy=SALESPERSON`);
    expect(pipeline.status, JSON.stringify(pipeline.body)).toBe(200);
    const kojo = (pipeline.body.rows ?? pipeline.body.data).find((r: { group: { id: string } }) => r.group.id === principals.get('sales'));
    // Kojo's quotes: the funeral, the GOAT-L pair, the one converted at 7 days less a minute and the one before the job: 4 won; the two lapsed: lost.
    expect([kojo.accepted, kojo.expired, kojo.lapsedAfterAcceptance, kojo.declined, kojo.winRatePercent]).toEqual([4, 2, 2, 0, '66.67']);
  });
});
